//! Race address families before the single TLS/WebSocket handshake. A stalled
//! IPv6 route must not consume the entire connection budget before IPv4 starts.
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{lookup_host, TcpStream};
use tokio::time::{sleep, Instant};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, handshake::client::Response, protocol::WebSocketConfig,
    Error, Result,
};

const CONNECTION_DELAY: Duration = Duration::from_millis(250);

pub(super) async fn websocket(
    endpoint: &str,
    config: WebSocketConfig,
) -> Result<(super::Socket, Response)> {
    let request = endpoint.into_client_request()?;
    let host = request.uri().host().ok_or_else(|| {
        Error::Io(io::Error::new(io::ErrorKind::InvalidInput, "Missing speech host"))
    })?;
    let host = host.strip_prefix('[').and_then(|host| host.strip_suffix(']')).unwrap_or(host);
    let port = request.uri().port_u16().unwrap_or(if request.uri().scheme_str() == Some("wss") { 443 } else { 80 });
    let addresses = lookup_host((host, port)).await?.collect();
    let socket = connect_addresses(addresses, |address| TcpStream::connect(address)).await?;
    socket.set_nodelay(true)?;
    // Keep the original URL for Host, SNI and certificate verification. Only
    // TCP is raced; TLS, the WebSocket request and audio are never replayed.
    tokio_tungstenite::client_async_tls_with_config(request, socket, Some(config), None).await
}

fn interleave(addresses: Vec<SocketAddr>) -> VecDeque<SocketAddr> {
    let ipv6_first = addresses.first().is_some_and(SocketAddr::is_ipv6);
    let (mut preferred, mut alternate): (VecDeque<_>, VecDeque<_>) = addresses.into_iter()
        .partition(|address| address.is_ipv6() == ipv6_first);
    let mut ordered = VecDeque::new();
    while let Some(address) = preferred.pop_front() {
        ordered.push_back(address);
        if let Some(address) = alternate.pop_front() { ordered.push_back(address); }
    }
    ordered.extend(alternate);
    ordered
}

async fn connect_addresses<T, F, C>(addresses: Vec<SocketAddr>, mut connect: F) -> io::Result<T>
where
    F: FnMut(SocketAddr) -> C,
    C: Future<Output = io::Result<T>>,
{
    let mut addresses = interleave(addresses);
    let first = addresses.pop_front().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "No speech server addresses")
    })?;
    let mut attempts = FuturesUnordered::new();
    attempts.push(connect(first));
    let next = sleep(CONNECTION_DELAY);
    tokio::pin!(next);
    loop {
        tokio::select! {
            biased;
            result = attempts.next() => match result.expect("at least one connection attempt") {
                Ok(socket) => return Ok(socket), // Dropping the other futures closes losing sockets.
                Err(error) => {
                    if let Some(address) = addresses.pop_front() {
                        attempts.push(connect(address));
                        next.as_mut().reset(Instant::now() + CONNECTION_DELAY);
                    } else if attempts.is_empty() { return Err(error); }
                }
            },
            _ = &mut next, if !addresses.is_empty() => {
                attempts.push(connect(addresses.pop_front().unwrap()));
                next.as_mut().reset(Instant::now() + CONNECTION_DELAY);
            },
        }
    }
}

#[cfg(test)]
#[path = "asr_connect_tests.rs"]
mod tests;
