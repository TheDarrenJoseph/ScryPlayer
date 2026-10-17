//! Album info and front cover art, via MusicBrainz and the Cover Art
//! Archive, for both a CD (`fetch_album_info`) and a local file
//! (`fetch_local_album_info`).
//!
//! Both share one rule: country/date/ASIN/the release link are only ever
//! populated from an *exact* match, never a guess — for a CD that means
//! MusicBrainz's own disc-ID (a SHA-1 hash of the TOC, unrelated to the
//! CDDB checksum `cddb::discid` computes), for a local file it means the
//! file's own embedded MusicBrainz Release ID tag (written by taggers like
//! Picard). An artist/album text search is used only as a cover-art
//! fallback when neither is available, since an approximate image is still
//! better than none, but nothing from a text match is trustworthy enough to
//! show as fact.

use std::fs;
use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::cdda::Toc;
use crate::cddb::frame_offsets;

/// MusicBrainz asks every client to identify itself with an application
/// name, version and a way to reach the maintainer.
const USER_AGENT: &str = concat!(
    "ScryPlayer/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/TheDarrenJoseph/ScryPlayer )"
);

/// What an album info dialog needs — `art` is a local cached file path (not
/// a remote URL), the rest are only ever set from an exact match (see the
/// module doc comment). `track_count` is only populated for a local file,
/// which has no TOC of its own to count from the way a CD does — the
/// frontend already has a ground-truth count for a CD from its own scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumInfo {
    pub art: Option<String>,
    pub country: Option<String>,
    pub date: Option<String>,
    pub asin: Option<String>,
    pub track_count: Option<u32>,
    pub release_url: Option<String>,
    pub toc_url: Option<String>,
}

/// MusicBrainz's own disc-ID: a fixed-width ASCII string — first track (2
/// hex digits), track count (2 hex digits), lead-out sector (8 hex digits),
/// then 99 track-offset slots (8 hex digits each, zero-padded past the
/// disc's real track count) — SHA-1 hashed and base64-encoded with `+/=`
/// swapped for `._-` so the result is URL-safe.
///
/// Verified against a disc MusicBrainz actually has on file: Foals' "Total
/// Life Forever" (UK CD) hashes to exactly
/// `F5gDrr2p.IMUvUxfNSc884xb.pc-` — see the test below.
pub fn disc_id(toc: &Toc) -> Option<String> {
    let offsets = frame_offsets(toc);
    let leadout = toc.tracks.last()?.end_lba + 150;

    let mut input = format!("{:02X}{:02X}{:08X}", 1u32, offsets.len(), leadout);
    for i in 0..99 {
        input.push_str(&format!("{:08X}", offsets.get(i).copied().unwrap_or(0)));
    }

    let digest = Sha1::digest(input.as_bytes());
    Some(STANDARD.encode(digest).replace('+', ".").replace('/', "_").replace('=', "-"))
}

#[derive(Deserialize)]
struct DiscIdResponse {
    releases: Vec<DiscIdRelease>,
}

#[derive(Deserialize)]
struct DiscIdRelease {
    id: String,
    date: Option<String>,
    country: Option<String>,
    asin: Option<String>,
    /// Only its length is used — how many media (discs) a release bundles —
    /// so the shape of each entry doesn't matter here.
    #[serde(default)]
    media: Vec<serde_json::Value>,
}

/// Every release MusicBrainz has filed under this exact disc ID — the same
/// TOC can be shared by several regional pressings or reissues.
fn releases_for_disc(mb_disc_id: &str) -> Option<Vec<DiscIdRelease>> {
    let url = format!("https://musicbrainz.org/ws/2/discid/{mb_disc_id}?fmt=json");
    let body = ureq::get(&url).set("User-Agent", USER_AGENT).call().ok()?.into_string().ok()?;
    let parsed: DiscIdResponse = serde_json::from_str(&body).ok()?;
    (!parsed.releases.is_empty()).then_some(parsed.releases)
}

