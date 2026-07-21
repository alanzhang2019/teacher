import { promises as fs } from 'fs';
import path from 'path';
import type { ClassroomStorage } from './types';
import type { PersistedClassroomData, Scene } from './types';
import { writeJsonFileAtomic } from './fs-utils';

/**
 * Filesystem-backed classroom storage. One JSON file per classroom at
 * `data/classrooms/<id>.json`, written atomically via the helper in
 * `fs-utils.ts`. This is the default backend and is also the one used by the
 * existing single-machine dev/test flows; the postgres backend is opt-in
 * via `STORAGE_BACKEND=postgres`.
 *
 * Concurrency: a single Next.js process serialises writes through Node's
 * libuv thread pool, but multiple pods writing to the same volume will race.
 * The postgres backend exists to make that race explicit; fs is for
 * single-process / single-pod deployments.
 */
export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');

export class FsClassroomStorage implements ClassroomStorage {
  async read(id: string): Promise<PersistedClassroomData | null> {
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as PersistedClassroomData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async write(data: PersistedClassroomData): Promise<void> {
    await fs.mkdir(CLASSROOMS_DIR, { recursive: true });
    const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
    await writeJsonFileAtomic(filePath, data);
  }

  async writeScenes(id: string, scenes: Scene[]): Promise<void> {
    // For the fs backend a "scenes-only" write is still a full-file rewrite
    // — there's no partial-update path that wouldn't be racy with a
    // concurrent `write()` from another tab. Read-modify-write under the
    // same atomic-rename pattern `write()` uses.
    const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
    let current: PersistedClassroomData;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      current = JSON.parse(content) as PersistedClassroomData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `FsClassroomStorage.writeScenes: classroom ${id} does not exist`,
        );
      }
      throw error;
    }
    await writeJsonFileAtomic(filePath, { ...current, scenes });
  }
}
