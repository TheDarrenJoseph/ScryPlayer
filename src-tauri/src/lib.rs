mod media;
mod server;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use media::{DirListing, Track};
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
        tracks.push(media::read_track(&path));
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
        .manage(scope)
        .manage(media_server)
        .invoke_handler(tauri::generate_handler![
            shortcuts,
            list_dir,
            scan_folder,
            load_tracks,
            grant_paths,
            media_url,
            pick_folder,
            pick_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scry Player");
}
