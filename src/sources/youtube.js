/** An 11-character YouTube video id. */
const ID_RE = /^[\w-]{11}$/;
const HOST_RE = /^((m|www|music)\.)?youtube(-nocookie)?\.com$/;

const asId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);

/**
 * Pull a video id (and playlist id, when present) out of whatever the user
 * pasted — a watch link, a share link, a Shorts link, or a bare id.
 *
 * @returns {{ videoId: string, playlistId: string | null } | null}
 */
export function parseYouTube(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // A bare id, pasted on its own.
  const bare = asId(raw);
  if (bare) return { videoId: bare, playlistId: null };

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const playlistId = url.searchParams.get('list');
  const segments = url.pathname.split('/').filter(Boolean);

  let videoId = null;

  if (host === 'youtu.be') {
    videoId = asId(segments[0]);
  } else if (HOST_RE.test(host)) {
    if (url.pathname === '/watch') {
      videoId = asId(url.searchParams.get('v'));
    } else if (['embed', 'v', 'shorts', 'live'].includes(segments[0])) {
      videoId = asId(segments[1]);
    }
  } else {
    return null;
  }

  if (!videoId) return null;
  return { videoId, playlistId };
}

/** Thumbnail URL — allowed by the app CSP's `img-src`. */
export function thumbnailFor(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
