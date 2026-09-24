/**
 * Runs inside youtube-embed.html, served over the loopback HTTP server
 * (src-tauri/src/server.rs) rather than the main app's `tauri://` origin.
 *
 * Drives the real YouTube IFrame Player API directly — this page has a
 * genuine http:// origin, so its own embed of YouTube carries a normal
 * Referer, unlike the main window's. It never talks to the rest of the app
 * directly; everything in and out goes through `postMessage` with the
 * parent frame. See sources/youtubeBridgeAdapter.js for the other end.
 *
 * `postMessage` target/source checks here use `window.parent` identity
 * rather than an origin string on purpose: the parent's real origin is
 * Tauri's own scheme, which has no stable cross-platform string form to
 * match against. Nothing crossing this bridge is sensitive — playback
 * commands and position/title — so an identity check is enough.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';
const POLL_MS = 250;

let player = null;
let playing = false;
let titleKnown = false;
let pollTimer = null;

function post(message) {
  window.parent.postMessage(message, '*');
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

/** As above, for calls that return something other than a number. */
function safeCall(fn, fallback = null) {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}

function emitMeta() {
  if (!player) return;
  const data = safeCall(() => player.getVideoData()) ?? {};
  const patch = {};

  if (typeof data.title === 'string' && data.title.trim()) {
    patch.title = data.title.trim();
    titleKnown = true;
  }
  if (typeof data.author === 'string' && data.author.trim()) patch.artist = data.author.trim();

  const duration = safeNum(() => player.getDuration());
  if (duration > 0) patch.duration = duration;

  if (Object.keys(patch).length) post({ type: 'meta', ...patch });
}

function emitTime() {
  if (!player) return;
  post({
    type: 'time',
    position: safeNum(() => player.getCurrentTime()),
    duration: safeNum(() => player.getDuration()),
  });
}

function startPolling() {
  stopPolling();
  // The IFrame API has no timeupdate event, so the seek bar is polled.
  pollTimer = setInterval(() => {
    emitTime();
    if (!titleKnown) emitMeta();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function onStateChange(e) {
  const S = window.YT?.PlayerState;
  if (!S) return;

  switch (e.data) {
    case S.PLAYING:
      playing = true;
      post({ type: 'state', playing: true });
      emitMeta();
      startPolling();
      break;

    case S.PAUSED:
      playing = false;
      stopPolling();
      post({ type: 'state', playing: false });
      emitTime();
      break;

    case S.ENDED:
      playing = false;
      stopPolling();
      post({ type: 'state', playing: false });
      post({ type: 'ended' });
      break;

    case S.CUED:
      emitMeta();
      emitTime();
      break;

    case S.BUFFERING:
      emitTime();
      break;

    default:
      break;
  }
}

/** Resolves once `player` is usable, loading the IFrame API script first if needed. */
function ensurePlayer() {
  return new Promise((resolve, reject) => {
    const create = () => {
      // No `modestbranding`: YouTube retired it in 2023 and ignores it now.
      const playerVars = {
        autoplay: 0,
        controls: 0,
        cc_load_policy: 0,
        disablekb: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        origin: location.origin,
      };

      try {
        // eslint-disable-next-line no-new
        player = new window.YT.Player('mount', {
          width: '100%',
          height: '100%',
          playerVars,
          events: {
            onReady: () => resolve(player),
            onStateChange,
            onError: (e) => {
              stopPolling();
              playing = false;
              post({ type: 'state', playing: false });
              post({ type: 'error', message: describeYtError(e.data) });
            },
          },
        });
      } catch (err) {
        reject(err);
      }
    };

    if (window.YT?.Player) {
      create();
      return;
    }

    // The API calls a global hook. Chain any existing one rather than stomp it.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      create();
    };

    const script = document.createElement('script');
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => reject(new Error('Could not reach YouTube.'));
    document.head.appendChild(script);
  });
}

const playerReady = ensurePlayer();
playerReady.catch((err) => post({ type: 'error', message: err.message }));

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  let p;
  try {
    p = await playerReady;
  } catch {
    return; // Already reported via the catch above.
  }

  switch (msg.type) {
    case 'load':
      titleKnown = false;
      p.setVolume(Math.round(Math.min(1, Math.max(0, msg.volume ?? 1)) * 100));
      if (msg.muted) p.mute();
      else p.unMute();
      if (msg.autoplay) p.loadVideoById(msg.videoId);
      else p.cueVideoById(msg.videoId);
      break;

    case 'play':
      p.playVideo();
      break;

    case 'pause':
      p.pauseVideo();
      break;

    case 'seek':
      if (Number.isFinite(msg.seconds)) p.seekTo(msg.seconds, true);
      break;

    case 'setVolume':
      p.setVolume(Math.round(Math.min(1, Math.max(0, msg.volume)) * 100));
      break;

    case 'setMuted':
      if (msg.muted) p.mute();
      else p.unMute();
      break;

    case 'release':
      stopPolling();
      p.pauseVideo();
      break;

    default:
      break;
  }
});

post({ type: 'bridge-ready' });
