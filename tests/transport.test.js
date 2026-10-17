import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { Emitter } from '../src/core/emitter.js';
import { click, installDom, keydown } from './helpers/dom.js';

let createTransport;

/** The transport markup from index.html, stripped of its inline SVG. */
const MARKUP = `
  <div class="np">
    <button class="np__art" id="np-art" type="button" disabled></button>
    <div class="np__title" id="np-title">Nothing playing</div>
    <div class="np__sub" id="np-sub">Still water</div>
  </div>
  <button id="btn-shuffle" title="Shuffle" aria-pressed="false"></button>
  <button id="btn-prev" title="Previous"></button>
  <button id="btn-play" title="Play" aria-label="Play"></button>
  <button id="btn-next" title="Next"></button>
  <button id="btn-repeat" title="Repeat off" data-mode="off"></button>
  <span id="time-cur">0:00</span>
  <input id="seek" type="range" min="0" max="1000" value="0" step="1" />
  <span id="time-dur">0:00</span>
  <button id="btn-mute" title="Mute" aria-pressed="false"></button>
  <input id="vol" type="range" min="0" max="100" value="80" step="1" />
  <dialog id="art-dialog" tabindex="-1">
    <button id="btn-art-maximize" aria-pressed="false"></button>
    <button id="btn-art-close"></button>
    <img id="art-dialog-image" alt="Cover art" />
    <p id="art-dialog-caption"></p>
  </dialog>
`;

/**
 * A stand-in for the Tauri bridge `transport.js` needs for `openExternal`.
 * `tauri.js` reads `window.__TAURI__` at import time and throws without it,
 * so this has to be installed before `transport.js` is imported.
 */
const bridge = {
  calls: [],
  invoke(command, args) {
    bridge.calls.push({ command, args });
    return Promise.resolve();
  },
};

before(async () => {
  const { window } = installDom(MARKUP);
  window.__TAURI__ = { core: { invoke: bridge.invoke } };
  ({ createTransport } = await import('../src/ui/transport.js'));
});

/**
 * A controller stand-in: emits what the real one emits, and records the calls
 * the transport makes back.
 */
class FakeController extends Emitter {
  calls = [];
  state = { playing: false, position: 0, duration: 0 };
  volume = 0.8;
  muted = false;
  queue = null;

  #record(method, ...args) {
    this.calls.push(args.length ? { method, args } : { method });
  }

  get log() {
    return this.calls.map((c) => c.method);
  }

  toggle() {
    this.#record('toggle');
  }
  next() {
    this.#record('next');
  }
  prev() {
    this.#record('prev');
  }
  seek(s) {
    this.#record('seek', s);
  }
  setVolume(v) {
    this.#record('setVolume', v);
  }
  toggleMute() {
    this.#record('toggleMute');
  }
}

let controller;

const $ = (id) => document.getElementById(id);

beforeEach(() => {
  // Not a bare innerHTML reset: the `<dialog>` needs `installDom`'s shim
  // re-applied to the fresh nodes, or `showModal`/`close` are no-ops.
  installDom(MARKUP);
  controller = new FakeController();
  bridge.calls = [];
});

