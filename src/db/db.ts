/**
 * The narrow database port the application depends on.
 *
 * Repositories are written against `Queryable`, so the same repository works
 * on the pool or inside a transaction. The port is deliberately tiny: it exists
 * to make transactions explicit and to let tests swap the driver, not to hide SQL.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a single transaction: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
