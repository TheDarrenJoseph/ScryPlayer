/**
 * The settings dialog.
 *
 * Settings live under their own storage key rather than alongside the session
 * in `main.js`. They have to outlive it: forgetting the saved session must not
 * also forget that the listener asked never to restore one.
 */

import { closeOnBackdropClick } from './dom.js';

const STORE_KEY = 'scry.settings.v1';

const $ = (id) => document.getElementById(id);

/** Defaults match how the app behaved before there was a dialog. */
export const DEFAULTS = {
  restoreSession: true,
  water: true,
  // On by default: scanning a disc is already an explicit action, and all
  // that leaves this machine is a checksum of the disc's track layout.
  cddbLookup: true,
  // Depends on `cddbLookup` resolving an artist/album to search by — on by
  // default for the same reason, but it sends real text rather than a
  // checksum, to a second service.
  albumArtLookup: true,
  // A separate switch from `albumArtLookup`: local files carry their own
  // artist/album tags already, so this needs no other lookup to depend on,
  // and a listener may want MusicBrainz asked for one source but not the
  // other.
  localAlbumInfoLookup: true,
};

/** Read the saved settings, falling back per-field so a partial save is fine. */
export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    // Corrupt or unavailable storage: the defaults are a fine answer.
  }

  const pick = (key) => (typeof saved[key] === 'boolean' ? saved[key] : DEFAULTS[key]);

  return {
    restoreSession: pick('restoreSession'),
    water: pick('water'),
    cddbLookup: pick('cddbLookup'),
    albumArtLookup: pick('albumArtLookup'),
    localAlbumInfoLookup: pick('localAlbumInfoLookup'),
  };
}

function save(values) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(values));
  } catch {
    // Out of quota, or storage disabled. Losing a preference is not worth
    // interrupting playback over — the same bargain main.js makes.
  }
}

/**
 * Wire up the dialog.
 *
 * @param {object} values the current settings, mutated in place as they change
 * @param {object} handlers
 * @param {(values: object) => void} handlers.onChange after any setting changes
 * @param {() => void} handlers.onForget the saved session should be discarded
 * @param {() => Promise<void>} handlers.onClearCddbCache the cached GnuDB
 *   lookups and cached album info (CD and local alike) should be discarded
 */
export function createSettings(values, { onChange, onForget, onClearCddbCache }) {
  const dialog = $('settings-dialog');
  const note = $('settings-note');
  const restore = $('set-restore');
  const water = $('set-water');
  const cddbLookup = $('set-cddb-lookup');
  const albumArtLookup = $('set-album-art-lookup');
  const localAlbumInfoLookup = $('set-local-album-info-lookup');

  restore.checked = values.restoreSession;
  water.checked = values.water;
  cddbLookup.checked = values.cddbLookup;
  albumArtLookup.checked = values.albumArtLookup;
  localAlbumInfoLookup.checked = values.localAlbumInfoLookup;

  function update(key, on) {
    values[key] = on;
    save(values);
    onChange(values);
  }

  restore.addEventListener('change', () => update('restoreSession', restore.checked));
  water.addEventListener('change', () => update('water', water.checked));
  cddbLookup.addEventListener('change', () => update('cddbLookup', cddbLookup.checked));
  albumArtLookup.addEventListener('change', () =>
    update('albumArtLookup', albumArtLookup.checked),
  );
  localAlbumInfoLookup.addEventListener('change', () =>
    update('localAlbumInfoLookup', localAlbumInfoLookup.checked),
  );

  $('btn-forget').addEventListener('click', () => {
    onForget();
    // Said in the dialog rather than the topbar status, which is behind it.
    note.textContent = 'Saved session forgotten.';
  });

  $('btn-clear-cddb-cache').addEventListener('click', async () => {
    try {
      await onClearCddbCache();
      note.textContent = 'Cleared cached album info.';
    } catch {
      note.textContent = 'Could not clear the cached album info.';
    }
  });

  $('btn-settings').addEventListener('click', () => {
    note.textContent = '';
    dialog.showModal();
  });

  $('btn-settings-close').addEventListener('click', () => dialog.close());

  closeOnBackdropClick(dialog);

  return {
    open: () => dialog.showModal(),
    close: () => dialog.close(),
  };
}
