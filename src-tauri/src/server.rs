//! A loopback HTTP server for local audio.
//!
//! Two other routes were tried and measured on WebKitGTK first:
//!
//! * Tauri's `asset:` protocol — the media element refuses custom URI schemes
//!   outright (`MediaError` code 4).
//! * A `blob:` URL built from the file's bytes — plays, but stutters badly.
//!   Recording the speaker output while playing a track gave ~18 dropouts per
//!   20s, against 1 for the same file over http.
//!
//! Serving over 127.0.0.1 is the one path this engine handles cleanly, and it
//! streams with range support, so seeking no longer needs the whole file in
//! memory.
//!
//! Access is gated twice: a random per-session token that only this app's
//! frontend is given, and the same [`MediaScope`] the commands enforce, so
//! another local process cannot read arbitrary files even if it guesses a URL.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use percent_encoding::percent_decode_str;
use tiny_http::{Header, Request, Response, Server, StatusCode};

use crate::MediaScope;

pub struct MediaServer {
    pub port: u16,
    pub token: String,
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header is valid")
}

/// The media element needs a type it recognises; it will not sniff.
fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "mp4" | "aac" => "audio/mp4",
        "wav" | "wave" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;

    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k != key {
            return None;
        }
        Some(percent_decode_str(v).decode_utf8_lossy().into_owned())
    })
}

/// Parse a `bytes=..` range against a known length. Single ranges only —
/// media elements do not ask for more.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = value.trim().strip_prefix("bytes=")?;
    let (from, to) = spec.split_once('-')?;

    // `bytes=-N` means the final N bytes.
    if from.is_empty() {
        let n: u64 = to.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), len - 1));
    }

    let start: u64 = from.parse().ok()?;
    let end = if to.is_empty() {
        len - 1
    } else {
        to.parse::<u64>().ok()?.min(len - 1)
    };

    (start <= end && start < len).then_some((start, end))
}

fn refuse(request: Request, code: u16) {
    let empty: &[u8] = &[];
    let _ = request.respond(Response::new(
        StatusCode(code),
        Vec::new(),
        empty,
        Some(0),
        None,
    ));
}

fn handle(request: Request, scope: &MediaScope, token: &str) {
    let url = request.url().to_string();

    if query_param(&url, "token").as_deref() != Some(token) {
        return refuse(request, 403);
    }

    let Some(raw) = query_param(&url, "path") else {
        return refuse(request, 400);
    };

    let path = PathBuf::from(raw);
    if !scope.is_allowed(&path) {
        return refuse(request, 403);
    }

    let Ok(mut file) = File::open(&path) else {
        return refuse(request, 404);
    };
    let Ok(meta) = file.metadata() else {
        return refuse(request, 500);
    };
    let len = meta.len();

    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| parse_range(h.value.as_str(), len));

    let mime = mime_for(&path);

    match range {
        Some((start, end)) => {
            if file.seek(SeekFrom::Start(start)).is_err() {
                return refuse(request, 500);
            }
            let count = end - start + 1;
            let headers = vec![
                header("Content-Type", mime),
                header("Accept-Ranges", "bytes"),
                header("Content-Range", &format!("bytes {start}-{end}/{len}")),
            ];
            let _ = request.respond(Response::new(
                StatusCode(206),
                headers,
                file.take(count),
                Some(count as usize),
                None,
            ));
        }
        None => {
            let headers = vec![
                header("Content-Type", mime),
                header("Accept-Ranges", "bytes"),
            ];
            let _ = request.respond(Response::new(
                StatusCode(200),
                headers,
                file,
                Some(len as usize),
                None,
            ));
        }
    }
}

/// Bind to an ephemeral loopback port and serve in the background.
pub fn start(scope: Arc<MediaScope>) -> Result<MediaServer, String> {
    let server = Server::http(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|e| format!("could not start the local media server: {e}"))?;

    let port = server
        .server_addr()
        .to_ip()
        .ok_or("local media server has no TCP port")?
        .port();

    let token = uuid::Uuid::new_v4().simple().to_string();
    let worker_token = token.clone();

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle(request, &scope, &worker_token);
        }
    });

    Ok(MediaServer { port, token })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        // Past the end clamps rather than failing.
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("nonsense", 1000), None);
    }

    /// Raw HTTP GET, returning (status, headers, body).
    fn get(port: u16, path: &str, range: Option<&str>) -> (u16, String, Vec<u8>) {
        use std::io::Write;

        let mut sock = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        if let Some(r) = range {
            req.push_str(&format!("Range: {r}\r\n"));
        }
        req.push_str("\r\n");
        sock.write_all(req.as_bytes()).unwrap();

        let mut buf = Vec::new();
        sock.read_to_end(&mut buf).unwrap();

        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&buf[..split]).to_string();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, head, buf[split + 4..].to_vec())
    }

    #[test]
    fn serves_only_allowed_files_and_honours_ranges() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("scry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let track = dir.join("tone.mp3");
        let secret = dir.join("secret.mp3");
        let body: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
        std::fs::File::create(&track).unwrap().write_all(&body).unwrap();
        std::fs::File::create(&secret).unwrap().write_all(b"nope").unwrap();

        let scope = Arc::new(MediaScope::default());
        scope.allow_file(&track); // `secret` is deliberately never allowed
        let srv = start(scope).unwrap();

        let enc = |p: &Path| {
            percent_encoding::utf8_percent_encode(
                p.to_str().unwrap(),
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string()
        };
        let ok_url = format!("/media?token={}&path={}", srv.token, enc(&track));

        let (status, head, got) = get(srv.port, &ok_url, None);
        assert_eq!(status, 200);
        assert_eq!(got, body);
        assert!(head.to_lowercase().contains("accept-ranges: bytes"));
        assert!(head.contains("audio/mpeg"));

        let (status, head, got) = get(srv.port, &ok_url, Some("bytes=100-199"));
        assert_eq!(status, 206, "seeking needs partial content");
        assert_eq!(got, body[100..=199]);
        assert!(head.contains("bytes 100-199/4096"), "head was: {head}");

        let (status, _, _) = get(srv.port, &ok_url, Some("bytes=4000-"));
        assert_eq!(status, 206);

        // A wrong token is refused even for an allowed file.
        let bad = format!("/media?token=wrong&path={}", enc(&track));
        assert_eq!(get(srv.port, &bad, None).0, 403);

        // A correct token cannot reach a file outside the scope.
        let outside = format!("/media?token={}&path={}", srv.token, enc(&secret));
        assert_eq!(get(srv.port, &outside, None).0, 403);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_query_params() {
        let url = "/media?token=abc&path=%2Ftmp%2Fa%20b.mp3";
        assert_eq!(query_param(url, "token").as_deref(), Some("abc"));
        assert_eq!(query_param(url, "path").as_deref(), Some("/tmp/a b.mp3"));
        assert_eq!(query_param(url, "missing"), None);
    }
}
