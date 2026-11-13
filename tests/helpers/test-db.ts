import { PGlite } from '@electric-sql/pglite';
import { pino } from 'pino';
import type { Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { createPgDb } from '../../src/db/pg.js';

/**
 * A migrated database for tests.
 *
 *  - By default: PGlite, real PostgreSQL compiled to WASM and running in-process.
 *    No Docker, no server, and the SQL under test is genuine Postgres SQL.
 *  - With TEST_DATABASE_URL set (as in CI): a real server through the
 *    production `pg` adapter, so the driver and pool path are exercised too.
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  const db = url
    ? createPgDb({ connectionString: url, max: 5, logger: pino({ level: 'silent' }) })
    : createPgliteDb();
  await migrate(db);
  return db;
}

export async function resetDb(db: Db): Promise<void> {
  await db.query('TRUNCATE users, chats, chat_members CASCADE');
}

function createPgliteDb(): Db {
  const pglite = new PGlite();
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      const res = await pglite.query<T>(sql, params ? [...params] : []);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    transaction<T>(fn: Parameters<Db['transaction']>[0]) {
      return pglite.transaction(async (tx) =>
        fn({
          async query<R>(sql: string, params?: readonly unknown[]) {
            const res = await tx.query<R>(sql, params ? [...params] : []);
            return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
          },
        }),
      ) as Promise<T>;
    },
    close: () => pglite.close(),
  };
}
