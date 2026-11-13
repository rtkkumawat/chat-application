import type { Cursor } from '../../lib/cursor.js';

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  /** Empty string once the message has been deleted (the content is scrubbed). */
  text: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  /** userId -> when that user first read the message. The sender is never listed. */
  readBy: Record<string, Date>;
}

export interface LastSeen {
  chatId: string;
  userId: string;
  messageId: string;
  /** createdAt of the last-seen message; this is what makes the pointer comparable. */
  messageCreatedAt: Date;
  updatedAt: Date;
}

export interface CreateMessageInput {
  chatId: string;
  /** Doubles as the idempotency key: creating the same id twice is a no-op. */
  messageId: string;
  senderId: string;
  text: string;
}

/**
 * Port for the message side of the system (messages, read receipts, last-seen
 * pointers). Production uses Firestore; tests and local dev can use the
 * in-memory implementation. Both must pass tests/message-store.contract.ts.
 *
 * Ordering contract: messages are totally ordered by (createdAt, id).
 * Not-found and ownership failures are reported as AppErrors.
 */
export interface MessageStore {
  /** Creates the message, or returns the existing one if `messageId` is already taken. */
  create(input: CreateMessageInput): Promise<{ message: Message; created: boolean }>;

  /** Newest first, starting strictly before `before` (or from the newest message). */
  list(chatId: string, opts: { limit: number; before?: Cursor }): Promise<Message[]>;

  /** Records the first time `userId` read the message. Idempotent; a no-op for the sender. */
  markRead(chatId: string, messageId: string, userId: string): Promise<Message>;

  /** Moves the user's last-seen pointer forward. It never moves backwards. */
  setLastSeen(chatId: string, userId: string, messageId: string): Promise<LastSeen>;
  listLastSeen(chatId: string): Promise<LastSeen[]>;

  /** Only the sender may edit; deleted messages cannot be edited. */
  edit(chatId: string, messageId: string, editorId: string, text: string): Promise<Message>;
  /** Soft delete: content is scrubbed and a tombstone is kept. Only the sender; idempotent. */
  softDelete(chatId: string, messageId: string, deleterId: string): Promise<Message>;

  /** Removes everything stored for a chat (used when a chat itself is deleted). */
  purgeChat(chatId: string): Promise<void>;
}

/** Total order shared by every implementation: (createdAt, id). */
export function compareByPosition(
  a: { createdAtMs: number; id: string },
  b: { createdAtMs: number; id: string },
): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
