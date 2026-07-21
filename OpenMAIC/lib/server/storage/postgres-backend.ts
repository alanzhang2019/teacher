import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/server/db/client';
import { classrooms, scenes } from '@/lib/server/db/schema';
import type { ClassroomStorage, PersistedClassroomData, Scene } from './types';

/**
 * Postgres-backed classroom storage. Reads and writes through the drizzle
 * client defined in `lib/server/db/client.ts`. The `classrooms` table holds
 * the stage JSONB; scenes live in their own table and are joined back on
 * read so the existing `PersistedClassroomData` envelope stays unchanged
 * for the call sites.
 *
 * Phase 1 scope: the storage abstraction. The `access_code_hash` column is
 * written as a placeholder; Phase 2 will plumb the real code through the
 * `POST /api/access-code/class` route and replace the placeholder on first
 * publish.
 */
export class PostgresClassroomStorage implements ClassroomStorage {
  async read(id: string): Promise<PersistedClassroomData | null> {
    const db = getDb();
    // Fetch the classroom header + every scene in one round trip. Drizzle's
    // relational query API would do this for us, but raw SQL is clearer
    // about the JOIN shape and avoids the `with` builder for such a small
    // payload.
    const result = await db.execute(sql`
      SELECT
        c.id,
        c.name,
        c.stage,
        c.created_at AS "createdAt",
        COALESCE(
          json_agg(
            json_build_object(
              'id', s.id,
              'type', s.type,
              'title', s.title,
              'order', s."order",
              'content', s.content,
            'actions', s.actions,
            'whiteboards', s.whiteboards,
            'createdAt', s.created_at,
              'updatedAt', s.updated_at
            ) ORDER BY s."order"
          ) FILTER (WHERE s.id IS NOT NULL),
          '[]'::json
        ) AS scenes
      FROM classrooms c
      LEFT JOIN scenes s ON s.classroom_id = c.id
      WHERE c.id = ${id}
      GROUP BY c.id, c.name, c.stage, c.created_at
    `);

    const rows = result.rows as Array<{
      id: string;
      name: string;
      stage: unknown;
      createdAt: Date | string;
      scenes: unknown;
    }>;
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0];
    // pg returns JSONB aggregations already-parsed; the cast is just to
    // satisfy the structural check. Drizzle's `mode: 'jsonb'` doesn't
    // apply to raw `sql` queries, so we get the parsed value as `unknown`.
    const stage = row.stage as PersistedClassroomData['stage'];
    const parsedScenes = (row.scenes ?? []) as PersistedClassroomData['scenes'];
    return {
      id: row.id,
      stage,
      scenes: parsedScenes,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
    };
  }

  async write(data: PersistedClassroomData): Promise<void> {
    const db = getDb();
    // Wrap the upsert + scene replace in a transaction. A partial write
    // (classroom row updated, scenes still showing the previous deck) is
    // the kind of corruption students see as "missing slides" with no
    // obvious cause. Postgres default isolation is READ COMMITTED which
    // is fine here because we never read back mid-transaction; the
    // transaction just gives us atomicity.
    await db.transaction(async (tx) => {
      // 1. UPSERT the classroom header. `name` is denormalised out of
      //    `stage.name` so we can list classrooms in a future dashboard
      //    without unpacking JSONB on every row.
      await tx
        .insert(classrooms)
        .values({
          id: data.id,
          name: data.stage?.name ?? data.id,
          stage: data.stage,
          // Phase 1 placeholder. Phase 2 will plumb the real bcrypt'd
          // class access code through here (likely via a separate
          // `POST /api/access-code/class` route that the classroom
          // creation flow calls into before this write).
          accessCodeHash: 'PENDING_PHASE_2',
          isPublished: false,
        })
        .onConflictDoUpdate({
          target: classrooms.id,
          set: {
            name: data.stage?.name ?? data.id,
            stage: data.stage,
            updatedAt: new Date(),
          },
        });

      // 2. Replace scenes. Delete + insert is simpler than diff-merging,
      //    and for a deck of < 100 scenes the write is a couple of ms.
      //    Drizzle doesn't support `TRUNCATE ... CASCADE` from the
      //    query builder, so we use raw SQL for the delete.
      await tx.execute(sql`DELETE FROM scenes WHERE classroom_id = ${data.id}`);

      if (data.scenes.length > 0) {
        await tx.insert(scenes).values(
          data.scenes.map((scene) => ({
            id: scene.id,
            classroomId: data.id,
            type: scene.type ?? null,
            title: scene.title ?? null,
            order: scene.order ?? 0,
            content: scene.content ?? null,
            actions: scene.actions ?? null,
            whiteboards: scene.whiteboards ?? null,
          })),
        );
      }
    });
  }

  async writeScenes(id: string, newScenes: Scene[]): Promise<void> {
    const db = getDb();
    // Same atomicity story as `write()`: a partial scene replace would
    // briefly expose a "deck of half-old, half-new scenes" to concurrent
    // readers. Wrap in a transaction with a classroom-exists check so
    // callers get a clear error rather than a silent no-op when the
    // classroom id is wrong.
    await db.transaction(async (tx) => {
      const exists = await tx
        .select({ id: classrooms.id })
        .from(classrooms)
        .where(sql`${classrooms.id} = ${id}`)
        .limit(1);
      if (exists.length === 0) {
        throw new Error(
          `PostgresClassroomStorage.writeScenes: classroom ${id} does not exist`,
        );
      }

      await tx.execute(sql`DELETE FROM scenes WHERE classroom_id = ${id}`);

      if (newScenes.length > 0) {
        await tx.insert(scenes).values(
          newScenes.map((scene) => ({
            id: scene.id,
            classroomId: id,
            type: scene.type ?? null,
            title: scene.title ?? null,
            order: scene.order ?? 0,
            content: scene.content ?? null,
              actions: scene.actions ?? null,
              whiteboards: scene.whiteboards ?? null,
            })),
          );
        }

      // Bump the classroom's `updated_at` so the dashboard (Phase 3 T3.1)
      // can sort by recency without an extra query against `scenes`.
      await tx
        .update(classrooms)
        .set({ updatedAt: new Date() })
        .where(sql`${classrooms.id} = ${id}`);
    });
  }
}
