import { Emitter } from '../core/emitter.js';
import { mediaServerPort } from '../tauri.js';

const READY_TIMEOUT_MS = 15000;

/**
 * Drives YouTube playback indirectly, through youtube-embed.html — a bridge
 * page served over our own loopback HTTP server (src-tauri/src/server.rs) —
 * rather than embedding YouTube in this window directly.
 *
 * Why: in a packaged build this window loads from Tauri's `tauri://` scheme,
 * which is not a real network origin. YouTube requires a valid Referer for
 * embedded playback and rejects requests that arrive without one (error
 * 153). The bridge page, served over genuine http://127.0.0.1, is the one
 * that actually embeds YouTube, so *its* request carries a normal Referer —
 * this window's own origin never has to change to get one.
 *
 * Presents the same adapter surface as every other source; the transport
 * bar has no idea playback is happening behind an iframe and a postMessage
 * relay instead of directly.
 */
export class YouTubeBridgeAdapter extends Emitter {
  #host;
  #iframe = null;
  #ready = null;
  #playing = false;
  #loaded = false;
  #position = 0;
  #duration = 0;
  #onMessageBound = (e) => this.#onMessage(e);

  /** @param {HTMLElement} host element the bridge iframe is mounted into */
  constructor(host) {
    super();
    this.#host = host;
    window.addEventListener('message', this.#onMessageBound);
  }

  async #ensureIframe() {
    if (this.#ready) return this.#ready;

    this.#ready = (async () => {
      const port = await mediaServerPort();

      const iframe = document.createElement('iframe');
      iframe.allow = 'autoplay; encrypted-media';
      // The API replaces this node with the iframe, so give it a fresh one.
      this.#host.replaceChildren(iframe);
      this.#iframe = iframe;

      const bridgeReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onReady);
          reject(new Error('The local YouTube bridge took too long to respond.'));
        }, READY_TIMEOUT_MS);

        const onReady = (e) => {
          if (e.source !== iframe.contentWindow || e.data?.type !== 'bridge-ready') return;
          clearTimeout(timer);
          window.removeEventListener('message', onReady);
          resolve();
        };
        window.addEventListener('message', onReady);
      });

      // Set only once the listener above is armed, so a fast-loading iframe
      // cannot fire "bridge-ready" before anyone is listening for it.
      iframe.src = `http://127.0.0.1:${port}/youtube-embed`;

      await bridgeReady;
    })();

    try {
      await this.#ready;
    } catch (err) {
      this.#ready = null; // Allow a retry on the next attempt.
      throw err;
    }
  }

  #post(message) {
    this.#iframe?.contentWindow?.postMessage(message, '*');
  }

  #onMessage(event) {
    if (!this.#iframe || event.source !== this.#iframe.contentWindow) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'time':
        this.#position = msg.position;
        this.#duration = msg.duration;
        this.emit('time', { position: msg.position, duration: msg.duration });
        break;

      case 'state':
        this.#playing = msg.playing;
        this.emit('state', { playing: msg.playing });
        break;

      case 'meta': {
        // eslint-disable-next-line no-unused-vars
        const { type, ...patch } = msg;
        this.emit('meta', patch);
        break;
      }

      case 'ended':
        this.#playing = false;
        this.emit('ended');
        break;

      case 'error':
        this.#playing = false;
        this.emit('state', { playing: false });
        this.emit('error', { message: msg.message });
        break;

      default:
        break;
    }
  }

  async load(track, { autoplay = true, volume = 1, muted = false } = {}) {
    await this.#ensureIframe();
    this.#post({ type: 'load', videoId: track.videoId, autoplay, volume, muted });
    this.#loaded = true;
  }

  async play() {
    if (!this.#iframe) {
      // Nothing loaded yet — the controller will call load() instead.
      return;
    }
    this.#post({ type: 'play' });
  }

  pause() {
    this.#post({ type: 'pause' });
  }

  seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    this.#post({ type: 'seek', seconds });
  }

  setVolume(v) {
    this.#post({ type: 'setVolume', volume: v });
  }

  setMuted(m) {
    this.#post({ type: 'setMuted', muted: m });
  }

  snapshot() {
    if (!this.#loaded) {
      return { position: 0, duration: 0, playing: false, loaded: false };
    }
    return {
      position: this.#position,
      duration: this.#duration,
      playing: this.#playing,
      loaded: true,
    };
  }

  release() {
    this.#post({ type: 'release' });
    this.#playing = false;
  }
}
