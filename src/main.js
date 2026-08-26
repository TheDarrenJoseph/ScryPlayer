import { Controller } from './core/controller.js';
import { Queue } from './core/queue.js';
import { LocalAdapter } from './sources/localAdapter.js';
import { YouTubeAdapter } from './sources/youtubeAdapter.js';
import { createLocalPanel } from './ui/localPanel.js';
import { createPicker } from './ui/picker.js';
import { createStatus } from './ui/status.js';
import { createSettings, loadSettings } from './ui/settings.js';
import { createTransport } from './ui/transport.js';
import { createYouTubePanel } from './ui/youtubePanel.js';
import { startWater } from './ui/water.js';
import { invoke } from './tauri.js';

const STORE_KEY = 'scry.v1';
/** A scan can return thousands of tracks; localStorage cannot hold them all. */
const MAX_PERSISTED = 500;
const SAVE_DEBOUNCE_MS = 400;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function main() {
  const settings = loadSettings();

  const waterEl = document.getElementById('water');
  let disposeWater = null;

  function applyWater() {
    // Hidden rather than cleared: the page background shows through, where
    // clearing an opaque canvas would leave a black rectangle instead. Set
    // before starting, since a hidden canvas measures zero and would never
    // reach a size worth drawing into.
    waterEl.hidden = !settings.water;

    // Only the transitions touch the animation itself, so calling this on
    // every settings change is free.
    if (settings.water && !disposeWater) {
      disposeWater = startWater(waterEl);
    } else if (!settings.water && disposeWater) {
      disposeWater();
      disposeWater = null;
    }
  }

  applyWater();
  const setStatus = createStatus();

  const controller = new Controller();
  const localQueue = new Queue('local');
  const youtubeQueue = new Queue('youtube');

  controller.register('local', new LocalAdapter(), localQueue);
  controller.register(
    'youtube',
    new YouTubeAdapter(document.getElementById('yt-mount')),
    youtubeQueue,
  );

  createTransport(controller);
  const localPanel = createLocalPanel(controller, localQueue, { setStatus });
  createYouTubePanel(controller, youtubeQueue, { setStatus });

  // Both panels clear the same way; each button names the queue it empties.
  for (const button of document.querySelectorAll('.btn-clear-playlist')) {
    button.addEventListener('click', () => controller.clearQueue(button.dataset.source));
  }

  controller.on('error', ({ message }) => setStatus(message, true));

  // ── Restore the last session ─────────────────────────────

  const saved = loadState();

  // The queues and the chosen source are the session; volume is a preference
  // and comes back either way, since nobody means "and reset my volume" by
  // turning this off.
  if (settings.restoreSession) {
    if (saved.localQueue) localQueue.restore(saved.localQueue);
    if (saved.youtubeQueue) youtubeQueue.restore(saved.youtubeQueue);

    // Asset-scope grants do not survive a restart, so restored local tracks
    // have to be re-granted before anything tries to play them.
    const restored = localQueue.items.map((t) => t.path).filter(Boolean);
    if (restored.length) {
      invoke('grant_paths', { paths: restored }).catch((err) => {
        setStatus(`Could not restore access to the previous queue: ${err}`, true);
      });
    }
  }

  // Volume first, so whichever source becomes active inherits it.
  controller.setVolume(typeof saved.volume === 'number' ? saved.volume : 0.8);
  controller.setMuted(!!saved.muted);

  const picker = createPicker(controller);
  const startingSource = settings.restoreSession ? saved.source : null;
  picker.select(startingSource === 'youtube' ? 'youtube' : 'local');

  localPanel.init();

  // ── Persist ──────────────────────────────────────────────

  let saveTimer = 0;

  function snapshotQueue(queue) {
    const snap = queue.toJSON();
    return { ...snap, items: snap.items.slice(0, MAX_PERSISTED) };
  }

  function write() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          version: 1,
          source: controller.activeId,
          volume: controller.volume,
          muted: controller.muted,
          localQueue: snapshotQueue(localQueue),
          youtubeQueue: snapshotQueue(youtubeQueue),
        }),
      );
    } catch {
      // Out of quota, or storage disabled. Losing the restored session is not
      // worth interrupting playback over.
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, SAVE_DEBOUNCE_MS);
  }

  controller.on('queue', persist);
  controller.on('volume', persist);
  controller.on('source', persist);
  window.addEventListener('beforeunload', write);

  // ── Settings ─────────────────────────────────────────────

  createSettings(settings, {
    onChange: applyWater,
    onForget: () => {
      clearTimeout(saveTimer); // A queued save would write the session straight back.
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {
        // Nothing saved is the state we wanted anyway.
      }
    },
  });
}

main();
