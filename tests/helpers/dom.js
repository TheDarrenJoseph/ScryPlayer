/**
 * A DOM for tests that touch `ui/`.
 *
 * The runner gives every test *file* its own process, so installing globals
 * here cannot leak into another file — only into the file that asks for it.
 *
 * This covers element construction and event wiring, which is all `ui/` does.
 * It does not stretch to the adapters: jsdom builds an `<audio>` element but
 * `play()` throws, and it never fires `timeupdate`, `loadedmetadata` or
 * `ended`, so every listener in `localAdapter` would sit inert. Those need a
 * real engine, and faking them here would only test the fake.
 */
import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';

/**
 * Install a document built from `html` as the global DOM.
 *
 * @param {string} html markup for `<body>`
 * @returns {{ window: Window, document: Document }}
 */
export function installDom(html = '') {
  return install(new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  }));
}

/**
 * Install the app's real `index.html` as the global DOM.
 *
 * Preferred over a hand-written fixture wherever a test needs more than a
 * couple of elements: the markup cannot drift from the app the way a copy
 * would. jsdom does not execute scripts unless asked, so the `main.js` module
 * tag sits inert and the test decides what to import.
 *
 * @returns {{ window: Window, document: Document }}
 */
export function installAppDom() {
  const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8');
  return install(new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' }));
}

function install(dom) {
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.HTMLElement = window.HTMLElement;
  global.HTMLInputElement = window.HTMLInputElement;
  global.HTMLTextAreaElement = window.HTMLTextAreaElement;
  global.Event = window.Event;
  global.KeyboardEvent = window.KeyboardEvent;
  global.MouseEvent = window.MouseEvent;
  global.localStorage = window.localStorage;
  // `LocalAdapter` builds one in its constructor. jsdom will not play it —
  // `play()` throws and no media events ever fire — but it constructs, which
  // is all anything outside the adapter's own tests needs.
  global.Audio = window.Audio;

  shimDialogs(window.document);

  return { window, document: window.document };
}

/**
 * Give `<dialog>` just enough behaviour to observe.
 *
 * jsdom (30) does not implement the element at all — `showModal` is not a
 * function. This makes `open` follow the calls, which is what lets a test say
 * *our code opened it here and closed it there*. It says nothing about the
 * real thing: modality, the focus trap, Escape and the backdrop are the
 * browser's, and are the reason for using a native dialog in the first place.
 */
function shimDialogs(document) {
  for (const el of document.querySelectorAll('dialog')) {
    if (typeof el.showModal === 'function') return; // A real implementation; leave it be.
    el.open = false;
    el.showModal = () => {
      el.open = true;
    };
    el.show = el.showModal;
    el.close = () => {
      el.open = false;
    };
  }
}

/** Dispatch a bubbling click, the way a real pointer would. */
export function click(node) {
  node.dispatchEvent(new global.window.MouseEvent('click', { bubbles: true }));
}

/** Dispatch a keydown on `document`, for the transport's shortcuts. */
export function keydown(code, init = {}) {
  global.document.dispatchEvent(
    new global.window.KeyboardEvent('keydown', { code, bubbles: true, ...init }),
  );
}
