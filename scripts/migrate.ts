import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('database_url_required');
const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
try {
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  console.log(JSON.stringify({ ok: true, operation: 'database_migrate' }));
} finally {
  await pool.end();
}
