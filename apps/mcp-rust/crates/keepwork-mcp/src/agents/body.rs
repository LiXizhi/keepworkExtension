//! Preserve the legacy parse limits while finishing bounded rejected uploads.
use axum::body::{Body, Bytes};
use futures_util::{Stream, StreamExt};
use std::time::Duration;

const MAX_REJECT_WIRE_BYTES: usize = 8_000_000;
const MAX_REJECT_CHUNKS: usize = 1024;
const REJECT_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) async fn read(body: Body, limit: usize) -> Result<Bytes, ()> {
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            let received = bytes.len().saturating_add(chunk.len());
            // Keep no rejected JSON/image payload while finishing the request.
            drop(bytes);
            drop(chunk);
            if received < MAX_REJECT_WIRE_BYTES {
                discard(&mut stream, MAX_REJECT_WIRE_BYTES - received).await;
            }
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(bytes))
}

async fn discard<S, E>(stream: &mut S, mut remaining: usize)
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    // Dropping an unread HTTP/1 body can reset the connection before its 400
    // response arrives. Finish ordinary finite uploads without buffering them.
    // A larger, stalled or endlessly fragmented body still has a fixed budget;
    // the frame that reaches the byte boundary is discarded, then reading ends.
    let _ = tokio::time::timeout(REJECT_TIMEOUT, async {
        for _ in 0..MAX_REJECT_CHUNKS {
            let Some(Ok(chunk)) = stream.next().await else {
                return;
            };
            if chunk.len() >= remaining {
                return;
            }
            remaining -= chunk.len();
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn parse_limit_is_exact_and_overflow_consumes_only_the_bounded_tail() {
        for limit in [2_000_000, 7_000_000] {
            for size in [limit - 1, limit, limit + 1] {
                let result = read(Body::from(vec![b'x'; size]), limit).await;
                if size <= limit {
                    assert_eq!(result.unwrap().len(), size);
                } else {
                    assert!(result.is_err());
                }
            }
        }
        let consumed = Arc::new(AtomicUsize::new(0));
        let seen = consumed.clone();
        let chunks = stream::iter([
            Bytes::from_static(b"1234"),
            Bytes::from_static(b"5"),
            Bytes::from_static(b"67"),
        ])
        .inspect(move |_| {
            seen.fetch_add(1, Ordering::Relaxed);
        })
        .map(Ok::<_, Infallible>);
        assert!(read(Body::from_stream(chunks), 4).await.is_err());
        assert_eq!(
            consumed.load(Ordering::Relaxed),
            3,
            "overflow must finish a finite request"
        );
    }

    #[tokio::test]
    async fn rejected_tail_stops_at_the_absolute_wire_or_chunk_budget() {
        let consumed = Arc::new(AtomicUsize::new(0));
        let seen = consumed.clone();
        let chunks = stream::repeat_with(move || {
            seen.fetch_add(1, Ordering::Relaxed);
            Ok::<_, Infallible>(Bytes::from(vec![0; 1_000_000]))
        });
        assert!(read(Body::from_stream(chunks), 2_000_000).await.is_err());
        assert_eq!(consumed.load(Ordering::Relaxed), 8);

        consumed.store(0, Ordering::Relaxed);
        let seen = consumed.clone();
        let chunks = stream::repeat_with(move || {
            seen.fetch_add(1, Ordering::Relaxed);
            Ok::<_, Infallible>(Bytes::from_static(b"x"))
        });
        assert!(read(Body::from_stream(chunks), 1).await.is_err());
        assert_eq!(consumed.load(Ordering::Relaxed), 2 + MAX_REJECT_CHUNKS);
    }

    #[tokio::test]
    async fn rejected_tail_cannot_wait_indefinitely_for_eof() {
        let chunks = stream::once(async { Ok::<_, Infallible>(Bytes::from_static(b"oversize")) })
            .chain(stream::pending());
        let started = tokio::time::Instant::now();
        let result = tokio::time::timeout(
            REJECT_TIMEOUT + Duration::from_secs(1),
            read(Body::from_stream(chunks), 1),
        )
        .await
        .expect("a stalled rejected request must release its handler");
        assert!(result.is_err());
        assert!(started.elapsed() >= REJECT_TIMEOUT);
    }
}
