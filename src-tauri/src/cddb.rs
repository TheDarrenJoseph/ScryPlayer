//! GnuDB (classic CDDBP protocol) disc-metadata lookup.
//!
//! Deliberately free of `tauri` types, same as `cdda.rs`/`media.rs`: the disc
//! ID checksum and response parsing are pure functions, unit-testable without
//! a network. Only `session` touches the network, tying together one
//! handshake and two commands (`query` then `read`) over a single connection.
//!
//! A Red Book audio CD carries no text metadata at all — this is purely a
//! lookup against GnuDB's database, keyed by a checksum of the disc's TOC.
//! Doing this from Rust rather than the frontend isn't a style choice: the
//! live service speaks the classic protocol over a raw TCP socket, with a
//! stateful `hello` handshake before anything else — not HTTP at all, so
//! there is no `fetch()`-shaped way to reach it from a WebView regardless of
//! CORS or CSP. (An HTTP-over-CGI gateway used to exist for exactly this
//! reason, and is what an earlier version of this module targeted, but it no
//! longer responds — verified by hand against the real server before writing
//! this version, the same way the disc-ID algorithm itself was verified
//! against the real `libcddb` rather than trusted from documentation.)

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::cdda::{Toc, SECTORS_PER_SECOND};

const SERVER_ADDR: &str = "gnudb.gnudb.org:8880";
const TIMEOUT: Duration = Duration::from_secs(5);
/// The CDDB "hello" identity sent once per connection. Generic on purpose —
/// nothing in the protocol needs it to name the real machine or user.
const HELLO: &str = "scryplayer localhost ScryPlayer";

pub struct CdMetadata {
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_titles: Vec<String>,
}

struct CddbMatch {
    category: String,
    discid: u32,
}

struct CddbDisc {
    artist: Option<String>,
    album: Option<String>,
    track_titles: Vec<String>,
}

// ---- disc ID -----------------------------------------------------------

fn digit_sum(mut n: u32) -> u32 {
    let mut sum = 0;
    while n > 0 {
        sum += n % 10;
        n /= 10;
    }
    sum
}

/// Each track's CDDB frame offset: the Red Book *absolute* address, which —
/// unlike the plain LBA our own TOC parsing uses (track 1 = 0) — includes the
/// 150-frame (2-second) lead-in pregap, so track 1 is conventionally 150.
pub fn frame_offsets(toc: &Toc) -> Vec<u32> {
    toc.tracks.iter().map(|t| t.start_lba + 150).collect()
}

/// Total disc length in seconds, the same way the CDDB reference
/// implementation derives it: from the lead-out address, which is exactly
/// our last track's `end_lba`.
pub fn disc_length_secs(toc: &Toc) -> u32 {
    match toc.tracks.last() {
        Some(last) => (last.end_lba + 150) / SECTORS_PER_SECOND,
        None => 0,
    }
}

/// The classic CDDB disc ID checksum.
pub fn discid(toc: &Toc) -> u32 {
    let offsets = frame_offsets(toc);
    let Some(&first) = offsets.first() else {
        return 0;
    };

    let sum: u32 = offsets.iter().map(|&fo| digit_sum(fo / SECTORS_PER_SECOND)).sum();
    let length = disc_length_secs(toc);
    let first_secs = first / SECTORS_PER_SECOND;

    ((sum % 0xff) << 24) | ((length - first_secs) << 8) | (toc.tracks.len() as u32)
}

// ---- query ---------------------------------------------------------------

/// A `category discid dtitle...` line, the shape of both a single `200`
/// match and each line of a `210`/`211` list.
fn parse_match_line(line: &str) -> Option<CddbMatch> {
    let mut parts = line.trim().splitn(3, ' ');
    let category = parts.next()?.to_string();
    let discid = u32::from_str_radix(parts.next()?, 16).ok()?;
    Some(CddbMatch { category, discid })
}

