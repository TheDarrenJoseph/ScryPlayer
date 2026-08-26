import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { click, installAppDom } from './helpers/dom.js';

let createSettings, loadSettings, DEFAULTS;

const KEY = 'scry.settings.v1';

before(async () => {
  installAppDom();
  ({ createSettings, loadSettings, DEFAULTS } = await import('../src/ui/settings.js'));
});

const $ = (id) => document.getElementById(id);
const dialog = () => $('settings-dialog');

/**
 * Wire the dialog over the markup installed by `beforeEach`.
 *
 * Every `installAppDom()` mints a fresh window and so a fresh `localStorage`,
 * which is what makes it a stand-in for restarting the app — a test that wants
 * to survive one has to hand the stored string across itself.
 */
function setup(stored) {
  if (stored !== undefined) localStorage.setItem(KEY, stored);

  const changes = [];
  const forgets = [];
  const values = loadSettings();
  const api = createSettings(values, {
    onChange: (v) => changes.push({ ...v }),
    onForget: () => forgets.push(true),
  });

  return { values, changes, forgets, api };
}

/** Flip a switch the way a pointer would. */
function toggle(id, on) {
  const box = $(id);
  box.checked = on;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/** Click at a point, as the backdrop handler sees it. */
function clickAt(x, y) {
  dialog().dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
}

beforeEach(() => {
  installAppDom();
  localStorage.clear();
});

describe('loadSettings', () => {
  it('defaults to how the app behaved before the dialog existed', () => {
    assert.deepEqual(loadSettings(), { restoreSession: true, water: true });
    assert.deepEqual(DEFAULTS, { restoreSession: true, water: true });
  });

  it('reads what was saved', () => {
    localStorage.setItem(KEY, JSON.stringify({ restoreSession: false, water: false }));

    assert.deepEqual(loadSettings(), { restoreSession: false, water: false });
  });

  it('fills in per field, so a partial save still loads', () => {
    localStorage.setItem(KEY, JSON.stringify({ water: false }));

    assert.deepEqual(loadSettings(), { restoreSession: true, water: false });
  });

  it('ignores values of the wrong type', () => {
    localStorage.setItem(KEY, JSON.stringify({ restoreSession: 'yes please', water: 1 }));

    assert.deepEqual(loadSettings(), { restoreSession: true, water: true });
  });

  it('falls back to the defaults when the saved value is unreadable', () => {
    localStorage.setItem(KEY, '{ not json');

    assert.deepEqual(loadSettings(), { restoreSession: true, water: true });
  });

  it('survives a stored null', () => {
    localStorage.setItem(KEY, 'null');

    assert.deepEqual(loadSettings(), { restoreSession: true, water: true });
  });
});

describe('createSettings', () => {
  describe('opening and closing', () => {
    it('opens from the gear', () => {
      setup();
      assert.equal(dialog().open, false);

      click($('btn-settings'));

      assert.equal(dialog().open, true);
    });

    it('closes from the close button', () => {
      setup();
      click($('btn-settings'));

      click($('btn-settings-close'));

      assert.equal(dialog().open, false);
    });

    it('closes on a click outside the panel', () => {
      setup();
      click($('btn-settings'));

      // jsdom reports a zero-size box, so any non-zero point is outside it.
      clickAt(9999, 9999);

      assert.equal(dialog().open, false);
    });

    it('stays open when the click lands on the panel', () => {
      setup();
      click($('btn-settings'));

      const box = dialog().getBoundingClientRect();
      clickAt(box.left, box.top);

      assert.equal(dialog().open, true);
    });

    it('stays open when the click came from something inside it', () => {
      setup();
      click($('btn-settings'));

      // A click on a child bubbles to the dialog but is not targeted at it.
      click($('set-water'));

      assert.equal(dialog().open, true);
    });
  });

  describe('the switches', () => {
    it('start from the values it was given', () => {
      setup(JSON.stringify({ restoreSession: false, water: true }));

      assert.equal($('set-restore').checked, false);
      assert.equal($('set-water').checked, true);
    });

    it('report and persist a change', () => {
      const { values, changes } = setup();

      toggle('set-water', false);

      assert.equal(values.water, false, 'the caller sees it through the object it passed');
      assert.deepEqual(changes.at(-1), { restoreSession: true, water: false });
      assert.deepEqual(loadSettings(), { restoreSession: true, water: false }, 'and it is saved');
    });

    it('keeps the two settings independent', () => {
      const { values } = setup();

      toggle('set-restore', false);

      assert.deepEqual(values, { restoreSession: false, water: true });
      assert.equal($('set-water').checked, true);
    });

    it('survives a reload', () => {
      setup();
      toggle('set-restore', false);
      const written = localStorage.getItem(KEY);

      // A fresh window, as after a restart, seeded with what the last one wrote.
      installAppDom();
      const { values } = setup(written);

      assert.equal(values.restoreSession, false);
      assert.equal($('set-restore').checked, false, 'and the switch shows it');
    });
  });

  describe('forgetting the saved session', () => {
    it('tells the caller and says so in the dialog', () => {
      const { forgets } = setup();
      click($('btn-settings'));

      click($('btn-forget'));

      assert.deepEqual(forgets, [true]);
      assert.equal($('settings-note').textContent, 'Saved session forgotten.');
    });

    it('leaves the dialog open, so the message can be read', () => {
      setup();
      click($('btn-settings'));

      click($('btn-forget'));

      assert.equal(dialog().open, true);
    });

    it('clears the message the next time the dialog is opened', () => {
      setup();
      click($('btn-settings'));
      click($('btn-forget'));
      click($('btn-settings-close'));

      click($('btn-settings'));

      assert.equal($('settings-note').textContent, '');
    });

    it('does not disturb the settings themselves', () => {
      const { values } = setup(JSON.stringify({ restoreSession: false, water: false }));
      click($('btn-settings'));

      click($('btn-forget'));

      assert.deepEqual(values, { restoreSession: false, water: false });
      assert.deepEqual(
        loadSettings(),
        { restoreSession: false, water: false },
        'settings outlive the session they describe',
      );
    });
  });

  describe('the returned handle', () => {
    it('opens and closes', () => {
      const { api } = setup();

      api.open();
      assert.equal(dialog().open, true);

      api.close();
      assert.equal(dialog().open, false);
    });
  });
});
