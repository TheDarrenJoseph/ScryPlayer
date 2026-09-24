#!/usr/bin/env node

// Overwrites one of the two README screenshots with a fresh capture of the
// running app window. Get the app into the state you want shown (`npm run
// dev`, then load a local folder or a YouTube link), then run:
//
//   node scripts/update-screenshot.js local
//   node scripts/update-screenshot.js youtube
//
// Only knows how to find the window on Linux (X11/XWayland) and macOS.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOW_TITLE = 'Scry Player';
const TARGETS = {
  local: 'example_local_screenshot.png',
  youtube: 'example_youtube_screenshot.png',
};

function usageAndExit(message) {
  if (message) console.error(message + '\n');
  console.error(
    'Usage: node scripts/update-screenshot.js <local|youtube> [--window-id=<id>]\n\n' +
      'Run the app (`npm run dev`), get it into the state you want captured,\n' +
      'then run this with the matching target to overwrite that README screenshot.'
  );
  process.exit(1);
}

function which(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findWindowIdsLinux() {
  const tree = execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' });
  return tree
    .split('\n')
    .map((line) => line.match(/^\s*(0x[0-9a-f]+)\b.*"[^"]*Scry Player[^"]*"/i))
    .filter(Boolean)
    .map((m) => m[1]);
}

function captureLinux(outFile, windowIdOverride) {
  for (const bin of ['xwininfo', 'import']) {
    if (!which(bin)) {
      usageAndExit(
        `Missing "${bin}". Install the X11/ImageMagick tools:\n` + '  sudo apt install x11-utils imagemagick'
      );
    }
  }

  let windowId = windowIdOverride;
  if (!windowId) {
    const ids = findWindowIdsLinux();
    if (ids.length === 0) {
      usageAndExit(
        `Couldn't find a window titled "${WINDOW_TITLE}". Is the app running (\`npm run dev\`)?\n` +
          "On a Wayland session, GTK apps sometimes render outside X and won't show up here — " +
          'try `GDK_BACKEND=x11 npm run dev` instead, or pass --window-id=<id> from `xwininfo -root -tree`.'
      );
    }
    if (ids.length > 1) {
      console.warn(`Found ${ids.length} windows titled "${WINDOW_TITLE}", using the first (${ids[0]}).`);
      console.warn('Pass --window-id=<id> to pick a different one.');
    }
    windowId = ids[0];
  }

  try {
    execFileSync('import', ['-window', windowId, outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    usageAndExit(
      `\`import -window ${windowId}\` failed: ${err.stderr?.toString().trim() || err.message}\n` +
        'The window may have closed, moved off a capturable surface, or the compositor is blocking the grab.'
    );
  }
}

function captureMac(outFile) {
  const script = `
    tell application "System Events"
      set theProcess to first process whose name is "${WINDOW_TITLE}"
      set theWindow to first window of theProcess
      set {x, y} to position of theWindow
      set {w, h} to size of theWindow
    end tell
    return (x as string) & "," & (y as string) & "," & (w as string) & "," & (h as string)
  `;
  let bounds;
  try {
    bounds = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
  } catch {
    usageAndExit(`Couldn't find a window titled "${WINDOW_TITLE}". Is the app running (\`npm run dev\`)?`);
  }
  const [x, y, w, h] = bounds.split(',').map(Number);
  try {
    execFileSync('screencapture', ['-R', `${x},${y},${w},${h}`, '-x', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    usageAndExit(`\`screencapture\` failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const windowIdArg = args.find((a) => a.startsWith('--window-id='));
  const windowIdOverride = windowIdArg ? windowIdArg.slice('--window-id='.length) : undefined;

  if (!target || !TARGETS[target]) {
    usageAndExit(`Target must be one of: ${Object.keys(TARGETS).join(', ')}`);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outFile = path.join(repoRoot, 'images', TARGETS[target]);
  const tmpFile = path.join(os.tmpdir(), `scryplayer-screenshot-${Date.now()}.png`);

  if (process.platform === 'linux') {
    captureLinux(tmpFile, windowIdOverride);
  } else if (process.platform === 'darwin') {
    captureMac(tmpFile);
  } else {
    usageAndExit(`Unsupported platform: ${process.platform}. This script only knows Linux (X11/XWayland) and macOS.`);
  }

  const stats = fs.statSync(tmpFile);
  if (stats.size < 1024) {
    fs.unlinkSync(tmpFile);
    usageAndExit(
      'Capture looked empty (under 1KB) — the window probably was not visible. Aborting without touching the README image.'
    );
  }

  fs.renameSync(tmpFile, outFile);
  console.log(`Saved ${target} screenshot to ${path.relative(repoRoot, outFile)} (${(stats.size / 1024).toFixed(0)} KB).`);
}

main();
