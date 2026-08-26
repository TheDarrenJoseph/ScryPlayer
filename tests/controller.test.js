import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { Controller } from '../src/core/controller.js';
import { Queue } from '../src/core/queue.js';
import { FakeAdapter, record, tracks } from './helpers/fakeAdapter.js';

/**
 * A controller with two registered sources, mirroring the real app.
 *
 * `local` is made active and filled with `n` tracks; `youtube` stays in the
 * background so tests can check that a background source is left alone.
 */
async function setup({ local = 3, youtube = 0, play = null } = {}) {
  const controller = new Controller();

  const localAdapter = new FakeAdapter();
  const youtubeAdapter = new FakeAdapter();
  const localQueue = new Queue('local');
  const youtubeQueue = new Queue('youtube');

  controller.register('local', localAdapter, localQueue);
  controller.register('youtube', youtubeAdapter, youtubeQueue);

  localQueue.add(tracks(local));
  youtubeQueue.add(tracks(youtube));

  await controller.setActive('local');
  if (play != null) await controller.playAt(play);

  // Calls made during setup are noise for the assertions that follow.
  localAdapter.calls.length = 0;
  youtubeAdapter.calls.length = 0;

  return { controller, localAdapter, youtubeAdapter, localQueue, youtubeQueue };
}

const playing = (adapter) => adapter.loadedTrack?.title ?? null;

