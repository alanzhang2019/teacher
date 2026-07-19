import { promises as fs } from 'fs';
import path from 'path';

/**
 * Shared fs utilities used by the classroom storage backends. Kept here so
 * both `fs-backend.ts` and any future file-backed backend (e.g. S3 mock for
 * local tests) can share the same atomic-write semantics.
 */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}
