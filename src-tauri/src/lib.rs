mod album_info_cache;
mod cdda;
#[cfg(target_os = "linux")]
mod cdda_linux;
mod cddb;
mod cddb_cache;
mod media;
mod musicbrainz;
mod server;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use cdda::DriveInfo;
use media::{DirListing, Track};
use musicbrainz::AlbumInfo;
use server::MediaServer;

/// The set of files the frontend is allowed to read.
///
/// Audio is served over a loopback HTTP server rather than Tauri's asset
/// protocol — see `server.rs` for the measurements behind that. This scope is
/// what both the commands and that server check, and it keeps exactly the rule
/// the asset scope enforced: nothing is readable until the user picks it, one
/// folder or file at a time.
#[derive(Default)]
pub struct MediaScope {
    dirs: Mutex<Vec<PathBuf>>,
    files: Mutex<HashSet<PathBuf>>,
}

impl MediaScope {
    fn allow_dir(&self, path: &Path) {
        if let Ok(canonical) = path.canonicalize() {
            self.dirs.lock().unwrap().push(canonical);
        }
    }

    fn allow_file(&self, path: &Path) {
        if let Ok(canonical) = path.canonicalize() {
            self.files.lock().unwrap().insert(canonical);
        }
    }

    /// Both sides are canonicalised, so a symlinked library still resolves —
    /// the asset protocol compared a canonical request against literal
    /// patterns, which quietly broke exactly that case.
    fn is_allowed(&self, path: &Path) -> bool {
        let Ok(canonical) = path.canonicalize() else {
            return false;
        };

        if self.files.lock().unwrap().contains(&canonical) {
            return true;
        }

        self.dirs
            .lock()
            .unwrap()
            .iter()
            .any(|dir| canonical.starts_with(dir))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Shortcut {
    label: String,
    path: String,
}

fn to_string_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// Common starting points for the folder browser.
#[tauri::command]
fn shortcuts(app: AppHandle) -> Vec<Shortcut> {
    let resolver = app.path();
    let candidates: [(&str, Option<PathBuf>); 3] = [
        ("Home", resolver.home_dir().ok()),
        ("Music", resolver.audio_dir().ok()),
        ("Desktop", resolver.desktop_dir().ok()),
    ];

    candidates
        .into_iter()
        .filter_map(|(label, path)| {
            let path = path?;
            path.is_dir().then(|| Shortcut {
                label: label.to_string(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

/// List one folder. With no path, opens wherever the user's music usually lives.
#[tauri::command]
fn list_dir(app: AppHandle, path: Option<String>) -> Result<DirListing, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let resolver = app.path();
            resolver
                .audio_dir()
                .or_else(|_| resolver.home_dir())
                .map_err(|e| format!("No default folder available: {e}"))?
        }
    };

    media::list_dir(&target)
}

/// Read every audio file under `path` and allow the frontend to play them.
#[tauri::command]
fn scan_folder(app: AppHandle, path: String, recursive: bool) -> Result<Vec<Track>, String> {
    let root = PathBuf::from(path);
    app.state::<Arc<MediaScope>>().allow_dir(&root);
    media::scan_dir(&root, recursive)
}

/// Read tags for individually chosen files and allow each.
#[tauri::command]
fn load_tracks(app: AppHandle, paths: Vec<String>) -> Result<Vec<Track>, String> {
    let scope = app.state::<Arc<MediaScope>>();
    let mut tracks = Vec::with_capacity(paths.len());

    for raw in paths {
        let path = PathBuf::from(raw);
        scope.allow_file(&path);
        let track = media::read_track(&path);
        // `scan_folder` already covers a cover image via its directory-wide
        // allow; a track picked on its own needs its cover named explicitly.
        if let Some(art) = &track.art {
            scope.allow_file(Path::new(art));
        }
        tracks.push(track);
    }

    Ok(tracks)
}

/// Re-allow tracks restored from a previous session.
///
/// The scope lives in memory and dies with the process, so a restored queue
/// points at files this process has never been told about.
#[tauri::command]
fn grant_paths(app: AppHandle, paths: Vec<String>) {
    let scope = app.state::<Arc<MediaScope>>();
    for raw in paths {
        scope.allow_file(Path::new(&raw));
    }
}

/// The loopback URL the media element should play this track from.
#[tauri::command]
fn media_url(app: AppHandle, path: String) -> Result<String, String> {
    if !app.state::<Arc<MediaScope>>().is_allowed(Path::new(&path)) {
        return Err("That file is outside the folders you have opened.".into());
    }

    let server = app.state::<MediaServer>();
    Ok(format!(
        "http://127.0.0.1:{}/media?token={}&path={}",
        server.port,
        server.token,
        utf8_percent_encode(&path, NON_ALPHANUMERIC)
    ))
}

/// The loopback URL for a track's folder cover image, as found by `media::read_track`.
#[tauri::command]
fn art_url(app: AppHandle, path: String) -> Result<String, String> {
    if !app.state::<Arc<MediaScope>>().is_allowed(Path::new(&path)) {
        return Err("That file is outside the folders you have opened.".into());
    }

    let server = app.state::<MediaServer>();
    Ok(format!(
        "http://127.0.0.1:{}/art?token={}&path={}",
        server.port,
        server.token,
        utf8_percent_encode(&path, NON_ALPHANUMERIC)
    ))
}

/// The loopback server's port, so the YouTube bridge iframe (see
/// `youtubeBridgeAdapter.js`) can be pointed at `/youtube-embed` directly.
/// No token needed here — unlike `/media`, that route serves no user data.
#[tauri::command]
fn media_server_port(app: AppHandle) -> u16 {
    app.state::<MediaServer>().port
}

/// A track as read straight from the disc's table of contents — no tags, so
/// `title` is just a placeholder ("Track 1", "Track 2", …); real metadata,
/// when there is any, arrives separately from `lookup_cd_metadata`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CdTrack {
    drive: String,
    track_no: u32,
    start_lba: u32,
    end_lba: u32,
    title: String,
    duration: f64,
}

/// CD drives currently visible to the OS (not necessarily holding a disc).
#[tauri::command]
fn list_cd_drives() -> Vec<DriveInfo> {
    cdda::list_drives()
}

/// Read `drive`'s table of contents and report its audio tracks.
#[tauri::command]
fn scan_cd(drive: String) -> Result<Vec<CdTrack>, String> {
    let toc = cdda::read_toc(&drive)?;
    Ok(toc
        .tracks
        .into_iter()
        .map(|t| CdTrack {
            drive: drive.clone(),
            track_no: t.track_no,
            start_lba: t.start_lba,
            end_lba: t.end_lba,
            title: format!("Track {}", t.track_no),
            duration: t.duration,
        })
        .collect())
}

/// The loopback URL the media element should play this CD track from. Unlike
/// `media_url` this needs no scope check — a CD track isn't a filesystem
/// path, so there's nothing for `MediaScope` to gate.
#[tauri::command]
fn cd_track_url(app: AppHandle, drive: String, start_lba: u32, end_lba: u32) -> String {
    let server = app.state::<MediaServer>();
    format!(
        "http://127.0.0.1:{}/cdda?token={}&drive={}&start={}&end={}",
        server.port,
        server.token,
        utf8_percent_encode(&drive, NON_ALPHANUMERIC),
        start_lba,
        end_lba
    )
}

fn cddb_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("cddb_cache.json"))
}

/// Reads through `cddb_cache` before ever asking GnuDB itself — a shared
/// public server, and a disc's metadata never changes, so a disc already
/// looked up (this session or a previous one) must not be asked again.
#[tauri::command]
fn lookup_cd_metadata(app: AppHandle, drive: String) -> Option<cddb::CdMetadata> {
    let toc = cdda::read_toc(&drive).ok()?;
    let id = cddb::discid(&toc);
    let cache_path = cddb_cache_path(&app);

    if let Some(path) = &cache_path {
        if let Some(cached) = cddb_cache::get(path, id) {
            return cached;
        }
    }

    let meta = cddb::lookup(&toc);
    if let Some(path) = &cache_path {
        cddb_cache::put(path, id, meta.as_ref());
    }
    meta
}

fn album_info_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("album_info_cache.json"))
}

