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

// File dialogs are opened from Rust, so the frontend needs no dialog plugin.
export const pickFolder = (startAt) => invoke('pick_folder', { startAt: startAt ?? null });
export const pickFiles = (startAt) => invoke('pick_files', { startAt: startAt ?? null });
