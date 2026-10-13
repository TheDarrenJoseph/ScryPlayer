import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { Controller } from '../src/core/controller.js';
import { Queue } from '../src/core/queue.js';
import { FakeAdapter } from './helpers/fakeAdapter.js';
import { click, installDom } from './helpers/dom.js';

let createCdPanel;

const MARKUP = `
  <section id="panel-cd">
    <button id="btn-scan-cd">Scan disc</button>
    <span id="count-cd">0</span>
    <ol id="queue-cd"></ol>
  </section>
`;

/**
 * Answers for the Rust commands, and a log of what was asked.
 *
 * `tauri.js` reads `window.__TAURI__` at import time and throws without it, so
 * this has to be installed before the panel is imported.
 */
const bridge = {
  calls: [],
  handlers: {},
  invoke(command, args) {
    bridge.calls.push({ command, args });
    const handler = bridge.handlers[command];
    if (!handler) return Promise.reject(`no stub for ${command}`);
    return Promise.resolve(handler(args));
  },
};

before(async () => {
  const { window } = installDom(MARKUP);
  window.__TAURI__ = { core: { invoke: bridge.invoke } };

  ({ createCdPanel } = await import('../src/ui/cdPanel.js'));
});

const DRIVE = { id: '/dev/sr0' };

const cdTrack = (over = {}) => ({
  drive: '/dev/sr0',
  trackNo: 1,
  startLba: 0,
  endLba: 21_000,
  title: 'Track 1',
  duration: 280,
  ...over,
});

let controller;
let adapter;
let queue;
let status;
let settings;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  bridge.calls = [];
  bridge.handlers = {
    list_cd_drives: () => [DRIVE],
    scan_cd: () => [cdTrack(), cdTrack({ trackNo: 2, title: 'Track 2', startLba: 21_000, endLba: 45_000 })],
    lookup_cd_metadata: () => null,
  };

  controller = new Controller();
  adapter = new FakeAdapter();
  queue = new Queue('cd');
  status = [];
  settings = { cddbLookup: true };

  controller.register('cd', adapter, queue);
  createCdPanel(controller, queue, {
    setStatus: (message, isError = false) => status.push({ message, isError }),
    settings,
  });

  return controller.setActive('cd');
});

const $ = (id) => document.getElementById(id);
const settle = () => new Promise((r) => setImmediate(r));
const rows = () => document.querySelectorAll('#queue-cd li.row');

async function scan() {
  click($('btn-scan-cd'));
  await settle();
}

describe('createCdPanel', () => {
  describe('scanning a disc', () => {
    it('lists every audio track the drive reports', async () => {
      await scan();

      assert.equal(queue.length, 2);
      assert.equal(queue.items[0].title, 'Track 1');
      assert.equal(queue.items[1].title, 'Track 2');
      assert.equal(queue.items[0].source, 'cd');
    });

    it('does not start playback on its own', async () => {
      await scan();

      assert.equal(adapter.loadedTrack, null, 'scanning only populates the queue');
    });

    it('replaces whatever was queued from a previous disc', async () => {
      queue.add([cdTrack({ title: 'Stale track' })]);

      await scan();

      assert.equal(queue.length, 2);
      assert.ok(!queue.items.some((t) => t.title === 'Stale track'));
    });

    it('stops playback before replacing the queue, in case the disc was swapped', async () => {
      await scan();
      await controller.playAt(0);
      assert.equal(controller.state.playing, true, 'sanity check: it was playing');

      bridge.handlers.scan_cd = () => [cdTrack({ title: 'A different disc entirely' })];
      await scan();

      assert.equal(controller.state.playing, false, 'the old track is not left streaming');
      assert.equal(queue.items[0].title, 'A different disc entirely');
    });

    it('reports how many tracks were found', async () => {
      await scan();

      assert.deepEqual(status.at(-1), { message: 'Found 2 tracks.', isError: false });
    });

    it('says so when no drive is found', async () => {
      bridge.handlers.list_cd_drives = () => [];

      await scan();

      assert.equal(queue.length, 0);
      assert.deepEqual(status.at(-1), { message: 'No CD drive found.', isError: true });
    });

    it('says so when the disc has no audio tracks', async () => {
      bridge.handlers.scan_cd = () => [];

      await scan();

      assert.equal(queue.length, 0);
      assert.deepEqual(status.at(-1), { message: 'No audio tracks found on that disc.', isError: true });
    });

    it('surfaces a failed read without throwing', async () => {
      bridge.handlers.scan_cd = () => Promise.reject('tray is open');

      await assert.doesNotReject(scan);

      assert.deepEqual(status.at(-1), { message: 'tray is open', isError: true });
      assert.equal(queue.length, 0);
    });
  });

  describe('GnuDB enrichment', () => {
    it('patches titles, artist and album once GnuDB answers', async () => {
      bridge.handlers.lookup_cd_metadata = () => ({
        artist: 'Fleetwood Mac',
        album: 'Rumours',
        trackTitles: ['Second Hand News', 'Dreams'],
      });

      await scan();

      assert.equal(queue.items[0].title, 'Second Hand News');
      assert.equal(queue.items[1].title, 'Dreams');
      assert.equal(queue.items[0].artist, 'Fleetwood Mac');
      assert.equal(queue.items[0].album, 'Rumours');
    });

    it('leaves the TOC placeholders when GnuDB has no match', async () => {
      bridge.handlers.lookup_cd_metadata = () => null;

      await scan();

      assert.equal(queue.items[0].title, 'Track 1');
      assert.equal(queue.items[0].artist, undefined, 'no artist arrives without a match');
    });

    it('never asks GnuDB when the setting is off', async () => {
      settings.cddbLookup = false;

      await scan();

      assert.ok(!bridge.calls.some((c) => c.command === 'lookup_cd_metadata'));
    });

    it('ignores a late answer after the disc was rescanned', async () => {
      let resolveFirst;
      bridge.handlers.lookup_cd_metadata = () => new Promise((r) => (resolveFirst = r));

      await scan();

      // A second scan replaces the queue before the first lookup answers.
      bridge.handlers.lookup_cd_metadata = () => null;
      bridge.handlers.scan_cd = () => [cdTrack({ title: 'Other disc track' })];
      await scan();

      resolveFirst({ artist: 'Wrong', album: 'Wrong', trackTitles: ['Wrong'] });
      await settle();

      assert.equal(queue.length, 1, 'the second scan replaced the queue');
      assert.equal(queue.items[0].title, 'Other disc track', 'the stale lookup did not overwrite it');
    });
  });

  describe('the queue pane', () => {
    it('keeps the count in step', async () => {
      assert.equal($('count-cd').textContent, '0');

      await scan();

      assert.equal($('count-cd').textContent, '2');
    });

    it('offers the empty state when nothing is queued', () => {
      const empty = document.querySelector('#queue-cd li.empty');
      assert.match(empty.textContent, /No disc cued\./);
    });

    it('plays the track that is clicked', async () => {
      await scan();

      click(rows()[1]);
      await settle();

      assert.equal(adapter.loadedTrack.title, 'Track 2');
    });

    it('removes a track, advancing when it was the one playing', async () => {
      await scan();
      await controller.playAt(0);

      click(rows()[0].querySelector('button'));
      await settle();

      assert.equal(queue.length, 1);
      assert.equal(adapter.loadedTrack.title, 'Track 2', 'playback followed the removal');
    });
  });
});