/// Among several pressings sharing one TOC, prefer the plainest: fewest
/// media (a single CD over a deluxe edition with a bonus disc), and among
/// ties, the earliest release date — usually the original edition rather
/// than a later reissue.
fn pick_release(releases: Vec<DiscIdRelease>) -> Option<DiscIdRelease> {
    releases
        .into_iter()
        .min_by_key(|r| (r.media.len(), r.date.clone().unwrap_or_else(|| "9999".to_string())))
}

/// Lucene, which MusicBrainz's search query uses, treats `"` and `\` as
/// syntax; an artist or album containing either needs them escaped so the
/// query still parses as one quoted phrase.
fn escape_lucene(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// A text search for the release, used only as a cover-art fallback when
/// the disc has no exact disc-ID match — approximate, since nothing here
/// confirms it's actually this pressing.
fn find_release_id_by_text(artist: &str, album: &str) -> Option<String> {
    let query = format!(
        "artist:\"{}\" AND release:\"{}\"",
        escape_lucene(artist),
        escape_lucene(album)
    );
    let url = format!(
        "https://musicbrainz.org/ws/2/release/?query={}&fmt=json&limit=1",
        utf8_percent_encode(&query, NON_ALPHANUMERIC)
    );

    #[derive(Deserialize)]
    struct ReleaseSearch {
        releases: Vec<SearchResult>,
    }
    #[derive(Deserialize)]
    struct SearchResult {
        id: String,
    }

    let body = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .call()
        .ok()?
        .into_string()
        .ok()?;

    let parsed: ReleaseSearch = serde_json::from_str(&body).ok()?;
    parsed.releases.into_iter().next().map(|r| r.id)
}

#[derive(Deserialize)]
struct CoverArt {
    images: Vec<CoverImage>,
}

#[derive(Deserialize)]
struct CoverImage {
    front: bool,
    image: String,
    thumbnails: Thumbnails,
}

#[derive(Deserialize)]
struct Thumbnails {
    large: Option<String>,
}

/// The front image's URL for a release, preferring the archive's own
/// "large" thumbnail over the (often much bigger) original scan.
fn front_image_url(release_id: &str) -> Option<String> {
    let url = format!("https://coverartarchive.org/release/{release_id}");

    let body = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .call()
        .ok()?
        .into_string()
        .ok()?;

    let parsed: CoverArt = serde_json::from_str(&body).ok()?;
    let mut images = parsed.images;
    if images.is_empty() {
        return None;
    }
    let front = images.iter().position(|img| img.front).unwrap_or(0);
    let image = images.remove(front);
    Some(image.thumbnails.large.unwrap_or(image.image))
}

fn extension_from_url(url: &str) -> &'static str {
    if url.to_ascii_lowercase().ends_with(".png") {
        "png"
    } else {
        "jpg"
    }
}

/// A filesystem-safe, deterministic stem for a string that isn't already
/// one (a CD's hex disc ID and a MusicBrainz release ID both already are) —
/// the `artist|album` text-search fallback key, for instance, which may
/// contain characters a path cannot.
fn hex_digest(s: &str) -> String {
    use std::fmt::Write;
    Sha1::digest(s.as_bytes()).iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// Download `image_url` into `dir` as `<file_stem>.<ext>`, returning that
/// file's path.
fn download_cover(image_url: &str, dir: &Path, file_stem: &str) -> Option<String> {
    let response = ureq::get(image_url).set("User-Agent", USER_AGENT).call().ok()?;
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes).ok()?;

    fs::create_dir_all(dir).ok()?;
    let file_path = dir.join(format!("{file_stem}.{}", extension_from_url(image_url)));
    fs::write(&file_path, &bytes).ok()?;

    Some(file_path.to_string_lossy().into_owned())
}

