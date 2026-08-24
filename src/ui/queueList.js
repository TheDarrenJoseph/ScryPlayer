import { formatTime, joinMeta } from '../util/format.js';
import { el, emptyState, icon, PATHS, playingBars } from './dom.js';

/**
 * Render a queue into an `<ol>`.
 *
 * Rebuilds the whole list on every change. Queues here are tens to a few
 * thousand rows and changes are user-driven, so the simplicity is worth more
 * than diffing would be.
 */
export function renderQueue(listEl, queue, { playing, onPlay, onRemove, emptyLines }) {
  listEl.replaceChildren();

  if (!queue.items.length) {
    listEl.appendChild(emptyState(...emptyLines));
    return;
  }

  const frag = document.createDocumentFragment();

  queue.items.forEach((track, i) => {
    const isCurrent = i === queue.index;

    const row = el('li', 'row');
    row.classList.toggle('is-playing', isCurrent);
    if (isCurrent && !playing) row.classList.add('is-paused');
    if (track.playable === false) row.classList.add('is-unplayable');

    // The playing row swaps its number for the animated bars.
    row.appendChild(isCurrent ? playingBars() : el('span', 'row__index', String(i + 1)));

    const body = el('div', 'row__body');
    body.appendChild(el('div', 'row__name', track.title || track.fileName || 'Unknown'));

    const sub =
      track.playable === false
        ? 'Unsupported format'
        : joinMeta(track.artist, track.album) || (track.source === 'youtube' ? 'YouTube' : '');
    if (sub) body.appendChild(el('div', 'row__sub', sub));
    row.appendChild(body);

    if (track.duration > 0) {
      row.appendChild(el('span', 'row__time', formatTime(track.duration)));
    }

    const remove = el('button', 'row__add');
    remove.type = 'button';
    remove.title = 'Remove from queue';
    remove.setAttribute('aria-label', `Remove ${track.title ?? 'track'} from queue`);
    remove.appendChild(icon(PATHS.close, ''));
    remove.addEventListener('click', (e) => {
      e.stopPropagation(); // Removing a row must not also play it.
      onRemove(i);
    });
    row.appendChild(remove);

    row.addEventListener('click', () => onPlay(i));

    frag.appendChild(row);
  });

  listEl.appendChild(frag);
}
