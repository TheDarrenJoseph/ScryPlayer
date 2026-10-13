//! A small on-disk cache for GnuDB lookups, keyed by disc ID.
//!
//! GnuDB is a shared public server, not infrastructure this project runs, so
//! a disc that has already been looked up — this session or a previous one —
//! should never be looked up again. A disc's metadata cannot change once
//! submitted, so unlike most caches this one needs no expiry: a hit is good
//! forever, including a cached *miss* ("GnuDB has nothing for this disc"),
//! which would otherwise re-ask on every single rescan of an unlisted disc.
//!
//! Deliberately simple: the whole (small — a personal CD collection, not a
//! library) cache is one JSON file, read fully on `get` and rewritten fully
//! on `put`. Lookups are a few per session at most, driven by a button
//! click, so this is nowhere near a path worth optimizing.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::cddb::CdMetadata;

type Entries = HashMap<String, Option<CdMetadata>>;

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
pub fn get(path: &Path, discid: u32) -> Option<Option<CdMetadata>> {
    load(path).remove(&key(discid))
}

pub fn put(path: &Path, discid: u32, value: Option<&CdMetadata>) {
    let mut entries = load(path);
    entries.insert(key(discid), value.cloned());

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = fs::write(path, json);
    }
}

/// Drop every cached lookup. A missing file is not an error — there was
/// nothing cached either way, which is the state this is trying to reach.
pub fn clear(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("scry-cddb-cache-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn an_unseen_discid_is_not_cached() {
        let path = temp_path();
        assert_eq!(get(&path, 0x920eec0b), None);
    }

    #[test]
    fn round_trips_a_hit() {
        let path = temp_path();
        let meta = CdMetadata {
            artist: Some("Massive Attack".into()),
            album: Some("Mezzanine".into()),
            track_titles: vec!["Angel".into()],
        };

        put(&path, 0x920eec0b, Some(&meta));
        let got = get(&path, 0x920eec0b).unwrap().unwrap();

        assert_eq!(got.artist.as_deref(), Some("Massive Attack"));
        assert_eq!(got.track_titles, vec!["Angel"]);
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
    fn keeps_separate_discs_separate() {
        let path = temp_path();
        let a = CdMetadata { artist: Some("A".into()), album: None, track_titles: vec![] };
        let b = CdMetadata { artist: Some("B".into()), album: None, track_titles: vec![] };

        put(&path, 1, Some(&a));
        put(&path, 2, Some(&b));

        assert_eq!(get(&path, 1).unwrap().unwrap().artist.as_deref(), Some("A"));
        assert_eq!(get(&path, 2).unwrap().unwrap().artist.as_deref(), Some("B"));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn clear_forgets_everything() {
        let path = temp_path();
        let meta = CdMetadata { artist: Some("A".into()), album: None, track_titles: vec![] };
        put(&path, 1, Some(&meta));

        clear(&path);

        assert_eq!(get(&path, 1), None, "back to never having looked");
    }

    #[test]
    fn clearing_an_already_absent_cache_is_not_an_error() {
        clear(&temp_path()); // must not panic
    }
}
