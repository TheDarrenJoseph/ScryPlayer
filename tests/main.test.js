import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { click, installAppDom } from './helpers/dom.js';

const SESSION_KEY = 'scry.v1';
const SETTINGS_KEY = 'scry.settings.v1';

/**
 * The Rust bridge.
 *
 * One object for the whole file, because `tauri.js` reads `window.__TAURI__`
 * once when it is first imported and keeps the `invoke` it found. Re-pointing
 * it at each new window would leave the module holding the old one, so the
 * object stays put and only its answers change.
 */
const bridge = {
  calls: [],
  handlers: {},
  invoke(command, args) {
    bridge.calls.push({ command, args });
    const handler = bridge.handlers[command];
    return Promise.resolve(handler ? handler(args) : undefined);
  },
};

const track = (over = {}) => ({
  path: '/music/a.mp3',
  fileName: 'a.mp3',
  title: 'A',
  duration: 100,
  source: 'local',
  playable: true,
  ...over,
});

const SAVED = {
  version: 1,
  source: 'youtube',
  volume: 0.35,
  muted: false,
  localQueue: {
    items: [track(), track({ path: '/music/b.mp3', title: 'B' })],
    index: 0,
    repeat: 'off',
    shuffle: false,
  },
  youtubeQueue: {
    items: [{ source: 'youtube', videoId: 'iR-K2rUP86M', title: 'iR-K2rUP86M' }],
    index: -1,
    repeat: 'off',
    shuffle: false,
  },
};

let run = 0;

/**
 * Boot the app over a fresh DOM.
 *
 * `main.js` runs its work on import, so each scenario needs its own module
 * instance — hence the query string, which makes the specifier unique.
 */
async function boot({ session = SAVED, settings, styles = false } = {}) {
  const { window } = installAppDom({ styles });
  window.__TAURI__ = { core: { invoke: bridge.invoke } };

  bridge.calls = [];
  bridge.handlers = {
    shortcuts: () => [{ label: 'Music', path: '/music' }],
    list_dir: ({ path }) => ({ path: path ?? '/music', parent: '/', entries: [] }),
    grant_paths: () => undefined,
  };

  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  if (settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  await import(`../src/main.js?run=${run++}`);
  await settle();
}

const settle = () => new Promise((r) => setImmediate(r));
const $ = (id) => document.getElementById(id);
const commands = () => bridge.calls.map((c) => c.command);

beforeEach(() => {
  installAppDom();
  localStorage.clear();
});

describe('main', () => {
  describe('restoring the last session', () => {
    it('brings the queues back by default', async () => {
      await boot();

      assert.equal($('count-local').textContent, '2');
      assert.equal($('count-youtube').textContent, '1');
    });

    it('brings back the source that was in use', async () => {
      await boot();

      assert.equal($('tab-youtube').getAttribute('aria-selected'), 'true');
      assert.equal($('panel-youtube').hidden, false);
    });

    it('re-grants the restored local paths, which do not survive a restart', async () => {
      await boot();

      const grant = bridge.calls.find((c) => c.command === 'grant_paths');
      assert.deepEqual(grant.args.paths, ['/music/a.mp3', '/music/b.mp3']);
    });

    it('leaves the queues empty when the setting is off', async () => {
      await boot({ settings: { restoreSession: false, water: true } });

      assert.equal($('count-local').textContent, '0');
      assert.equal($('count-youtube').textContent, '0');
    });

    it('starts on local when the setting is off, whatever was saved', async () => {
      await boot({ settings: { restoreSession: false, water: true } });

      assert.equal($('tab-local').getAttribute('aria-selected'), 'true');
      assert.equal($('tab-youtube').getAttribute('aria-selected'), 'false');
    });

    it('asks Rust for nothing when there is no queue to re-grant', async () => {
      await boot({ settings: { restoreSession: false, water: true } });

      assert.ok(!commands().includes('grant_paths'));
    });

    it('remembers the volume either way', async () => {
      await boot({ settings: { restoreSession: false, water: true } });

      assert.equal($('vol').value, '35', 'nobody means "and reset my volume" by that switch');
    });

    it('copes with nothing saved at all', async () => {
      await boot({ session: null });

      assert.equal($('count-local').textContent, '0');
      assert.equal($('tab-local').getAttribute('aria-selected'), 'true');
      assert.equal($('vol').value, '80', 'the default level');
    });
  });

  describe('the water', () => {
    /**
     * Whether the canvas is actually off the screen.
     *
     * Deliberately the computed style rather than the `hidden` attribute.
     * `#water` sets `display: block`, which outranks the user agent's
     * `[hidden] { display: none }` — so the attribute alone once read as
     * hidden while the canvas sat there holding its last painted frame.
     */
    const gone = () => window.getComputedStyle($('water')).display === 'none';

    it('is shown by default', async () => {
      await boot({ styles: true });

      assert.equal(gone(), false);
    });

    it('goes completely when the setting is off', async () => {
      await boot({ settings: { restoreSession: true, water: false }, styles: true });

      assert.equal($('water').hidden, true);
      assert.equal(gone(), true, 'the canvas must not be left showing its last frame');
    });

    it('follows the switch without a reload', async () => {
      await boot({ styles: true });
      assert.equal(gone(), false);

      $('set-water').checked = false;
      $('set-water').dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.equal(gone(), true);

      $('set-water').checked = true;
      $('set-water').dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.equal(gone(), false, 'and comes back');
    });
  });

  describe('the clear buttons', () => {
    it('each empty their own queue', async () => {
      await boot();

      click($('btn-clear-local'));
      await settle();

      assert.equal($('count-local').textContent, '0');
      assert.equal($('count-youtube').textContent, '1', 'the other queue is untouched');

      click($('btn-clear-youtube'));
      await settle();

      assert.equal($('count-youtube').textContent, '0');
    });
  });

  describe('forgetting the saved session', () => {
    it('removes it from storage', async () => {
      await boot();
      assert.ok(localStorage.getItem(SESSION_KEY), 'something to forget');

      click($('btn-settings'));
      click($('btn-forget'));

      assert.equal(localStorage.getItem(SESSION_KEY), null);
    });

    it('leaves the settings themselves alone', async () => {
      await boot({ settings: { restoreSession: false, water: false } });

      click($('btn-settings'));
      click($('btn-forget'));

      assert.deepEqual(JSON.parse(localStorage.getItem(SETTINGS_KEY)), {
        restoreSession: false,
        water: false,
      });
    });
  });

  describe('persisting', () => {
    it('writes the session out when the window is going away', async () => {
      await boot({ session: null });
      assert.equal(localStorage.getItem(SESSION_KEY), null);

      window.dispatchEvent(new window.Event('beforeunload'));

      const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
      assert.equal(saved.source, 'local');
      assert.equal(saved.volume, 0.8);
    });
  });
});
