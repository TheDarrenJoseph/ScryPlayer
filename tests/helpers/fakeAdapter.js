/**
 * A stand-in source, implementing the adapter contract from the header of
 * `core/controller.js`:
 *
 *   load(track, { autoplay, volume, muted }) → Promise<void>
 *   play() / pause() / seek(seconds) / setVolume(0..1) / setMuted(bool)
 *   snapshot() → { position, duration, playing, loaded }
 *   release()
 *
 * It records every call so a test can assert on what the controller asked the
 * source to do, and exposes `finish()` / `fail()` to drive the events a real
 * adapter emits from the outside world.
 */
import { Emitter } from '../../src/core/emitter.js';

export class FakeAdapter extends Emitter {
  /** @type {{ method: string, args: unknown[] }[]} */
  calls = [];

  #position = 0;
  #duration = 0;
  #playing = false;
  #loaded = false;

  /** Track passed to the most recent load(). */
  loadedTrack = null;

  /** Set to reject, to exercise the controller's error path. */
  loadError = null;

  #record(method, ...args) {
    this.calls.push({ method, args });
  }

  /** Method names in call order — the usual thing a test wants to assert. */
  get log() {
    return this.calls.map((c) => c.method);
  }

  async load(track, opts = {}) {
    this.#record('load', track, opts);

    if (this.loadError) throw new Error(this.loadError);

    this.loadedTrack = track;
    this.#loaded = true;
    this.#position = 0;
    this.#duration = track?.duration ?? 100;
    this.#playing = !!opts.autoplay;

    this.emit('state', { playing: this.#playing });
    this.emit('time', { position: 0, duration: this.#duration });
  }

  async play() {
    this.#record('play');
    this.#playing = true;
    this.emit('state', { playing: true });
  }

  pause() {
    this.#record('pause');
    this.#playing = false;
    this.emit('state', { playing: false });
  }

  seek(seconds) {
    this.#record('seek', seconds);
    this.#position = seconds;
  }

  setVolume(v) {
    this.#record('setVolume', v);
  }

  setMuted(m) {
    this.#record('setMuted', m);
  }

  snapshot() {
    return {
      position: this.#position,
      duration: this.#duration,
      playing: this.#playing,
      loaded: this.#loaded,
    };
  }

  release() {
    this.#record('release');
    this.#playing = false;
  }

  // ── Driving the outside world ────────────────────────────

  /** The track ran to its end. */
  finish() {
    this.#playing = false;
    this.emit('ended');
  }

  /** The source failed. */
  fail(message = 'something broke') {
    this.emit('error', { message });
  }

  /** Late-arriving detail, the way a real title or duration turns up. */
  describe(patch) {
    this.emit('meta', patch);
  }

  /** Move the clock, as a playing source does. */
  tick(position, duration = this.#duration) {
    this.#position = position;
    this.#duration = duration;
    this.emit('time', { position, duration });
  }
}

/** `n` throwaway tracks, named A, B, C… */
export function tracks(n) {
  return Array.from({ length: n }, (_, i) => ({
    title: String.fromCharCode(65 + i),
    duration: 100,
  }));
}

/** Collect every event a controller emits, for order-sensitive assertions. */
export function record(emitter, types) {
  const seen = [];
  for (const type of types) {
    emitter.on(type, (detail) => seen.push({ type, detail }));
  }
  return seen;
}
