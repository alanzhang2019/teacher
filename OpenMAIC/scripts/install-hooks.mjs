#!/usr/bin/env node
// scripts/install-hooks.mjs
//
// One-time install of .git/hooks/pre-commit that calls scripts/precommit.mjs.
// Re-runnable: overwrites the previous hook.
//
// Usage:
//   node scripts/install-hooks.mjs           # install
//   node scripts/install-hooks.mjs --uninstall  # remove

import { existsSync, writeFileSync, chmodSync, unlinkSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to THIS script (works regardless of where the repo
// root is — important because this repo's git toplevel is one level up from
// the OpenMAIC subdir, not OpenMAIC itself).
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const repoDir    = resolve(__dirname, '..');   // OpenMAIC/

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const hooksDir = resolve(root, '.git', 'hooks');
const hookPath = resolve(hooksDir, 'pre-commit');

if (process.argv.includes('--uninstall')) {
  if (existsSync(hookPath)) {
    unlinkSync(hookPath);
    console.log(`[install-hooks] removed: ${hookPath}`);
  } else {
    console.log(`[install-hooks] no pre-commit hook to remove`);
  }
  process.exit(0);
}

if (!existsSync(hooksDir)) {
  console.error(`[install-hooks] .git/hooks not found at ${hooksDir}`);
  console.error(`[install-hooks] are you in a git repo?`);
  process.exit(1);
}

const precommitPath = resolve(repoDir, 'scripts', 'precommit.mjs');
if (!existsSync(precommitPath)) {
  console.error(`[install-hooks] ${precommitPath} not found`);
  process.exit(1);
}

const hookBody = `#!/bin/sh
# Auto-installed by scripts/install-hooks.mjs
# Do not edit by hand — re-run install-hooks.mjs to update.
exec node "${precommitPath}" "$@"
`;

writeFileSync(hookPath, hookBody, { encoding: 'utf8' });

// Make executable (best-effort on Windows; harmless if chmod fails).
try {
  chmodSync(hookPath, 0o755);
} catch {
  // Windows: git bash reads the shebang anyway.
}

console.log(`[install-hooks] installed: ${hookPath}`);
console.log(`[install-hooks] pre-commit hook will run scripts/precommit.mjs`);
console.log(`[install-hooks] to skip once:  git commit --no-verify`);
