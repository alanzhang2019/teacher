import { type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { isValidClassroomId, readClassroom } from '@/lib/server/classroom-storage';
import { getClassroomStorage } from '@/lib/server/storage';
import { getDb } from '@/lib/server/db/client';
import { classroomAssets } from '@/lib/server/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom Assets API');

/**
 * Where the assets are physically served from. Lives under `public/` so
 * Next.js's static handler serves them at `/classroom-assets/...` without
 * going through any TS code — a generated `Image` element pointing at
 * `/classroom-assets/abc/img_1.png` will be fetched by the browser
 * directly, no Next.js route involvement, which matters for the
 * "50 concurrent students" pressure test (Phase 6 T6.2).
 *
 * The fs storage backend is the source of truth for the bytes; the
 * postgres backend ALSO writes here so both backends get the same
 * `/classroom-assets/...` URL the client can rely on.
 */
export const CLASSROOM_ASSETS_DIR = path.join(process.cwd(), 'public', 'classroom-assets');

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'application/octet-stream': 'bin',
  'application/json': 'json',
};

function pickExtension(kind: string, meta: unknown): string {
  if (meta && typeof meta === 'object' && 'mime' in meta) {
    const mime = (meta as { mime?: unknown }).mime;
    if (typeof mime === 'string' && MIME_TO_EXT[mime]) {
      return MIME_TO_EXT[mime];
    }
  }
  switch (kind) {
    case 'image':
      return 'png';
    case 'voice_profile':
      return 'wav';
    case 'agent':
      return 'json';
    default:
      return 'bin';
  }
}

