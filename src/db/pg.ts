import pg from 'pg';
import type { Logger } from '../lib/logger.js';
import type { Db, Queryable, QueryResult } from './db.js';

export interface PgOptions {
  connectionString: string;
  max: number;
  logger: Logger;
}

export function createPgDb({ connectionString, max, logger }: PgOptions): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Guard rails: no single statement or idle transaction may pin a connection forever.
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
  });

  // An idle client erroring (e.g. the server restarted) must not crash the process.
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

  const run = async <T>(
    executor: pg.Pool | pg.PoolClient,
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> => {
    const res = await executor.query(sql, params as unknown[] | undefined);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  };

  return {
    query: (sql, params) => run(pool, sql, params),

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => run(client, sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
          logger.error({ err: rollbackErr }, 'rollback failed');
        });
        throw err;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}