describe('Controller', () => {
  describe('setActive', () => {
    it('releases the source it is leaving', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });

      await controller.setActive('youtube');

      assert.deepEqual(localAdapter.log, ['release']);
      assert.equal(controller.activeId, 'youtube');
    });

    it('ignores an unknown source and a no-op switch', async () => {
      const { controller, localAdapter } = await setup();

      await controller.setActive('spotify');
      await controller.setActive('local');

      assert.deepEqual(localAdapter.log, []);
      assert.equal(controller.activeId, 'local');
    });

    it('hands the new source the current volume and mute state', async () => {
      const { controller, youtubeAdapter } = await setup();

      controller.setVolume(0.5);
      controller.setMuted(true);
      youtubeAdapter.calls.length = 0;

      await controller.setActive('youtube');

      assert.deepEqual(youtubeAdapter.calls[0], { method: 'setVolume', args: [0] });
      assert.deepEqual(youtubeAdapter.calls[1], { method: 'setMuted', args: [true] });
    });

    it('announces the switch so every pane can repaint', async () => {
      const { controller } = await setup();
      const seen = record(controller, ['source', 'queue', 'track', 'state', 'time']);

      await controller.setActive('youtube');

      assert.deepEqual(
        seen.map((e) => e.type),
        ['source', 'queue', 'track', 'state', 'time'],
      );
    });
  });

  describe('playAt', () => {
    it('cues the track and tells the UI before the source loads', async () => {
      const { controller, localAdapter } = await setup();
      const seen = record(controller, ['track']);

      await controller.playAt(1);

      assert.equal(playing(localAdapter), 'B');
      assert.deepEqual(seen[0].detail, {
        track: localAdapter.loadedTrack,
        index: 1,
        sourceId: 'local',
      });
    });

    it('ignores an index outside the queue', async () => {
      const { controller, localAdapter } = await setup();

      await controller.playAt(9);
      await controller.playAt(-1);
      await controller.playAt(null);

      assert.deepEqual(localAdapter.log, []);
    });

    it('reports a load failure rather than throwing', async () => {
      const { controller, localAdapter } = await setup();
      localAdapter.loadError = 'the file looks damaged';
      const seen = record(controller, ['error']);

      await assert.doesNotReject(() => controller.playAt(0));
      assert.deepEqual(seen[0].detail, { message: 'the file looks damaged' });
    });

    it('can cue without starting sound', async () => {
      const { controller, localAdapter } = await setup();

      await controller.playAt(0, { autoplay: false });

      assert.equal(localAdapter.snapshot().playing, false);
    });
  });

  describe('removeAt', () => {
    it('advances to the next track when the playing one is removed', async () => {
      const { controller, localAdapter, localQueue } = await setup({ play: 1 });

      await controller.removeAt('local', 1);

      assert.equal(playing(localAdapter), 'C', 'playback follows the removal');
      assert.equal(localQueue.length, 2);
      assert.equal(localQueue.current().title, 'C', 'the pane agrees with the sound');
    });

    it('wraps when the playing track is last', async () => {
      const { controller, localAdapter } = await setup({ play: 2 });

      await controller.removeAt('local', 2);

      assert.equal(playing(localAdapter), 'A');
    });

    it('leaves playback alone when another track is removed', async () => {
      const { controller, localAdapter, localQueue } = await setup({ play: 1 });

      await controller.removeAt('local', 0);

      assert.deepEqual(localAdapter.log, [], 'the source is not disturbed');
      assert.equal(localQueue.current().title, 'B', 'the cursor tracks the shift');
    });

    it('settles playback when the last track is removed', async () => {
      const { controller, localAdapter, localQueue } = await setup({ local: 1, play: 0 });
      const seen = record(controller, ['track']);

      await controller.removeAt('local', 0);

      assert.equal(localQueue.length, 0);
      assert.deepEqual(localAdapter.log, ['pause']);
      assert.equal(controller.state.playing, false);
      assert.deepEqual(seen.at(-1).detail, { track: null, index: -1, sourceId: 'local' });
    });

    it('keeps a paused listener paused', async () => {
      const { controller, localAdapter } = await setup({ play: 1 });

      controller.toggle(); // pause
      localAdapter.calls.length = 0;

      await controller.removeAt('local', 1);

      const load = localAdapter.calls.find((c) => c.method === 'load');
      assert.equal(load.args[1].autoplay, false, 'the next track is cued, not started');
    });

    it('does not touch playback for a background source', async () => {
      const { controller, localAdapter, youtubeAdapter, youtubeQueue } = await setup({
        youtube: 3,
        play: 0,
      });
      youtubeQueue.setIndex(1);

      await controller.removeAt('youtube', 1);

      assert.equal(youtubeQueue.length, 2);
      assert.deepEqual(youtubeAdapter.log, []);
      assert.deepEqual(localAdapter.log, [], 'the playing source is untouched');
    });

    it('ignores an unknown source and an out-of-range index', async () => {
      const { controller, localAdapter, localQueue } = await setup({ play: 0 });

      await controller.removeAt('spotify', 0);
      await controller.removeAt('local', 9);
      await controller.removeAt('local', -1);

      assert.equal(localQueue.length, 3);
      assert.deepEqual(localAdapter.log, []);
    });

    // The permutation is random, and wrapping a shuffled queue draws a fresh
    // one that can name the track being removed.
    it('always lands on a surviving track when shuffled', async () => {
      for (let run = 0; run < 100; run++) {
        const { controller, localAdapter, localQueue } = await setup({ local: 5 });
        localQueue.setShuffle(true);

        const at = Math.floor(Math.random() * 5);
        await controller.playAt(at);
        const removed = localAdapter.loadedTrack.title;

        await controller.removeAt('local', at);

        assert.notEqual(playing(localAdapter), removed, 'the removed track must not play on');
        assert.ok(
          localQueue.items.some((t) => t.title === playing(localAdapter)),
          `played ${playing(localAdapter)}, which is not in the queue`,
        );
      }
    });
  });

  describe('clearQueue', () => {
    it('empties the queue and settles playback', async () => {
      const { controller, localAdapter, localQueue } = await setup({ play: 0 });
      const seen = record(controller, ['track']);

      controller.clearQueue('local');

      assert.equal(localQueue.length, 0);
      assert.deepEqual(localAdapter.log, ['pause']);
      assert.equal(controller.state.playing, false);
      assert.deepEqual(seen.at(-1).detail, { track: null, index: -1, sourceId: 'local' });
    });

    it('leaves the playing source alone when a background queue is cleared', async () => {
      const { controller, localAdapter, youtubeQueue } = await setup({ youtube: 2, play: 0 });
      const seen = record(controller, ['track']);

      controller.clearQueue('youtube');

      assert.equal(youtubeQueue.length, 0);
      assert.deepEqual(localAdapter.log, [], 'local keeps playing');
      assert.equal(seen.length, 0, 'the now-playing display is not reset');
    });

    it('ignores an unknown source', async () => {
      const { controller, localQueue } = await setup();
      controller.clearQueue('spotify');
      assert.equal(localQueue.length, 3);
    });
  });

  describe('stop', () => {
    it('pauses and returns the transport to zero', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });
      localAdapter.tick(42, 100);

      const seen = record(controller, ['state', 'time']);
      controller.stop();

      assert.deepEqual(localAdapter.log, ['pause']);
      assert.deepEqual(controller.state, { playing: false, position: 0, duration: 0 });

      // A source that echoes its own pause produces a second 'state', which is
      // why the count is not asserted: the explicit emit is what makes the
      // stop synchronous for sources that report back late, like YouTube.
      assert.equal(seen.filter((e) => e.type === 'state').every((e) => !e.detail.playing), true);
      assert.deepEqual(seen.findLast((e) => e.type === 'time').detail, {
        position: 0,
        duration: 0,
      });
    });

    it('works on an empty queue, so callers may stop before or after clearing', async () => {
      const { controller, localAdapter, localQueue } = await setup({ play: 0 });

      localQueue.clear();
      assert.doesNotThrow(() => controller.stop());
      assert.deepEqual(localAdapter.log, ['pause']);
    });

    it('does nothing with no source registered', () => {
      assert.doesNotThrow(() => new Controller().stop());
    });
  });

  describe('toggle', () => {
    it('starts the first track when nothing is cued', async () => {
      const { controller, localAdapter } = await setup();

      await controller.toggle();

      assert.equal(playing(localAdapter), 'A');
    });

    it('pauses what is playing and resumes what is paused', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });

      controller.toggle();
      assert.deepEqual(localAdapter.log, ['pause']);

      controller.toggle();
      assert.deepEqual(localAdapter.log, ['pause', 'play']);
    });

    it('does nothing with an empty queue', async () => {
      const { controller, localAdapter, localQueue } = await setup();
      localQueue.clear();

      controller.toggle();

      assert.deepEqual(localAdapter.log, []);
    });

    it('loads rather than resumes when the cued track was never loaded', async () => {
      const { controller, localAdapter, localQueue } = await setup();
      localQueue.setIndex(1);

      await controller.toggle();

      assert.equal(playing(localAdapter), 'B', 'a cued-but-unloaded track is loaded');
    });
  });

  describe('next and prev', () => {
    it('walks forward through the queue', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });

      await controller.next();

      assert.equal(playing(localAdapter), 'B');
    });

    it('restarts the track on the first press, then steps back', async () => {
      const { controller, localAdapter } = await setup({ play: 1 });

      localAdapter.tick(30);
      await controller.prev();
      assert.deepEqual(localAdapter.log.at(-1), 'seek', 'far in, so restart');

      localAdapter.tick(1);
      await controller.prev();
      assert.equal(playing(localAdapter), 'A', 'near the start, so step back');
    });

    it('settles at the end of the queue when a track ends and repeat is off', async () => {
      const { controller, localAdapter } = await setup({ play: 2 });
      const seen = record(controller, ['state']);

      localAdapter.finish();

      assert.equal(controller.state.playing, false);
      assert.equal(seen.at(-1).detail.playing, false);
    });

    it('rolls onto the next track when one ends mid-queue', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });

      localAdapter.finish();
      await new Promise((r) => setImmediate(r)); // #advance is async

      assert.equal(playing(localAdapter), 'B');
    });
  });

  describe('volume', () => {
    it('clamps to 0..1 and passes the level down', async () => {
      const { controller, localAdapter } = await setup();

      controller.setVolume(5);
      assert.equal(controller.volume, 1);

      controller.setVolume(-2);
      assert.equal(controller.volume, 0);

      assert.deepEqual(localAdapter.calls.at(-2), { method: 'setVolume', args: [0] });
    });

    it('treats nudging the slider up as an unmute', async () => {
      const { controller } = await setup();

      controller.setMuted(true);
      controller.setVolume(0.4);

      assert.equal(controller.muted, false);
    });

    it('outputs silence while muted without losing the level', async () => {
      const { controller, localAdapter } = await setup();

      controller.setVolume(0.6);
      localAdapter.calls.length = 0;
      controller.setMuted(true);

      assert.deepEqual(localAdapter.calls[0], { method: 'setVolume', args: [0] });
      assert.equal(controller.volume, 0.6, 'the remembered level is unchanged');
    });

    it('toggles', async () => {
      const { controller } = await setup();

      controller.toggleMute();
      assert.equal(controller.muted, true);

      controller.toggleMute();
      assert.equal(controller.muted, false);
    });
  });

  describe('background sources', () => {
    let ctx;

    beforeEach(async () => {
      ctx = await setup({ youtube: 2, play: 0 });
    });

    it('ignores time from a source that is not active', () => {
      const seen = record(ctx.controller, ['time']);

      ctx.youtubeAdapter.tick(55, 200);

      assert.equal(seen.length, 0);
      assert.equal(ctx.controller.state.position, 0);
    });

    it('ignores state, errors and ended from a source that is not active', () => {
      const seen = record(ctx.controller, ['state', 'error', 'track']);

      ctx.youtubeAdapter.play();
      ctx.youtubeAdapter.fail('background trouble');
      ctx.youtubeAdapter.finish();

      assert.equal(seen.length, 0);
    });
  });

  describe('late-arriving metadata', () => {
    it('folds a real title into the cued track and repaints', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });
      const seen = record(controller, ['track', 'queue']);

      localAdapter.describe({ title: 'The Real Title', duration: 217 });

      assert.equal(localAdapter.loadedTrack.title, 'The Real Title');
      assert.equal(localAdapter.loadedTrack.duration, 217);
      assert.deepEqual(seen.map((e) => e.type), ['queue', 'track']);
    });

    it('is ignored when nothing is cued', async () => {
      const { controller, localAdapter, localQueue } = await setup();
      localQueue.setIndex(-1);
      const seen = record(controller, ['track']);

      localAdapter.describe({ title: 'nobody asked' });

      assert.equal(seen.length, 0);
    });
  });

  describe('seek', () => {
    it('moves the source and the transport together', async () => {
      const { controller, localAdapter } = await setup({ play: 0 });
      const seen = record(controller, ['time']);

      controller.seek(90);

      assert.deepEqual(localAdapter.calls.at(-1), { method: 'seek', args: [90] });
      assert.equal(controller.state.position, 90);
      assert.equal(seen.at(-1).detail.position, 90);
    });
  });
});
