import type { ClassroomStorage, ClassroomStorageBackend } from './types';
import { FsClassroomStorage } from './fs-backend';
import { PostgresClassroomStorage } from './postgres-backend';

/**
 * Single source of truth for which `ClassroomStorage` implementation the app
 * uses. Resolution order:
 *
 *   1. `STORAGE_BACKEND` env var (set per deploy)
 *   2. fallback to 'fs' (the original behaviour, safe for local dev)
 *
 * The instance is cached on `globalThis` because Next.js dev mode hot-reloads
 * the module on every route change; without the cache, every reload would
 * re-read `STORAGE_BACKEND` and re-instantiate the backend, which is fine for
 * `fs` but would also drop a postgres connection pool mid-request. The same
 * trick is used in `tts-queue.ts`; keeping the pattern consistent.
 */
const STORAGE_GLOBAL_KEY = '__openmaic_classroom_storage__' as const;

interface CachedStorage {
  instance: ClassroomStorage;
  backend: ClassroomStorageBackend;
}

function resolveStorage(): CachedStorage {
  const raw = (process.env.STORAGE_BACKEND ?? 'fs').toLowerCase();
  if (raw !== 'fs' && raw !== 'postgres') {
    throw new Error(
      `STORAGE_BACKEND="${raw}" is not supported. Use "fs" (default) or "postgres".`,
    );
  }
  const backend: ClassroomStorageBackend = raw;
  const instance: ClassroomStorage =
    backend === 'postgres' ? new PostgresClassroomStorage() : new FsClassroomStorage();
  return { instance, backend };
}

function getCachedStorage(): CachedStorage {
  const g = globalThis as unknown as Record<typeof STORAGE_GLOBAL_KEY, CachedStorage | undefined>;
  if (!g[STORAGE_GLOBAL_KEY]) {
    g[STORAGE_GLOBAL_KEY] = resolveStorage();
  }
  return g[STORAGE_GLOBAL_KEY];
}

/** The active classroom storage backend instance. Resolved on first call. */
export function getClassroomStorage(): ClassroomStorage {
  return getCachedStorage().instance;
}

/** The backend id ('fs' | 'postgres') the app is currently using. */
export function getClassroomStorageBackend(): ClassroomStorageBackend {
  return getCachedStorage().backend;
}

/**
 * Test-only: clear the cached instance so the next `getClassroomStorage()`
 * call re-reads `STORAGE_BACKEND`. Production code must never call this; the
 * whole point of the cache is that a server runtime picks one backend and
 * keeps it.
 */
export function _resetClassroomStorageForTests(): void {
  const g = globalThis as unknown as Record<typeof STORAGE_GLOBAL_KEY, CachedStorage | undefined>;
  delete g[STORAGE_GLOBAL_KEY];
}
