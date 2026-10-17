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
 * A loopback URL for a track's folder cover image (e.g. `cover.jpg`), as
 * found by the backend when the track was scanned.
 *
 * @returns {Promise<string>}
 */
export const artUrl = (path) => invoke('art_url', { path });

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

/**
 * Artist, album and real track titles for a scanned disc, from GnuDB —
 * resolves `null` rather than throwing on any failure (offline, no match, a
 * malformed reply), since the TOC-only placeholder titles are always a fine
 * fallback. The same contract `fetchVideoInfo` already uses for YouTube.
 *
 * @returns {Promise<{ artist: string|null, album: string|null, trackTitles: string[] } | null>}
 */
export const lookupCdMetadata = (drive) => invoke('lookup_cd_metadata', { drive });

/**
 * A disc's album info from MusicBrainz and the Cover Art Archive: a
 * cached-on-disk cover image path, plus — only when MusicBrainz's disc-ID
 * lookup found an exact match for the disc's own TOC — its release country,
 * date, and MusicBrainz links. `artist`/`album` (the text `lookupCdMetadata`
 * already found) are used only as a cover-art fallback when the disc isn't
 * in MusicBrainz's disc-ID database at all, so `country`/`date`/the links
 * are never a guess. `null` when nothing at all was found.
 *
 * @returns {Promise<{ art: string|null, country: string|null, date: string|null, asin: string|null, releaseUrl: string|null, tocUrl: string|null } | null>}
 */
export const lookupAlbumInfo = (drive, artist, album) =>
  invoke('lookup_album_info', { drive, artist, album });

/**
 * A local track's own album info, the same shape as `lookupAlbumInfo` and
 * the same trust rule: `country`/`date`/`asin`/`releaseUrl` only ever come
 * from an exact match — here, the file's own embedded MusicBrainz Release Id
 * tag (`releaseId`, as read by the backend; `null` when the file has none).
 * Without one, `artist`/`album` (the file's own tags) are used only as a
 * cover-art fallback, same as GnuDB's text does for a CD with no disc-ID
 * match. `tocUrl` has no local-file equivalent, so it is always `null`.
 *
 * @returns {Promise<{ art: string|null, country: string|null, date: string|null, asin: string|null, releaseUrl: string|null, tocUrl: null } | null>}
 */
export const lookupLocalAlbumInfo = (releaseId, artist, album) =>
  invoke('lookup_local_album_info', { releaseId, artist, album });

/** Forget every cached GnuDB lookup and cached album info (CD and local
 * alike), so the next scan or play asks again. */
export const clearCddbCache = () => invoke('clear_cddb_cache');

/**
 * Open a URL in the user's default browser rather than inside the app's own
 * webview — for the MusicBrainz/TOC links in the album info dialog.
 *
 * @returns {Promise<void>}
 */
export const openExternal = (url) => invoke('plugin:shell|open', { path: url });
