import { v7 as uuidv7 } from 'uuid';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { conflict } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { ChatService } from '../chats/chat.service.js';
import type { LastSeen, Message, MessageStore } from './message.store.js';

export interface MessagePage {
  /** Chronological (oldest first), ready to render. */
  messages: Message[];
  /** Pass as `before` to fetch the next older page; null when there is none. */
  nextCursor: string | null;
}

/**
 * Orchestrates the two stores: PostgreSQL answers "may this user act in this
 * chat?", Firestore holds the message data. Membership is always checked
 * against Postgres first, so Firestore never has to be trusted for authorisation.
 */
export class MessageService {
  constructor(
    private readonly chats: ChatService,
    private readonly store: MessageStore,
    private readonly logger: Logger,
  ) {}

  async send(input: {
    chatId: string;
    senderId: string;
    text: string;
    clientMessageId?: string | undefined;
  }): Promise<{ message: Message; created: boolean }> {
    await this.chats.assertMember(input.chatId, input.senderId);

    // Server-generated ids are UUIDv7 (time-ordered), so messages created in the
    // same millisecond by one instance still sort in creation order by id.
    const messageId = input.clientMessageId ?? uuidv7();
    const { message, created } = await this.store.create({
      chatId: input.chatId,
      messageId,
      senderId: input.senderId,
      text: input.text,
    });

    if (!created) {
      // A replay of the same request returns the original message. The same key
      // carrying a different payload is a client bug and must not be masked.
      if (message.senderId !== input.senderId || (!message.deletedAt && !message.editedAt && message.text !== input.text)) {
        throw conflict('IDEMPOTENCY_KEY_CONFLICT', 'clientMessageId was already used for a different message');
      }
      return { message, created };
    }

    // Dual write: the activity marker in Postgres only affects chat-list order,
    // so it is best effort. Failing the request here would make the client
    // retry a message that is already durably stored.
    await this.chats.touchLastMessage(input.chatId, message.createdAt).catch((err: unknown) => {
      this.logger.warn({ err, chatId: input.chatId }, 'failed to update chat activity marker');
    });
    return { message, created };
  }

  async list(chatId: string, opts: { limit: number; before?: string | undefined }): Promise<MessagePage> {
    await this.chats.assertChatExists(chatId);

    const newestFirst = await this.store.list(chatId, {
      limit: opts.limit + 1,
      ...(opts.before ? { before: decodeCursor(opts.before) } : {}),
    });
    const page = newestFirst.slice(0, opts.limit);
    const oldest = page.at(-1);
    const nextCursor =
      newestFirst.length > opts.limit && oldest
        ? encodeCursor({ ts: oldest.createdAt.getTime(), id: oldest.id })
        : null;
    return { messages: page.reverse(), nextCursor };
  }

  async markRead(chatId: string, messageId: string, userId: string): Promise<Message> {
    await this.chats.assertMember(chatId, userId);
    return this.store.markRead(chatId, messageId, userId);
  }

  async setLastSeen(chatId: string, userId: string, messageId: string): Promise<LastSeen> {
    await this.chats.assertMember(chatId, userId);
    return this.store.setLastSeen(chatId, userId, messageId);
  }

  async listLastSeen(chatId: string): Promise<LastSeen[]> {
    await this.chats.assertChatExists(chatId);
    return this.store.listLastSeen(chatId);
  }

  async edit(chatId: string, messageId: string, userId: string, text: string): Promise<Message> {
    await this.chats.assertMember(chatId, userId);
    return this.store.edit(chatId, messageId, userId, text);
  }

  async delete(chatId: string, messageId: string, userId: string): Promise<Message> {
    await this.chats.assertMember(chatId, userId);
    return this.store.softDelete(chatId, messageId, userId);
  }
}
