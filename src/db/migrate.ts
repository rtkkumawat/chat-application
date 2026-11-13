import type { Db } from './db.js';
import { migrations, type Migration } from './migrations.js';

/** Arbitrary constant identifying this app's migration lock. */
const MIGRATION_LOCK_KEY = 728_190_441;

/**
 * Applies pending migrations and returns the ids that were applied.
 *
 * Runs in one transaction behind a transaction-scoped advisory lock, so several
 * instances booting at once are safe: one migrates, the others wait and then
 * find nothing left to do. Postgres DDL is transactional, so a failing
 * migration leaves the schema untouched.
 */
export async function migrate(db: Db, list: Migration[] = migrations): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id          text PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const { rows } = await tx.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    const applied: string[] = [];

    for (const migration of list) {
      if (done.has(migration.id)) continue;
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
    }
    return applied;
  });
}
