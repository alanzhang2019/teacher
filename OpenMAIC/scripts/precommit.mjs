#!/usr/bin/env node
// scripts/precommit.mjs
//
// Pre-commit hook: detect risky CSS / Tailwind / layout changes that
// historically caused the Next.js dev server to serve a page with
// un-injected CSS (huge logo, vertical text stacking, no flex/grid).
//
// When risky files are touched, clear .next/ and node_modules/.cache/
// BEFORE the commit so the next `pnpm dev` / `start_all.ps1` starts
// from a clean webpack state.  Also emit a tip about hard-refresh.
//
// Install:  npm run precommit:install
//   (or)    node scripts/install-hooks.mjs

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANSI = {
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

// Patterns of files that affect global CSS / layout output.
// Test: filename as repo-relative path from `git diff --cached --name-only`.
const RISKY_PATTERNS = [
  // Top-level config files
  /^tailwind\.config\./,
  /^postcss\.config\./,
  /^next\.config\./,
  // Layout components
  /(^|\/)app\/layout\.tsx?$/,
  /(^|\/)app\/.+\/layout\.tsx?$/,           // nested layouts
  // Any CSS under app/, components/, styles/, src/ — these are global CSS
  // carriers (Tailwind directives, CSS modules, postcss plugins) that can
  // confuse the dev server when changed mid-session.
  /(^|\/)app\/.+\.css$/,
  /(^|\/)components\/.+\.css$/,
  /(^|\/)styles\/.+\.css$/,
  /(^|\/)src\/.+\.css$/,
];

// Resolve repo dir from this script's location (works regardless of where
// the git toplevel is — this repo's toplevel is one level above OpenMAIC/).
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const repoDir    = resolve(__dirname, '..');   // OpenMAIC/

// Staged files (what's about to be committed).
let staged;
try {
  staged = execSync('git diff --cached --name-only --diff-filter=ACMR', {
    encoding: 'utf8',
    cwd: repoDir,
  });
} catch (e) {
  console.error(`${ANSI.yellow}[precommit]${ANSI.reset} git diff failed, skipping: ${e.message}`);
  process.exit(0);
}

const files = staged.split('\n').filter(Boolean);
const risky = files.filter((f) => RISKY_PATTERNS.some((p) => p.test(f)));

if (risky.length === 0) {
  console.log(`${ANSI.dim}[precommit] no risky CSS files — nothing to do${ANSI.reset}`);
  process.exit(0);
}

console.log(`${ANSI.cyan}[precommit]${ANSI.reset} detected ${ANSI.bold}${risky.length}${ANSI.reset} risky file(s):`);
for (const f of risky) console.log(`  ${ANSI.dim}-${ANSI.reset} ${f}`);

// Clear dev caches that are most likely to hold stale CSS chunks.
const toClear = ['.next', 'node_modules/.cache'];
let cleared = 0;
let blocked = 0;
for (const rel of toClear) {
  const abs = resolve(repoDir, rel);
  if (existsSync(abs)) {
    try {
      rmSync(abs, { recursive: true, force: true });
      console.log(`${ANSI.cyan}[precommit]${ANSI.reset} cleared ${rel}/`);
      cleared++;
    } catch (e) {
      // ENOTEMPTY / EBUSY on Windows = dev server is still using the dir.
      // Not fatal; we just note it and let the user restart dev manually.
      console.error(
        `${ANSI.yellow}[precommit]${ANSI.reset} could not clear ${rel}/ (dev server may be running): ${e.code ?? e.message}`,
      );
      blocked++;
    }
  }
}

console.log('');
if (blocked > 0 && cleared === 0) {
  console.log(`${ANSI.cyan}[precommit]${ANSI.reset} ${ANSI.bold}action taken:${ANSI.reset} detected ${risky.length} risky file(s), but dev server is holding cache.`);
  console.log(`${ANSI.cyan}[precommit]${ANSI.reset} run ${ANSI.bold}stop_all.ps1 && start_all.ps1${ANSI.reset} once to clear, or just Ctrl+Shift+R.`);
} else {
  console.log(`${ANSI.cyan}[precommit]${ANSI.reset} ${ANSI.bold}action taken:${ANSI.reset} cleared ${cleared} cache dir(s).`);
  console.log(`${ANSI.cyan}[precommit]${ANSI.reset} next ${ANSI.bold}pnpm dev${ANSI.reset} / ${ANSI.bold}start_all.ps1${ANSI.reset} will recompile (~1-3 min).`);
  console.log(`${ANSI.cyan}[precommit]${ANSI.reset} ${ANSI.dim}tip:${ANSI.reset} if you still see a broken page (huge logo, vertical text), Ctrl+Shift+R.`);
}
process.exit(0);
