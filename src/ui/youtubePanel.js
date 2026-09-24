import { parseYouTube, fetchVideoInfo as defaultFetchVideoInfo } from '../sources/youtube.js';
import { renderQueue } from './queueList.js';

const $ = (id) => document.getElementById(id);

/**
 * The YouTube source: a link box above the embedded player, its queue beside it.
 *
 * The real title is unknown at the moment a link is pasted, so the row shows
 * the video id and a background oEmbed lookup swaps in the real name as soon
 * as it lands. The player is a second, independent source of the same detail
 * (it emits `meta` once the video actually loads) — whichever arrives first
 * wins, and the other is a no-op against an already-real title.
 */
export function createYouTubePanel(controller, queue, { setStatus, fetchVideoInfo = defaultFetchVideoInfo }) {
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
      onRemove: (i) => controller.removeAt('youtube', i),
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
    const track = {
      source: 'youtube',
      videoId: parsed.videoId,
      // A placeholder until the oEmbed lookup below, or the player itself,
      // reports the real title.
      title: parsed.videoId,
      artist: null,
      duration: null,
    };
    queue.add([track]);
    input.value = '';

    fetchVideoInfo(parsed.videoId).then((info) => {
      if (!info) return;
      // Someone else already filled this in — the player, most likely,
      // since it started loading the moment this was the first track added.
      if (track.title !== parsed.videoId) return;
      // Removed from the queue before the lookup came back.
      if (!queue.items.includes(track)) return;

      track.title = info.title;
      if (info.artist) track.artist = info.artist;
      queue.emit('change', queue);
    });

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
