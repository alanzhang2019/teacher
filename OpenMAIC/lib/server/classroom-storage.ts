import path from 'path';
import type { NextRequest } from 'next/server';
import {
  CLASSROOMS_DIR as FS_CLASSROOMS_DIR,
  FsClassroomStorage,
} from '@/lib/server/storage/fs-backend';
import { writeJsonFileAtomic } from '@/lib/server/storage/fs-utils';
import { getClassroomStorage } from '@/lib/server/storage';
import type { PersistedClassroomData } from '@/lib/server/storage/types';

/**
 * Classroom storage — thin facade in front of the swappable
 * `ClassroomStorage` backend (see `./storage/`).
 *
 * History: this file used to read/write the local filesystem directly. The
 * classroom JSON stayed there even when we moved long TTS jobs to the
 * server-side queue, which was fine for single-machine dev. The cloud
 * teacher-classroom deploy (#spec/deploy-teacher-classroom.md) needs a
 * database-backed store so multiple replicas share the same metadata, so the
 * fs write path moved behind a `ClassroomStorage` interface selected by the
 * `STORAGE_BACKEND` env var. Callers keep importing the same names
 * (`readClassroom` / `persistClassroom`) so the change is transparent.
 *
 * The media files themselves (under `data/classrooms/<id>/{media,audio}/`)
 * still live on the filesystem — see `app/api/classroom-media/.../route.ts`.
 * On cloud, mount `data/` to a shared volume (EBS / NFS); the postgres
 * backend covers the *metadata*, the media directory is best-effort cached.
 */

// ---------------------------------------------------------------------------
// Back-compat re-exports
// ---------------------------------------------------------------------------

/**
 * The persisted shape of a classroom — declared in `storage/types.ts` (where
 * the storage abstraction lives) and re-exported here so existing
 * `import type { PersistedClassroomData } from '@/lib/server/classroom-storage'`
 * callers keep working without a path change.
 */
export type { PersistedClassroomData };

// ---------------------------------------------------------------------------
// Paths / helpers (unchanged — job-store and media route still need them)
// ---------------------------------------------------------------------------

export const CLASSROOMS_DIR = FS_CLASSROOMS_DIR; // re-export for back-compat
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

export async function ensureClassroomsDir() {
  const { mkdir } = await import('fs/promises');
  await mkdir(CLASSROOMS_DIR, { recursive: true });
}

export async function ensureClassroomJobsDir() {
  const { mkdir } = await import('fs/promises');
  await mkdir(CLASSROOM_JOBS_DIR, { recursive: true });
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// Backend-driven classroom persistence
// ---------------------------------------------------------------------------

/**
 * Read a classroom. Backed by the configured `ClassroomStorage`; resolves
 * to the active backend (fs or postgres) on first call. Returns `null` when
 * the id is unknown.
 */
export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  return getClassroomStorage().read(id);
}

/**
 * Replace just the scene list for a classroom, leaving the stage
 * metadata untouched. Forwards straight through to the active backend's
 * `writeScenes`. Throws if the classroom id is unknown — callers can
 * `readClassroom` first if they need a 404 vs 200 distinction.
 */
export async function writeClassroomScenes(
  id: string,
  scenes: PersistedClassroomData['scenes'],
): Promise<void> {
  await getClassroomStorage().writeScenes(id, scenes);
}

/**
 * Persist a classroom. Builds the `PersistedClassroomData` envelope
 * (adding `createdAt` if missing) and writes through the active backend.
 * Returns the persisted record plus the canonical share URL so the API
 * route can hand the link straight back to the client.
 */
export async function persistClassroom(
  data: {
    id: string;
    stage: PersistedClassroomData['stage'];
    scenes: PersistedClassroomData['scenes'];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  await getClassroomStorage().write(classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

// ---------------------------------------------------------------------------
// Legacy fs-only exports (still used by classroom-job-store.ts and tests).
// These are NOT part of the storage abstraction — they're plain file helpers.
// Kept here so callers that only need a quick `writeJsonFileAtomic` don't
// have to import the new storage module.
// ---------------------------------------------------------------------------

export { writeJsonFileAtomic };

/**
 * Test-only helper: spin up a fresh fs backend. Production code must use
 * `getClassroomStorage()` so the env-driven backend is respected.
 */
export function makeFsClassroomStorage(): FsClassroomStorage {
  return new FsClassroomStorage();
}
