import { invoke, pickFiles, pickFolder } from '../tauri.js';
import { el, emptyState, icon, PATHS } from './dom.js';
import { renderQueue } from './queueList.js';

const $ = (id) => document.getElementById(id);

/** Split an absolute path into clickable breadcrumb segments. */
function crumbsFor(fullPath) {
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const parts = fullPath.split(sep).filter(Boolean);
  const out = [];

  if (sep === '/') {
    out.push({ label: '/', path: '/' });
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      out.push({ label: part, path: acc });
    }
  } else {
    // Windows: the first segment is the drive, and keeping the trailing
    // separator is what makes `C:\` mean the drive root rather than the CWD.
    let acc = '';
    parts.forEach((part) => {
      acc += `${part}\\`;
      out.push({ label: part, path: acc });
    });
  }

  return out;
}

const asMessage = (err, fallback) =>
  typeof err === 'string' ? err : (err?.message ?? fallback);

/**
 * The local-files source: a folder browser on the left, its queue on the right.
 *
 * Every path shown here came from a Tauri command, and the Rust side widens the
 * asset-protocol scope as tracks are added — the WebView can only read media
 * from folders the user actually chose.
 */
export function createLocalPanel(controller, queue, { setStatus }) {
  const shortcutsEl = $('shortcuts');
  const crumbsEl = $('crumbs');
  const listEl = $('filelist');
  const queueEl = $('queue-local');
  const countEl = $('count-local');

  let currentPath = null;

  // ── Queue pane ───────────────────────────────────────────

  function paintQueue() {
    countEl.textContent = String(queue.length);
    renderQueue(queueEl, queue, {
      playing: controller.state.playing && controller.activeId === 'local',
      onPlay: async (i) => {
        await controller.setActive('local');
        await controller.playAt(i);
      },
      onRemove: (i) => queue.removeAt(i),
      emptyLines: ['The queue is still.', 'Add a folder, or pick tracks from the library.'],
    });
  }

  // ── Browser pane ─────────────────────────────────────────

  function paintCrumbs(listing) {
    crumbsEl.replaceChildren();
    const crumbs = crumbsFor(listing.path);

    crumbs.forEach((crumb, i) => {
      if (i) crumbsEl.appendChild(el('span', 'crumb__sep', '›'));
      const btn = el('button', 'crumb', crumb.label);
      btn.type = 'button';
      if (i === crumbs.length - 1) btn.classList.add('is-current');
      btn.addEventListener('click', () => navigate(crumb.path));
      crumbsEl.appendChild(btn);
    });
  }

  function paintFiles(listing) {
    listEl.replaceChildren();

    if (!listing.entries.length) {
      listEl.appendChild(emptyState('Nothing here.', 'No folders or audio in this location.'));
      return;
    }

    const frag = document.createDocumentFragment();

    for (const entry of listing.entries) {
      const row = el('li', 'row');
      if (!entry.isDir && !entry.playable) row.classList.add('is-unplayable');

      row.appendChild(
        icon(
          entry.isDir ? PATHS.folder : PATHS.note,
          entry.isDir ? 'row__icon row__icon--folder' : 'row__icon',
        ),
      );

      const body = el('div', 'row__body');
      body.appendChild(el('div', 'row__name', entry.name));
      if (!entry.isDir && !entry.playable) {
        body.appendChild(el('div', 'row__sub', 'Unsupported format'));
      }
      row.appendChild(body);

      const add = el('button', 'row__add');
      add.type = 'button';
      add.title = entry.isDir ? 'Add folder to queue' : 'Add to queue';
      add.setAttribute('aria-label', add.title);
      add.appendChild(icon(PATHS.plus, ''));
      add.addEventListener('click', (e) => {
        // Adding must not also trigger the row's navigate/play.
        e.stopPropagation();
        if (entry.isDir) addFolder(entry.path);
        else addFiles([entry.path]);
      });
      row.appendChild(add);

      row.addEventListener('click', () => {
        if (entry.isDir) navigate(entry.path);
        else addFiles([entry.path], { play: true });
      });

      frag.appendChild(row);
    }

    listEl.appendChild(frag);
  }

  async function navigate(path) {
    try {
      const listing = await invoke('list_dir', { path: path ?? null });
      currentPath = listing.path;
      paintCrumbs(listing);
      paintFiles(listing);
    } catch (err) {
      setStatus(asMessage(err, 'Could not open that folder.'), true);
    }
  }

  // ── Adding to the queue ──────────────────────────────────

  async function addFiles(paths, { play = false } = {}) {
    if (!paths.length) return;

    try {
      const tracks = await invoke('load_tracks', { paths });
      const startAt = queue.length;
      queue.add(tracks.map((t) => ({ ...t, source: 'local' })));

      if (play) {
        await controller.setActive('local');
        await controller.playAt(startAt);
      } else {
        setStatus(`Added ${tracks.length} track${tracks.length === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      setStatus(asMessage(err, 'Could not read those files.'), true);
    }
  }

  async function addFolder(path, { play = false } = {}) {
    setStatus('Reading folder…');

    try {
      const tracks = await invoke('scan_folder', { path, recursive: true });

      if (!tracks.length) {
        setStatus('No audio found in that folder.', true);
        return;
      }

      const startAt = queue.length;
      queue.add(tracks.map((t) => ({ ...t, source: 'local' })));
      setStatus(`Added ${tracks.length} tracks.`);

      if (play) {
        await controller.setActive('local');
        await controller.playAt(startAt);
      }
    } catch (err) {
      setStatus(asMessage(err, 'Could not read that folder.'), true);
    }
  }

  // ── Wiring ───────────────────────────────────────────────

  $('btn-pick-folder').addEventListener('click', async () => {
    const picked = await pickFolder(currentPath);
    if (!picked) return; // Dialog dismissed.
    await addFolder(picked);
    await navigate(picked);
  });

  $('btn-pick-files').addEventListener('click', async () => {
    await addFiles(await pickFiles(currentPath));
  });

  $('btn-clear-local').addEventListener('click', () => queue.clear());

  queue.on('change', paintQueue);
  controller.on('state', paintQueue);
  controller.on('source', paintQueue);

  async function init() {
    try {
      const items = await invoke('shortcuts');
      shortcutsEl.replaceChildren();
      for (const shortcut of items) {
        const chip = el('button', 'chip', shortcut.label);
        chip.type = 'button';
        chip.addEventListener('click', () => navigate(shortcut.path));
        shortcutsEl.appendChild(chip);
      }
    } catch {
      // Shortcuts are a convenience; the browser still works without them.
    }

    await navigate(null);
    paintQueue();
  }

  return { init, navigate };
}
