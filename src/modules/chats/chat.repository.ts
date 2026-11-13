import type { Queryable } from '../../db/db.js';
import type { Cursor } from '../../lib/cursor.js';

export type ChatType = 'direct' | 'group';
export type MemberRole = 'owner' | 'member';

export interface Chat {
  id: string;
  type: ChatType;
  title: string | null;
  createdBy: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
}

export interface ChatSummary extends Chat {
  memberIds: string[];
}

export interface ChatMember {
  userId: string;
  role: MemberRole;
  joinedAt: Date;
}

export interface Membership {
  chatExists: boolean;
  role: MemberRole | null;
}

interface ChatRow {
  id: string;
  type: ChatType;
  title: string | null;
  created_by: string | null;
  created_at: Date;
  last_message_at: Date | null;
}

const CHAT_COLUMNS = 'c.id, c.type, c.title, c.created_by, c.created_at, c.last_message_at';

const toChat = (row: ChatRow): Chat => ({
  id: row.id,
  type: row.type,
  title: row.title,
  createdBy: row.created_by,
  createdAt: row.created_at,
  lastMessageAt: row.last_message_at,
});

/**
 * Data access for chats and memberships. Bound to a `Queryable`, so a service
 * can instantiate it on the pool or on a transaction handle.
 */
export class ChatRepository {
  constructor(private readonly q: Queryable) {}

  /**
   * Inserts the direct chat for a canonical (low, high) pair.
   * Returns null if one already exists. If a concurrent transaction is inserting
   * the same pair, this statement blocks on the unique index until that
   * transaction finishes, so the caller can safely read the winner afterwards.
   */
  async insertDirect(low: string, high: string, createdBy: string): Promise<string | null> {
    const { rows } = await this.q.query<{ id: string }>(
      `INSERT INTO chats (type, direct_user_low, direct_user_high, created_by)
       VALUES ('direct', $1, $2, $3)
       ON CONFLICT ON CONSTRAINT chats_direct_pair_uq DO NOTHING
       RETURNING id`,
      [low, high, createdBy],
    );
    return rows[0]?.id ?? null;
  }

  async findDirectId(low: string, high: string): Promise<string | null> {
    const { rows } = await this.q.query<{ id: string }>(
      'SELECT id FROM chats WHERE direct_user_low = $1 AND direct_user_high = $2',
      [low, high],
    );
    return rows[0]?.id ?? null;
  }

  async insertGroup(title: string, createdBy: string): Promise<Chat> {
    const { rows } = await this.q.query<ChatRow>(
      `INSERT INTO chats AS c (type, title, created_by) VALUES ('group', $1, $2)
       RETURNING ${CHAT_COLUMNS}`,
      [title, createdBy],
    );
    return toChat(rows[0]!);
  }

  async findById(chatId: string, opts: { forUpdate?: boolean } = {}): Promise<Chat | null> {
    const { rows } = await this.q.query<ChatRow>(
      `SELECT ${CHAT_COLUMNS} FROM chats c WHERE c.id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [chatId],
    );
    return rows[0] ? toChat(rows[0]) : null;
  }

  /** One round trip that distinguishes "no such chat" from "not a member". */
  async getMembership(chatId: string, userId: string): Promise<Membership> {
    const { rows } = await this.q.query<{ role: MemberRole | null }>(
      `SELECT m.role
         FROM chats c
         LEFT JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $2
        WHERE c.id = $1`,
      [chatId, userId],
    );
    const row = rows[0];
    return row ? { chatExists: true, role: row.role } : { chatExists: false, role: null };
  }

  async listMembers(chatId: string): Promise<ChatMember[]> {
    const { rows } = await this.q.query<{ user_id: string; role: MemberRole; joined_at: Date }>(
      `SELECT user_id, role, joined_at FROM chat_members
        WHERE chat_id = $1 ORDER BY joined_at, user_id`,
      [chatId],
    );
    return rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: r.joined_at }));
  }

  /** Idempotent: existing members are left untouched. Returns the ids actually added. */
  async addMembers(chatId: string, userIds: readonly string[], role: MemberRole): Promise<string[]> {
    if (userIds.length === 0) return [];
    const { rows } = await this.q.query<{ user_id: string }>(
      `INSERT INTO chat_members (chat_id, user_id, role)
       SELECT $1, u, $3 FROM unnest($2::uuid[]) AS u
       ON CONFLICT (chat_id, user_id) DO NOTHING
       RETURNING user_id`,
      [chatId, [...userIds], role],
    );
    return rows.map((r) => r.user_id);
  }

  async removeMember(chatId: string, userId: string): Promise<void> {
    await this.q.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  }

  async setRole(chatId: string, userId: string, role: MemberRole): Promise<void> {
    await this.q.query('UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2', [
      chatId,
      userId,
      role,
    ]);
  }

  async rename(chatId: string, title: string): Promise<void> {
    await this.q.query('UPDATE chats SET title = $2, updated_at = now() WHERE id = $1', [chatId, title]);
  }

  async delete(chatId: string): Promise<void> {
    await this.q.query('DELETE FROM chats WHERE id = $1', [chatId]);
  }

  /** Monotonic: an out-of-order call can never move the activity marker backwards. */
  async touchLastMessage(chatId: string, at: Date): Promise<void> {
    await this.q.query(
      `UPDATE chats SET last_message_at = $2::timestamptz
        WHERE id = $1 AND (last_message_at IS NULL OR last_message_at < $2::timestamptz)`,
      [chatId, at.toISOString()],
    );
  }

  /**
   * A user's chats, most recently active first, each with its member ids.
   * Keyset-paginated on (activity, id). Driven by chat_members_user_idx; member
   * ids are aggregated per returned row only, so cost is O(page), not O(chats).
   */
  async listForUser(userId: string, opts: { limit: number; before?: Cursor }): Promise<ChatSummary[]> {
    const params: unknown[] = [userId, opts.limit];
    let seek = '';
    if (opts.before) {
      params.push(new Date(opts.before.ts).toISOString(), opts.before.id);
      seek = 'AND (COALESCE(c.last_message_at, c.created_at), c.id) < ($3::timestamptz, $4::uuid)';
    }
    const { rows } = await this.q.query<ChatRow & { member_ids: string[] }>(
      `SELECT ${CHAT_COLUMNS},
              ARRAY(SELECT cm.user_id::text FROM chat_members cm
                     WHERE cm.chat_id = c.id ORDER BY cm.joined_at, cm.user_id) AS member_ids
         FROM chat_members m
         JOIN chats c ON c.id = m.chat_id
        WHERE m.user_id = $1 ${seek}
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT $2`,
      params,
    );
    return rows.map((row) => ({ ...toChat(row), memberIds: row.member_ids }));
  }
}
