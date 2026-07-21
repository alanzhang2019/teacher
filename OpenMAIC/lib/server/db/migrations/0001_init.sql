-- Phase 1 initial schema — cloud teacher-classroom deploy.
-- See: OpenMAIC/.trae-cn/specs/deploy-teacher-classroom.md section 3.2.
-- Mirror of `lib/server/db/schema.ts` for ops who apply with `psql`.

BEGIN;

-- pgcrypto for gen_random_uuid(); modern Postgres (13+) also has it built
-- in, but enabling the extension is harmless and makes the requirement
-- explicit for older versions.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- teachers ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teachers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   TEXT NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_code_hash_idx ON teachers(code_hash);

-- classrooms -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS classrooms (
  id                  TEXT PRIMARY KEY,
  teacher_id          UUID REFERENCES teachers(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  stage               JSONB NOT NULL,
  access_code_hash    TEXT NOT NULL,
  is_published        BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS classrooms_teacher_idx ON classrooms(teacher_id);

-- scenes -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scenes (
  id            TEXT PRIMARY KEY,
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  type          TEXT,
  title         TEXT,
  "order"       INT NOT NULL,
  content       JSONB,
  actions       JSONB,
  whiteboards   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scenes_classroom_order_idx ON scenes(classroom_id, "order");
CREATE INDEX IF NOT EXISTS scenes_classroom_idx ON scenes(classroom_id);

-- classroom_assets -------------------------------------------------------
CREATE TABLE IF NOT EXISTS classroom_assets (
  id            TEXT NOT NULL,
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  blob          BYTEA NOT NULL,
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (classroom_id, kind, id)
);
CREATE INDEX IF NOT EXISTS classroom_assets_classroom_kind_idx
  ON classroom_assets(classroom_id, kind);

COMMIT;
