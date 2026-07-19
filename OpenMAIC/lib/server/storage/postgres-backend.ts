import type { ClassroomStorage, PersistedClassroomData } from './types';

/**
 * Postgres-backed classroom storage. NOT YET IMPLEMENTED — the schema lives
 * in the cloud-deploy spec (`OpenMAIC/.trae-cn/specs/deploy-teacher-classroom.md`,
 * section 3.2) and will be wired in Phase 1.1 (T1.1–T1.3). The constructor
 * throws so that a deploy with `STORAGE_BACKEND=postgres` set fails loudly at
 * boot instead of silently dropping writes — the fs fallback is the
 * single-source-of-truth loss you do NOT want to debug from a 500 dashboard
 * a day later.
 *
 * Connection settings (read here, ignored until the implementation lands):
 *   - `DATABASE_URL`  — postgres://user:pass@host:5432/db
 *   - `PGSSLMODE`     — default 'disable'; cloud deploys set 'require'
 */
export class PostgresClassroomStorage implements ClassroomStorage {
  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'PostgresClassroomStorage: STORAGE_BACKEND=postgres but DATABASE_URL is not set. ' +
          'Either set DATABASE_URL or unset STORAGE_BACKEND to fall back to the fs backend.',
      );
    }
    throw new Error(
      'PostgresClassroomStorage: not yet implemented. ' +
        'See OpenMAIC/.trae-cn/specs/deploy-teacher-classroom.md Phase 1.1 (T1.1–T1.3) for the schema.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async read(id: string): Promise<PersistedClassroomData | null> {
    // Intentionally unreachable: constructor throws first. Keep the method
    // body so the class still satisfies the `ClassroomStorage` interface and
    // TypeScript won't reject the import.
    throw new Error('PostgresClassroomStorage: not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async write(data: PersistedClassroomData): Promise<void> {
    throw new Error('PostgresClassroomStorage: not yet implemented');
  }
}
