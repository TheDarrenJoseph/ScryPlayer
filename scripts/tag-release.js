#!/usr/bin/env node

// Bumps the version everywhere it's declared (package.json, tauri.conf.json,
// Cargo.toml — and Cargo.lock's record of it), commits that as one change,
// and tags it. Pushing is a separate, explicit confirmation: this script
// collapses the busywork, not the decision to actually ship.
//
// Every step checks the current state first and skips itself — with a line
// saying so — when there's nothing to do. That makes it safe to re-run: a
// first release tagging an already-correct 0.1.0, or a retry after an
// earlier run got as far as the commit but not the tag, both just do
// whatever's left.
//
//   node scripts/tag-release.js 0.2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usageAndExit(message) {
  if (message) console.error(message + '\n');
  console.error(
    'Usage: node scripts/tag-release.js <version>\n\n' + 'Example: node scripts/tag-release.js 0.2.0',
  );
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** Reads and rewrites a `"version": "..."` field, reporting what it did. */
function syncJsonVersion(relPath, version) {
  const file = path.join(repoRoot, relPath);
  const text = fs.readFileSync(file, 'utf8');
  const pattern = /"version":\s*"([^"]*)"/;
  const match = text.match(pattern);
  if (!match) usageAndExit(`Could not find a "version" field in ${relPath}.`);

  if (match[1] === version) {
    console.log(`skipped ${relPath} (already ${version})`);
    return false;
  }
  fs.writeFileSync(file, text.replace(pattern, `"version": "${version}"`));
  console.log(`updated ${relPath}`);
  return true;
}

/** As above, for Cargo.toml's bare `version = "..."` form. */
function syncCargoVersion(relPath, version) {
  const file = path.join(repoRoot, relPath);
  const text = fs.readFileSync(file, 'utf8');
  // Anchored so this only ever touches the [package] version, never a
  // dependency's — those are written as `name = { version = "...", ... }`
  // on one line, not a standalone `version = "..."` line.
  const pattern = /^version = "([^"]*)"/m;
  const match = text.match(pattern);
  if (!match) usageAndExit(`Could not find a "version" field in ${relPath}.`);

  if (match[1] === version) {
    console.log(`skipped ${relPath} (already ${version})`);
    return false;
  }
  fs.writeFileSync(file, text.replace(pattern, `version = "${version}"`));
  console.log(`updated ${relPath}`);
  return true;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) usageAndExit();

  const version = raw.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    usageAndExit(`"${raw}" doesn't look like a version (expected e.g. 0.2.0).`);
  }
  const tag = `v${version}`;

  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
    usageAndExit('Releases are tagged from main. Switch branches and try again.');
  }

  if (git(['status', '--porcelain'])) {
    usageAndExit('Working tree is not clean. Commit or stash first.');
  }

  git(['fetch', 'origin', 'main']);
  if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'origin/main'])) {
    usageAndExit('main is not up to date with origin/main. Pull first.');
  }

  const changed = [];
  if (syncJsonVersion('package.json', version)) changed.push('package.json');
  if (syncJsonVersion('src-tauri/tauri.conf.json', version)) changed.push('src-tauri/tauri.conf.json');
  if (syncCargoVersion('src-tauri/Cargo.toml', version)) changed.push('src-tauri/Cargo.toml');

  if (changed.includes('src-tauri/Cargo.toml')) {
    // Regenerates just this package's version line in Cargo.lock — nothing
    // else in it.
    execFileSync('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--quiet'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    changed.push('src-tauri/Cargo.lock');
    console.log('updated src-tauri/Cargo.lock');
  }

  if (changed.length) {
    git(['add', ...changed]);
    git(['commit', '-m', `Bump version to ${version}`]);
    console.log(`committed: Bump version to ${version}`);
  } else {
    console.log('skipped commit (nothing changed)');
  }

  if (git(['tag', '--list', tag])) {
    console.log(`skipped git tag (already ${tag})`);
  } else {
    git(['tag', tag]);
    console.log(`created git tag ${tag}`);
  }

  if (await confirm(`\nPush main and ${tag} to origin now? This starts the release build.`)) {
    git(['push', 'origin', 'main', tag]);
    console.log(`Pushed. Watch the build under Actions, then publish the draft release once it's done.`);
  } else {
    console.log(`Not pushed. When ready:\n\n  git push origin main ${tag}\n`);
  }
}

main();
