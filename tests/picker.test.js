import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { click, installDom } from './helpers/dom.js';

let createPicker;

/** The picker markup from index.html, with the two panels it controls. */
const MARKUP = `
  <nav class="picker" id="picker" role="tablist" aria-label="Media source">
    <span class="picker__glow" id="picker-glow" aria-hidden="true"></span>
    <button class="picker__opt" id="tab-local" role="tab"
            data-source="local" aria-controls="panel-local" aria-selected="true"></button>
    <button class="picker__opt" id="tab-youtube" role="tab"
            data-source="youtube" aria-controls="panel-youtube" aria-selected="false"
            tabindex="-1"></button>
  </nav>
  <section id="panel-local"></section>
  <section id="panel-youtube" hidden></section>
`;

before(async () => {
  installDom(MARKUP);
  ({ createPicker } = await import('../src/ui/picker.js'));
});

/** Records what the picker asked the controller to do. */
function fakeController() {
  const activated = [];
  return { activated, setActive: (id) => activated.push(id) };
}

let controller;
let picker;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  controller = fakeController();
  picker = createPicker(controller);
});

const tab = (id) => document.getElementById(`tab-${id}`);
const panel = (id) => document.getElementById(`panel-${id}`);

describe('createPicker', () => {
  describe('select', () => {
    it('makes the chosen source active', () => {
      picker.select('youtube');
      assert.deepEqual(controller.activated, ['youtube']);
    });

    it('shows the chosen panel and hides the other', () => {
      picker.select('youtube');

      assert.equal(panel('youtube').hidden, false);
      assert.equal(panel('local').hidden, true);
      assert.ok(panel('youtube').classList.contains('is-active'));
      assert.ok(!panel('local').classList.contains('is-active'));
    });

    it('moves aria-selected to the chosen tab', () => {
      picker.select('youtube');

      assert.equal(tab('youtube').getAttribute('aria-selected'), 'true');
      assert.equal(tab('local').getAttribute('aria-selected'), 'false');
    });

    it('keeps only the selected tab in the tab order', () => {
      picker.select('youtube');

      assert.equal(tab('youtube').tabIndex, 0);
      assert.equal(tab('local').tabIndex, -1);
    });

    it('ignores a source it does not have a tab for', () => {
      picker.select('spotify');

      assert.deepEqual(controller.activated, []);
      assert.equal(tab('local').getAttribute('aria-selected'), 'true', 'unchanged');
    });
  });

  describe('clicking a tab', () => {
    it('selects that source', () => {
      click(tab('youtube'));

      assert.deepEqual(controller.activated, ['youtube']);
      assert.equal(panel('youtube').hidden, false);
    });
  });

  describe('keyboard', () => {
    /** The roving tabindex means arrows act on whichever tab has focus. */
    function focusAndPress(id, key) {
      tab(id).focus();
      document.getElementById('picker').dispatchEvent(
        new window.KeyboardEvent('keydown', { key, bubbles: true }),
      );
    }

    it('moves right and wraps', () => {
      focusAndPress('local', 'ArrowRight');
      assert.equal(controller.activated.at(-1), 'youtube');

      focusAndPress('youtube', 'ArrowRight');
      assert.equal(controller.activated.at(-1), 'local', 'wraps past the end');
    });

    it('moves left and wraps', () => {
      focusAndPress('youtube', 'ArrowLeft');
      assert.equal(controller.activated.at(-1), 'local');

      focusAndPress('local', 'ArrowLeft');
      assert.equal(controller.activated.at(-1), 'youtube', 'wraps past the start');
    });

    it('jumps to the ends with Home and End', () => {
      focusAndPress('local', 'End');
      assert.equal(controller.activated.at(-1), 'youtube');

      focusAndPress('youtube', 'Home');
      assert.equal(controller.activated.at(-1), 'local');
    });

    it('moves focus along with the selection', () => {
      focusAndPress('local', 'ArrowRight');
      assert.equal(document.activeElement, tab('youtube'));
    });

    it('leaves other keys to the rest of the app', () => {
      focusAndPress('local', 'Space');
      focusAndPress('local', 'a');

      assert.deepEqual(controller.activated, []);
    });

    it('does nothing when focus is outside the tabs', () => {
      document.body.focus();
      document.getElementById('picker').dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );

      assert.deepEqual(controller.activated, []);
    });
  });
});