function safeAssetId(id: string): string {
  // Allow only the same charset as classroom ids so we can't escape the
  // classroom-assets directory via a crafted asset id.
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid asset id: ${id}`);
  }
  return id;
}

function safeKind(kind: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(kind)) {
    throw new Error(`Invalid asset kind: ${kind}`);
  }
  return kind;
}

/**
 * `GET /api/classroom/[id]/assets` — return the asset list for a classroom.
 *
 * The response shape is:
 *   [{ id, kind, url, meta, bytes, createdAt }]
 *
 * `url` is the public static path (`/classroom-assets/<id>/<kind>/<asset>.<ext>`).
 * `bytes` is the in-DB blob length for fs mode (or a `null` if the file
 * isn't on disk yet, e.g. a postgres-only row whose static file copy was
 * deleted by accident). Clients should still GET `url` first and only
 * fall back to `/api/classroom/[id]/assets/[assetId]/raw` (Phase 1.5.1
 * follow-up) if that 404s.
 *
 * Phase 1: no authz, mirroring `/api/classroom/[id]/scenes`. Phase 2
 * will gate behind TEACHER_CODE / class access code.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidClassroomId(id)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }
  try {
    // Confirm the classroom exists so a 404 here means "no such classroom"
    // rather than "classroom exists but has no assets yet".
    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.NOT_FOUND, 404, 'Classroom not found');
    }

    const backend = getClassroomStorage().constructor.name;
    if (backend === 'FsClassroomStorage') {
      // fs mode: scan the static dir on disk. The on-disk file IS the
      // asset; we never round-trip through the DB on fs.
      const dir = path.join(CLASSROOM_ASSETS_DIR, id);
      let entries: Array<{ name: string; isFile: () => boolean }> = [];
      try {
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        entries = dirents as unknown as Array<{ name: string; isFile: () => boolean }>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        // No assets yet — return empty list, not a 500.
      }
      const assets: Array<{
        id: string;
        kind: string;
        url: string;
        meta: unknown;
        bytes: number;
        createdAt: string;
      }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        // File naming convention: `<kind>/<assetId>.<ext>`. The kind
        // segment lets us disambiguate ids that collide across kinds.
        const segments = entry.name.split('/');
        if (segments.length < 2) continue;
        const [kind, fileName] = segments;
        const dotIndex = fileName.lastIndexOf('.');
        const assetId = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        const url = `/classroom-assets/${id}/${entry.name}`;
        assets.push({
          id: assetId,
          kind,
          url,
          meta: null,
          bytes: stat.size,
          createdAt: stat.mtime.toISOString(),
        });
      }
      return apiSuccess({ id, assets });
    }

    // postgres mode: read the classroom_assets table.
    const db = getDb();
    const rows = await db
      .select({
        id: classroomAssets.id,
        kind: classroomAssets.kind,
        meta: classroomAssets.meta,
        bytes: sql<number>`octet_length(${classroomAssets.blob})`,
        createdAt: classroomAssets.createdAt,
      })
      .from(classroomAssets)
      .where(sql`${classroomAssets.classroomId} = ${id}`)
      .orderBy(classroomAssets.kind, classroomAssets.id);

    const assets = rows.map((row) => {
      const ext = pickExtension(row.kind, row.meta);
      return {
        id: row.id,
        kind: row.kind,
        url: `/classroom-assets/${id}/${row.kind}/${row.id}.${ext}`,
        meta: row.meta,
        bytes: Number(row.bytes),
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      };
    });
    return apiSuccess({ id, assets });
  } catch (error) {
    log.error(`Assets GET failed [id=${id}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to list assets',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `POST /api/classroom/[id]/assets` — upload an asset binary.
 *
 * Body: `{ id: string, kind: 'image' | 'voice_profile' | 'agent' | string,
 *          blobBase64: string, meta?: object }`
 *
 * Behavior:
 *   - Validate id (classroom + asset) and kind to prevent path traversal.
 *   - Decode base64 → Buffer.
 *   - For fs backend: write the file under
 *     `public/classroom-assets/<classroomId>/<kind>/<id>.<ext>`.
 *   - For postgres backend: INSERT into classroom_assets AND also write
 *     the same file under public/ (so the static-URL contract is uniform
 *     across backends).
 *
 * Returns: `{ id, kind, url, bytes }`.
 *
 * Phase 1: no authz. Phase 2 (T2.4) will require teacher identity.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: classroomId } = await params;
  if (!isValidClassroomId(classroomId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }
  try {
    const body = (await request.json()) as {
      id?: unknown;
      kind?: unknown;
      blobBase64?: unknown;
      meta?: unknown;
    };
    if (typeof body.id !== 'string' || typeof body.kind !== 'string' || typeof body.blobBase64 !== 'string') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: id, kind, blobBase64',
      );
    }
    const assetId = safeAssetId(body.id);
    const kind = safeKind(body.kind);
    const meta = (body.meta ?? null) as Record<string, unknown> | null;
    const ext = pickExtension(kind, meta);

    // Decode the base64 payload. Use Buffer.from with explicit base64
    // encoding — the default would assume utf-8 and corrupt the bytes.
    const buffer = Buffer.from(body.blobBase64, 'base64');
    if (buffer.length === 0) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Empty blob');
    }

    // Confirm the classroom exists; otherwise an asset row would dangle
    // (or the fs write would land in a directory no one will ever read).
    const classroom = await readClassroom(classroomId);
    if (!classroom) {
      return apiError(API_ERROR_CODES.NOT_FOUND, 404, 'Classroom not found');
    }

    // Always write the static file so the URL contract is uniform across
    // backends. Postgres gets a redundant on-disk copy; if disk space
    // becomes a concern, a follow-up can gate the static write on
    // "small enough to inline" (the bytea column handles <2MB fine).
    const fileDir = path.join(CLASSROOM_ASSETS_DIR, classroomId, kind);
    const filePath = path.join(fileDir, `${assetId}.${ext}`);
    await fs.mkdir(fileDir, { recursive: true });
    await fs.writeFile(filePath, buffer);

    // Persist to DB if using postgres backend. For fs we leave the DB
    // alone (no schema-level row to maintain; the directory listing is
    // the source of truth).
    const backend = getClassroomStorage().constructor.name;
    if (backend === 'PostgresClassroomStorage') {
      const db = getDb();
      await db
        .insert(classroomAssets)
        .values({
          id: assetId,
          classroomId,
          kind,
          blob: buffer,
          meta: meta as never,
        })
        .onConflictDoUpdate({
          target: [classroomAssets.classroomId, classroomAssets.kind, classroomAssets.id],
          set: {
            blob: buffer,
            meta: meta as never,
            createdAt: new Date(),
          },
        });
    }

    return apiSuccess(
      {
        id: assetId,
        kind,
        url: `/classroom-assets/${classroomId}/${kind}/${assetId}.${ext}`,
        bytes: buffer.length,
      },
      201,
    );
  } catch (error) {
    log.error(`Assets POST failed [classroom=${classroomId}]:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to upload asset',
      message,
    );
  }
}
