import { Emitter } from '../core/emitter.js';
import { cdTrackUrl } from '../tauri.js';

/**
 * Plays audio-CD tracks through a plain `<audio>` element.
 *
 * The source is a loopback http URL served by Rust, exactly like
 * `LocalAdapter` — see that file for why `asset:`/`blob:` URLs are not an
 * option on this WebView. The difference is what the URL points at: here
 * Rust reads raw sectors off the disc on demand and wraps them in a WAV
 * header, rather than opening a file.
 */
export class CdAdapter extends Emitter {
  #el;
  #track = null;
  /** Guards against a slow load resolving after a newer one started. */
  #loadToken = 0;
  /** The load token we have already reported a failure for. */
  #reportedFor = -1;

  constructor() {
    super();

    const el = new Audio();
    el.preload = 'auto';
    this.#el = el;

    el.addEventListener('timeupdate', () => this.#emitTime());
    el.addEventListener('durationchange', () => this.#emitTime());

    el.addEventListener('play', () => this.emit('state', { playing: true }));
    el.addEventListener('pause', () => this.emit('state', { playing: false }));
    el.addEventListener('ended', () => this.emit('ended'));

    el.addEventListener('error', () => {
      if (!el.src) return; // Clearing the source is not an error.
      this.emit('state', { playing: false });
      this.#reportFailure();
    });
  }

  /** Report a failed load once, even if several signals fire for it. */
  #reportFailure(message) {
    if (this.#reportedFor === this.#loadToken) return;
    this.#reportedFor = this.#loadToken;

    const name = this.#track?.title ?? 'This track';
    this.emit('error', { message: message ?? `${name} — could not be played.` });
  }

  #emitTime() {
    this.emit('time', {
      position: this.#el.currentTime || 0,
      duration: Number.isFinite(this.#el.duration) ? this.#el.duration : 0,
    });
  }

  async load(track, { autoplay = true, volume = 1, muted = false } = {}) {
    const token = ++this.#loadToken;
    this.#track = track;

    this.#el.volume = volume;
    this.#el.muted = muted;

    let url;
    try {
      url = await cdTrackUrl(track.drive, track.startLba, track.endLba);
    } catch (err) {
      if (token !== this.#loadToken) return; // Superseded by a newer load.
      this.#reportFailure(`${track.title ?? 'This track'} — ${err}`);
      return;
    }

    if (token !== this.#loadToken) return;

    this.#el.src = url;
    this.#el.load();

    if (!autoplay) return;

    try {
      await this.#el.play();
    } catch (err) {
      if (token !== this.#loadToken) return;
      if (err?.name === 'AbortError') return;
      this.#reportFailure();
    }
  }

  async play() {
    try {
      await this.#el.play();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.#reportFailure();
    }
  }

  pause() {
    this.#el.pause();
  }

  seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    this.#el.currentTime = seconds;
  }

  setVolume(v) {
    this.#el.volume = Math.min(1, Math.max(0, v));
  }

  setMuted(m) {
    this.#el.muted = !!m;
  }

  snapshot() {
    return {
      position: this.#el.currentTime || 0,
      duration: Number.isFinite(this.#el.duration) ? this.#el.duration : 0,
      playing: !this.#el.paused && !this.#el.ended,
      loaded: !!this.#el.src,
    };
  }

  release() {
    this.#el.pause();
  }
}
