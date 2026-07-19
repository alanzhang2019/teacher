/**
 * Classroom storage abstraction.
 *
 * The classroom domain originally wrote to the local filesystem
 * (`data/classrooms/<id>.json`). When the app is deployed to a multi-user
 * cloud environment (e.g. behind a load balancer or as a managed container),
 * a single pod's filesystem is ephemeral, so the same data needs to live in a
 * shared store. This interface lets the call sites keep using
 * `readClassroom` / `persistClassroom` from `classroom-storage.ts` while the
 * underlying backend is swapped via the `STORAGE_BACKEND` env var.
 *
 * Implementations:
 *   - `fs-backend.ts`     — current behaviour, default. One JSON file per
 *                           classroom under `data/classrooms/`.
 *   - `postgres-backend.ts` — production. Single `classrooms` row carrying
 *                           stage JSONB + access code; scenes live in a
 *                           separate table so we can stream them in.
 *                           NOTE: not yet implemented; the constructor throws
 *                           so a misconfigured deploy fails fast at boot
 *                           instead of silently dropping writes.
 *
 * The factory in `./index.ts` reads `STORAGE_BACKEND` (default `fs`) and
 * caches the instance on `globalThis` so Next.js dev hot-reload doesn't
 * reset it between requests.
 */
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * The persisted shape of a classroom. Re-exported from
 * `classroom-storage.ts` for back-compat with existing imports
 * (`import type { PersistedClassroomData } from '@/lib/server/classroom-storage'`).
 */
export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export interface ClassroomStorage {
  /**
   * Read a persisted classroom by its stage id. Returns `null` when not found;
   * throws on any other I/O error (caller decides whether to surface it).
   */
  read(id: string): Promise<PersistedClassroomData | null>;

  /**
   * Persist (create or overwrite) a classroom. Implementations must be atomic
   * for the fs case (`writeFile` + `rename`) and use a single upsert
   * statement for the postgres case — a partial write is unrecoverable for
   * students who joined mid-deploy.
   */
  write(data: PersistedClassroomData): Promise<void>;
}

export type ClassroomStorageBackend = 'fs' | 'postgres';