/// Resolve a disc's album info: country/date/links from an exact disc-ID
/// match when MusicBrainz has one on file, plus cover art — from that same
/// matched release when possible, or from a text search on `artist`/`album`
/// when the disc isn't in MusicBrainz's disc-ID database at all. `None` —
/// never a hard error — when nothing at all came back: no disc-ID match, no
/// text match, no cover art, or any network failure along the way.
pub fn fetch_album_info(toc: &Toc, artist: &str, album: &str, dir: &Path, discid: u32) -> Option<AlbumInfo> {
    let mb_disc_id = disc_id(toc);
    let release = mb_disc_id.as_deref().and_then(releases_for_disc).and_then(pick_release);

    let (release_id, country, date, asin, toc_url) = match (release, &mb_disc_id) {
        (Some(r), Some(id)) => (
            Some(r.id),
            r.country,
            r.date,
            r.asin,
            Some(format!("https://musicbrainz.org/cdtoc/{id}")),
        ),
        _ => (None, None, None, None, None),
    };

    let art_release_id = release_id.clone().or_else(|| find_release_id_by_text(artist, album));
    let art = art_release_id
        .as_deref()
        .and_then(front_image_url)
        .and_then(|url| download_cover(&url, dir, &format!("{discid:08x}")));

    let release_url = release_id.map(|id| format!("https://musicbrainz.org/release/{id}"));

    (art.is_some() || country.is_some() || date.is_some() || release_url.is_some())
        .then_some(AlbumInfo { art, country, date, asin, track_count: None, release_url, toc_url })
}

#[derive(Deserialize)]
struct ReleaseLookup {
    id: String,
    date: Option<String>,
    country: Option<String>,
    asin: Option<String>,
    #[serde(default)]
    media: Vec<ReleaseMedium>,
}

#[derive(Deserialize)]
struct ReleaseMedium {
    #[serde(rename = "track-count")]
    track_count: Option<u32>,
}

/// A release looked up directly by its MusicBrainz ID — an exact match by
/// construction, unlike `find_release_id_by_text`. `inc=media` is what gets
/// `track-count` into the response at all; without it, `media` is absent.
fn lookup_release_by_id(release_id: &str) -> Option<ReleaseLookup> {
    let url = format!("https://musicbrainz.org/ws/2/release/{release_id}?fmt=json&inc=media");
    let body = ureq::get(&url).set("User-Agent", USER_AGENT).call().ok()?.into_string().ok()?;
    serde_json::from_str(&body).ok()
}

/// Summed across every medium — a release can bundle more than one disc —
/// `None` rather than `Some(0)` when there is nothing to report, so the
/// frontend's "N tracks" has a plain presence check to work with.
fn total_track_count(media: &[ReleaseMedium]) -> Option<u32> {
    let total: u32 = media.iter().filter_map(|m| m.track_count).sum();
    (total > 0).then_some(total)
}

