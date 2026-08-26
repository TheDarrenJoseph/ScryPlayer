import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { Controller } from '../src/core/controller.js';
import { Queue } from '../src/core/queue.js';
import { FakeAdapter } from './helpers/fakeAdapter.js';
import { click, installDom } from './helpers/dom.js';

let createLocalPanel;

const MARKUP = `
  <section id="panel-local">
    <div id="shortcuts"></div>
    <nav id="crumbs"></nav>
    <ol id="filelist"></ol>
    <button id="btn-pick-folder">Add folder</button>
    <button id="btn-pick-files">Add files</button>
    <span id="count-local">0</span>
    <ol id="queue-local"></ol>
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

  ({ createLocalPanel } = await import('../src/ui/localPanel.js'));
});

const entry = (over = {}) => ({
  name: 'thing',
  path: '/music/thing',
  isDir: false,
  isAudio: true,
  playable: true,
  ...over,
});

const trackFrom = (over = {}) => ({
  path: '/music/a.mp3',
  fileName: 'a.mp3',
  title: 'A',
  duration: 100,
  playable: true,
  ...over,
});

let controller;
let adapter;
let queue;
let status;
let panel;

beforeEach(async () => {
  document.body.innerHTML = MARKUP;
  bridge.calls = [];
  bridge.handlers = {
    shortcuts: () => [{ label: 'Music', path: '/music' }],
    list_dir: ({ path }) => ({
      path: path ?? '/music',
      parent: '/',
      entries: [],
    }),
    load_tracks: ({ paths }) => paths.map((p) => trackFrom({ path: p, fileName: p.split('/').pop() })),
    scan_folder: () => [trackFrom(), trackFrom({ path: '/music/b.mp3', title: 'B' })],
  };

  controller = new Controller();
  adapter = new FakeAdapter();
  queue = new Queue('local');
  status = [];

  controller.register('local', adapter, queue);
  panel = createLocalPanel(controller, queue, {
    setStatus: (message, isError = false) => status.push({ message, isError }),
  });

  await controller.setActive('local');
});

const $ = (id) => document.getElementById(id);
const settle = () => new Promise((r) => setImmediate(r));
const fileRows = () => document.querySelectorAll('#filelist li.row');
const crumbs = () => [...document.querySelectorAll('#crumbs .crumb')].map((c) => c.textContent);

describe('createLocalPanel', () => {
  describe('breadcrumbs', () => {
    it('splits a posix path from the root down', async () => {
      bridge.handlers.list_dir = () => ({ path: '/home/dj/Music', parent: '/home/dj', entries: [] });

      await panel.init();
      await settle();

      assert.deepEqual(crumbs(), ['/', 'home', 'dj', 'Music']);
    });

    it('splits a windows path by drive', async () => {
      bridge.handlers.list_dir = () => ({ path: 'C:\\Users\\dj\\Music', parent: null, entries: [] });

      await panel.init();
      await settle();

      assert.deepEqual(crumbs(), ['C:', 'Users', 'dj', 'Music']);
    });

    it('marks the last crumb as where we are', async () => {
      bridge.handlers.list_dir = () => ({ path: '/home/dj', parent: '/home', entries: [] });

      await panel.init();
      await settle();

      const all = document.querySelectorAll('#crumbs .crumb');
      assert.ok(all[all.length - 1].classList.contains('is-current'));
      assert.ok(!all[0].classList.contains('is-current'));
    });

    it('navigates when a crumb is clicked', async () => {
      bridge.handlers.list_dir = ({ path }) => ({
        path: path ?? '/home/dj/Music',
        parent: null,
        entries: [],
      });

      await panel.init();
      await settle();

      click(document.querySelectorAll('#crumbs .crumb')[1]);
      await settle();

      assert.equal(bridge.calls.at(-1).args.path, '/home');
    });
  });

  describe('the file list', () => {
    it('shows an empty state for a folder with nothing in it', async () => {
      await panel.init();
      await settle();

      const empty = document.querySelector('#filelist li.empty');
      assert.match(empty.textContent, /Nothing here\./);
    });

    it('lists folders and files with the right icons', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'Albums', isDir: true }), entry({ name: 'a.mp3' })],
      });

      await panel.init();
      await settle();

      assert.equal(fileRows().length, 2);
      assert.ok(fileRows()[0].querySelector('.row__icon--folder'), 'a folder icon');
      assert.equal(fileRows()[1].querySelector('.row__icon--folder'), null);
    });

    it('marks a file the WebView cannot decode', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'old.wma', playable: false })],
      });

      await panel.init();
      await settle();

      assert.ok(fileRows()[0].classList.contains('is-unplayable'));
      assert.equal(fileRows()[0].querySelector('.row__sub').textContent, 'Unsupported format');
    });

    it('opens a folder when its row is clicked', async () => {
      bridge.handlers.list_dir = ({ path }) => ({
        path: path ?? '/music',
        parent: '/',
        entries: [entry({ name: 'Albums', path: '/music/Albums', isDir: true })],
      });

      await panel.init();
      await settle();
      click(fileRows()[0]);
      await settle();

      assert.equal(bridge.calls.at(-1).command, 'list_dir');
      assert.equal(bridge.calls.at(-1).args.path, '/music/Albums');
    });

    it('plays a file when its row is clicked', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'a.mp3', path: '/music/a.mp3' })],
      });

      await panel.init();
      await settle();
      click(fileRows()[0]);
      await settle();

      assert.equal(queue.length, 1);
      assert.equal(adapter.loadedTrack.path, '/music/a.mp3', 'and it starts playing');
    });

    it('queues without playing when the add button is used', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'a.mp3', path: '/music/a.mp3' })],
      });

      await panel.init();
      await settle();
      click(fileRows()[0].querySelector('.row__add'));
      await settle();

      assert.equal(queue.length, 1);
      assert.equal(adapter.loadedTrack, null, 'adding must not also play');
      assert.deepEqual(status.at(-1), { message: 'Added 1 track.', isError: false });
    });

    it('scans a whole folder from its add button', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'Albums', path: '/music/Albums', isDir: true })],
      });

      await panel.init();
      await settle();
      click(fileRows()[0].querySelector('.row__add'));
      await settle();

      assert.equal(bridge.calls.at(-1).command, 'scan_folder');
      assert.equal(queue.length, 2);
      assert.deepEqual(status.at(-1), { message: 'Added 2 tracks.', isError: false });
    });

    it('says so when a folder holds no audio', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'Empty', path: '/music/Empty', isDir: true })],
      });
      bridge.handlers.scan_folder = () => [];

      await panel.init();
      await settle();
      click(fileRows()[0].querySelector('.row__add'));
      await settle();

      assert.equal(queue.length, 0);
      assert.deepEqual(status.at(-1), { message: 'No audio found in that folder.', isError: true });
    });
  });

  describe('shortcuts', () => {
    it('offers one chip per place Rust reported', async () => {
      bridge.handlers.shortcuts = () => [
        { label: 'Home', path: '/home/dj' },
        { label: 'Music', path: '/music' },
      ];

      await panel.init();
      await settle();

      assert.deepEqual(
        [...document.querySelectorAll('#shortcuts .chip')].map((c) => c.textContent),
        ['Home', 'Music'],
      );
    });

    it('navigates to a chip when it is clicked', async () => {
      await panel.init();
      await settle();

      click(document.querySelector('#shortcuts .chip'));
      await settle();

      assert.equal(bridge.calls.at(-1).args.path, '/music');
    });
  });

  describe('the queue pane', () => {
    it('keeps the count in step', async () => {
      assert.equal($('count-local').textContent, '0');

      queue.add([trackFrom(), trackFrom()]);

      assert.equal($('count-local').textContent, '2');
    });

    it('offers the empty state when nothing is queued', () => {
      const empty = document.querySelector('#queue-local li.empty');
      assert.match(empty.textContent, /The queue is still\./);
    });

    it('removes a track, advancing when it was the one playing', async () => {
      queue.add([trackFrom({ title: 'A' }), trackFrom({ title: 'B' })]);
      await controller.playAt(0);

      click(document.querySelectorAll('#queue-local li.row')[0].querySelector('button'));
      await settle();

      assert.equal(queue.length, 1);
      assert.equal(adapter.loadedTrack.title, 'B', 'playback followed the removal');
    });
  });

  describe('when Rust reports a failure', () => {
    it('surfaces a failed browse without throwing', async () => {
      bridge.handlers.list_dir = () => Promise.reject('Permission denied');

      await assert.doesNotReject(() => panel.init());
      await settle();

      assert.deepEqual(status.at(-1), { message: 'Permission denied', isError: true });
    });

    it('surfaces a failed read', async () => {
      bridge.handlers.list_dir = () => ({
        path: '/music',
        parent: '/',
        entries: [entry({ name: 'a.mp3', path: '/music/a.mp3' })],
      });
      bridge.handlers.load_tracks = () => Promise.reject(new Error('disk is on fire'));

      await panel.init();
      await settle();
      click(fileRows()[0]);
      await settle();

      assert.deepEqual(status.at(-1), { message: 'disk is on fire', isError: true });
      assert.equal(queue.length, 0);
    });
  });
});
