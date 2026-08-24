import { thumbnailFor } from '../sources/youtube.js';
import { formatTime, joinMeta } from '../util/format.js';

const $ = (id) => document.getElementById(id);

/** Paint the filled portion of a range input. */
function setPct(input, value, max) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  input.style.setProperty('--pct', `${Math.min(100, Math.max(0, pct))}%`);
}

/**
 * The shared transport bar.
 *
 * It talks only to the controller, so it drives local files and YouTube with
 * exactly the same code.
 */
export function createTransport(controller) {
  const playBtn = $('btn-play');
  const prevBtn = $('btn-prev');
  const nextBtn = $('btn-next');
  const shuffleBtn = $('btn-shuffle');
  const repeatBtn = $('btn-repeat');
  const muteBtn = $('btn-mute');
  const seek = $('seek');
  const vol = $('vol');
  const timeCur = $('time-cur');
  const timeDur = $('time-dur');
  const npTitle = $('np-title');
  const npSub = $('np-sub');
  const npArt = $('np-art');

  // While the user drags the seek bar, incoming time updates must not fight
  // them for the handle.
  let scrubbing = false;
  let duration = 0;

  // ── Controller → UI ──────────────────────────────────────

  controller.on('time', ({ position, duration: d }) => {
    duration = Number.isFinite(d) && d > 0 ? d : 0;

    seek.max = String(duration || 1);
    seek.disabled = duration === 0;
    timeDur.textContent = formatTime(duration);

    if (scrubbing) return;
    const clamped = duration ? Math.min(position, duration) : position;
    seek.value = String(clamped);
    timeCur.textContent = formatTime(clamped);
    setPct(seek, clamped, duration);
  });

  controller.on('state', ({ playing }) => {
    playBtn.classList.toggle('is-playing', playing);
    playBtn.title = playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });

  controller.on('track', ({ track }) => {
    if (!track) {
      npTitle.textContent = 'Nothing playing';
      npSub.textContent = 'Still water';
      npArt.style.backgroundImage = '';
      return;
    }

    npTitle.textContent = track.title || track.fileName || 'Unknown';
    npSub.textContent =
      joinMeta(track.artist, track.album) ||
      (track.source === 'youtube' ? 'YouTube' : 'Local file');

    // `videoId` has already been validated against the id pattern, so it is
    // safe to interpolate into a CSS url().
    npArt.style.backgroundImage = track.videoId ? `url("${thumbnailFor(track.videoId)}")` : '';
  });

  controller.on('volume', ({ volume, muted }) => {
    vol.value = String(Math.round(volume * 100));
    setPct(vol, muted ? 0 : volume * 100, 100);
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  });

  /** Shuffle and repeat live on the active source's queue, so re-read on switch. */
  function syncQueueModes() {
    const queue = controller.queue;
    const hasItems = !!queue?.length;

    shuffleBtn.setAttribute('aria-pressed', String(!!queue?.shuffle));
    shuffleBtn.title = queue?.shuffle ? 'Shuffle on' : 'Shuffle off';

    const mode = queue?.repeat ?? 'off';
    repeatBtn.dataset.mode = mode;
    repeatBtn.classList.toggle('is-on', mode !== 'off');
    repeatBtn.title =
      mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat all' : 'Repeat one';

    playBtn.disabled = !hasItems;
    prevBtn.disabled = !hasItems;
    nextBtn.disabled = !hasItems;
    shuffleBtn.disabled = !queue;
    repeatBtn.disabled = !queue;
  }

  controller.on('queue', syncQueueModes);
  controller.on('source', syncQueueModes);

  // ── UI → controller ──────────────────────────────────────

  playBtn.addEventListener('click', () => controller.toggle());
  prevBtn.addEventListener('click', () => controller.prev());
  nextBtn.addEventListener('click', () => controller.next());

  shuffleBtn.addEventListener('click', () => {
    const queue = controller.queue;
    if (!queue) return;
    queue.setShuffle(!queue.shuffle);
    syncQueueModes();
  });

  repeatBtn.addEventListener('click', () => {
    const queue = controller.queue;
    if (!queue) return;
    const order = ['off', 'all', 'one'];
    queue.setRepeat(order[(order.indexOf(queue.repeat) + 1) % order.length]);
    syncQueueModes();
  });

  muteBtn.addEventListener('click', () => controller.toggleMute());

  seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  seek.addEventListener('input', () => {
    const v = Number(seek.value);
    scrubbing = true;
    timeCur.textContent = formatTime(v);
    setPct(seek, v, duration);
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    controller.seek(Number(seek.value));
  });

  vol.addEventListener('input', () => {
    const v = Number(vol.value) / 100;
    setPct(vol, Number(vol.value), 100);
    controller.setVolume(v);
  });

  // ── Keyboard ─────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // Never steal keys from a text field.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        controller.toggle();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) controller.next();
        else controller.seek(Math.min(controller.state.position + 5, duration || Infinity));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) controller.prev();
        else controller.seek(Math.max(controller.state.position - 5, 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        controller.setVolume(controller.volume + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        controller.setVolume(controller.volume - 0.05);
        break;
      case 'KeyM':
        controller.toggleMute();
        break;
      default:
        break;
    }
  });

  syncQueueModes();
}