fn album_art_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("album_art"))
}

/// A disc's album info — cover art plus, when MusicBrainz's disc-ID lookup
/// finds an exact match for the TOC, its country/date and MusicBrainz links
/// (see `musicbrainz` for why that match matters). `artist`/`album` are the
/// GnuDB-resolved text, used only as a cover-art fallback when the disc
/// isn't in MusicBrainz's disc-ID database at all. Reads through
/// `album_info_cache` first, same reasoning as `lookup_cd_metadata`.
#[tauri::command]
fn lookup_album_info(app: AppHandle, drive: String, artist: String, album: String) -> Option<AlbumInfo> {
    let toc = cdda::read_toc(&drive).ok()?;
    let id = cddb::discid(&toc);
    let cache_key = format!("{id:08x}");
    let cache_path = album_info_cache_path(&app);

    if let Some(path) = &cache_path {
        if let Some(cached) = album_info_cache::get(path, &cache_key) {
            if let Some(art) = cached.as_ref().and_then(|info| info.art.as_deref()) {
                app.state::<Arc<MediaScope>>().allow_file(Path::new(art));
            }
            return cached;
        }
    }

    let info = album_art_dir(&app)
        .and_then(|dir| musicbrainz::fetch_album_info(&toc, &artist, &album, &dir, id));
    if let Some(path) = &cache_path {
        album_info_cache::put(path, &cache_key, info.as_ref());
    }
    if let Some(art) = info.as_ref().and_then(|info| info.art.as_deref()) {
        app.state::<Arc<MediaScope>>().allow_file(Path::new(art));
    }
    info
}

