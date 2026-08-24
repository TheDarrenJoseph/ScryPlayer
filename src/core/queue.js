import { Emitter } from './emitter.js';

/** @typedef {'off' | 'all' | 'one'} RepeatMode */

/**
 * An ordered list of tracks plus a cursor.
 *
 * `items` always stays in the order the user added things — that is what the
 * queue pane renders. Playback order lives in a separate permutation (`#order`)
 * so toggling shuffle never reshuffles what the user is looking at.
 */
export class Queue extends Emitter {
  /** @type {number[]} playback order, as positions into `items` */
  #order = [];

  /** @param {string} id */
  constructor(id) {
    super();
    this.id = id;
    /** @type {object[]} */
    this.items = [];
    /** Index into `items`, or -1 when nothing is cued. */
    this.index = -1;
    /** @type {RepeatMode} */
    this.repeat = 'off';
    this.shuffle = false;
    this.#rebuildOrder();
  }

  get length() {
    return this.items.length;
  }

  current() {
    return this.items[this.index] ?? null;
  }

  #rebuildOrder() {
    const n = this.items.length;
    this.#order = Array.from({ length: n }, (_, i) => i);

    if (!this.shuffle) return;

    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.#order[i], this.#order[j]] = [this.#order[j], this.#order[i]];
    }

    // Whatever is playing stays at the head, so shuffling never yanks the
    // current track out from under the listener.
    if (this.index >= 0) {
      const at = this.#order.indexOf(this.index);
      if (at > 0) [this.#order[0], this.#order[at]] = [this.#order[at], this.#order[0]];
    }
  }

  #changed() {
    this.emit('change', this);
  }

  add(tracks) {
    const incoming = Array.isArray(tracks) ? tracks : [tracks];
    if (!incoming.length) return 0;
    this.items.push(...incoming);
    this.#rebuildOrder();
    this.#changed();
    return incoming.length;
  }

  removeAt(i) {
    if (i < 0 || i >= this.items.length) return;
    this.items.splice(i, 1);

    if (i === this.index) {
      // Keep the cursor pointing at the same slot; it now holds the next track.
      // Clamp so removing the last item leaves the cursor parked on the end.
      this.index = Math.min(this.index, this.items.length - 1);
    } else if (i < this.index) {
      this.index -= 1;
    }

    this.#rebuildOrder();
    this.#changed();
  }

  clear() {
    this.items = [];
    this.index = -1;
    this.#rebuildOrder();
    this.#changed();
  }

  setIndex(i) {
    if (i < -1 || i >= this.items.length) return;
    this.index = i;
    this.#changed();
  }

  setShuffle(on) {
    this.shuffle = !!on;
    this.#rebuildOrder();
    this.#changed();
  }

  /** @param {RepeatMode} mode */
  setRepeat(mode) {
    this.repeat = mode;
    this.#changed();
  }

  /**
   * The index to play next, or `null` to stop.
   *
   * @param {boolean} auto true when a track ended on its own, false when the
   *   user pressed Next. Repeat-one only applies to the automatic case, and
   *   running off the end only stops playback in the automatic case — a manual
   *   Next always wraps.
   */
  nextIndex(auto = false) {
    if (!this.items.length) return null;
    if (auto && this.repeat === 'one') return this.index;

    const pos = this.#order.indexOf(this.index);
    const next = pos + 1;

    if (next < this.#order.length) return this.#order[next];

    if (auto && this.repeat === 'off') return null;

    // Wrapping around: give shuffle a fresh permutation for the new pass.
    if (this.shuffle) {
      const keep = this.index;
      this.index = -1;
      this.#rebuildOrder();
      this.index = keep;
    }
    return this.#order[0] ?? null;
  }

  /** Previous in playback order, wrapping at the start. */
  prevIndex() {
    if (!this.items.length) return null;
    const pos = this.#order.indexOf(this.index);
    const prev = pos - 1;
    return prev >= 0 ? this.#order[prev] : this.#order[this.#order.length - 1];
  }

  toJSON() {
    return {
      items: this.items,
      index: this.index,
      repeat: this.repeat,
      shuffle: this.shuffle,
    };
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return;
    this.items = snapshot.items;
    this.index = Number.isInteger(snapshot.index) ? snapshot.index : -1;
    if (this.index >= this.items.length) this.index = -1;
    this.repeat = ['off', 'all', 'one'].includes(snapshot.repeat) ? snapshot.repeat : 'off';
    this.shuffle = !!snapshot.shuffle;
    this.#rebuildOrder();
    this.#changed();
  }
}
