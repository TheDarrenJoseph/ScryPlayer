import { Emitter } from './emitter.js';

/**
 * Owns every media source and presents one playback surface to the UI.
 *
 * Each source contributes an adapter and a queue. The transport bar talks only
 * to this controller, so adding a third source later means implementing the
 * adapter contract and registering it — no UI changes.
 *
 * ── Adapter contract ────────────────────────────────────────────────────────
 *   load(track, { autoplay, volume, muted }) → Promise<void>
 *   play() / pause() / seek(seconds) / setVolume(0..1) / setMuted(bool)
 *   snapshot() → { position, duration, playing, loaded }
 *   release()  — called when the user switches away from this source
 *
 *   Events: 'time'  { position, duration }
 *           'state' { playing }
 *           'ended'
 *           'error' { message }
 *           'meta'  { ...patch }   — late-arriving details for the cued track
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Controller events: 'source' | 'track' | 'queue' | 'state' | 'time' | 'volume' | 'error'
 */
export class Controller extends Emitter {
  #sources = new Map();
  #activeId = null;
  #volume = 0.8;
  #muted = false;

  state = { playing: false, position: 0, duration: 0 };

  get activeId() {
    return this.#activeId;
  }

  get #active() {
    return this.#sources.get(this.#activeId) ?? null;
  }

  get adapter() {
    return this.#active?.adapter ?? null;
  }

  get queue() {
    return this.#active?.queue ?? null;
  }

  get volume() {
    return this.#volume;
  }

  get muted() {
    return this.#muted;
  }

  /** What the adapter should actually output right now. */
  #level() {
    return this.#muted ? 0 : this.#volume;
  }

  register(id, adapter, queue) {
    this.#sources.set(id, { adapter, queue });

    // Only the active adapter is allowed to drive the shared UI. A background
    // adapter that is still winding down must not move the seek bar.
    const isActive = () => this.adapter === adapter;

    adapter.on('time', (d) => {
      if (!isActive()) return;
      this.state.position = d.position;
      this.state.duration = d.duration;
      this.emit('time', d);
    });

    adapter.on('state', ({ playing }) => {
      if (!isActive()) return;
      this.state.playing = playing;
      this.emit('state', { playing });
    });

    adapter.on('ended', () => {
      if (!isActive()) return;
      this.#advance(true);
    });

    adapter.on('error', ({ message }) => {
      if (!isActive()) return;
      this.emit('error', { message });
    });

    // The adapter learned something the queue did not know yet — a YouTube
    // title, a real duration. Fold it into the cued track.
    adapter.on('meta', (patch) => {
      if (!isActive()) return;
      const track = queue.current();
      if (!track) return;
      Object.assign(track, patch);
      queue.emit('change', queue);
      this.emit('track', { track, index: queue.index, sourceId: id });
    });

    queue.on('change', () => this.emit('queue', { id, queue }));
  }

  /** Switch which source the transport is driving. */
  async setActive(id) {
    if (!this.#sources.has(id) || id === this.#activeId) return;

    // Leaving a source stops its sound but keeps its position, so coming back
    // resumes where the listener left off.
    this.#active?.adapter.release();

    this.#activeId = id;
    const { adapter, queue } = this.#active;
    adapter.setVolume(this.#level());
    adapter.setMuted(this.#muted);

    const snap = adapter.snapshot();
    this.state = {
      playing: snap.playing,
      position: snap.position,
      duration: snap.duration,
    };

    this.emit('source', { id });
    this.emit('queue', { id, queue });
    this.emit('track', { track: queue.current(), index: queue.index, sourceId: id });
    this.emit('state', { playing: this.state.playing });
    this.emit('time', { position: this.state.position, duration: this.state.duration });
  }

  async playAt(index, { autoplay = true } = {}) {
    const active = this.#active;
    if (!active) return;

    const { adapter, queue } = active;
    if (index == null || index < 0 || index >= queue.length) return;

    queue.setIndex(index);
    const track = queue.items[index];
    this.emit('track', { track, index, sourceId: this.#activeId });

    try {
      await adapter.load(track, {
        autoplay,
        volume: this.#level(),
        muted: this.#muted,
      });
    } catch (err) {
      this.emit('error', { message: err?.message ?? String(err) });
    }
  }

  async toggle() {
    const active = this.#active;
    if (!active) return;
    const { adapter, queue } = active;

    if (!queue.length) return;

    // Nothing cued yet, or cued but never loaded — start it.
    if (queue.index < 0) return this.playAt(0);
    if (!adapter.snapshot().loaded) return this.playAt(queue.index);

    if (this.state.playing) adapter.pause();
    else await adapter.play();
  }

  async #advance(auto) {
    const queue = this.queue;
    if (!queue) return;
    const next = queue.nextIndex(auto);
    if (next == null) {
      // End of the queue with repeat off: settle rather than loop.
      this.state.playing = false;
      this.emit('state', { playing: false });
      return;
    }
    await this.playAt(next);
  }

  next() {
    return this.#advance(false);
  }

  prev() {
    const queue = this.queue;
    if (!queue) return;
    // Familiar behaviour: the first press restarts the track, the second
    // actually goes back.
    if (this.state.position > 3) {
      this.seek(0);
      return;
    }
    const i = queue.prevIndex();
    if (i == null) return;
    return this.playAt(i);
  }

  seek(seconds) {
    this.adapter?.seek(seconds);
    this.state.position = seconds;
    this.emit('time', { position: seconds, duration: this.state.duration });
  }

  setVolume(v) {
    this.#volume = Math.min(1, Math.max(0, v));
    // Nudging the slider up is an unmute.
    if (this.#volume > 0 && this.#muted) this.#muted = false;
    this.adapter?.setVolume(this.#level());
    this.adapter?.setMuted(this.#muted);
    this.emit('volume', { volume: this.#volume, muted: this.#muted });
  }

  setMuted(m) {
    this.#muted = !!m;
    this.adapter?.setVolume(this.#level());
    this.adapter?.setMuted(this.#muted);
    this.emit('volume', { volume: this.#volume, muted: this.#muted });
  }

  toggleMute() {
    this.setMuted(!this.#muted);
  }
}
