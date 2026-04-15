import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

let _db: NodePgDatabase<typeof schema> | null = null;
let _pool: Pool | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL environment variable is required. ' +
        'If running unit tests, ensure SKIP_DB_TESTS=true and avoid importing DB-dependent modules.'
    );
  }

  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  _db = drizzle(_pool, { schema });
  return _db;
}

export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop) {
    return getDb()[prop as keyof NodePgDatabase<typeof schema>];
  },
});
