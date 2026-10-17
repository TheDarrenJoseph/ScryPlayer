//! A small on-disk cache of resolved CD cover-art files, keyed by disc ID.
//!
//! Same reasoning as `cddb_cache`: MusicBrainz and the Cover Art Archive are
//! shared public services, not infrastructure this project runs, and a
//! disc's cover never changes once released — so a lookup already made
//! (hit or miss) must not be repeated on every rescan.
//!
//! The cached value is a path to the image file `musicbrainz::fetch_cover_art`
//! already saved to disk, not the image bytes themselves — this file just
//! remembers where that is (or that there is none).

use std::collections::HashMap;
use std::fs;
use std::path::Path;

type Entries = HashMap<String, Option<String>>;

fn key(discid: u32) -> String {
    format!("{discid:08x}")
}

fn load(path: &Path) -> Entries {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// `None` means "not cached" — go look it up. `Some(None)` means "cached as
/// a known miss", which is itself a reason not to ask again.
pub fn get(path: &Path, discid: u32) -> Option<Option<String>> {
    load(path).remove(&key(discid))
}

pub fn put(path: &Path, discid: u32, value: Option<&str>) {
    let mut entries = load(path);
    entries.insert(key(discid), value.map(str::to_string));

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
        std::env::temp_dir().join(format!("scry-art-cache-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn an_unseen_discid_is_not_cached() {
        let path = temp_path();
        assert_eq!(get(&path, 0x920eec0b), None);
    }

    #[test]
    fn round_trips_a_hit() {
        let path = temp_path();
        put(&path, 0x920eec0b, Some("/cache/album_art/920eec0b.jpg"));

        assert_eq!(
            get(&path, 0x920eec0b),
            Some(Some("/cache/album_art/920eec0b.jpg".to_string())),
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn remembers_a_miss_distinctly_from_not_having_looked() {
        let path = temp_path();
        put(&path, 0x12345678, None);

        assert_eq!(get(&path, 0x12345678), Some(None), "a known miss, not 'go ask again'");
        assert_eq!(get(&path, 0xdeadbeef), None, "a different disc was never cached at all");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn clear_forgets_the_index_and_deletes_the_images_dir() {
        let path = temp_path();
        let images_dir = std::env::temp_dir().join(format!("scry-art-images-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&images_dir).unwrap();
        std::fs::write(images_dir.join("920eec0b.jpg"), b"fake").unwrap();
        put(&path, 0x920eec0b, Some(images_dir.join("920eec0b.jpg").to_str().unwrap()));

        clear(&path, &images_dir);

        assert_eq!(get(&path, 0x920eec0b), None, "back to never having looked");
        assert!(!images_dir.exists());
    }

    #[test]
    fn clearing_an_already_absent_cache_is_not_an_error() {
        clear(&temp_path(), &std::env::temp_dir().join(format!("scry-nope-{}", uuid::Uuid::new_v4())));
    }
}
