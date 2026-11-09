use crate::files::{inside, validate_relative_path};
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

pub struct DevServer {
    port: u16,
    root_dir: PathBuf,
    entry_file: String,
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn write_http_response(
    mut stream: TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

fn handle_client(mut stream: TcpStream, root_dir: &Path, entry_file: &str) {
    let mut buf = [0u8; 8192];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    if n == 0 {
        return;
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let Some(first_line) = req.lines().next() else {
        return;
    };
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        write_http_response(
            stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method Not Allowed",
            method == "HEAD",
        );
        return;
    }

    let path_part = raw_target.split('?').next().unwrap_or("/");
    let decoded = url::form_urlencoded::parse(format!("p={}", path_part.trim_start_matches('/')).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| path_part.trim_start_matches('/').to_string());

    let rel_str = if decoded.is_empty() || decoded == "/" {
        entry_file
    } else {
        decoded.as_str()
    };

    let Ok(rel_buf) = validate_relative_path(rel_str) else {
        write_http_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
        return;
    };

    let candidate = root_dir.join(&rel_buf);
    if !inside(root_dir, &candidate) {
        write_http_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
        return;
    }

    let Ok(real_target) = dunce::canonicalize(&candidate) else {
        write_http_response(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not Found",
            method == "HEAD",
        );
        return;
    };

    if !inside(root_dir, &real_target) || !real_target.is_file() {
        write_http_response(
            stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
        return;
    }

    match fs::read(&real_target) {
        Ok(bytes) => {
            write_http_response(
                stream,
                "200 OK",
                content_type_for(&real_target),
                &bytes,
                method == "HEAD",
            );
        }
        Err(_) => {
            write_http_response(
                stream,
                "404 Not Found",
                "text/plain; charset=utf-8",
                b"Not Found",
                method == "HEAD",
            );
        }
    }
}

impl DevServer {
    pub fn start(source_dir: &Path, entry_file: &str) -> Result<Self, String> {
        let root_dir = dunce::canonicalize(source_dir)
            .map_err(|e| format!("Cannot resolve AIChat source directory {}: {e}", source_dir.display()))?;
        let entry_path = root_dir.join(entry_file);
        if !entry_path.is_file() {
            return Err(format!(
                "Missing AIChat entry file: {}",
                entry_path.display()
            ));
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to bind loopback development server: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to query local server address: {e}"))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure nonblocking listener: {e}"))?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop_flag);
        let thread_root = root_dir.clone();
        let thread_entry = entry_file.to_string();

        let handle = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _addr)) => {
                        let _ = stream.set_nonblocking(false);
                        let r = thread_root.clone();
                        let e = thread_entry.clone();
                        thread::spawn(move || handle_client(stream, &r, &e));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            port,
            root_dir,
            entry_file: entry_file.to_string(),
            stop_flag,
            handle: Some(handle),
        })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.entry_file)
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for DevServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn serves_local_aichat_source_on_loopback_and_blocks_traversal() {
        let root = std::env::temp_dir().join(format!("aichat-rust-devsrv-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("js")).unwrap();
        fs::write(root.join("AIChat.html"), "<!doctype html><title>AIChat</title>").unwrap();
        fs::write(root.join("js/app.js"), "export const ok = true;").unwrap();

        let mut server = DevServer::start(&root, "AIChat.html").unwrap();
        let client = reqwest::Client::new();

        let res = client.get(server.url()).send().await.unwrap();
        assert_eq!(res.status().as_u16(), 200);
        assert_eq!(
            res.headers().get("cache-control").unwrap().to_str().unwrap(),
            "no-store"
        );
        let text = res.text().await.unwrap();
        assert!(text.contains("<title>AIChat</title>"));

        let traversal = client
            .get(format!("http://127.0.0.1:{}/../secret.txt", server.port))
            .send()
            .await
            .unwrap();
        assert!(traversal.status().as_u16() >= 400);

        server.stop();
        let _ = fs::remove_dir_all(&root);
    }
}
