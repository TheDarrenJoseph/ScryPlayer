/**
 * The settings dialog.
 *
 * Settings live under their own storage key rather than alongside the session
 * in `main.js`. They have to outlive it: forgetting the saved session must not
 * also forget that the listener asked never to restore one.
 */

const STORE_KEY = 'scry.settings.v1';

const $ = (id) => document.getElementById(id);

/** Defaults match how the app behaved before there was a dialog. */
export const DEFAULTS = {
  restoreSession: true,
  water: true,
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

  return { restoreSession: pick('restoreSession'), water: pick('water') };
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
 */
export function createSettings(values, { onChange, onForget }) {
  const dialog = $('settings-dialog');
  const note = $('settings-note');
  const restore = $('set-restore');
  const water = $('set-water');

  restore.checked = values.restoreSession;
  water.checked = values.water;

  function update(key, on) {
    values[key] = on;
    save(values);
    onChange(values);
  }

  restore.addEventListener('change', () => update('restoreSession', restore.checked));
  water.addEventListener('change', () => update('water', water.checked));

  $('btn-forget').addEventListener('click', () => {
    onForget();
    // Said in the dialog rather than the topbar status, which is behind it.
    note.textContent = 'Saved session forgotten.';
  });

  $('btn-settings').addEventListener('click', () => {
    note.textContent = '';
    dialog.showModal();
  });

  $('btn-settings-close').addEventListener('click', () => dialog.close());

  // A native dialog fills its backdrop with the dialog element itself, so a
  // click lands on the dialog whether or not it hit the panel. Compare against
  // the box to tell the two apart.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const outside =
      e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
    if (outside) dialog.close();
  });

  return {
    open: () => dialog.showModal(),
    close: () => dialog.close(),
  };
}
