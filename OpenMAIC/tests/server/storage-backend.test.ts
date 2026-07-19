/**
 * Smoke test for the STORAGE_BACKEND switch.
 *
 *   1. Default (no env var) → fs backend, reads/writes data/classrooms/<id>.json
 *   2. STORAGE_BACKEND=postgres without DATABASE_URL → constructor throws fail-fast
 *   3. STORAGE_BACKEND=invalid → factory throws with a clear message
 *
 * Run with:  pnpm tsx tests/server/storage-backend.test.ts
 * (or just:  npx tsx tests/server/storage-backend.test.ts)
 */
import path from 'path';
import { promises as fs } from 'fs';
import {
  getClassroomStorage,
  getClassroomStorageBackend,
  _resetClassroomStorageForTests,
} from '@/lib/server/storage';

const tmpRoot = path.join(process.cwd(), 'data', 'classrooms');

function assertEq<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const fakeId = 'smoke-test-classroom';
  const file = path.join(tmpRoot, `${fakeId}.json`);
  await fs.rm(file, { force: true });
  const tmpFiles = await fs.readdir(tmpRoot).catch(() => []);
  for (const f of tmpFiles) {
    if (f.startsWith(fakeId)) await fs.rm(path.join(tmpRoot, f), { force: true });
  }
}

async function caseFsDefault() {
  // eslint-disable-next-line no-console
  console.log('\n[case 1] default backend is fs');
  _resetClassroomStorageForTests();
  delete process.env.STORAGE_BACKEND;
  delete process.env.DATABASE_URL;
  assertEq(getClassroomStorageBackend(), 'fs', 'backend === "fs"');

  const storage = getClassroomStorage();
  const id = 'smoke-test-classroom';
  const stage = { id, name: 'Smoke' } as never;
  const scenes = [] as never;

  const before = await storage.read(id);
  assertEq(before, null, 'read missing → null');

  await storage.write({ id, stage, scenes, createdAt: new Date().toISOString() });
  const after = await storage.read(id);
  if (!after) throw new Error('read after write returned null');
  assertEq(after.id, id, 'read after write → id matches');
}

async function casePostgresMissingUrl() {
  // eslint-disable-next-line no-console
  console.log('\n[case 2] STORAGE_BACKEND=postgres without DATABASE_URL → fail-fast');
  _resetClassroomStorageForTests();
  process.env.STORAGE_BACKEND = 'postgres';
  delete process.env.DATABASE_URL;
  try {
    getClassroomStorage();
    throw new Error('expected constructor to throw');
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('DATABASE_URL')) {
      throw new Error(`expected DATABASE_URL error, got: ${msg}`);
    }
    // eslint-disable-next-line no-console
    console.log('  ok  constructor threw with DATABASE_URL hint');
  }
}

async function caseInvalidBackend() {
  // eslint-disable-next-line no-console
  console.log('\n[case 3] STORAGE_BACKEND=garbage → factory throws');
  _resetClassroomStorageForTests();
  process.env.STORAGE_BACKEND = 'garbage';
  try {
    getClassroomStorage();
    throw new Error('expected factory to throw');
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('not supported')) {
      throw new Error(`expected "not supported" error, got: ${msg}`);
    }
    // eslint-disable-next-line no-console
    console.log('  ok  factory threw with clear message');
  }
}

async function main() {
  await caseFsDefault();
  await casePostgresMissingUrl();
  await caseInvalidBackend();
  await cleanup();
  // eslint-disable-next-line no-console
  console.log('\nAll storage-backend smoke tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nFAIL:', err);
  process.exit(1);
});
