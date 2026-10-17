//! Front cover art for a CD, via MusicBrainz and the Cover Art Archive.
//!
//! Neither service can be asked by the disc's CDDB checksum — MusicBrainz
//! has its own disc-ID scheme (a different hash this app does not compute),
//! so the lookup instead goes by the artist/album text GnuDB already
//! resolved: search MusicBrainz for the matching release, then ask the
//! Cover Art Archive for that release's front image.
//!
//! Both are plain HTTPS/JSON, reached straight from a blocking `ureq` call
//! rather than the WebView (which has no reason to be trusted with the raw
//! API responses, only the resolved image).

use std::fs;
use std::io::Read;
use std::path::Path;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;

/// MusicBrainz asks every client to identify itself with an application
/// name, version and a way to reach the maintainer.
const USER_AGENT: &str = concat!(
    "ScryPlayer/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/TheDarrenJoseph/ScryPlayer )"
);

#[derive(Deserialize)]
struct ReleaseSearch {
    releases: Vec<Release>,
}

#[derive(Deserialize)]
struct Release {
    id: String,
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

/// Lucene, which MusicBrainz's search query uses, treats `"` and `\` as
/// syntax; an artist or album containing either needs them escaped so the
/// query still parses as one quoted phrase.
fn escape_lucene(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn find_release_id(artist: &str, album: &str) -> Option<String> {
    let query = format!(
        "artist:\"{}\" AND release:\"{}\"",
        escape_lucene(artist),
        escape_lucene(album)
    );
    let url = format!(
        "https://musicbrainz.org/ws/2/release/?query={}&fmt=json&limit=1",
        utf8_percent_encode(&query, NON_ALPHANUMERIC)
    );

    let body = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .call()
        .ok()?
        .into_string()
        .ok()?;

    let parsed: ReleaseSearch = serde_json::from_str(&body).ok()?;
    parsed.releases.into_iter().next().map(|r| r.id)
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

/// Resolve `artist`/`album`'s front cover and save it into `dir` as
/// `<discid-hex>.<ext>`, returning that file's path. `None` — never a hard
/// error — covers no MusicBrainz match, no cover art for the match, and any
/// network failure along the way: a missing cover must not block anything
/// else about the disc.
pub fn fetch_cover_art(artist: &str, album: &str, dir: &Path, discid: u32) -> Option<String> {
    let release_id = find_release_id(artist, album)?;
    let image_url = front_image_url(&release_id)?;

    let response = ureq::get(&image_url).set("User-Agent", USER_AGENT).call().ok()?;
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes).ok()?;

    fs::create_dir_all(dir).ok()?;
    let file_path = dir.join(format!("{discid:08x}.{}", extension_from_url(&image_url)));
    fs::write(&file_path, &bytes).ok()?;

    Some(file_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_quotes_and_backslashes_for_lucene() {
        assert_eq!(escape_lucene(r#"Guns N\" Roses"#), r#"Guns N\\\" Roses"#);
        assert_eq!(escape_lucene("Simple Minds"), "Simple Minds");
    }

    #[test]
    fn picks_png_or_jpg_by_the_url_suffix() {
        assert_eq!(extension_from_url("https://example.org/foo.png"), "png");
        assert_eq!(extension_from_url("https://example.org/foo.PNG"), "png");
        assert_eq!(extension_from_url("https://example.org/foo.jpg"), "jpg");
        assert_eq!(extension_from_url("https://example.org/foo"), "jpg");
    }
}
