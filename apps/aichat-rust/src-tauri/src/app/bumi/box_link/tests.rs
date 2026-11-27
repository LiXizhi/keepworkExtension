use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::protocol::Role;

#[test]
fn hotspot_scanning_is_an_additive_box_link_operation() {
    assert!(matches!(
        serde_json::from_str::<Request>(r#"{"operation":"scanWifi"}"#).unwrap(),
        Request::ScanWifi
    ));
    for legacy in [
        r#"{"operation":"status"}"#,
        r#"{"operation":"scan"}"#,
        r#"{"operation":"disconnect"}"#,
        r#"{"operation":"connect","ip":"192.168.5.1"}"#,
    ] {
        assert!(serde_json::from_str::<Request>(legacy).is_ok(), "{legacy}");
    }
    assert!(serde_json::from_str::<Request>(r#"{"operation":"scanWifi2"}"#).is_err());
}

#[test]
fn box_and_pc_hotspots_are_included_in_tcp_fallback() {
    let box_hotspot = Interface::with_prefix("192.168.5.10".parse().unwrap(), 24).unwrap();
    assert_eq!(
        box_hotspot.broadcast(),
        Some("192.168.5.255".parse().unwrap())
    );
    assert!(box_hotspot.scan_addresses().any(|ip| ip == BOX_HOTSPOT));
    assert!(!box_hotspot.scan_addresses().any(|ip| ip == box_hotspot.ip));

    let pc_hotspot = Interface::with_prefix("192.168.137.1".parse().unwrap(), 24).unwrap();
    assert!(pc_hotspot
        .scan_addresses()
        .any(|ip| ip == Ipv4Addr::new(192, 168, 137, 2)));
    assert!(!pc_hotspot.peer(BOX_HOTSPOT));

    let router = Interface::with_prefix("10.0.1.35".parse().unwrap(), 27).unwrap();
    assert_eq!(router.broadcast(), Some("10.0.1.63".parse().unwrap()));
    assert_eq!(router.scan_addresses().count(), 29);
    let interfaces = BTreeSet::from([router]);
    for invalid in [
        "127.0.0.1",
        "203.0.113.5",
        "10.0.1.63",
        "224.0.0.1",
        "0.0.0.0",
        "10.0.1.35",
    ] {
        assert!(
            !reachable(invalid.parse().unwrap(), &interfaces),
            "{invalid}"
        );
    }
}

#[test]
fn beacons_must_advertise_the_sender_and_documented_service() {
    let interface = Interface::with_prefix("192.168.5.10".parse().unwrap(), 24).unwrap();
    let from = "192.168.5.1:8081".parse().unwrap();
    let beacon = br#"{"t":"beacon","id":"8D91","ip":"192.168.5.1","port":8080,"caps":["mjpeg"],"extra":true}"#;
    let found = parse_beacon(beacon, from, interface, None).unwrap();
    assert_eq!(found.ip, BOX_HOTSPOT);
    assert_eq!(found.id.as_deref(), Some("8D91"));
    assert!(parse_beacon(beacon, "192.168.5.2:8081".parse().unwrap(), interface, None).is_none());
    assert!(parse_beacon(
        br#"{"t":"beacon","ip":"192.168.5.1","port":22}"#,
        from,
        interface,
        None
    )
    .is_none());
    assert!(parse_beacon(
        br#"{"t":"beacon","ip":"0.0.0.0","port":8080}"#,
        from,
        interface,
        None
    )
    .is_none());
}

#[test]
fn identifies_info_with_additive_fields_and_reads_legacy_history() {
    let device = parse_info(
        BOX_HOTSPOT,
        br#"{"name":"Box","fw":"1.0","caps":["mjpeg","ws"],"camera":true}"#,
    )
    .unwrap();
    assert_eq!(device.name.as_deref(), Some("Box"));
    assert!(device.camera);
    assert!(
        parse_info(
            BOX_HOTSPOT,
            br#"{"name":"Box","fw":"1.0","caps":["mjpeg"]}"#
        )
        .unwrap()
        .camera
    );
    assert!(
        !parse_info(
            BOX_HOTSPOT,
            br#"{"name":"Box","fw":"1.0","caps":["mjpeg"],"camera":false}"#
        )
        .unwrap()
        .camera
    );
    assert!(
        !parse_info(BOX_HOTSPOT, br#"{"name":"Box","fw":"1.0","caps":["ws"]}"#)
            .unwrap()
            .camera
    );
    assert!(parse_info(BOX_HOTSPOT, br#"{"status":"ok"}"#).is_none());

    let remembered: Remembered = serde_json::from_str(r#"{"ip":"192.168.5.1","ts":123}"#).unwrap();
    assert_eq!(remembered.ip, BOX_HOTSPOT);
    assert!(!remembered.requires_key);
    assert_eq!(
        serde_json::to_value(remembered).unwrap(),
        json!({"ip":"192.168.5.1","requiresKey":false})
    );
}

#[test]
fn lan_search_is_an_additive_connect_option() {
    for legacy in [
        r#"{"operation":"connect","ip":"192.168.5.1"}"#,
        r#"{"operation":"connect","ip":"192.168.5.1","key":"abc","expectedId":"8D91"}"#,
    ] {
        let Ok(Request::Connect { ip, lan, .. }) = serde_json::from_str(legacy) else {
            panic!("{legacy}")
        };
        assert_eq!(ip, Some(BOX_HOTSPOT));
        assert!(!lan);
    }
    for searched in [
        r#"{"operation":"connect","lan":true}"#,
        r#"{"operation":"connect","ip":"192.168.110.87","lan":true}"#,
    ] {
        assert!(matches!(
            serde_json::from_str(searched),
            Ok(Request::Connect { lan: true, .. })
        ));
    }
    assert!(
        serde_json::from_str::<Request>(r#"{"operation":"connect","ip":"nope","lan":true}"#)
            .is_err()
    );
}

#[test]
fn a_lan_search_sweeps_whatever_subnet_a_router_hands_out() {
    let wide = Interface::with_prefix("10.0.1.35".parse().unwrap(), 22).unwrap();
    let addresses: Vec<_> = wide.scan_addresses().collect();
    assert_eq!(addresses.len(), 1021);
    assert_eq!(addresses[0], "10.0.1.1".parse::<Ipv4Addr>().unwrap());
    assert_eq!(addresses[252], "10.0.1.254".parse::<Ipv4Addr>().unwrap());
    for host in ["10.0.0.1", "10.0.2.200", "10.0.3.254"] {
        assert!(
            addresses.contains(&host.parse::<Ipv4Addr>().unwrap()),
            "{host}"
        );
    }
    for skipped in ["10.0.0.0", "10.0.3.255", "10.0.1.35"] {
        assert!(
            !addresses.contains(&skipped.parse::<Ipv4Addr>().unwrap()),
            "{skipped}"
        );
    }

    let wider = Interface::with_prefix("10.0.9.35".parse().unwrap(), 20).unwrap();
    let addresses: Vec<_> = wider.scan_addresses().collect();
    assert_eq!(addresses.len(), 4093);
    assert_eq!(addresses[0], "10.0.9.1".parse::<Ipv4Addr>().unwrap());
    assert_eq!(addresses[252], "10.0.9.254".parse::<Ipv4Addr>().unwrap());
    for host in ["10.0.0.1", "10.0.8.1", "10.0.12.200", "10.0.15.254"] {
        assert!(
            addresses.contains(&host.parse::<Ipv4Addr>().unwrap()),
            "{host}"
        );
    }
    for skipped in ["10.0.0.0", "10.0.15.255", "10.0.9.35"] {
        assert!(
            !addresses.contains(&skipped.parse::<Ipv4Addr>().unwrap()),
            "{skipped}"
        );
    }

    // A /21 is still swept whole; a pool too large to sweep in time keeps only the
    // window around this computer.
    assert_eq!(
        Interface::with_prefix("10.0.1.35".parse().unwrap(), 21)
            .unwrap()
            .scan_addresses()
            .count(),
        2045
    );
    assert_eq!(
        Interface::with_prefix("10.0.1.35".parse().unwrap(), 16)
            .unwrap()
            .scan_addresses()
            .count(),
        253
    );
}

#[test]
fn a_box_heard_and_read_is_one_device_and_the_remembered_box_wins() {
    let box_at = |ip: [u8; 4], id: Option<&str>| Device {
        ip: Ipv4Addr::from(ip),
        port: HTTP_PORT,
        id: id.map(str::to_owned),
        name: None,
        firmware: None,
        camera: false,
    };
    let mut page = box_at([10, 0, 0, 2], None);
    page.name = Some("xiaozhi-box".into());
    page.firmware = Some("2.2.3".into());
    page.camera = true;
    let heard = box_at([10, 0, 0, 2], Some("80:F1:B2:DA:B3:1D"));
    let devices = assemble(vec![heard], vec![page, box_at([10, 0, 0, 3], Some("B"))]);
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0].ip, Ipv4Addr::from([10, 0, 0, 2]));
    assert_eq!(devices[0].id.as_deref(), Some("80:F1:B2:DA:B3:1D"));
    assert_eq!(devices[0].firmware.as_deref(), Some("2.2.3"));
    assert!(devices[0].camera);
    assert_eq!(devices[1].id.as_deref(), Some("B"));

    let two = [
        box_at([10, 0, 0, 2], Some("A")),
        box_at([10, 0, 0, 3], Some("B")),
    ];
    assert_eq!(assemble(two.to_vec(), Vec::new()), two.to_vec());
    assert_eq!(assemble(Vec::new(), two.to_vec()), two.to_vec());

    assert!(matches!(pick(&[], None), Picked::Missed));
    assert!(matches!(
        pick(&[box_at([10, 0, 0, 2], Some("A"))], None),
        Picked::One(device) if device.ip == Ipv4Addr::from([10, 0, 0, 2])
    ));
    assert!(matches!(
        pick(&[box_at([10, 0, 0, 2], None)], Some("A")),
        Picked::One(device) if device.ip == Ipv4Addr::from([10, 0, 0, 2])
    ));
    let two = [
        box_at([10, 0, 0, 2], Some("A")),
        box_at([10, 0, 0, 3], Some("B")),
    ];
    assert!(matches!(pick(&two, None), Picked::Many));
    assert!(matches!(pick(&two, Some("C")), Picked::Many));
    assert!(matches!(
        pick(&two, Some("B")),
        Picked::One(device) if device.ip == Ipv4Addr::from([10, 0, 0, 3])
    ));
    assert!(no_box(None).contains("未在局域网中发现盒子"));
    assert!(no_box(Some(BOX_HOTSPOT)).contains("未在 192.168.5.1 或局域网中发现盒子"));
}

// A loopback port answering one HTTP request each, or a port nobody listens on.
async fn serve_info(status: &'static str, body: &'static str) -> u16 {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = [0; 1024];
                let _ = stream.read(&mut request).await;
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    port
}

#[tokio::test]
async fn an_address_without_a_box_lets_the_search_move_on() {
    let client = info_client(Duration::from_secs(1)).unwrap();
    let ask = |url: String| {
        let client = client.clone();
        async move {
            read_info(
                &client,
                &url,
                Ipv4Addr::LOCALHOST,
                "",
                Duration::from_secs(1),
            )
            .await
        }
    };

    let closed = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let failure = ask(format!("http://127.0.0.1:{closed}/api/info"))
        .await
        .unwrap_err();
    assert!(failure.absent);
    assert!(failure.message.contains("无法访问盒子"));

    let port = serve_info("404 Not Found", "<html>").await;
    assert!(
        ask(format!("http://127.0.0.1:{port}/api/info"))
            .await
            .unwrap_err()
            .absent
    );

    let port = serve_info("200 OK", r#"{"status":"ok"}"#).await;
    assert!(
        ask(format!("http://127.0.0.1:{port}/api/info"))
            .await
            .unwrap_err()
            .absent
    );

    // A box rejecting the key is a box, so the address is not given up on.
    let port = serve_info("401 Unauthorized", "").await;
    let failure = ask(format!("http://127.0.0.1:{port}/api/info"))
        .await
        .unwrap_err();
    assert!(!failure.absent);
    assert!(failure.message.contains("配对码"));

    let port = serve_info(
        "200 OK",
        r#"{"id":"8D91","name":"Box","fw":"1.0","caps":["ws"]}"#,
    )
    .await;
    let device = ask(format!("http://127.0.0.1:{port}/api/info"))
        .await
        .unwrap();
    assert_eq!(device.id.as_deref(), Some("8D91"));
}

/// Simulates a box on this computer and scans for it as if this computer sat one
/// address over; whatever else is on the network is reported but not required.
#[tokio::test]
#[ignore = "needs port 8080 free on this computer's network"]
async fn live_lan_scan_finds_a_simulated_box() {
    let own = interfaces()
        .into_iter()
        .find(|interface| interface.broadcast().is_some())
        .expect("join a network");
    let box_ip = own.ip;
    let listener = tokio::net::TcpListener::bind((box_ip, HTTP_PORT))
        .await
        .expect("port 8080 is in use");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = [0; 1024];
                let _ = stream.read(&mut request).await;
                let body = r#"{"id":"FAKE","name":"Simulated box","fw":"1.0","caps":["ws"]}"#;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });

    let decoy = Interface::with_prefix(own.scan_addresses().next().unwrap(), 24).unwrap();
    let started = Instant::now();
    let devices = discover_in(&BTreeSet::from([decoy]), Vec::new(), None)
        .await
        .unwrap();
    eprintln!(
        "sweep of a /24 took {:?} and found {} device(s): {:?}",
        started.elapsed(),
        devices.len(),
        devices
    );
    let simulated = devices
        .iter()
        .find(|device| device.id.as_deref() == Some("FAKE"))
        .expect("the simulated box was not found");
    assert_eq!(simulated.ip, box_ip);
}

/// Searches this computer's real networks, with and without a stale address to
/// miss, and connects to the box when it is the only one.
#[tokio::test]
#[ignore = "contacts any box on this computer's network"]
async fn live_lan_search_reaches_a_box_on_this_network() {
    for (target, lan) in [
        (None, true),
        (Some(BOX_HOTSPOT), true),
        (Some(BOX_HOTSPOT), false),
    ] {
        let started = Instant::now();
        let outcome = match dial(target, "", None, lan).await {
            Ok(Dial::Linked(device, _socket)) => {
                format!(
                    "connected to {} {}",
                    device.ip,
                    device.name.unwrap_or_default()
                )
            }
            Ok(Dial::Choices(devices)) => format!("{} boxes to choose from", devices.len()),
            Err(error) => error,
        };
        eprintln!(
            "target {target:?} with lan={lan} took {:?}: {outcome}",
            started.elapsed()
        );
        assert!(started.elapsed() < Duration::from_secs(12));
    }
}

#[tokio::test]
async fn disconnect_invalidates_the_current_operation_without_affecting_the_next_one() {
    let mut link = Link::default();
    let mut cancelled = link.begin().unwrap();
    assert!(link.begin().is_err());
    link.reset();
    assert!(cancelled.changed().await.is_err());
    let next = link.begin().unwrap();
    assert!(!link.owns(&cancelled));
    assert!(link.owns(&next));
}

async fn reference_handshake(reply: Value) -> Result<(), String> {
    let (client, server) = tokio::io::duplex(512);
    let mut client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
    let mut server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;

    let (result, ()) = tokio::join!(hello(&mut client, "fixture-key"), async {
        let greeting = server.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&greeting).unwrap(),
            json!({"t":"hello","v":1,"key":"fixture-key","client":"keepwork-desktop"})
        );
        server
            .send(Message::Text(r#"{"t":"status","additive":true}"#.into()))
            .await
            .unwrap();
        server.send(Message::Text(reply.to_string())).await.unwrap();
    });
    result
}

#[tokio::test]
async fn box_websocket_waits_for_hello_ok_and_reports_auth_rejection() {
    reference_handshake(json!({"t":"hello_ok","id":"8D91"}))
        .await
        .unwrap();
    assert!(reference_handshake(json!({"t":"err","code":"auth"}))
        .await
        .unwrap_err()
        .contains("配对码"));
}

#[test]
fn mjpeg_payload_yields_each_complete_jpeg_and_drops_an_oversized_partial() {
    let jpeg = [0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9];
    let mut buffer = b"--frame\r\n".to_vec();
    buffer.extend_from_slice(&jpeg);
    buffer.extend_from_slice(&jpeg[..4]);
    assert_eq!(take_jpegs(&mut buffer, 8), vec![jpeg.to_vec()]);
    assert_eq!(buffer, jpeg[..4]);

    let mut oversized = vec![0xFF, 0xD8, 1, 2, 3, 4, 5, 6, 7];
    assert!(take_jpegs(&mut oversized, 8).is_empty());
    assert!(oversized.is_empty());
}

#[test]
fn camera_stream_requires_the_connected_box_camera() {
    let mut link = Link::default();
    assert!(link.begin_camera().unwrap_err().contains("请先连接"));
    link.connected = Some(Device {
        ip: BOX_HOTSPOT,
        port: HTTP_PORT,
        id: Some("8D91".into()),
        name: Some("xiaozhi-box".into()),
        firmware: Some("2.2.3".into()),
        camera: false,
    });
    link.key = "secret".into();
    assert!(link.begin_camera().unwrap_err().contains("不可用"));
    link.connected.as_mut().unwrap().camera = true;
    let (ip, key, cancelled) = link.begin_camera().unwrap();
    assert_eq!(ip, BOX_HOTSPOT);
    assert_eq!(key, "secret");
    assert!(link.owns_camera(&cancelled));
    link.stop_camera();
    assert!(!link.owns_camera(&cancelled));
    assert_eq!(link.key, "secret");
}