/// Album info for a local track's own album — an exact match when the file
/// carries its own embedded MusicBrainz Release ID tag (common from
/// Picard-tagged rips), the same trust model as the CD disc-ID path: only an
/// exact ID match ever populates country/date/ASIN/the release link. Without
/// one, `artist`/`album` (the file's own tags) are used only as a cover-art
/// fallback. Reads through `album_info_cache` first, same as `lookup_album_info`.
#[tauri::command]
fn lookup_local_album_info(
    app: AppHandle,
    release_id: Option<String>,
    artist: String,
    album: String,
) -> Option<AlbumInfo> {
    if release_id.is_none() && (artist.trim().is_empty() || album.trim().is_empty()) {
        return None; // nothing to key a cache entry on, or to search by
    }

    let cache_key = release_id
        .clone()
        .unwrap_or_else(|| format!("{}|{}", artist.trim().to_lowercase(), album.trim().to_lowercase()));
    let cache_path = album_info_cache_path(&app);

    if let Some(path) = &cache_path {
        if let Some(cached) = album_info_cache::get(path, &cache_key) {
            if let Some(art) = cached.as_ref().and_then(|info| info.art.as_deref()) {
                app.state::<Arc<MediaScope>>().allow_file(Path::new(art));
            }
            return cached;
        }
    }

    let info = album_art_dir(&app).and_then(|dir| {
        musicbrainz::fetch_local_album_info(release_id.as_deref(), &artist, &album, &dir, &cache_key)
    });
    if let Some(path) = &cache_path {
        album_info_cache::put(path, &cache_key, info.as_ref());
    }
    if let Some(art) = info.as_ref().and_then(|info| info.art.as_deref()) {
        app.state::<Arc<MediaScope>>().allow_file(Path::new(art));
    }
    info
}

/// Forget every cached GnuDB lookup and cached album info, so the next scan
/// of each disc asks again — for when a cached entry turns out wrong, or
/// just to reclaim the (small) disk space.
#[tauri::command]
fn clear_cddb_cache(app: AppHandle) {
    if let Some(path) = cddb_cache_path(&app) {
        cddb_cache::clear(&path);
    }
    if let (Some(cache_path), Some(dir)) = (album_info_cache_path(&app), album_art_dir(&app)) {
        album_info_cache::clear(&cache_path, &dir);
    }
}

/// Native folder picker.
///
/// These commands are `async` on purpose: the blocking dialog helpers deadlock
/// if they run on the main thread, and Tauri runs async commands elsewhere.
#[tauri::command]
async fn pick_folder(app: AppHandle, start_at: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Choose a music folder");

    if let Some(dir) = start_at.filter(|d| Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }

    dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(to_string_path)
}

/// Native multi-file picker, filtered to formats the WebView can play.
#[tauri::command]
async fn pick_files(app: AppHandle, start_at: Option<String>) -> Vec<String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose audio files")
        .add_filter("Audio", media::PLAYABLE_EXTS);

    if let Some(dir) = start_at.filter(|d| Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }

    dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(to_string_path)
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The scope is shared: commands widen it, the media server enforces it.
    let scope = Arc::new(MediaScope::default());
    let media_server = server::start(scope.clone()).expect("could not start the media server");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(scope)
        .manage(media_server)
        .invoke_handler(tauri::generate_handler![
            shortcuts,
            list_dir,
            scan_folder,
            load_tracks,
            grant_paths,
            media_url,
            art_url,
            media_server_port,
            list_cd_drives,
            scan_cd,
            cd_track_url,
            lookup_cd_metadata,
            lookup_album_info,
            lookup_local_album_info,
            clear_cddb_cache,
            pick_folder,
            pick_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scry Player");
}
