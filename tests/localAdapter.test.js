import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { installDom } from './helpers/dom.js';

let LocalAdapter;

/**
 * Answers for the Rust commands, and a log of what was asked.
 *
 * `tauri.js` reads `window.__TAURI__` at import time and throws without it,
 * so this has to be installed before `localAdapter.js` is imported.
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
  const { window } = installDom();
  window.__TAURI__ = { core: { invoke: bridge.invoke } };

  ({ LocalAdapter } = await import('../src/sources/localAdapter.js'));
});

const settle = () => new Promise((r) => setImmediate(r));

const NO_INFO = { art: null, country: null, date: null, asin: null, trackCount: null, releaseUrl: null, tocUrl: null };

const track = (over = {}) => ({
  path: '/music/song.mp3',
  fileName: 'song.mp3',
  title: 'Song',
  artist: 'Massive Attack',
  album: 'Mezzanine',
  ...over,
});

let adapter;
let metaEvents;

beforeEach(() => {
  bridge.calls = [];
  bridge.handlers = {
    media_url: () => 'http://127.0.0.1:1234/media?token=abc&path=%2Fmusic%2Fsong.mp3',
    art_url: (args) => `http://127.0.0.1:1234/art?token=abc&path=${encodeURIComponent(args.path)}`,
    lookup_local_album_info: () => NO_INFO,
  };

  metaEvents = [];
  adapter = new LocalAdapter({ settings: { localAlbumInfoLookup: true } });
  adapter.on('meta', (patch) => metaEvents.push(patch));
});

describe('LocalAdapter', () => {
  describe('local album info lookup', () => {
    it('asks for album info keyed by the track and emits it onto meta', async () => {
      bridge.handlers.lookup_local_album_info = () => ({
        ...NO_INFO,
        country: 'GB',
        date: '2010-05-10',
        asin: 'B003D7F33Q',
        trackCount: 11,
        releaseUrl: 'https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67',
      });

      await adapter.load(track(), { autoplay: false });
      await settle();

      const call = bridge.calls.find((c) => c.command === 'lookup_local_album_info');
      assert.deepEqual(call.args, { releaseId: null, artist: 'Massive Attack', album: 'Mezzanine' });

      const patch = metaEvents.find((p) => p.albumInfo);
      assert.deepEqual(patch.albumInfo, {
        country: 'GB',
        date: '2010-05-10',
        asin: 'B003D7F33Q',
        releaseUrl: 'https://musicbrainz.org/release/507b4cda-bebd-468e-a1fc-f8873f162f67',
        tocUrl: null,
        trackCount: 11,
      });
    });

    it('passes the embedded MusicBrainz release id when the file has one', async () => {
      await adapter.load(track({ releaseId: '507b4cda-bebd-468e-a1fc-f8873f162f67' }), { autoplay: false });
      await settle();

      const call = bridge.calls.find((c) => c.command === 'lookup_local_album_info');
      assert.equal(call.args.releaseId, '507b4cda-bebd-468e-a1fc-f8873f162f67');
    });

    it('uses MusicBrainz art when the file has no folder cover of its own', async () => {
      bridge.handlers.lookup_local_album_info = () => ({ ...NO_INFO, art: '/cache/album_art/abc123.jpg' });

      await adapter.load(track(), { autoplay: false });
      await settle();

      const patch = metaEvents.find((p) => p.artUrl);
      assert.match(patch.artUrl, /abc123\.jpg/);
    });

    it('never lets MusicBrainz art override a folder cover', async () => {
      bridge.handlers.lookup_local_album_info = () => ({ ...NO_INFO, art: '/cache/album_art/abc123.jpg' });

      await adapter.load(track({ art: '/music/cover.jpg' }), { autoplay: false });
      await settle();

      // Only the folder cover's own artUrl patch, never MusicBrainz's.
      const artPatches = metaEvents.filter((p) => p.artUrl);
      assert.equal(artPatches.length, 1);
      assert.match(artPatches[0].artUrl, /cover\.jpg/);
    });

    it('never asks when the setting is off', async () => {
      adapter = new LocalAdapter({ settings: { localAlbumInfoLookup: false } });

      await adapter.load(track(), { autoplay: false });
      await settle();

      assert.ok(!bridge.calls.some((c) => c.command === 'lookup_local_album_info'));
    });

    it('never asks when there is neither a release id nor an artist/album pair', async () => {
      await adapter.load(track({ artist: undefined, album: undefined }), { autoplay: false });
      await settle();

      assert.ok(!bridge.calls.some((c) => c.command === 'lookup_local_album_info'));
    });

    it('leaves meta untouched when nothing at all came back', async () => {
      await adapter.load(track(), { autoplay: false });
      await settle();

      assert.ok(!metaEvents.some((p) => 'albumInfo' in p || 'artUrl' in p));
    });

    it('ignores a late answer after a newer track started loading', async () => {
      // One resolver per call, so the stale (first) one can be answered
      // independently of whatever the second, current load is waiting on.
      const resolvers = [];
      bridge.handlers.lookup_local_album_info = () => new Promise((r) => resolvers.push(r));

      await adapter.load(track(), { autoplay: false });
      await adapter.load(track({ path: '/music/other.mp3', album: 'Other Album' }), { autoplay: false });

      resolvers[0]({ ...NO_INFO, country: 'GB' }); // the stale, first lookup answers late
      await settle();

      assert.ok(!metaEvents.some((p) => p.albumInfo), 'the stale lookup did not land');
    });
  });
});
