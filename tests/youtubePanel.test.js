import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { Controller } from '../src/core/controller.js';
import { Queue } from '../src/core/queue.js';
import { FakeAdapter } from './helpers/fakeAdapter.js';
import { click, installDom } from './helpers/dom.js';

let createYouTubePanel;

const MARKUP = `
  <section id="panel-youtube">
    <form id="yt-form"><input id="yt-input" /><button type="submit">Add</button></form>
    <div class="video-frame"><div id="yt-mount"></div></div>
    <span id="count-youtube">0</span>
    <ol id="queue-youtube"></ol>
  </section>
`;

const ID = 'iR-K2rUP86M';
const OTHER = 'vfp003u_BWU';

before(async () => {
  installDom(MARKUP);
  ({ createYouTubePanel } = await import('../src/ui/youtubePanel.js'));
});

let controller;
let adapter;
let queue;
let status;

/** Build the panel over a real controller and queue. */
function setup() {
  document.body.innerHTML = MARKUP;

  controller = new Controller();
  adapter = new FakeAdapter();
  queue = new Queue('youtube');
  status = [];

  controller.register('youtube', adapter, queue);
  createYouTubePanel(controller, queue, {
    setStatus: (message, isError = false) => status.push({ message, isError }),
  });

  return controller.setActive('youtube');
}

const $ = (id) => document.getElementById(id);
const rows = () => document.querySelectorAll('#queue-youtube li.row');

/** Paste a link and submit the form, the way the user adds a video. */
async function add(value) {
  $('yt-input').value = value;
  $('yt-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  // The submit handler is async.
  await new Promise((r) => setImmediate(r));
}

beforeEach(setup);

describe('createYouTubePanel', () => {
  describe('adding a link', () => {
    it('queues the video and clears the box', async () => {
      await add(`https://www.youtube.com/watch?v=${ID}`);

      assert.equal(queue.length, 1);
      assert.equal(queue.items[0].videoId, ID);
      assert.equal(queue.items[0].source, 'youtube');
      assert.equal($('yt-input').value, '', 'ready for the next paste');
    });

    it('shows the video id until the real title arrives', async () => {
      await add(ID);

      assert.equal(rows()[0].querySelector('.row__name').textContent, ID);

      adapter.describe({ title: 'Never Gonna Give You Up', duration: 213 });

      assert.equal(
        rows()[0].querySelector('.row__name').textContent,
        'Never Gonna Give You Up',
        'the row rewrites itself',
      );
    });

    it('starts playing the first video, but only joins the queue after that', async () => {
      await add(ID);
      assert.equal(adapter.loadedTrack?.videoId, ID, 'the first add plays');

      await add(OTHER);
      assert.equal(adapter.loadedTrack?.videoId, ID, 'the second only queues');
      assert.equal(queue.length, 2);
      assert.ok(status.some((s) => s.message === 'Added to the queue.'));
    });

    it('rejects something that is not a YouTube link', async () => {
      await add('play something nice');

      assert.equal(queue.length, 0);
      assert.deepEqual(status.at(-1), {
        message: "That doesn't look like a YouTube link or video id.",
        isError: true,
      });
    });

    it('rejects a Shorts link, since only ordinary videos are supported', async () => {
      await add(`https://www.youtube.com/shorts/${ID}`);

      assert.equal(queue.length, 0);
      assert.equal(status.at(-1).isError, true);
    });

    it('says playlists are not expanded when a link carries one', async () => {
      await add(`https://www.youtube.com/watch?v=${ID}&list=PL123`);

      assert.equal(queue.length, 1, 'the linked video is still added');
      assert.ok(status.some((s) => /Whole playlists are not supported/.test(s.message)));
    });
  });

  describe('the queue pane', () => {
    it('keeps the count in step', async () => {
      assert.equal($('count-youtube').textContent, '0');

      await add(ID);
      assert.equal($('count-youtube').textContent, '1');

      await add(OTHER);
      assert.equal($('count-youtube').textContent, '2');
    });

    it('offers the empty state when nothing is cued', () => {
      const empty = document.querySelector('#queue-youtube li.empty');
      assert.match(empty.textContent, /Nothing cued\.Paste a YouTube link above\./);
    });

    it('plays the row that is clicked', async () => {
      await add(ID);
      await add(OTHER);

      click(rows()[1]);
      await new Promise((r) => setImmediate(r));

      assert.equal(adapter.loadedTrack.videoId, OTHER);
    });

    it('removes a track, and advances when it was the one playing', async () => {
      await add(ID);
      await add(OTHER);

      click(rows()[0].querySelector('button'));
      await new Promise((r) => setImmediate(r));

      assert.equal(queue.length, 1);
      assert.equal(adapter.loadedTrack.videoId, OTHER, 'playback followed the removal');
    });

    it('settles when the last track is removed', async () => {
      await add(ID);

      click(rows()[0].querySelector('button'));
      await new Promise((r) => setImmediate(r));

      assert.equal(queue.length, 0);
      assert.equal(controller.state.playing, false);
      assert.ok(document.querySelector('#queue-youtube li.empty'), 'back to the empty state');
    });
  });

  describe('the player frame', () => {
    it('stays hidden until something is cued', () => {
      assert.ok(!document.querySelector('.video-frame').classList.contains('is-loaded'));
    });

    it('is revealed once a video is cued', async () => {
      await add(ID);
      assert.ok(document.querySelector('.video-frame').classList.contains('is-loaded'));
    });

    it('is hidden again when the queue empties', async () => {
      await add(ID);
      queue.clear();

      assert.ok(!document.querySelector('.video-frame').classList.contains('is-loaded'));
    });
  });
});
