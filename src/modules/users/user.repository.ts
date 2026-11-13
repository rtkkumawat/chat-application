import type { Queryable } from '../../db/db.js';

export interface User {
  id: string;
  displayName: string;
  email: string;
  createdAt: Date;
}

interface UserRow {
  id: string;
  display_name: string;
  email: string;
  created_at: Date;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  displayName: row.display_name,
  email: row.email,
  createdAt: row.created_at,
});

export class UserRepository {
  constructor(private readonly q: Queryable) {}

  async create(input: { displayName: string; email: string }): Promise<User> {
    const { rows } = await this.q.query<UserRow>(
      `INSERT INTO users (display_name, email) VALUES ($1, $2)
       RETURNING id, display_name, email, created_at`,
      [input.displayName, input.email],
    );
    return toUser(rows[0]!);
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.q.query<UserRow>(
      'SELECT id, display_name, email, created_at FROM users WHERE id = $1',
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** Returns the subset of `ids` that do not correspond to an existing user. */
  async findMissingIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.q.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
      [...ids],
    ]);
    const found = new Set(rows.map((r) => r.id));
    return ids.filter((id) => !found.has(id));
  }
}
