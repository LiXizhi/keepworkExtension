//! Real HTTP/1 uploads must retain the agent rejection JSON at size boundaries.
use keepwork_mcp::http::{router, AppState};
use keepwork_mcp::identity::Identity;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn payload(size: usize) -> Vec<u8> {
    let mut bytes = br#"{"text":""#.to_vec();
    bytes.resize(size - 2, b'x');
    bytes.extend_from_slice(br#""}"#);
    bytes
}

#[tokio::test]
async fn finite_oversized_agent_uploads_return_json_without_dispatch_or_connection_reset() {
    let directory =
        std::env::temp_dir().join(format!("kp-agent-http-body-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}");
    let state = Arc::new(AppState::new_at(
        address.port(),
        directory.clone(),
        false,
        "fixture-token".into(),
        Identity::from_env(Some("standalone".into()), None),
        directory.join("personas"),
    ));
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let app = router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .http1_only()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let route = "/agents/sessions/no-owned-session";
    for (suffix, size) in [
        ("turns", 2_800_000),
        ("turns", 5_600_000),
        ("image-turns", 7_000_100),
    ] {
        let response = client
            .post(format!("{base}{route}/{suffix}"))
            .header("Origin", &base)
            .header("x-agent-owner", "a".repeat(32))
            .header("Content-Type", "application/json")
            .body(payload(size))
            .send()
            .await
            .expect("a finite oversized upload must deliver its rejection response");
        assert_eq!(response.status(), 400);
        let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(body["error"], "Request too large");
        assert_eq!(body["acceptanceUnknown"], false);
    }

    // No Content-Length: the same contract applies when the overflow is learned
    // from streamed data. Yield each HTTP chunk so the tail remains in flight.
    let connection = tokio::net::TcpStream::connect(address).await.unwrap();
    let (mut reader, mut writer) = connection.into_split();
    let headers = format!("POST {route}/turns HTTP/1.1\r\nHost: {address}\r\nOrigin: {base}\r\nx-agent-owner: {}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", "a".repeat(32));
    let sending = async {
        writer.write_all(headers.as_bytes()).await.unwrap();
        let bytes = payload(2_800_000);
        for chunk in bytes.chunks(16_384) {
            writer
                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                .await
                .unwrap();
            writer.write_all(chunk).await.unwrap();
            writer.write_all(b"\r\n").await.unwrap();
            tokio::task::yield_now().await;
        }
        writer.write_all(b"0\r\n\r\n").await.unwrap();
    };
    let receiving = async {
        let mut bytes = Vec::new();
        (&mut reader)
            .take(64 * 1024)
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        bytes
    };
    let (_, bytes) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(sending, receiving)
    })
    .await
    .unwrap();
    let response = String::from_utf8(bytes).unwrap();
    assert!(response.starts_with("HTTP/1.1 400"), "{response}");
    assert!(response.contains("Request too large"), "{response}");
    assert!(
        response.contains("\"acceptanceUnknown\":false"),
        "{response}"
    );

    // The dedicated route still accepts the same wire size for normal JSON
    // validation, rather than applying the legacy size cap.
    let response = client
        .post(format!("{base}{route}/image-turns"))
        .header("Origin", &base)
        .header("x-agent-owner", "a".repeat(32))
        .header("Content-Type", "application/json")
        .body(payload(2_800_000))
        .send()
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(body["error"], "Missing images");
    assert_eq!(body["acceptanceUnknown"], false);
    assert_eq!(
        client
            .get(format!("{base}/health"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(
        !directory.join("agent-sessions-v1.json").exists(),
        "rejected bodies must never claim or persist a submission"
    );
    let _ = stop.send(());
    server.await.unwrap();
    state.agents.close().await;
    state.messaging.close().await;
    drop(state);
    std::fs::remove_dir_all(directory).unwrap();
}
