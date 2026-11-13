import type { Cursor } from '../../lib/cursor.js';
import { messageDeleted, messageNotFound, notMessageSender } from './message.errors.js';
import {
  compareByPosition,
  type CreateMessageInput,
  type LastSeen,
  type Message,
  type MessageStore,
} from './message.store.js';

/**
 * Non-persistent MessageStore for tests and for running the API locally without
 * Firebase. It honours the same contract as the Firestore implementation
 * (ordering, idempotency, monotonic last-seen) and is verified by the same
 * contract test suite. Not for production: state is per-process.
 */
export class InMemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, Map<string, Message>>();
  private readonly lastSeen = new Map<string, Map<string, LastSeen>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: CreateMessageInput): Promise<{ message: Message; created: boolean }> {
    const chat = this.chat(input.chatId);
    const existing = chat.get(input.messageId);
    if (existing) return { message: clone(existing), created: false };

    const message: Message = {
      id: input.messageId,
      chatId: input.chatId,
      senderId: input.senderId,
      text: input.text,
      createdAt: this.now(),
      editedAt: null,
      deletedAt: null,
      readBy: {},
    };
    chat.set(message.id, message);
    return { message: clone(message), created: true };
  }

  async list(chatId: string, opts: { limit: number; before?: Cursor }): Promise<Message[]> {
    const before = opts.before && { createdAtMs: opts.before.ts, id: opts.before.id };
    return [...this.chat(chatId).values()]
      .filter((m) => !before || compareByPosition(position(m), before) < 0)
      .sort((a, b) => compareByPosition(position(b), position(a)))
      .slice(0, opts.limit)
      .map(clone);
  }

  async markRead(chatId: string, messageId: string, userId: string): Promise<Message> {
    const message = this.require(chatId, messageId);
    if (message.senderId !== userId && !message.readBy[userId]) {
      message.readBy[userId] = this.now();
    }
    return clone(message);
  }

  async setLastSeen(chatId: string, userId: string, messageId: string): Promise<LastSeen> {
    const message = this.require(chatId, messageId);
    const states = this.lastSeen.get(chatId) ?? new Map<string, LastSeen>();
    this.lastSeen.set(chatId, states);

    const current = states.get(userId);
    if (
      current &&
      compareByPosition(
        { createdAtMs: current.messageCreatedAt.getTime(), id: current.messageId },
        position(message),
      ) >= 0
    ) {
      return { ...current };
    }
    const next: LastSeen = {
      chatId,
      userId,
      messageId,
      messageCreatedAt: message.createdAt,
      updatedAt: this.now(),
    };
    states.set(userId, next);
    return { ...next };
  }

  async listLastSeen(chatId: string): Promise<LastSeen[]> {
    return [...(this.lastSeen.get(chatId)?.values() ?? [])].map((s) => ({ ...s }));
  }

  async edit(chatId: string, messageId: string, editorId: string, text: string): Promise<Message> {
    const message = this.require(chatId, messageId);
    if (message.senderId !== editorId) throw notMessageSender();
    if (message.deletedAt) throw messageDeleted();
    message.text = text;
    message.editedAt = this.now();
    return clone(message);
  }

  async softDelete(chatId: string, messageId: string, deleterId: string): Promise<Message> {
    const message = this.require(chatId, messageId);
    if (message.senderId !== deleterId) throw notMessageSender();
    if (!message.deletedAt) {
      message.text = '';
      message.deletedAt = this.now();
    }
    return clone(message);
  }

  async purgeChat(chatId: string): Promise<void> {
    this.messages.delete(chatId);
    this.lastSeen.delete(chatId);
  }

  private chat(chatId: string): Map<string, Message> {
    let chat = this.messages.get(chatId);
    if (!chat) {
      chat = new Map();
      this.messages.set(chatId, chat);
    }
    return chat;
  }

  private require(chatId: string, messageId: string): Message {
    const message = this.messages.get(chatId)?.get(messageId);
    if (!message) throw messageNotFound(messageId);
    return message;
  }
}

const position = (m: Message): { createdAtMs: number; id: string } => ({
  createdAtMs: m.createdAt.getTime(),
  id: m.id,
});

const clone = (m: Message): Message => ({ ...m, readBy: { ...m.readBy } });
