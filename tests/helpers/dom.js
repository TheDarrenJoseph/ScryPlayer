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
import { JSDOM } from 'jsdom';

/**
 * Install a document built from `html` as the global DOM.
 *
 * @param {string} html markup for `<body>`
 * @returns {{ window: Window, document: Document }}
 */
export function installDom(html = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  });

  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.HTMLElement = window.HTMLElement;
  global.HTMLInputElement = window.HTMLInputElement;
  global.HTMLTextAreaElement = window.HTMLTextAreaElement;
  global.Event = window.Event;
  global.KeyboardEvent = window.KeyboardEvent;
  global.MouseEvent = window.MouseEvent;

  return { window, document: window.document };
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
