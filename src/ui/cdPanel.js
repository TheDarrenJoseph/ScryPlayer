import { artUrl, listCdDrives, lookupAlbumArt, lookupCdMetadata, scanCd } from '../tauri.js';
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
 *
 * A scan's TOC-only "Track N" titles are enriched in the background from
 * GnuDB, when the setting allows it — the same shape as how YouTube's real
 * title arrives after `youtubePanel.js` queues its placeholder. Cover art
 * follows the same shape again, chained off whatever artist/album GnuDB
 * found, when that setting allows it too.
 */
export function createCdPanel(controller, queue, { setStatus, settings }) {
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

      // Not a bare `queue.clear()`: a rescan can happen mid-playback (the
      // disc was swapped), and the active track's URL encodes the *old*
      // disc's sector range — it must stop rather than keep streaming
      // whatever now happens to sit at those sectors on the new one.
      controller.clearQueue('cd');
      const queued = tracks.map((t) => ({ ...t, source: 'cd' }));
      queue.add(queued);
      setStatus(`Found ${tracks.length} track${tracks.length === 1 ? '' : 's'}.`);

      if (settings.cddbLookup) enrich(drive, queued);
    } catch (err) {
      setStatus(asMessage(err, 'Could not read that disc.'), true);
    }
  }

  /**
   * Patch TOC-only tracks with real metadata once GnuDB answers.
   *
   * `queuedTracks` are checked back against the live queue one at a time
   * rather than trusted outright — a slow lookup can land after the queue was
   * cleared, or after a second scan replaced it with a different disc's
   * tracks entirely, and this must not resurrect or stomp on either.
   */
  function enrich(drive, queuedTracks) {
    lookupCdMetadata(drive).then((info) => {
      if (!info) return;

      for (const track of queuedTracks) {
        if (!queue.items.includes(track)) continue;

        const title = info.trackTitles[track.trackNo - 1];
        if (title) track.title = title;
        if (info.artist) track.artist = info.artist;
        if (info.album) track.album = info.album;
      }

      queue.emit('change', queue);

      // Needs an artist and album to search by — GnuDB having nothing for
      // this disc leaves nothing to look cover art up with either.
      if (settings.albumArtLookup && info.artist && info.album) {
        enrichArt(drive, queuedTracks, info.artist, info.album);
      }
    });
  }

  /**
   * Same shape as `enrich`'s metadata patch, for the album's cover: resolve
   * it once in the background and fan it out to every track from this disc.
   */
  function enrichArt(drive, queuedTracks, artist, album) {
    lookupAlbumArt(drive, artist, album)
      .then((path) => (path ? artUrl(path) : null))
      .then((url) => {
        if (!url) return;

        for (const track of queuedTracks) {
          if (!queue.items.includes(track)) continue;
          track.artUrl = url;
        }

        queue.emit('change', queue);
      })
      .catch(() => {}); // A missing cover must not surface as an error.
  }

  scanBtn.addEventListener('click', scan);

  queue.on('change', paintQueue);
  controller.on('state', paintQueue);
  controller.on('source', paintQueue);

  paintQueue();
}