/// Resolve album info for a local file: country/date/ASIN/the release link
/// from an exact match when the file carries its own MusicBrainz Release ID
/// tag, plus cover art — from that same release when possible, or from a
/// text search on `artist`/`album` when the file has no such tag. `cache_key`
/// is whatever the caller is using to dedupe this lookup (the release ID
/// when there is one, an `artist|album` string otherwise) and only matters
/// here for naming the downloaded image file when there's no release ID to
/// name it by instead. `None` — never a hard error — when nothing at all
/// came back, same contract as `fetch_album_info`.
pub fn fetch_local_album_info(
    release_id: Option<&str>,
    artist: &str,
    album: &str,
    dir: &Path,
    cache_key: &str,
) -> Option<AlbumInfo> {
    let release = release_id.and_then(lookup_release_by_id);

    let (release_id, country, date, asin, track_count) = match release {
        Some(r) => (Some(r.id), r.country, r.date, r.asin, total_track_count(&r.media)),
        None => (None, None, None, None, None),
    };

    let art_release_id = release_id.clone().or_else(|| find_release_id_by_text(artist, album));
    let art_stem = release_id.clone().unwrap_or_else(|| hex_digest(cache_key));
    let art = art_release_id
        .as_deref()
        .and_then(front_image_url)
        .and_then(|url| download_cover(&url, dir, &art_stem));

    let release_url = release_id.map(|id| format!("https://musicbrainz.org/release/{id}"));

    (art.is_some() || country.is_some() || date.is_some() || release_url.is_some())
        .then_some(AlbumInfo { art, country, date, asin, track_count, release_url, toc_url: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdda::TocTrack;

    /// Foals – "Total Life Forever" (UK CD, jewel case):
    /// https://musicbrainz.org/cdtoc/F5gDrr2p.IMUvUxfNSc884xb.pc-
    fn foals_toc() -> Toc {
        let starts = [150, 23917, 40580, 55445, 84420, 115137, 133345, 136975, 164622, 182642, 206305];
        let leadout = 227100;

        let tracks = starts
            .iter()
            .enumerate()
            .map(|(i, &start)| {
                let end = starts.get(i + 1).copied().unwrap_or(leadout);
                TocTrack {
                    track_no: i as u32 + 1,
                    start_lba: start - 150,
                    end_lba: end - 150,
                    duration: 0.0,
                }
            })
            .collect();

        Toc { tracks }
    }

    #[test]
    fn computes_the_known_musicbrainz_discid() {
        assert_eq!(disc_id(&foals_toc()).as_deref(), Some("F5gDrr2p.IMUvUxfNSc884xb.pc-"));
    }

    #[test]
    fn escapes_quotes_and_backslashes_for_lucene() {
        assert_eq!(escape_lucene(r#"Guns N\" Roses"#), r#"Guns N\\\" Roses"#);
        assert_eq!(escape_lucene("Simple Minds"), "Simple Minds");
    }

    #[test]
    fn total_track_count_sums_across_media() {
        let media = vec![ReleaseMedium { track_count: Some(11) }, ReleaseMedium { track_count: Some(15) }];
        assert_eq!(total_track_count(&media), Some(26));
    }

    #[test]
    fn total_track_count_is_none_rather_than_zero_when_nothing_is_known() {
        assert_eq!(total_track_count(&[]), None);
        assert_eq!(total_track_count(&[ReleaseMedium { track_count: None }]), None);
    }

    #[test]
    fn hex_digest_is_deterministic_and_filesystem_safe() {
        let a = hex_digest("massive attack|mezzanine");
        let b = hex_digest("massive attack|mezzanine");
        let c = hex_digest("foals|total life forever");

        assert_eq!(a, b, "the same key always hashes the same");
        assert_ne!(a, c, "different keys do not collide");
        assert_eq!(a.len(), 40, "a SHA-1 digest is 20 bytes, 2 hex chars each");
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()), "safe in any filename: {a}");
    }

    #[test]
    fn picks_png_or_jpg_by_the_url_suffix() {
        assert_eq!(extension_from_url("https://example.org/foo.png"), "png");
        assert_eq!(extension_from_url("https://example.org/foo.PNG"), "png");
        assert_eq!(extension_from_url("https://example.org/foo.jpg"), "jpg");
        assert_eq!(extension_from_url("https://example.org/foo"), "jpg");
    }

    fn release(id: &str, date: Option<&str>, media_count: usize) -> DiscIdRelease {
        DiscIdRelease {
            id: id.to_string(),
            date: date.map(str::to_string),
            country: None,
            asin: None,
            media: vec![serde_json::Value::Null; media_count],
        }
    }

    #[test]
    fn prefers_the_release_with_fewer_discs() {
        let picked = pick_release(vec![
            release("deluxe", Some("2010-05-07"), 2),
            release("plain", Some("2010-05-10"), 1),
        ]);
        assert_eq!(picked.unwrap().id, "plain");
    }

    #[test]
    fn breaks_a_tie_on_fewest_discs_by_earliest_date() {
        let picked = pick_release(vec![
            release("us", Some("2010-06-15"), 1),
            release("gb", Some("2010-05-10"), 1),
        ]);
        assert_eq!(picked.unwrap().id, "gb");
    }
}
