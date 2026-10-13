import { listCdDrives, scanCd } from '../tauri.js';
import { renderQueue } from './queueList.js';

const $ = (id) => document.getElementById(id);

const asMessage = (err, fallback) => (typeof err === 'string' ? err : (err?.message ?? fallback));

/**
 * The audio-CD source: a "Scan disc" button above its queue.
 *
 * A disc has nothing to browse — just tracks — so scanning its table of
 * contents is the whole "add to queue" step here, the CD equivalent of
 * local's "Add folder…". Like that button, scanning only populates the
 * queue; it does not start playback on its own.
 */
export function createCdPanel(controller, queue, { setStatus }) {
  const queueEl = $('queue-cd');
  const countEl = $('count-cd');
  const scanBtn = $('btn-scan-cd');

  function paintQueue() {
    countEl.textContent = String(queue.length);
    renderQueue(queueEl, queue, {
      playing: controller.state.playing && controller.activeId === 'cd',
      onPlay: async (i) => {
        await controller.setActive('cd');
        await controller.playAt(i);
      },
      onRemove: (i) => controller.removeAt('cd', i),
      emptyLines: ['No disc cued.', 'Insert an audio CD and scan it.'],
    });
  }

  async function scan() {
    setStatus('Looking for a drive…');

    let drives;
    try {
      drives = await listCdDrives();
    } catch (err) {
      setStatus(asMessage(err, 'Could not look for a CD drive.'), true);
      return;
    }

    if (!drives.length) {
      setStatus('No CD drive found.', true);
      return;
    }

    // Multiple drives are rare enough on a desktop that picking the first
    // one is the right default rather than a selector nobody will use.
    const drive = drives[0].id;
    setStatus('Reading disc…');

    try {
      const tracks = await scanCd(drive);
      if (!tracks.length) {
        setStatus('No audio tracks found on that disc.', true);
        return;
      }

      queue.clear();
      queue.add(tracks.map((t) => ({ ...t, source: 'cd' })));
      setStatus(`Found ${tracks.length} track${tracks.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setStatus(asMessage(err, 'Could not read that disc.'), true);
    }
  }

  scanBtn.addEventListener('click', scan);

  queue.on('change', paintQueue);
  controller.on('state', paintQueue);
  controller.on('source', paintQueue);

  paintQueue();
}
