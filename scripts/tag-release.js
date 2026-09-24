#!/usr/bin/env node

// Bumps the version everywhere it's declared (package.json, tauri.conf.json,
// Cargo.toml — and Cargo.lock's record of it), commits that as one change,
// and tags it. Pushing is a separate, explicit confirmation: this script
// collapses the busywork, not the decision to actually ship.
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

function bumpJsonVersion(relPath, version) {
  const file = path.join(repoRoot, relPath);
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`);
  if (next === text) usageAndExit(`Could not find a "version" field in ${relPath}.`);
  fs.writeFileSync(file, next);
}

function bumpCargoVersion(relPath, version) {
  const file = path.join(repoRoot, relPath);
  const text = fs.readFileSync(file, 'utf8');
  // Anchored so this only ever touches the [package] version, never a
  // dependency's — those are written as `name = { version = "...", ... }`
  // on one line, not a standalone `version = "..."` line.
  const next = text.replace(/^version = "[^"]*"/m, `version = "${version}"`);
  if (next === text) usageAndExit(`Could not find a "version" field in ${relPath}.`);
  fs.writeFileSync(file, next);
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

  if (git(['tag', '--list', tag])) {
    usageAndExit(`Tag ${tag} already exists.`);
  }

  git(['fetch', 'origin', 'main']);
  if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'origin/main'])) {
    usageAndExit('main is not up to date with origin/main. Pull first.');
  }

  bumpJsonVersion('package.json', version);
  bumpJsonVersion('src-tauri/tauri.conf.json', version);
  bumpCargoVersion('src-tauri/Cargo.toml', version);

  // Regenerates just this package's version line in Cargo.lock — nothing
  // else in it — so the bump commit doesn't leave the lockfile stale.
  execFileSync('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--quiet'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  git(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
  git(['commit', '-m', `Bump version to ${version}`]);
  git(['tag', tag]);

  console.log(`\nTagged ${tag} on top of a new "Bump version to ${version}" commit.`);

  if (await confirm(`Push main and ${tag} to origin now? This starts the release build.`)) {
    git(['push', 'origin', 'main', tag]);
    console.log(`Pushed. Watch the build under Actions, then publish the draft release once it's done.`);
  } else {
    console.log(`Not pushed. When ready:\n\n  git push origin main ${tag}\n`);
  }
}

main();
