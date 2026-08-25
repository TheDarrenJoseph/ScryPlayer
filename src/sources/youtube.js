/** An 11-character YouTube video id. */
const VIDEO_ID_REGEX = /^[\w-]{11}$/;
const HOST_REGEX = /^((m|www|music)\.)?youtube(-nocookie)?\.com$/;

const asId = (v) => (typeof v === 'string' && VIDEO_ID_REGEX.test(v) ? v : null);

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
  const path = url.pathname.split('/').filter(Boolean);

  let videoId = null;

  // Check for the shortened URL
  if (host === 'youtu.be') {
    videoId = asId(path[0]);
  } else if (HOST_REGEX.test(host) && url.pathname === '/watch') {
      videoId = asId(url.searchParams.get('v'));
  } else {
    return null;
  }

  if (videoId != null) {
    return { videoId, playlistId };
  } else {
    return null;
  }
}

/** Thumbnail URL — allowed by the app CSP's `img-src`. */
export function thumbnailFor(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
