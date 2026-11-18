use super::*;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

type Dial = Pin<Box<dyn Future<Output = io::Result<SocketAddr>> + Send>>;

fn v4(last: u8) -> SocketAddr {
    SocketAddr::from(([192, 0, 2, last], 443))
}

fn v6(last: u16) -> SocketAddr {
    SocketAddr::from(([0x2001, 0xdb8, 0, 0, 0, 0, 0, last], 443))
}

struct AttemptDrop {
    address: SocketAddr,
    dropped: Arc<Mutex<Vec<SocketAddr>>>,
}

impl Drop for AttemptDrop {
    fn drop(&mut self) {
        self.dropped.lock().unwrap().push(self.address);
    }
}

async fn stalled_preferred_address_falls_back(first: SocketAddr, second: SocketAddr) {
    let started = Arc::new(Mutex::new(Vec::new()));
    let dropped = Arc::new(Mutex::new(Vec::new()));
    let attempts = started.clone();
    let cleanup = dropped.clone();
    let beginning = Instant::now();
    let work = connect_addresses(vec![first, second], move |address| -> Dial {
        attempts.lock().unwrap().push((address, Instant::now()));
        let cleanup = AttemptDrop {
            address,
            dropped: cleanup.clone(),
        };
        Box::pin(async move {
            let _cleanup = cleanup;
            if address == first {
                std::future::pending::<io::Result<SocketAddr>>().await
            } else {
                Ok(address)
            }
        })
    });
    tokio::pin!(work);
    assert!(futures_util::poll!(&mut work).is_pending());
    assert_eq!(&*started.lock().unwrap(), &[(first, beginning)]);
    tokio::time::advance(Duration::from_millis(249)).await;
    assert!(futures_util::poll!(&mut work).is_pending());
    assert_eq!(
        started.lock().unwrap().len(),
        1,
        "do not race the alternate immediately"
    );
    tokio::time::advance(Duration::from_millis(1)).await;
    let result = tokio::time::timeout(Duration::from_secs(1), &mut work)
        .await
        .expect("a blackholed preferred address must not block the reachable family")
        .unwrap();
    assert_eq!(result, second);
    assert_eq!(
        &*started.lock().unwrap(),
        &[
            (first, beginning),
            (second, beginning + Duration::from_millis(250)),
        ]
    );
    let dropped = dropped.lock().unwrap();
    assert!(
        dropped.contains(&first),
        "the pending loser must be cancelled on success"
    );
    assert_eq!(
        dropped.len(),
        2,
        "both dial futures release their resources"
    );
}

#[tokio::test(start_paused = true)]
async fn blackholed_ipv6_starts_ipv4_after_250ms_and_drops_loser() {
    stalled_preferred_address_falls_back(v6(1), v4(1)).await;
}

#[tokio::test(start_paused = true)]
async fn blackholed_ipv4_starts_ipv6_after_250ms_and_drops_loser() {
    stalled_preferred_address_falls_back(v4(1), v6(1)).await;
}

#[tokio::test(start_paused = true)]
async fn immediate_failures_try_remaining_addresses_without_waiting() {
    let first = v6(1);
    let second = v4(1);
    let last = v6(2);
    let attempted = Arc::new(Mutex::new(Vec::new()));
    let observed = attempted.clone();
    let beginning = Instant::now();
    let result = connect_addresses(vec![first, last, second], move |address| {
        observed.lock().unwrap().push(address);
        std::future::ready(if address == last {
            Ok(address)
        } else {
            Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "fixture refusal",
            ))
        })
    })
    .await
    .unwrap();
    assert_eq!(result, last);
    assert_eq!(&*attempted.lock().unwrap(), &[first, second, last]);
    assert_eq!(
        Instant::now(),
        beginning,
        "an explicit refusal needs no fallback delay"
    );
}

#[tokio::test(start_paused = true)]
async fn all_failed_addresses_return_the_last_error_without_waiting() {
    let first = v6(1);
    let last = v4(1);
    let beginning = Instant::now();
    let error = connect_addresses(vec![first, last], |address| {
        std::future::ready::<io::Result<SocketAddr>>(Err(io::Error::new(
            if address == last {
                io::ErrorKind::ConnectionRefused
            } else {
                io::ErrorKind::NetworkUnreachable
            },
            address.to_string(),
        )))
    })
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
    assert_eq!(error.to_string(), last.to_string());
    assert_eq!(Instant::now(), beginning);
}

#[tokio::test(start_paused = true)]
async fn outer_timeout_and_cancellation_drop_every_in_flight_attempt() {
    for cancelled in [false, true] {
        let started = Arc::new(Mutex::new(Vec::new()));
        let dropped = Arc::new(Mutex::new(Vec::new()));
        let attempts = started.clone();
        let cleanup = dropped.clone();
        let mut work = Box::pin(connect_addresses(
            vec![v6(1), v4(1)],
            move |address| -> Dial {
                attempts.lock().unwrap().push(address);
                let cleanup = AttemptDrop {
                    address,
                    dropped: cleanup.clone(),
                };
                Box::pin(async move {
                    let _cleanup = cleanup;
                    std::future::pending::<io::Result<SocketAddr>>().await
                })
            },
        ));
        assert!(futures_util::poll!(&mut work).is_pending());
        tokio::time::advance(Duration::from_millis(250)).await;
        assert!(futures_util::poll!(&mut work).is_pending());
        assert_eq!(started.lock().unwrap().len(), 2);
        assert!(dropped.lock().unwrap().is_empty());
        if cancelled {
            drop(work);
        } else {
            assert!(tokio::time::timeout(Duration::from_secs(1), work)
                .await
                .is_err());
        }
        let dropped = dropped.lock().unwrap();
        assert_eq!(
            dropped.len(),
            2,
            "timeout/cancellation must not leave background dials"
        );
        assert!(dropped.contains(&v6(1)) && dropped.contains(&v4(1)));
    }
}

#[test]
fn address_order_alternates_families_and_preserves_each_family_order() {
    for (input, expected) in [
        (
            vec![v6(1), v6(2), v4(1), v4(2), v4(3)],
            vec![v6(1), v4(1), v6(2), v4(2), v4(3)],
        ),
        (
            vec![v4(1), v4(2), v6(1), v6(2), v6(3)],
            vec![v4(1), v6(1), v4(2), v6(2), v6(3)],
        ),
        (vec![v6(1), v6(2)], vec![v6(1), v6(2)]),
        (vec![v4(1), v4(2)], vec![v4(1), v4(2)]),
        (vec![], vec![]),
    ] {
        assert_eq!(interleave(input).into_iter().collect::<Vec<_>>(), expected);
    }
}

#[tokio::test(start_paused = true)]
async fn empty_dns_answers_fail_without_starting_a_connection() {
    let error = connect_addresses(vec![], |_address| {
        panic!("an empty DNS result cannot open a connection");
        #[allow(unreachable_code)]
        std::future::ready::<io::Result<SocketAddr>>(Ok(v4(1)))
    })
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}
