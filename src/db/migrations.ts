/**
 * Forward-only schema migrations, applied in order by `migrate()`.
 * Never edit a migration that has shipped: add a new one.
 *
 * All timestamps are `timestamptz(3)` (millisecond precision) on purpose: JS
 * `Date` cannot represent microseconds, so a keyset cursor built from a
 * microsecond column would silently skip or repeat rows.
 */
export interface Migration {
  id: string;
  statements: string[];
}

export const migrations: Migration[] = [
  {
    id: '001_init',
    statements: [
      `CREATE TABLE users (
         id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
         email         text NOT NULL CHECK (char_length(email) <= 320),
         created_at    timestamptz(3) NOT NULL DEFAULT now()
       )`,
      // Emails are unique case-insensitively.
      `CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email))`,

      `CREATE TABLE chats (
         id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         type              text NOT NULL CHECK (type IN ('direct', 'group')),
         title             text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
         -- For direct chats the participant pair is stored in canonical order
         -- (low < high). The UNIQUE constraint below then guarantees at most one
         -- chat per pair, even under concurrent "create or get" requests.
         direct_user_low   uuid REFERENCES users (id) ON DELETE CASCADE,
         direct_user_high  uuid REFERENCES users (id) ON DELETE CASCADE,
         created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
         created_at        timestamptz(3) NOT NULL DEFAULT now(),
         updated_at        timestamptz(3) NOT NULL DEFAULT now(),
         -- Denormalised from Firestore (best effort) so chat lists can be sorted
         -- by recent activity without a cross-store join.
         last_message_at   timestamptz(3),
         CONSTRAINT chats_direct_pair_uq UNIQUE (direct_user_low, direct_user_high),
         CONSTRAINT chats_shape_ck CHECK (
           (type = 'direct' AND direct_user_low IS NOT NULL AND direct_user_high IS NOT NULL
              AND direct_user_low < direct_user_high AND title IS NULL)
           OR
           (type = 'group' AND direct_user_low IS NULL AND direct_user_high IS NULL
              AND title IS NOT NULL)
         )
       )`,

      `CREATE TABLE chat_members (
         chat_id    uuid NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
         user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
         role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
         joined_at  timestamptz(3) NOT NULL DEFAULT now(),
         PRIMARY KEY (chat_id, user_id)
       )`,
      // The PK serves "members of a chat" and membership checks; this index
      // serves the reverse lookup, "chats of a user".
      `CREATE INDEX chat_members_user_idx ON chat_members (user_id, chat_id)`,
    ],
  },
];
