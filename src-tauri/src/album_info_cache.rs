//! A small on-disk cache of resolved album info, shared by both CD and
//! local-file lookups, keyed by whatever the caller treats as a release's
//! identity — a CD's disc ID as 8 lowercase hex digits, or (for a local
//! file) its embedded MusicBrainz Release ID, or a `artist|album` fallback.
//!
//! Same reasoning as `cddb_cache`: MusicBrainz and the Cover Art Archive are
//! shared public services, not infrastructure this project runs, and a
//! release's info never changes — so a lookup already made (hit or miss)
//! must not be repeated on every rescan or replay.
//!
//! The cached art is a path to the image file `musicbrainz` already saved to
//! disk, not the image bytes themselves — this file just remembers where
//! that is (or that there is none).

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::musicbrainz::AlbumInfo;

type Entries = HashMap<String, Option<AlbumInfo>>;

fn load(path: &Path) -> Entries {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// `None` means "not cached" — go look it up. `Some(None)` means "cached as
/// a known miss", which is itself a reason not to ask again.
pub fn get(path: &Path, key: &str) -> Option<Option<AlbumInfo>> {
    load(path).remove(key)
}

pub fn put(path: &Path, key: &str, value: Option<&AlbumInfo>) {
    let mut entries = load(path);
    entries.insert(key.to_string(), value.cloned());

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = fs::write(path, json);
    }
}

/// Drop every cached lookup and the image files they point to. A missing
/// file or directory is not an error — there was nothing cached either way,
/// which is the state this is trying to reach.
pub fn clear(path: &Path, images_dir: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_dir_all(images_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("scry-album-info-cache-{}.json", uuid::Uuid::new_v4()))
    }

    fn info() -> AlbumInfo {
        AlbumInfo {
            art: Some("/cache/album_art/920eec0b.jpg".to_string()),
            country: Some("GB".to_string()),
            date: Some("2010-05-10".to_string()),
            asin: Some("B003D7F33Q".to_string()),
            track_count: Some(11),
            release_url: Some("https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67".to_string()),
            toc_url: Some("https://musicbrainz.org/cdtoc/F5gDrr2p.IMUvUxfNSc884xb.pc-".to_string()),
        }
    }

    #[test]
    fn an_unseen_key_is_not_cached() {
        let path = temp_path();
        assert_eq!(get(&path, "920eec0b"), None);
    }

    #[test]
    fn round_trips_a_hit() {
        let path = temp_path();
        put(&path, "920eec0b", Some(&info()));

        assert_eq!(get(&path, "920eec0b"), Some(Some(info())));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trips_a_musicbrainz_release_id_key() {
        let path = temp_path();
        let key = "507b4cda-bebd-468e-a1fc-f8873f162f67";
        put(&path, key, Some(&info()));

        assert_eq!(get(&path, key), Some(Some(info())));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn remembers_a_miss_distinctly_from_not_having_looked() {
        let path = temp_path();
        put(&path, "12345678", None);

        assert_eq!(get(&path, "12345678"), Some(None), "a known miss, not 'go ask again'");
        assert_eq!(get(&path, "deadbeef"), None, "a different key was never cached at all");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn clear_forgets_the_index_and_deletes_the_images_dir() {
        let path = temp_path();
        let images_dir = std::env::temp_dir().join(format!("scry-art-images-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&images_dir).unwrap();
        std::fs::write(images_dir.join("920eec0b.jpg"), b"fake").unwrap();
        put(&path, "920eec0b", Some(&info()));

        clear(&path, &images_dir);

        assert_eq!(get(&path, "920eec0b"), None, "back to never having looked");
        assert!(!images_dir.exists());
    }

    #[test]
    fn clearing_an_already_absent_cache_is_not_an_error() {
        clear(&temp_path(), &std::env::temp_dir().join(format!("scry-nope-{}", uuid::Uuid::new_v4())));
    }
}
