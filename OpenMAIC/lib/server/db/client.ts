/**
 * Postgres connection singleton.
 *
 * The `pg` driver's `Pool` keeps open connections between requests. In
 * Next.js dev mode every route change hot-reloads modules, so without a
 * `globalThis` cache the pool would be torn down and recreated constantly,
 * leaking file descriptors and dropping in-flight queries.
 *
 * Same caching pattern as `lib/server/storage/index.ts` (ClassroomStorage)
 * and `lib/server/tts-queue.ts`. The cache key is namespaced so the three
 * systems can't accidentally collide.
 */
import { Pool, type PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const DB_GLOBAL_KEY = '__openmaic_pg_pool__' as const;
const DB_DRIZZLE_KEY = '__openmaic_drizzle_db__' as const;

interface CachedPool {
  pool: Pool;
}

function buildPoolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Postgres: DATABASE_URL is not set. ' +
        'Configure it in .env (e.g. postgres://user:pass@localhost:5432/openmaic) ' +
        'or unset STORAGE_BACKEND to fall back to the fs backend.',
    );
  }
  return {
    connectionString: url,
    // Cloud deploys terminate TLS at the load balancer; PGSSLMODE=require is
    // a no-op locally but mandatory on managed Postgres (RDS, Aliyun RDS,
    // Supabase). The `pg` driver reads it from the connection string OR the
    // explicit `ssl` field; we forward via env so the URL stays portable.
    ssl:
      process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full'
        ? { rejectUnauthorized: process.env.PGSSLMODE === 'verify-full' }
        : undefined,
    // Conservative defaults — long TTS inference means requests can hang
    // for many minutes, but a connection that's idle for 30s is almost
    // certainly a leaked one. The statement timeout is a hard wall against
    // runaway migrations during deploys.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 0, // disabled; TTS writes can run 25-50 min on CPU
    max: Number(process.env.PG_POOL_MAX ?? 10),
  };
}

function getPool(): Pool {
  const g = globalThis as unknown as Record<typeof DB_GLOBAL_KEY, CachedPool | undefined>;
  if (!g[DB_GLOBAL_KEY]) {
    g[DB_GLOBAL_KEY] = { pool: new Pool(buildPoolConfig()) };
  }
  return g[DB_GLOBAL_KEY].pool;
}

/**
 * Drizzle ORM instance, typed against the schema. Use this from the
 * storage backends and API routes instead of raw `pool.query` so we get
 * compile-time column-name checks and consistent JSONB parsing.
 */
export function getDb() {
  const g = globalThis as unknown as Record<typeof DB_DRIZZLE_KEY, ReturnType<typeof drizzle> | undefined>;
  if (!g[DB_DRIZZLE_KEY]) {
    g[DB_DRIZZLE_KEY] = drizzle(getPool(), { schema });
  }
  return g[DB_DRIZZLE_KEY];
}

/**
 * Test-only: tear down the cached pool. Production code must never call
 * this — the cache exists precisely to keep the pool alive across hot
 * reloads.
 */
export async function _disposeDbForTests(): Promise<void> {
  const g = globalThis as unknown as Record<typeof DB_GLOBAL_KEY, CachedPool | undefined>;
  if (g[DB_GLOBAL_KEY]) {
    await g[DB_GLOBAL_KEY].pool.end().catch(() => {
      /* ignore — pool may already be closed */
    });
    delete g[DB_GLOBAL_KEY];
  }
  const gd = globalThis as unknown as Record<typeof DB_DRIZZLE_KEY, ReturnType<typeof drizzle> | undefined>;
  delete gd[DB_DRIZZLE_KEY];
}

export { schema };