describe('createTransport', () => {
  describe('now playing', () => {
    beforeEach(() => createTransport(controller));

    it('shows the title and the source when there are no tags', () => {
      controller.emit('track', { track: { title: 'Cavern', source: 'youtube' } });

      assert.equal($('np-title').textContent, 'Cavern');
      assert.equal($('np-sub').textContent, 'YouTube');
    });

    it('prefers artist and album over the source name', () => {
      controller.emit('track', {
        track: { title: 'Cavern', artist: 'Liquid Liquid', album: 'Optimo' },
      });

      assert.equal($('np-sub').textContent, 'Liquid Liquid · Optimo');
    });

    it('falls back to the filename, then to Unknown', () => {
      controller.emit('track', { track: { fileName: 'track01.flac' } });
      assert.equal($('np-title').textContent, 'track01.flac');

      controller.emit('track', { track: {} });
      assert.equal($('np-title').textContent, 'Unknown');
    });

    it('shows the thumbnail for a YouTube track', () => {
      controller.emit('track', { track: { title: 'x', videoId: 'dQw4w9WgXcQ' } });

      assert.match($('np-art').style.backgroundImage, /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/);
    });

    it('carries no artwork for a local file with no folder cover', () => {
      controller.emit('track', { track: { title: 'x', source: 'local' } });
      assert.equal($('np-art').style.backgroundImage, '');
      assert.equal($('np-art').disabled, true, 'nothing to open without art');
    });

    it('shows the folder cover for a local file once resolved', () => {
      controller.emit('track', {
        track: {
          title: 'x',
          source: 'local',
          artUrl: 'http://127.0.0.1:1234/art?token=abc&path=%2Fm%2Fcover.jpg',
        },
      });
      assert.match($('np-art').style.backgroundImage, /127\.0\.0\.1:1234\/art/);
      assert.equal($('np-art').disabled, false);
    });

    it('settles back to nothing when the queue empties', () => {
      controller.emit('track', { track: { title: 'Cavern', videoId: 'dQw4w9WgXcQ' } });
      controller.emit('track', { track: null, index: -1, sourceId: 'youtube' });

      assert.equal($('np-title').textContent, 'Nothing playing');
      assert.equal($('np-sub').textContent, 'Still water');
      assert.equal($('np-art').style.backgroundImage, '', 'the old artwork goes too');
      assert.equal($('np-art').disabled, true);
    });

    it('renders a scripted title as text', () => {
      const nasty = '<img src=x onerror="alert(1)">';
      controller.emit('track', { track: { title: nasty } });

      assert.equal($('np-title').textContent, nasty);
      assert.equal($('np-title').querySelector('img'), null);
    });
  });

  describe('the art dialog', () => {
    beforeEach(() => createTransport(controller));

    it('opens with the art and an album/artist caption when clicked', () => {
      controller.emit('track', {
        track: { title: 'x', artist: 'Massive Attack', album: 'Mezzanine', artUrl: 'http://x/art.jpg' },
      });

      click($('np-art'));

      assert.equal($('art-dialog').open, true);
      assert.equal($('art-dialog-image').src, 'http://x/art.jpg');
      assert.equal($('art-dialog-caption').textContent, 'Mezzanine · Massive Attack');
    });

    it('focuses the dialog itself, not the close button, when opened', () => {
      controller.emit('track', { track: { title: 'x', artUrl: 'http://x/art.jpg' } });

      click($('np-art'));

      assert.equal(document.activeElement, $('art-dialog'));
    });

    it('adds country, date and track count from album info', () => {
      controller.emit('track', {
        track: {
          title: 'x',
          artist: 'Foals',
          album: 'Total Life Forever',
          artUrl: 'http://x/art.jpg',
          albumInfo: {
            country: 'GB',
            date: '2010-05-10',
            trackCount: 11,
            releaseUrl: null,
            tocUrl: null,
          },
        },
      });

      click($('np-art'));

      assert.equal(
        $('art-dialog-caption').textContent,
        'Total Life Forever · Foals · GB · 2010-05-10 · 11 tracks',
      );
    });

    it('appends MusicBrainz/TOC/Release links when the disc has an exact match', () => {
      controller.emit('track', {
        track: {
          title: 'x',
          artist: 'Foals',
          album: 'Total Life Forever',
          artUrl: 'http://x/art.jpg',
          albumInfo: {
            country: 'GB',
            date: '2010-05-10',
            trackCount: 11,
            releaseUrl: 'https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67',
            tocUrl: 'https://musicbrainz.org/cdtoc/F5gDrr2p.IMUvUxfNSc884xb.pc-',
          },
        },
      });

      click($('np-art'));

      const caption = $('art-dialog-caption');
      assert.match(caption.textContent, /\(MusicBrainz: TOC · Release\)$/);

      // "MusicBrainz" only names where the links lead — it is not itself one.
      const links = Object.fromEntries([...caption.querySelectorAll('a')].map((a) => [a.textContent, a.href]));
      assert.equal(links.MusicBrainz, undefined);
      assert.equal(links.TOC, 'https://musicbrainz.org/cdtoc/F5gDrr2p.IMUvUxfNSc884xb.pc-');
      assert.equal(links.Release, 'https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67');
    });

    it('adds the ASIN to the facts line when present', () => {
      controller.emit('track', {
        track: {
          title: 'x',
          artist: 'Foals',
          album: 'Total Life Forever',
          artUrl: 'http://x/art.jpg',
          albumInfo: {
            country: 'GB',
            date: '2010-05-10',
            trackCount: 11,
            asin: 'B003D7F33Q',
            releaseUrl: null,
            tocUrl: null,
          },
        },
      });

      click($('np-art'));

      assert.equal(
        $('art-dialog-caption').textContent,
        'Total Life Forever · Foals · GB · 2010-05-10 · 11 tracks · ASIN B003D7F33Q',
      );
    });

    it('opens a caption link in the default browser instead of navigating', () => {
      controller.emit('track', {
        track: {
          title: 'x',
          artist: 'Foals',
          album: 'Total Life Forever',
          artUrl: 'http://x/art.jpg',
          albumInfo: {
            country: 'GB',
            date: '2010-05-10',
            trackCount: 11,
            releaseUrl: 'https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67',
            tocUrl: null,
          },
        },
      });
      click($('np-art'));

      const releaseLink = [...$('art-dialog-caption').querySelectorAll('a')].find((a) => a.textContent === 'Release');
      // Not the shared `click()` helper: it dispatches a non-cancelable event,
      // and `preventDefault()` on a non-cancelable one is a silent no-op — jsdom
      // would then try to actually navigate, which it does not implement.
      releaseLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

      assert.deepEqual(bridge.calls, [
        {
          command: 'plugin:shell|open',
          args: { path: 'https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67' },
        },
      ]);
    });

    it('omits the MusicBrainz line entirely when there are no links', () => {
      controller.emit('track', {
        track: {
          title: 'x',
          artist: 'Foals',
          album: 'Total Life Forever',
          artUrl: 'http://x/art.jpg',
          albumInfo: { country: 'GB', date: '2010-05-10', trackCount: 11, releaseUrl: null, tocUrl: null },
        },
      });

      click($('np-art'));

      assert.equal($('art-dialog-caption').querySelector('a'), null);
      assert.ok(!$('art-dialog-caption').textContent.includes('MusicBrainz'));
    });

    it('shows the YouTube thumbnail when there is no local art', () => {
      controller.emit('track', { track: { title: 'x', videoId: 'dQw4w9WgXcQ' } });

      click($('np-art'));

      assert.match($('art-dialog-image').src, /i\.ytimg\.com\/vi\/dQw4w9WgXcQ/);
    });

    it('does nothing when there is no art to show', () => {
      controller.emit('track', { track: { title: 'x' } });

      click($('np-art'));

      assert.equal($('art-dialog').open, false);
    });

    it('closes from the close button', () => {
      controller.emit('track', { track: { title: 'x', artUrl: 'http://x/art.jpg' } });
      click($('np-art'));

      click($('btn-art-close'));

      assert.equal($('art-dialog').open, false);
    });

    it('closes on a click outside the panel', () => {
      controller.emit('track', { track: { title: 'x', artUrl: 'http://x/art.jpg' } });
      click($('np-art'));

      // jsdom reports a zero-size box, so any non-zero point is outside it.
      $('art-dialog').dispatchEvent(
        new window.MouseEvent('click', { clientX: 9999, clientY: 9999, bubbles: true }),
      );

      assert.equal($('art-dialog').open, false);
    });

    describe('maximizing', () => {
      beforeEach(() => {
        controller.emit('track', { track: { title: 'x', artUrl: 'http://x/art.jpg' } });
        click($('np-art'));
      });

      it('toggles the maximized class and aria-pressed on click', () => {
        click($('btn-art-maximize'));

        assert.equal($('art-dialog').classList.contains('art-viewer--maximized'), true);
        assert.equal($('btn-art-maximize').getAttribute('aria-pressed'), 'true');

        click($('btn-art-maximize'));

        assert.equal($('art-dialog').classList.contains('art-viewer--maximized'), false);
        assert.equal($('btn-art-maximize').getAttribute('aria-pressed'), 'false');
      });

      it('resets to not maximized the next time the dialog opens', () => {
        click($('btn-art-maximize'));
        assert.equal($('art-dialog').classList.contains('art-viewer--maximized'), true);

        click($('btn-art-close'));
        click($('np-art'));

        assert.equal($('art-dialog').classList.contains('art-viewer--maximized'), false);
      });
    });
  });

  describe('the clock', () => {
    beforeEach(() => createTransport(controller));

    it('shows position and duration', () => {
      controller.emit('time', { position: 65, duration: 185 });

      assert.equal($('time-cur').textContent, '1:05');
      assert.equal($('time-dur').textContent, '3:05');
      assert.equal($('seek').value, '65');
    });

    it('disables the seek bar for a stream with no known length', () => {
      controller.emit('time', { position: 12, duration: 0 });

      assert.equal($('seek').disabled, true);
      assert.equal($('time-dur').textContent, '0:00');
    });

    it('clamps a position that overshoots the duration', () => {
      controller.emit('time', { position: 999, duration: 185 });
      assert.equal($('seek').value, '185');
    });

    it('leaves the handle alone while it is being dragged', () => {
      const seek = $('seek');
      seek.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));

      controller.emit('time', { position: 42, duration: 185 });

      assert.notEqual(seek.value, '42', 'an incoming update must not fight the drag');
    });

    it('seeks once on release, not on every input', () => {
      const seek = $('seek');
      seek.value = '90';
      seek.dispatchEvent(new window.Event('input', { bubbles: true }));

      assert.deepEqual(controller.log, [], 'dragging alone does not seek');
      assert.equal($('time-cur').textContent, '1:30', 'but the clock previews it');

      seek.dispatchEvent(new window.Event('change', { bubbles: true }));

      assert.deepEqual(controller.calls, [{ method: 'seek', args: [90] }]);
    });
  });

  describe('play state', () => {
    beforeEach(() => createTransport(controller));

    it('relabels the play button as it changes', () => {
      controller.emit('state', { playing: true });

      assert.ok($('btn-play').classList.contains('is-playing'));
      assert.equal($('btn-play').title, 'Pause');
      assert.equal($('btn-play').getAttribute('aria-label'), 'Pause');

      controller.emit('state', { playing: false });

      assert.ok(!$('btn-play').classList.contains('is-playing'));
      assert.equal($('btn-play').title, 'Play');
    });
  });

  describe('queue modes', () => {
    it('disables transport buttons while the queue is empty', () => {
      controller.queue = { length: 0, shuffle: false, repeat: 'off' };
      createTransport(controller);

      for (const id of ['btn-play', 'btn-prev', 'btn-next']) {
        assert.equal($(id).disabled, true, id);
      }
      assert.equal($('btn-shuffle').disabled, false, 'modes stay usable');
    });

    it('disables the mode buttons when there is no source at all', () => {
      createTransport(controller);

      assert.equal($('btn-shuffle').disabled, true);
      assert.equal($('btn-repeat').disabled, true);
    });

    it('reflects shuffle and repeat from the active queue', () => {
      controller.queue = { length: 3, shuffle: true, repeat: 'one' };
      createTransport(controller);

      assert.equal($('btn-shuffle').getAttribute('aria-pressed'), 'true');
      assert.equal($('btn-repeat').dataset.mode, 'one');
      assert.ok($('btn-repeat').classList.contains('is-on'));
      assert.equal($('btn-repeat').title, 'Repeat one');
    });

    it('re-reads them when the source changes', () => {
      controller.queue = { length: 3, shuffle: false, repeat: 'off' };
      createTransport(controller);

      controller.queue = { length: 3, shuffle: true, repeat: 'all' };
      controller.emit('source', { id: 'youtube' });

      assert.equal($('btn-shuffle').getAttribute('aria-pressed'), 'true');
      assert.equal($('btn-repeat').title, 'Repeat all');
    });

    it('cycles repeat off → all → one → off', () => {
      const queue = {
        length: 3,
        shuffle: false,
        repeat: 'off',
        setRepeat(m) {
          this.repeat = m;
        },
        setShuffle(s) {
          this.shuffle = s;
        },
      };
      controller.queue = queue;
      createTransport(controller);

      click($('btn-repeat'));
      assert.equal(queue.repeat, 'all');

      click($('btn-repeat'));
      assert.equal(queue.repeat, 'one');

      click($('btn-repeat'));
      assert.equal(queue.repeat, 'off');
    });

    it('toggles shuffle on the active queue', () => {
      const queue = {
        length: 3,
        shuffle: false,
        repeat: 'off',
        setShuffle(s) {
          this.shuffle = s;
        },
        setRepeat() {},
      };
      controller.queue = queue;
      createTransport(controller);

      click($('btn-shuffle'));

      assert.equal(queue.shuffle, true);
      assert.equal($('btn-shuffle').getAttribute('aria-pressed'), 'true');
    });
  });

  describe('volume', () => {
    beforeEach(() => createTransport(controller));

    it('shows the level, and shows silence while muted', () => {
      controller.emit('volume', { volume: 0.4, muted: false });
      assert.equal($('vol').value, '40');
      assert.equal($('btn-mute').getAttribute('aria-pressed'), 'false');

      controller.emit('volume', { volume: 0.4, muted: true });
      assert.equal($('btn-mute').getAttribute('aria-pressed'), 'true');
      assert.equal($('btn-mute').title, 'Unmute');
    });

    it('passes a dragged level up as a fraction', () => {
      $('vol').value = '25';
      $('vol').dispatchEvent(new window.Event('input', { bubbles: true }));

      assert.deepEqual(controller.calls, [{ method: 'setVolume', args: [0.25] }]);
    });
  });

  describe('buttons', () => {
    beforeEach(() => createTransport(controller));

    it('drive the controller', () => {
      click($('btn-play'));
      click($('btn-prev'));
      click($('btn-next'));
      click($('btn-mute'));

      assert.deepEqual(controller.log, ['toggle', 'prev', 'next', 'toggleMute']);
    });
  });

  describe('keyboard', () => {
    beforeEach(() => createTransport(controller));

    it('plays and pauses on Space', () => {
      keydown('Space');
      assert.deepEqual(controller.log, ['toggle']);
    });

    it('seeks by five seconds with the arrows', () => {
      controller.state.position = 30;
      controller.emit('time', { position: 30, duration: 185 });

      keydown('ArrowRight');
      keydown('ArrowLeft');

      assert.deepEqual(controller.calls, [
        { method: 'seek', args: [35] },
        { method: 'seek', args: [25] },
      ]);
    });

    it('will not seek past either end', () => {
      controller.state.position = 2;
      controller.emit('time', { position: 2, duration: 10 });

      keydown('ArrowLeft');
      assert.deepEqual(controller.calls.at(-1), { method: 'seek', args: [0] });

      controller.state.position = 9;
      keydown('ArrowRight');
      assert.deepEqual(controller.calls.at(-1), { method: 'seek', args: [10] });
    });

    it('steps tracks with shift and the arrows', () => {
      keydown('ArrowRight', { shiftKey: true });
      keydown('ArrowLeft', { shiftKey: true });

      assert.deepEqual(controller.log, ['next', 'prev']);
    });

    it('changes volume with the up and down arrows', () => {
      keydown('ArrowUp');
      keydown('ArrowDown');

      assert.deepEqual(controller.calls, [
        { method: 'setVolume', args: [0.8500000000000001] },
        { method: 'setVolume', args: [0.75] },
      ]);
    });

    it('mutes on M', () => {
      keydown('KeyM');
      assert.deepEqual(controller.log, ['toggleMute']);
    });

    it('never steals a key from a text field', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);

      input.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));

      assert.deepEqual(controller.log, [], 'Space belongs to whoever is typing');
    });

    it('leaves shortcuts with a modifier to the OS', () => {
      keydown('Space', { ctrlKey: true });
      keydown('KeyM', { metaKey: true });

      assert.deepEqual(controller.log, []);
    });
  });
});
