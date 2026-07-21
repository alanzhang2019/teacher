/**
 * Postgres schema for the cloud teacher-classroom deploy.
 *
 * Source of truth: `OpenMAIC/.trae-cn/specs/deploy-teacher-classroom.md`
 * section 3.2. This file is consumed by drizzle-orm at query time, and the
 * raw DDL is mirrored in `lib/server/db/migrations/0001_init.sql` for ops
 * who don't want to install the Node toolchain to set up the database.
 *
 * Conventions:
 *   - snake_case column names (Postgres convention), camelCase in TS.
 *   - UUIDs for cross-classroom / cross-teacher ids; TEXT for stage.id and
 *     scene.id since those already exist in the on-disk JSON and we want to
 *     reuse them as primary keys without re-issuing ids on first migrate.
 *   - JSONB for everything that's a structural blob (stage, scene content,
 *     actions, asset meta). The binary assets (images / audio) live in
 *     `classroom_assets.blob` as BYTEA — small file (< 2MB) so the per-row
 *     toast threshold is fine; large audio stays on disk under
 *     `public/audio-cache/` and is referenced by id only.
 *   - `gen_random_uuid()` requires the `pgcrypto` extension (enabled below)
 *     OR `pg_uuid_ossp`; pgcrypto is the modern default.
 */
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  primaryKey,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle's built-in `bytea` type uses parameterized binding correctly but
 * defaults to Node's Buffer / Uint8Array. We add a thin custom type so the
 * return type is `Buffer` and the accept type is `Buffer | Uint8Array`,
 * which matches what the postgres `pg` driver hands back for `bytea` columns.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ---------------------------------------------------------------------------
// teachers
// ---------------------------------------------------------------------------
/**
 * One row per teacher. `codeHash` is bcrypt(TEACHER_CODE) — the plain
 * `TEACHER_CODE` is an env var on the server, but the per-teacher hash lets
 * us (later) support multiple teachers or rotate codes without a redeploy.
 *
 * Phase 2 will wire authz; for Phase 1 the row is just a foreign-key target.
 */
export const teachers = pgTable(
  'teachers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeHashIdx: uniqueIndex('teachers_code_hash_idx').on(table.codeHash),
  }),
);

// ---------------------------------------------------------------------------
// classrooms
// ---------------------------------------------------------------------------
/**
 * One row per classroom. `stage` is the full Stage JSONB (id + name +
 * description + style + languageDirective), and scenes live in their own
 * table so we can stream them and keep classroom UPDATE light.
 *
 * `accessCodeHash` is bcrypt(<6-8 char class code>). The plain code is
 * returned once at creation time so the teacher can hand it to students;
 * after that we only ever compare against the hash.
 *
 * `isPublished` gates student access — drafts can be edited without
 * exposing them mid-flight (Phase 3 T3.5).
 */
export const classrooms = pgTable(
  'classrooms',
  {
    id: text('id').primaryKey(),
    teacherId: uuid('teacher_id').references(() => teachers.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    stage: jsonb('stage').notNull(),
    accessCodeHash: text('access_code_hash').notNull(),
    isPublished: boolean('is_published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teacherIdx: index('classrooms_teacher_idx').on(table.teacherId),
  }),
);

// ---------------------------------------------------------------------------
// scenes
// ---------------------------------------------------------------------------
/**
 * One row per scene. Split out from `classrooms.stage` so the student GET
 * can return a slim classroom header plus a streamed scene list, and so
 * concurrent scene edits don't `UPDATE classrooms` and bump the
 * `updated_at` on the whole deck.
 *
 * `order` is the slide position (0-indexed). The unique index
 * `(classroom_id, "order")` makes slide reorder safe at the DB level
 * (Postgres will reject duplicate orders within a classroom).
 */
export const scenes = pgTable(
  'scenes',
  {
    id: text('id').primaryKey(),
    classroomId: text('classroom_id')
      .notNull()
      .references(() => classrooms.id, { onDelete: 'cascade' }),
    type: text('type'),
    title: text('title'),
    order: integer('order').notNull(),
    content: jsonb('content'),
    actions: jsonb('actions'),
    whiteboards: jsonb('whiteboards'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    classroomOrderIdx: uniqueIndex('scenes_classroom_order_idx').on(
      table.classroomId,
      table.order,
    ),
    classroomIdx: index('scenes_classroom_idx').on(table.classroomId),
  }),
);

// ---------------------------------------------------------------------------
// classroom_assets
// ---------------------------------------------------------------------------
/**
 * Binary blob store for images / agent definitions / voice profile WAVs.
 * Audio for the player is NOT here — that goes to `public/audio-cache/`
 * (served by Next.js as static) and is keyed by `audioId`. This table is
 * for the small, infrequently-changed binaries that need to ship with the
 * classroom but don't have a static URL.
 *
 * `kind` discriminates the column shape:
 *   - 'image'        — `meta` holds { mime, width, height, prompt }
 *   - 'agent'        — `meta` holds the serialized agent config
 *   - 'voice_profile'— `meta` holds the VoxCPM clone profile metadata
 *
 * `blob` is `bytea`. The 2MB `bytea` direct-store threshold is fine for
 * images and clone voice samples; if we ever need to store >2MB blobs
 * (e.g. high-res video frames) we'll move them to S3-style storage and
 * keep this table for metadata only.
 */
export const classroomAssets = pgTable(
  'classroom_assets',
  {
    id: text('id').notNull(),
    classroomId: text('classroom_id')
      .notNull()
      .references(() => classrooms.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    blob: bytea('blob').notNull(),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.classroomId, table.kind, table.id] }),
    classroomKindIdx: index('classroom_assets_classroom_kind_idx').on(
      table.classroomId,
      table.kind,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Inferred row types — exported for use in PostgresClassroomStorage and
// the API route handlers, so the storage layer doesn't have to redeclare
// every column.
// ---------------------------------------------------------------------------
export type Teacher = typeof teachers.$inferSelect;
export type ClassroomRow = typeof classrooms.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type ClassroomAssetRow = typeof classroomAssets.$inferSelect;