/// The `200` (exact match) / `210`/`211` (list, terminated by a lone `.`) /
/// `202` (no match) query responses. Multiple candidates are never
/// disambiguated in the UI — the first one wins, same as the TOC-only
/// listing it enriches; a wrong match is no worse than today's placeholder.
fn parse_query_response(body: &str) -> Option<CddbMatch> {
    let mut lines = body.lines();
    let first = lines.next()?.trim();
    let (code, rest) = first.split_once(' ')?;

    match code {
        "200" => parse_match_line(rest),
        "210" | "211" => lines
            .map(str::trim)
            .take_while(|l| *l != ".")
            .find_map(parse_match_line),
        _ => None, // "202 No match found", or any error code
    }
}

// ---- read ------------------------------------------------------------------

/// The `210` disc-details response: `DTITLE=Artist / Album` plus one
/// `TTITLEn=...` line per track, terminated by a lone `.`.
fn parse_read_response(body: &str) -> Option<CddbDisc> {
    let mut lines = body.lines();
    let status = lines.next()?.trim();
    if status.split(' ').next() != Some("210") {
        return None; // not found, or a server-side error — nothing to extract
    }

    let mut artist = None;
    let mut album = None;
    let mut titles: Vec<(usize, String)> = Vec::new();

    for line in lines.map(str::trim).take_while(|l| *l != ".") {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }

        if key == "DTITLE" {
            match value.split_once(" / ") {
                Some((a, b)) => {
                    artist = Some(a.trim().to_string());
                    album = Some(b.trim().to_string());
                }
                None => album = Some(value.to_string()),
            }
        } else if let Some(idx) = key.strip_prefix("TTITLE").and_then(|n| n.parse().ok()) {
            titles.push((idx, value.to_string()));
        }
    }

    titles.sort_by_key(|(idx, _)| *idx);
    Some(CddbDisc {
        artist,
        album,
        track_titles: titles.into_iter().map(|(_, t)| t).collect(),
    })
}

// ---- network ---------------------------------------------------------------

/// One `\r\n`- or `\n`-terminated line, terminator included — callers
/// reassemble responses as plain text and hand them to the same
/// `parse_query_response`/`parse_read_response` that operate on a complete
/// reply, rather than parsing line-by-line while reading.
fn read_line(reader: &mut BufReader<&TcpStream>) -> Result<String, String> {
    let mut line = String::new();
    let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("the server closed the connection".into());
    }
    Ok(line)
}

/// A full server reply: the status line, plus — only for the codes that mean
/// "list follows" (`210`/`211`) — every line after it up to and including the
/// lone `.` that ends it. Every other status (`200`, `202`, `401`, …) is a
/// single line in this protocol.
fn read_response(reader: &mut BufReader<&TcpStream>) -> Result<String, String> {
    let first = read_line(reader)?;
    let code = first.split(' ').next().unwrap_or("");

    if !matches!(code, "210" | "211") {
        return Ok(first);
    }

    let mut body = first;
    loop {
        let line = read_line(reader)?;
        let done = line.trim_end() == ".";
        body.push_str(&line);
        if done {
            break;
        }
    }
    Ok(body)
}

fn send(writer: &mut &TcpStream, command: &str) -> Result<(), String> {
    write!(writer, "{command}\r\n").map_err(|e| e.to_string())
}

