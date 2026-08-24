/** Seconds → `m:ss`, or `h:mm:ss` once we pass the hour. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');

  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Join the parts of a subtitle, skipping the ones we do not have. */
export function joinMeta(...parts) {
  return parts.filter((p) => typeof p === 'string' && p.trim()).join(' · ');
}
