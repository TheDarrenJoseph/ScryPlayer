/**
 * The backdrop: a moon over dark water, and its reflection broken into glints.
 *
 * The reflection is ~200 horizontal light streaks stacked from the horizon to
 * the bottom edge. Each one is the same pre-rendered sprite, drawn with a
 * different width, offset and opacity — cheap enough to animate, and it reads
 * as moving water because the offsets are driven by layered sine waves at
 * different frequencies, so the pattern never visibly repeats.
 */

const ROWS = 120;
const SPRITE_W = 256;
const SPRITE_H = 4;
const STAR_COUNT = 90;

/// A decorative backdrop has no business competing with audio decoding, and
/// at full resolution and 60fps this one cost ~32% of a core continuously.
/// Water is soft and slow, so neither of these is visible:

/** Render below device resolution and let the compositor scale it up. */
const RENDER_SCALE = 0.6;
/** Redraw at 30fps rather than every vsync. */
const FRAME_MS = 1000 / 30;

/** Deterministic PRNG, so the stars hold still between frames. */
function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One soft horizontal streak, drawn once and reused for every row. */
function makeStreakSprite() {
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = SPRITE_H;

  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, SPRITE_W, 0);
  grad.addColorStop(0, 'rgba(150, 190, 240, 0)');
  grad.addColorStop(0.28, 'rgba(160, 198, 244, 0.55)');
  grad.addColorStop(0.5, 'rgba(226, 238, 255, 1)');
  grad.addColorStop(0.72, 'rgba(160, 198, 244, 0.55)');
  grad.addColorStop(1, 'rgba(150, 190, 240, 0)');

  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE_W, SPRITE_H);
  return c;
}

export function startWater(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return () => {};

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sprite = makeStreakSprite();

  let w = 0;
  let h = 0;
  let horizon = 0;
  let moonX = 0;
  let moonY = 0;
  let moonR = 0;
  let skyGrad = null;
  let waterGrad = null;
  let stars = [];
  let raf = 0;
  /** False until the canvas has a real size to draw into. */
  let sized = false;
  /** Timestamp of the last painted frame, for the 30fps throttle. */
  let lastDrawn = 0;

  /** @returns {boolean} false when the canvas has no size to draw into yet */
  function layout() {
    const rect = canvas.getBoundingClientRect();
    w = Math.round(rect.width);
    h = Math.round(rect.height);

    // On the very first pass the element may not be laid out. Drawing now
    // would bake in a 1x1 backing store, so wait for the ResizeObserver.
    if (w === 0 || h === 0) return false;

    // Cap DPR: past 2x the extra pixels cost more than they show. Then scale
    // down again — this is blurred light on water, not text.
    const scale = Math.min(window.devicePixelRatio || 1, 2) * RENDER_SCALE;
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    horizon = h * 0.4;
    moonX = w * 0.72;
    moonY = horizon * 0.44;
    moonR = Math.max(24, Math.min(w, h) * 0.042);

    skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
    skyGrad.addColorStop(0, '#03050a');
    skyGrad.addColorStop(0.6, '#060a13');
    skyGrad.addColorStop(1, '#0b1220');

    waterGrad = ctx.createLinearGradient(0, horizon, 0, h);
    waterGrad.addColorStop(0, '#0a1120');
    waterGrad.addColorStop(0.45, '#070c17');
    waterGrad.addColorStop(1, '#03050b');

    const rand = mulberry32(0x5c27);
    stars = Array.from({ length: STAR_COUNT }, () => ({
      x: rand() * w,
      // Keep them in the sky, thinning out toward the horizon haze.
      y: rand() * horizon * 0.86,
      r: 0.35 + rand() * 0.9,
      a: 0.18 + rand() * 0.5,
      phase: rand() * Math.PI * 2,
    }));

    return true;
  }

  function drawStars(t) {
    for (const s of stars) {
      // A slow, shallow twinkle.
      const twinkle = 0.75 + 0.25 * Math.sin(t * 0.0009 + s.phase);
      ctx.globalAlpha = s.a * twinkle;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawMoon() {
    const halo = ctx.createRadialGradient(moonX, moonY, moonR * 0.6, moonX, moonY, moonR * 7);
    halo.addColorStop(0, 'rgba(178, 206, 244, 0.30)');
    halo.addColorStop(0.35, 'rgba(140, 176, 224, 0.10)');
    halo.addColorStop(1, 'rgba(120, 160, 210, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(moonX, moonY, moonR * 7, 0, Math.PI * 2);
    ctx.fill();

    const disc = ctx.createRadialGradient(
      moonX - moonR * 0.3,
      moonY - moonR * 0.34,
      moonR * 0.1,
      moonX,
      moonY,
      moonR,
    );
    disc.addColorStop(0, '#ffffff');
    disc.addColorStop(0.55, '#e6eeff');
    disc.addColorStop(1, '#a8bcdd');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawReflection(t) {
    const depth = h - horizon;
    const rowH = (depth / ROWS) * 2.1; // Overlap slightly so there are no gaps.

    for (let i = 0; i < ROWS; i++) {
      const p = i / ROWS; // 0 at the horizon, 1 at the bottom edge.
      const y = horizon + p * depth;

      // Three frequencies, so the surface never settles into a visible loop.
      const wobble =
        Math.sin(p * 26.0 + t * 0.0011) * 0.55 +
        Math.sin(p * 11.3 - t * 0.0017) * 0.3 +
        Math.sin(p * 47.0 + t * 0.0026) * 0.15;

      // The reflected column fans out as it approaches the viewer.
      const width = moonR * (1.9 + p * 9) * (0.72 + 0.28 * Math.sin(p * 33 + t * 0.0021));
      const x = moonX + wobble * (6 + p * 46);

      const fade = (1 - p) ** 1.5;
      const flicker = 0.62 + 0.38 * Math.sin(p * 58 - t * 0.0034);
      ctx.globalAlpha = Math.max(0, fade * flicker * 0.42);

      ctx.drawImage(sprite, x - width / 2, y, width, rowH);
    }

    ctx.globalAlpha = 1;
  }

  function draw(t) {
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, horizon);
    ctx.fillStyle = waterGrad;
    ctx.fillRect(0, horizon, w, h - horizon);

    ctx.fillStyle = '#dce8ff';
    drawStars(t);

    // Light adds to light: the moon and its reflection glow rather than paint.
    ctx.globalCompositeOperation = 'lighter';
    drawMoon();
    drawReflection(t);
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    // Skip vsyncs rather than draw on every one.
    if (t - lastDrawn < FRAME_MS) return;
    lastDrawn = t;
    draw(t);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function start() {
    if (raf || !sized) return;
    // A still frame is the whole animation when motion is unwelcome.
    if (motion.matches) {
      draw(0);
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function relayout() {
    stop();
    sized = layout();
    if (sized && !document.hidden) start();
  }

  const onVisibility = () => {
    // No point burning frames on a hidden window.
    if (document.hidden) stop();
    else start();
  };

  // The canvas fills the viewport, so observing it covers both the first
  // layout and every later window resize.
  const observer = new ResizeObserver(relayout);
  observer.observe(canvas);

  relayout();

  document.addEventListener('visibilitychange', onVisibility);
  motion.addEventListener('change', relayout);

  return function dispose() {
    stop();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    motion.removeEventListener('change', relayout);
  };
}
