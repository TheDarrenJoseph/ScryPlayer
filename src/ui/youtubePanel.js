import { parseYouTube } from '../sources/youtube.js';
import { renderQueue } from './queueList.js';

const $ = (id) => document.getElementById(id);

/**
 * The YouTube source: a link box above the embedded player, its queue beside it.
 *
 * Titles are unknown at the moment a link is pasted — the queue shows the video
 * id until the player reports back, at which point the adapter emits `meta` and
 * the row rewrites itself.
 */
export function createYouTubePanel(controller, queue, { setStatus }) {
  const form = $('yt-form');
  const input = $('yt-input');
  const frame = document.querySelector('.video-frame');
  const queueEl = $('queue-youtube');
  const countEl = $('count-youtube');

  function paintQueue() {
    countEl.textContent = String(queue.length);
    renderQueue(queueEl, queue, {
      playing: controller.state.playing && controller.activeId === 'youtube',
      onPlay: async (i) => {
        await controller.setActive('youtube');
        await controller.playAt(i);
      },
      onRemove: (i) => queue.removeAt(i),
      emptyLines: ['Nothing cued.', 'Paste a YouTube link above.'],
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const parsed = parseYouTube(input.value);
    if (!parsed) {
      setStatus("That doesn't look like a YouTube link or video id.", true);
      return;
    }

    const wasEmpty = queue.length === 0;
    queue.add([
      {
        source: 'youtube',
        videoId: parsed.videoId,
        // A placeholder until the player tells us the real title.
        title: parsed.videoId,
        artist: null,
        duration: null,
      },
    ]);
    input.value = '';

    if (parsed.playlistId) {
      setStatus('Added the video. Whole playlists are not supported yet.');
    }

    // A first add starts playing; later ones just join the queue.
    if (wasEmpty) {
      await controller.setActive('youtube');
      await controller.playAt(0);
    } else if (!parsed.playlistId) {
      setStatus('Added to the queue.');
    }
  });

  $('btn-clear-youtube').addEventListener('click', () => queue.clear());

  // Reveal the iframe only once something is actually cued, so the empty state
  // is not a black rectangle.
  controller.on('track', ({ track, sourceId }) => {
    if (sourceId !== 'youtube' || !track) return;
    frame.classList.add('is-loaded');
  });

  queue.on('change', () => {
    if (!queue.length) frame.classList.remove('is-loaded');
    paintQueue();
  });
  controller.on('state', paintQueue);
  controller.on('source', paintQueue);

  paintQueue();
}
