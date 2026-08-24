import { Emitter } from '../core/emitter.js';
import { mediaUrl } from '../tauri.js';

/**
 * Describe a decode failure.
 *
 * Reading the file is now a separate, explicit step that reports its own
 * errors, so by the time the media element complains the bytes are known to
 * have arrived — which leaves the format itself as the cause.
 */
function describeDecodeError(code, name) {
  if (code === 3 /* MEDIA_ERR_DECODE */) return `${name} — the file looks damaged.`;
  if (code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */) {
    return `${name} — this format is not supported by the player.`;
  }
  return `${name} — could not be played.`;
}

/**
 * Plays files off disk through a plain `<audio>` element.
 *
 * The source is a loopback http URL served by Rust. The two more obvious
 * routes both fail on WebKitGTK: `asset:` will not load at all, and a `blob:`
 * URL plays but stutters. `server.rs` has the numbers.
 *
 * Because it is ordinary http with range support, the engine streams and seeks
 * on its own — nothing is held in memory here.
 */
export class LocalAdapter extends Emitter {
  #el;
  #track = null;
  /** Guards against a slow load resolving after a newer one started. */
  #loadToken = 0;
  /** The load token we have already reported a failure for. */
  #reportedFor = -1;

  constructor() {
    super();

    const el = new Audio();
    // Buffer ahead rather than fetching lazily; measured to reach
    // HAVE_ENOUGH_DATA instead of idling at HAVE_FUTURE_DATA.
    el.preload = 'auto';
    this.#el = el;

    el.addEventListener('timeupdate', () => this.#emitTime());
    el.addEventListener('durationchange', () => this.#emitTime());
    el.addEventListener('loadedmetadata', () => {
      this.#emitTime();
      // Tags can lie, or be missing; the decoder is the authority on length.
      if (Number.isFinite(el.duration) && el.duration > 0) {
        this.emit('meta', { duration: el.duration });
      }
    });

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

    const name = this.#track?.fileName ?? 'This file';
    this.emit('error', {
      message: message ?? describeDecodeError(this.#el.error?.code, name),
    });
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
      url = await mediaUrl(track.path);
    } catch (err) {
      if (token !== this.#loadToken) return; // Superseded by a newer load.
      this.#reportFailure(`${track.fileName ?? 'This file'} — ${err}`);
      return;
    }

    // A newer track was chosen while we were resolving this one.
    if (token !== this.#loadToken) return;

    this.#el.src = url;
    this.#el.load();

    if (!autoplay) return;

    try {
      await this.#el.play();
    } catch (err) {
      // A newer load superseded this one — its failure is expected, ignore it.
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
