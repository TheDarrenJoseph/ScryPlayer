//! Filesystem walking and audio tag reading.

use std::path::{Path, PathBuf};

use lofty::prelude::*;
use serde::Serialize;

/// Extensions the WebView can actually decode in an `<audio>` element.
pub const PLAYABLE_EXTS: &[&str] = &[
    "mp3", "m4a", "m4b", "aac", "wav", "wave", "ogg", "oga", "opus", "flac", "webm", "mp4",
];

/// Audio we still list, but that the WebView will probably refuse to play.
const OTHER_AUDIO_EXTS: &[&str] = &["wma", "aiff", "aif", "ape", "wv", "mpc", "alac", "dsf"];

/// Extensions recognised for a folder-level cover image.
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png"];

/// Guard rails so a stray pick of `/` cannot hang the app.
const MAX_SCAN_DEPTH: usize = 12;
const MAX_SCAN_FILES: usize = 25_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_audio: bool,
    pub playable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Seconds. `None` when the file could not be parsed.
    pub duration: Option<f64>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub playable: bool,
    /// A sibling `cover.{jpg,jpeg,png}` in the track's own folder, if any.
    pub art: Option<String>,
    /// The file's own embedded MusicBrainz Release ID tag, if any — written
    /// by taggers like Picard, and an exact key for looking the release up.
    pub release_id: Option<String>,
}

fn ext_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_playable(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| PLAYABLE_EXTS.contains(&e.as_str()))
}

pub fn is_audio(path: &Path) -> bool {
    ext_lower(path).is_some_and(|e| {
        PLAYABLE_EXTS.contains(&e.as_str()) || OTHER_AUDIO_EXTS.contains(&e.as_str())
    })
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Look for a `cover.{jpg,jpeg,png}` sibling in `dir` — the de facto standard
/// for a folder's album art when a track has no embedded picture.
fn find_cover_image(dir: &Path) -> Option<PathBuf> {
    let read = std::fs::read_dir(dir).ok()?;
    read.flatten().find_map(|entry| {
        let path = entry.path();
        let stem = path.file_stem()?.to_str()?;
        let ext = ext_lower(&path)?;
        (stem.eq_ignore_ascii_case("cover") && COVER_EXTS.contains(&ext.as_str()))
            .then_some(path)
    })
}

fn to_string_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// List one directory: sub-directories plus audio files, hidden entries skipped.
pub fn list_dir(path: &Path) -> Result<DirListing, String> {
    let read = std::fs::read_dir(path).map_err(|e| format!("{}: {e}", path.display()))?;

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        // `file_type()` does not follow symlinks; resolve so linked folders still work.
        let Ok(meta) = entry.metadata() else { continue };
        let entry_path = entry.path();
        let is_dir = meta.is_dir();

        if !is_dir && !is_audio(&entry_path) {
            continue;
        }

        entries.push(DirEntryInfo {
            name,
            path: to_string_path(&entry_path),
            is_dir,
            is_audio: !is_dir,
            playable: !is_dir && is_playable(&entry_path),
        });
    }

    // Folders first, then files; both case-insensitive.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        path: to_string_path(path),
        parent: path.parent().map(to_string_path),
        entries,
    })
}

/// Read tags for one file. Never fails: an unreadable file still yields a Track
/// built from its filename, so a bad tag cannot drop a song from the queue.
pub fn read_track(path: &Path) -> Track {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| to_string_path(path));

    // Filename without extension, as the fallback title.
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.clone());

    let mut track = Track {
        path: to_string_path(path),
        file_name,
        title: stem,
        artist: None,
        album: None,
        duration: None,
        track_no: None,
        disc_no: None,
        playable: is_playable(path),
        art: path.parent().and_then(find_cover_image).map(|p| to_string_path(&p)),
        release_id: None,
    };

    let Ok(tagged) = lofty::read_from_path(path) else {
        return track;
    };

    let duration = tagged.properties().duration().as_secs_f64();
    if duration > 0.0 {
        track.duration = Some(duration);
    }

    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return track;
    };

    if let Some(title) = tag.title().map(|t| t.trim().to_string()) {
        if !title.is_empty() {
            track.title = title;
        }
    }
    track.artist = tag
        .artist()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    track.album = tag
        .album()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    track.track_no = tag.track();
    track.disc_no = tag.disk();
    track.release_id = tag
        .get_string(ItemKey::MusicBrainzReleaseId)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    track
}

/// Walk `root` collecting playable audio, breadth-first, with depth and count caps.
pub fn scan_dir(root: &Path, recursive: bool) -> Result<Vec<Track>, String> {
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }

    let mut files: Vec<PathBuf> = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = queue.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue; // Unreadable folder: skip rather than abort the whole scan.
        };

        for entry in read.flatten() {
            if files.len() >= MAX_SCAN_FILES {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let path = entry.path();

            if meta.is_dir() {
                if recursive && depth + 1 <= MAX_SCAN_DEPTH {
                    queue.push((path, depth + 1));
                }
            } else if is_audio(&path) {
                files.push(path);
            }
        }
    }

    let mut tracks: Vec<Track> = files.iter().map(|p| read_track(p)).collect();

    // Album order where tags allow it, filename order where they do not.
    tracks.sort_by(|a, b| {
        a.album
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b.album.as_deref().unwrap_or("").to_lowercase())
            .then_with(|| a.disc_no.unwrap_or(0).cmp(&b.disc_no.unwrap_or(0)))
            .then_with(|| a.track_no.unwrap_or(0).cmp(&b.track_no.unwrap_or(0)))
            .then_with(|| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()))
    });

    Ok(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_extensions() {
        assert!(is_playable(Path::new("/m/a.mp3")));
        assert!(is_playable(Path::new("/m/A.FLAC")));
        assert!(!is_playable(Path::new("/m/a.wma")));
        assert!(is_audio(Path::new("/m/a.wma")));
        assert!(!is_audio(Path::new("/m/cover.jpg")));
        assert!(!is_audio(Path::new("/m/noext")));
    }

    #[test]
    fn unreadable_file_still_yields_a_track() {
        let t = read_track(Path::new("/nope/Song Name.mp3"));
        assert_eq!(t.title, "Song Name");
        assert_eq!(t.duration, None);
        assert!(t.playable);
    }

    #[test]
    fn finds_cover_image_case_insensitively() {
        let dir = std::env::temp_dir().join(format!("scry-cover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cover.PNG"), b"fake").unwrap();
        std::fs::write(dir.join("song.mp3"), b"").unwrap();

        assert_eq!(find_cover_image(&dir), Some(dir.join("Cover.PNG")));

        let t = read_track(&dir.join("song.mp3"));
        assert_eq!(t.art, Some(dir.join("Cover.PNG").to_string_lossy().into_owned()));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_art_when_no_cover_image_present() {
        let dir = std::env::temp_dir().join(format!("scry-nocover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("song.mp3"), b"").unwrap();

        assert_eq!(find_cover_image(&dir), None);
        assert_eq!(read_track(&dir.join("song.mp3")).art, None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
