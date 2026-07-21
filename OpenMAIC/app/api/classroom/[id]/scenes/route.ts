import { type NextRequest } from 'next/server';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  isValidClassroomId,
  readClassroom,
  writeClassroomScenes,
} from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('Classroom Scenes API');

/**
 * `GET /api/classroom/[id]/scenes` — return just the scene list for a
 * classroom, sorted by `order`. The student GET /api/classroom/:id/full
 * (Phase 3 T3.4) will compose this with the stage header; for now the
 * classroom's existing GET handler in `app/api/classroom/route.ts` already
 * returns the full deck, so this endpoint's main use case is the
 * "scenes-only" push from the teacher's client (PUT) and the slim
 * scene-list fetch for student load (GET).
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
    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.NOT_FOUND, 404, 'Classroom not found');
    }
    return apiSuccess({ id: classroom.id, scenes: classroom.scenes });
  } catch (error) {
    log.error(`Scenes GET failed [id=${id}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to read scenes',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `PUT /api/classroom/[id]/scenes` — replace the scene list for a
 * classroom. Used by the teacher's client after each batch of scenes
 * is generated, and by student-side re-sync on classroom reload.
 *
 * Body: `{ scenes: Scene[] }`. Validation: each scene must have a
 * string `id` and a numeric `order`; duplicate orders within one
 * payload are rejected (the unique index on `(classroom_id, order)`
 * would catch it server-side, but a 400 with a clear message is
 * friendlier to debug from the browser console).
 *
 * Phase 1: no authz. Phase 2 (T2.4) will require teacher identity
 * (TEACHER_CODE or session token) and verify the caller owns the
 * classroom. For now this endpoint is open, which is fine because
 * the dev backend is `fs` and writes go to a per-developer directory.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidClassroomId(id)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
  }
  try {
    const body = (await request.json()) as { scenes?: unknown };
    if (!Array.isArray(body.scenes)) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing or invalid `scenes` (expected an array)',
      );
    }
    const scenes = body.scenes as Scene[];
    // Validate each entry has at least an id. Deeper structural validation
    // lives in the zod schema for Scene; keeping this check light so the
    // server can accept a forward-compatible payload shape (extra fields
    // ignored, missing fields coerced to defaults).
    for (const scene of scenes) {
      if (typeof scene?.id !== 'string' || !scene.id) {
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          'Each scene must have a string `id`',
        );
      }
    }
    // Reject duplicate orders — better to fail fast at the API than to let
    // Postgres' unique index throw at the tail end of a 10s push.
    const orderSet = new Set<number>();
    for (const scene of scenes) {
      const order = scene.order;
      if (typeof order !== 'number') {
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `Scene ${scene.id} is missing a numeric \`order\``,
        );
      }
      if (orderSet.has(order)) {
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `Duplicate scene order ${order} in payload`,
        );
      }
      orderSet.add(order);
    }

    await writeClassroomScenes(id, scenes);
    return apiSuccess({ id, count: scenes.length });
  } catch (error) {
    log.error(`Scenes PUT failed [id=${id}]:`, error);
    // The facade throws a clear "classroom does not exist" error; surface
    // it as 404 instead of a generic 500 so the client can distinguish
    // missing-classroom from backend-failure.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('does not exist')) {
      return apiError(API_ERROR_CODES.NOT_FOUND, 404, message);
    }
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to write scenes',
      message,
    );
  }
}
