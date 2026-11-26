use super::*;
use tokio_tungstenite::tungstenite::protocol::Role;

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
    assert!(parse_info(BOX_HOTSPOT, br#"{"status":"ok"}"#).is_none());

    let remembered: Remembered = serde_json::from_str(r#"{"ip":"192.168.5.1","ts":123}"#).unwrap();
    assert_eq!(remembered.ip, BOX_HOTSPOT);
    assert!(!remembered.requires_key);
    assert_eq!(
        serde_json::to_value(remembered).unwrap(),
        json!({"ip":"192.168.5.1","requiresKey":false})
    );
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
