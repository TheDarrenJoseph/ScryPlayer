import { Emitter } from '../core/emitter.js';

const API_SRC = 'https://www.youtube.com/iframe_api';
const API_TIMEOUT_MS = 15000;
const POLL_MS = 250;

/** Module-level: the IFrame API script is a singleton for the whole page. */
let apiPromise = null;

function loadApi() {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      apiPromise = null; // Let a later attempt retry from scratch.
      reject(new Error(message));
    };

    const timer = setTimeout(
      () => fail('YouTube took too long to respond. Check your connection.'),
      API_TIMEOUT_MS,
    );

    // The API calls a global hook. Chain any existing one rather than stomp it.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(window.YT);
    };

    const script = document.createElement('script');
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => fail('Could not reach YouTube.');
    document.head.appendChild(script);
  });

  return apiPromise;
}

function describeYtError(code) {
  switch (code) {
    case 2:
      return 'That video id is not valid.';
    case 5:
      return 'YouTube could not play that video here.';
    case 100:
      return 'That video is private or has been removed.';
    case 101:
    case 150:
      return 'The owner of that video has disabled embedded playback.';
    default:
      return 'YouTube could not play that video.';
  }
}

/** The player throws if asked for a number before it is ready. */
function safeNum(fn, fallback = 0) {
  try {
    const v = fn();
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * As above, for calls that return something other than a number.
 *
 * Kept separate on purpose: running `getVideoData()` through a numeric guard
 * discards the object every time, which silently costs you every title.
 */
function safeCall(fn, fallback = null) {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Drives an embedded YouTube player through the IFrame API.
 *
 * Presents the same surface as the local-file adapter so the shared transport
 * bar does not need to know which source is playing.
 */
export class YouTubeAdapter extends Emitter {
  #host;
  #player = null;
  #playerPromise = null;
  #timer = null;
  #playing = false;
  #loaded = false;
  #track = null;
  /** Whether the real title has arrived for the currently cued video. */
  #titleKnown = false;

  /** @param {HTMLElement} host element the iframe is mounted into */
  constructor(host) {
    super();
    this.#host = host;
  }

  async #ensurePlayer() {
    if (this.#player) return this.#player;
    if (this.#playerPromise) return this.#playerPromise;

    this.#playerPromise = (async () => {
      const YT = await loadApi();

      // The API replaces this node with the iframe, so give it a fresh one.
      const mount = document.createElement('div');
      this.#host.replaceChildren(mount);

      const playerVars = {
        autoplay: 0,
        controls: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        iv_load_policy: 3,
      };

      // The API only accepts an http(s) origin. A packaged Tauri build serves
      // the page from a custom scheme, so the hint is omitted there.
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        playerVars.origin = location.origin;
      }

      return new Promise((resolve, reject) => {
        try {
          // eslint-disable-next-line no-new
          new YT.Player(mount, {
            width: '100%',
            height: '100%',
            playerVars,
            events: {
              onReady: (e) => resolve(e.target),
              onStateChange: (e) => this.#onStateChange(e),
              onError: (e) => {
                this.#stopPolling();
                this.#playing = false;
                this.emit('state', { playing: false });
                this.emit('error', { message: describeYtError(e.data) });
              },
            },
          });
        } catch (err) {
          reject(err);
        }
      });
    })();

    try {
      this.#player = await this.#playerPromise;
      return this.#player;
    } catch (err) {
      this.#playerPromise = null; // Allow a retry on the next attempt.
      throw err;
    }
  }

  #onStateChange(e) {
    const S = window.YT?.PlayerState;
    if (!S) return;

    switch (e.data) {
      case S.PLAYING:
        this.#playing = true;
        this.emit('state', { playing: true });
        this.#emitMeta();
        this.#startPolling();
        break;

      case S.PAUSED:
        this.#playing = false;
        this.#stopPolling();
        this.emit('state', { playing: false });
        this.#emitTime();
        break;

      case S.ENDED:
        this.#playing = false;
        this.#stopPolling();
        this.emit('state', { playing: false });
        this.emit('ended');
        break;

      case S.CUED:
        this.#emitMeta();
        this.#emitTime();
        break;

      case S.BUFFERING:
        this.#emitTime();
        break;

      default:
        break;
    }
  }

  /** Titles are only known once YouTube has the video loaded. */
  #emitMeta() {
    const p = this.#player;
    if (!p) return;

    const data = safeCall(() => p.getVideoData()) ?? {};
    const patch = {};

    if (typeof data.title === 'string' && data.title.trim()) {
      patch.title = data.title.trim();
      this.#titleKnown = true;
    }
    if (typeof data.author === 'string' && data.author.trim()) patch.artist = data.author.trim();

    const duration = safeNum(() => p.getDuration());
    if (duration > 0) patch.duration = duration;

    if (Object.keys(patch).length) this.emit('meta', patch);
  }

  #emitTime() {
    const p = this.#player;
    if (!p) return;
    this.emit('time', {
      position: safeNum(() => p.getCurrentTime()),
      duration: safeNum(() => p.getDuration()),
    });
  }

  #startPolling() {
    this.#stopPolling();
    // The IFrame API has no timeupdate event, so the seek bar is polled.
    this.#timer = setInterval(() => {
      this.#emitTime();
      // getVideoData() stays empty for a moment after a load, so keep asking
      // until the real title lands rather than leaving a bare video id.
      if (!this.#titleKnown) this.#emitMeta();
    }, POLL_MS);
  }

  #stopPolling() {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async load(track, { autoplay = true, volume = 1, muted = false } = {}) {
    const player = await this.#ensurePlayer();
    this.#track = track;
    this.#titleKnown = false;

    player.setVolume(Math.round(Math.min(1, Math.max(0, volume)) * 100));
    if (muted) player.mute();
    else player.unMute();

    if (autoplay) player.loadVideoById(track.videoId);
    else player.cueVideoById(track.videoId);

    this.#loaded = true;
  }

  async play() {
    const p = this.#player;
    if (!p) {
      // Nothing loaded yet — the controller will call load() instead.
      return;
    }
    p.playVideo();
  }

  pause() {
    this.#player?.pauseVideo();
  }

  seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    this.#player?.seekTo(seconds, true);
  }

  setVolume(v) {
    this.#player?.setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100));
  }

  setMuted(m) {
    const p = this.#player;
    if (!p) return;
    if (m) p.mute();
    else p.unMute();
  }

  snapshot() {
    const p = this.#player;
    if (!p || !this.#loaded) {
      return { position: 0, duration: 0, playing: false, loaded: false };
    }
    return {
      position: safeNum(() => p.getCurrentTime()),
      duration: safeNum(() => p.getDuration()),
      playing: this.#playing,
      loaded: true,
    };
  }

  release() {
    this.#stopPolling();
    this.#player?.pauseVideo();
    this.#playing = false;
  }
}
