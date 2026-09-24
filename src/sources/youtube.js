/** An 11-character YouTube video id. */
const VIDEO_ID_REGEX = /^[\w-]{11}$/;
const HOST_REGEX = /^((m|www|music)\.)?youtube(-nocookie)?\.com$/;

const asId = (v) => (typeof v === 'string' && VIDEO_ID_REGEX.test(v) ? v : null);

/**
 * Pull a video id (and playlist id, when present) out of whatever the user
 * pasted — a watch link, a youtu.be share link, or a bare id.
 *
 * Ordinary videos only. Embed and Shorts URL forms are deliberately not
 * accepted; they are not what anyone reaches for when queueing music.
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

  let videoId = null;

  if (host === 'youtu.be') {
    // The share form carries the id as the first path segment.
    videoId = asId(url.pathname.split('/').filter(Boolean)[0]);
  } else if (HOST_REGEX.test(host) && url.pathname === '/watch') {
    videoId = asId(url.searchParams.get('v'));
  }

  if (!videoId) return null;
  return { videoId, playlistId: url.searchParams.get('list') };
}

/** Thumbnail URL — allowed by the app CSP's `img-src`. */
export function thumbnailFor(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * The real title and channel name for a video, via YouTube's oEmbed endpoint.
 * No API key needed, and it reflects back whatever origin asks — the app CSP
 * allows the request under `connect-src`.
 *
 * This exists so a queued video shows its actual name right away, instead of
 * the bare id it starts with. Failure of any kind (offline, a deleted video,
 * an owner who disabled embedding) resolves to `null` rather than throwing,
 * since the caller has a perfectly good placeholder to fall back to.
 *
 * @returns {Promise<{ title: string, artist: string | null } | null>}
 */
export async function fetchVideoInfo(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  try {
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;

    const data = await res.json();
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) return null;

    const artist = typeof data.author_name === 'string' ? data.author_name.trim() : '';
    return { title, artist: artist || null };
  } catch {
    return null;
  }
}