/// Look up a disc's metadata over one CDDBP connection: the mandatory
/// `hello` handshake, then `query` to find a candidate, then `read` for its
/// full details. `None` covers every failure mode alike — unreachable, no
/// match, a malformed response, a timeout — since there is nothing more
/// specific a caller could usefully do with any of them; the TOC-only
/// placeholder listing is always a fine fallback.
pub fn lookup(toc: &Toc) -> Option<CdMetadata> {
    if toc.tracks.is_empty() {
        return None;
    }

    let offsets = frame_offsets(toc);
    let length = disc_length_secs(toc);
    let id = discid(toc);
    let offsets_str = offsets.iter().map(u32::to_string).collect::<Vec<_>>().join(" ");

    let addr = SERVER_ADDR.to_socket_addrs().ok()?.next()?;
    let stream = TcpStream::connect_timeout(&addr, TIMEOUT).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok();
    stream.set_write_timeout(Some(TIMEOUT)).ok();

    let mut writer = &stream;
    let mut reader = BufReader::new(&stream);

    read_line(&mut reader).ok()?; // the greeting banner; nothing to act on

    send(&mut writer, &format!("cddb hello {HELLO}")).ok()?;
    read_line(&mut reader).ok()?; // the handshake's own "200 ..." reply

    send(&mut writer, &format!("cddb query {id:08x} {} {offsets_str} {length}", offsets.len())).ok()?;
    let found = parse_query_response(&read_response(&mut reader).ok()?)?;

    send(&mut writer, &format!("cddb read {} {:08x}", found.category, found.discid)).ok()?;
    let disc = parse_read_response(&read_response(&mut reader).ok()?)?;

    Some(CdMetadata {
        artist: disc.artist,
        album: disc.album,
        track_titles: disc.track_titles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdda::CdTrack;

    /// A real disc's frame offsets (from the CDDB reference tooling's own
    /// documented example), with the disc ID verified independently by
    /// compiling a tiny harness against the actual installed `libcddb.so`
    /// and calling its real `cddb_disc_calc_discid()` — the documented
    /// example ID turned out to be a stale typo, so this is the value that
    /// library itself actually produces, not the one in its docs.
    fn known_toc() -> Toc {
        let starts = [
            150u32, 28_690, 51_102, 75_910, 102_682, 121_522, 149_040, 175_772, 204_387, 231_145,
            268_065,
        ];
        let mut tracks: Vec<CdTrack> = starts
            .iter()
            .enumerate()
            .map(|(i, &fo)| CdTrack {
                track_no: i as u32 + 1,
                start_lba: fo - 150,
                end_lba: 0, // filled in below except for the last track
                duration: 0.0,
            })
            .collect();

        for i in 0..tracks.len() - 1 {
            tracks[i].end_lba = tracks[i + 1].start_lba;
        }
        // Disc length is 3822s; end_lba of the last track is whatever makes
        // `disc_length_secs` land there: (end_lba + 150) / 75 == 3822.
        let last = tracks.len() - 1;
        tracks[last].end_lba = 3822 * SECTORS_PER_SECOND - 150;

        Toc { tracks }
    }

    #[test]
    fn computes_the_known_discid() {
        assert_eq!(discid(&known_toc()), 0x920eec0b);
    }

    #[test]
    fn frame_offsets_add_the_150_frame_pregap() {
        assert_eq!(frame_offsets(&known_toc())[0], 150);
    }

    #[test]
    fn disc_length_matches_the_known_value() {
        assert_eq!(disc_length_secs(&known_toc()), 3822);
    }

    #[test]
    fn parses_a_single_exact_match() {
        let body = "200 rock a00b640b Artist / Album\r\n";
        let m = parse_query_response(body).unwrap();
        assert_eq!(m.category, "rock");
        assert_eq!(m.discid, 0xa00b640b);
    }

    #[test]
    fn parses_the_first_of_several_inexact_matches() {
        let body = "211 Found inexact matches, list follows (until terminating `.`)\r\n\
                     rock a00b640b Artist / Album\r\n\
                     misc a00b640c Other / Thing\r\n\
                     .\r\n";
        let m = parse_query_response(body).unwrap();
        assert_eq!(m.category, "rock");
        assert_eq!(m.discid, 0xa00b640b);
    }

    #[test]
    fn no_match_yields_nothing() {
        assert!(parse_query_response("202 No match found\r\n").is_none());
    }

    #[test]
    fn parses_artist_album_and_track_titles() {
        let body = "210 rock a00b640b CD database entry follows\r\n\
                     DTITLE=Fleetwood Mac / Rumours\r\n\
                     DYEAR=1977\r\n\
                     TTITLE0=Second Hand News\r\n\
                     TTITLE1=Dreams\r\n\
                     EXTD=\r\n\
                     .\r\n";
        let disc = parse_read_response(body).unwrap();
        assert_eq!(disc.artist.as_deref(), Some("Fleetwood Mac"));
        assert_eq!(disc.album.as_deref(), Some("Rumours"));
        assert_eq!(disc.track_titles, vec!["Second Hand News", "Dreams"]);
    }

    #[test]
    fn a_non_success_read_status_yields_nothing() {
        assert!(parse_read_response("401 No such CD entry\r\n.\r\n").is_none());
    }
}
