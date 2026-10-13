/**
 * The single bridge to the Rust side.
 *
 * There is no bundler in this project, so the frontend cannot import
 * `@tauri-apps/api` by bare specifier. Instead `withGlobalTauri` (see
 * `tauri.conf.json`) injects the same API at `window.__TAURI__`, and this
 * module is the only place that reaches for it. If a bundler is ever added
 * back, this file is the one that changes.
 */

const api = globalThis.window?.__TAURI__;

if (!api) {
  throw new Error(
    'The Tauri API is missing. Scry Player has to run inside the app window — try `npm run dev`.',
  );
}

export const invoke = api.core.invoke;

/**
 * A loopback URL the media element can stream this track from.
 *
 * Neither the `asset:` protocol nor a `blob:` URL works properly for audio in
 * WebKitGTK — see `src-tauri/src/server.rs` for the measurements. Plain http
 * over 127.0.0.1 is the one route that plays cleanly.
 *
 * @returns {Promise<string>}
 */
export const mediaUrl = (path) => invoke('media_url', { path });

/**
 * The loopback server's port, so the YouTube bridge iframe (see
 * sources/youtubeBridgeAdapter.js) can be pointed at it directly.
 *
 * @returns {Promise<number>}
 */
export const mediaServerPort = () => invoke('media_server_port');

// File dialogs are opened from Rust, so the frontend needs no dialog plugin.
export const pickFolder = (startAt) => invoke('pick_folder', { startAt: startAt ?? null });
export const pickFiles = (startAt) => invoke('pick_files', { startAt: startAt ?? null });

/**
 * CD drives currently visible to the OS (not necessarily holding a disc).
 *
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
export const listCdDrives = () => invoke('list_cd_drives');

/**
 * Read `drive`'s table of contents and report its audio tracks.
 *
 * @returns {Promise<object[]>}
 */
export const scanCd = (drive) => invoke('scan_cd', { drive });

/**
 * A loopback URL the media element can stream this CD track from — the same
 * idea as `mediaUrl`, just built from a drive id and the track's sector
 * range (from `scanCd`) instead of a filesystem path.
 *
 * @returns {Promise<string>}
 */
export const cdTrackUrl = (drive, startLba, endLba) =>
  invoke('cd_track_url', { drive, startLba, endLba });
