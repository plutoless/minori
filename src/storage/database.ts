import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseHandle = {
  pool: Pool;
  db: Database;
  close(): Promise<void>;
};

export function createDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    async close() {
      await pool.end();
    },
  };
}
