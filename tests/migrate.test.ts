import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { createTestDb } from './helpers/test-db.js';

let db: Db;
beforeAll(async () => {
  db = await createTestDb(); // already migrated once
});
afterAll(() => db.close());

describe('migrations', () => {
  it('are idempotent: a second run applies nothing', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(migrations.map((m) => m.id));
  });

  it('enforce the direct-chat invariants in the schema itself', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (display_name, email) VALUES ('X', 'x@migrate.test'), ('Y', 'y@migrate.test') RETURNING id`,
    );
    const [low, high] = rows.map((r) => r.id).sort() as [string, string];

    // Pair must be stored in canonical order...
    await expect(
      db.query(`INSERT INTO chats (type, direct_user_low, direct_user_high) VALUES ('direct', $1, $2)`, [high, low]),
    ).rejects.toMatchObject({ code: '23514' });

    // ...and at most once.
    const insert = `INSERT INTO chats (type, direct_user_low, direct_user_high) VALUES ('direct', $1, $2)`;
    await db.query(insert, [low, high]);
    await expect(db.query(insert, [low, high])).rejects.toMatchObject({ code: '23505' });

    await db.query(`DELETE FROM users WHERE email LIKE '%@migrate.test'`);
  });
});
