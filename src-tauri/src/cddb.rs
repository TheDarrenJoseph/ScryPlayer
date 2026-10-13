//! GnuDB (classic CDDB protocol, over HTTP) disc-metadata lookup.
//!
//! Deliberately free of `tauri` types, same as `cdda.rs`/`media.rs`: the disc
//! ID checksum, URL building and response parsing are pure functions and
//! unit-testable without a network. Only `get` touches the network, and only
//! `lookup` ties the two requests (`query` then `read`) together.
//!
//! A Red Book audio CD carries no text metadata at all — this is purely a
//! lookup against GnuDB's database, keyed by a checksum of the disc's TOC.
//! Doing this from Rust rather than the frontend is deliberate: GnuDB's CGI
//! gateway predates CORS and sends none of the headers a WebView `fetch()`
//! would need, so a frontend request would simply be blocked.

use crate::cdda::{Toc, SECTORS_PER_SECOND};

const SERVER: &str = "http://gnudb.gnudb.org/~cddb/cddb.cgi";
/// The CDDB "hello" identity sent with every request. Generic on purpose —
/// nothing in the protocol needs it to name the real machine or user.
const HELLO: &str = "scryplayer+localhost+ScryPlayer";

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

fn query_url(discid: u32, offsets: &[u32], length: u32) -> String {
    let offsets_str = offsets.iter().map(|o| o.to_string()).collect::<Vec<_>>().join("+");
    format!(
        "{SERVER}?cmd=cddb+query+{discid:08x}+{}+{offsets_str}+{length}&hello={HELLO}+{}&proto=6",
        offsets.len(),
        env!("CARGO_PKG_VERSION"),
    )
}

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

fn read_url(category: &str, discid: u32) -> String {
    format!(
        "{SERVER}?cmd=cddb+read+{category}+{discid:08x}&hello={HELLO}+{}&proto=6",
        env!("CARGO_PKG_VERSION"),
    )
}

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

fn get(url: &str) -> Result<String, String> {
    ureq::get(url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Look up a disc's metadata: `query` to find a candidate, then `read` for
/// its full details. `None` covers every failure mode alike — offline, no
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

    let found = parse_query_response(&get(&query_url(id, &offsets, length)).ok()?)?;
    let disc = parse_read_response(&get(&read_url(&found.category, found.discid)).ok()?)?;

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

    #[test]
    fn query_url_puts_offsets_and_length_in_the_right_order() {
        let url = query_url(0x920ef00b, &[150, 28_690], 3822);
        assert!(url.contains("cmd=cddb+query+920ef00b+2+150+28690+3822"));
        assert!(url.starts_with(SERVER));
    }

    #[test]
    fn read_url_names_the_category_and_discid() {
        let url = read_url("rock", 0x920ef00b);
        assert!(url.contains("cmd=cddb+read+rock+920ef00b"));
    }
}
