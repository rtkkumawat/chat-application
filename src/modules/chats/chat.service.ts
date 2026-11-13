import type { Db } from '../../db/db.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { MessageStore } from '../messages/message.store.js';
import { UserRepository } from '../users/user.repository.js';
import { ChatRepository, type Chat, type ChatMember, type ChatSummary, type MemberRole } from './chat.repository.js';

/**
 * Hard cap on group size. Read receipts are stored as a map on each message
 * document, so membership must stay bounded (see FirestoreMessageStore).
 */
export const MAX_GROUP_MEMBERS = 100;

export interface ChatDetails extends Chat {
  members: ChatMember[];
}

export interface ChatPage {
  chats: ChatSummary[];
  nextCursor: string | null;
}

export class ChatService {
  private readonly chats: ChatRepository;
  private readonly users: UserRepository;

  constructor(
    private readonly db: Db,
    private readonly messageStore: MessageStore,
    private readonly logger: Logger,
  ) {
    this.chats = new ChatRepository(db);
    this.users = new UserRepository(db);
  }

  /**
   * Create-or-get for 1:1 chats. Idempotent and safe under concurrency:
   * (A,B) and (B,A) map to the same canonical pair, and the unique constraint
   * on that pair decides the winner if two requests race.
   */
  async createOrGetDirect(userAId: string, userBId: string): Promise<{ chatId: string; created: boolean }> {
    await this.assertUsersExist([userAId, userBId]);
    const [low, high] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];

    return this.db.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const insertedId = await chats.insertDirect(low, high, userAId);
      if (insertedId) {
        await chats.addMembers(insertedId, [low, high], 'member');
        return { chatId: insertedId, created: true };
      }
      const existingId = await chats.findDirectId(low, high);
      // Unreachable unless the chat was deleted between the two statements.
      if (!existingId) throw new Error('direct chat vanished during create-or-get');
      return { chatId: existingId, created: false };
    });
  }

  async createGroup(input: { creatorId: string; title: string; memberIds: string[] }): Promise<ChatDetails> {
    const others = [...new Set(input.memberIds)].filter((id) => id !== input.creatorId);
    if (others.length + 1 > MAX_GROUP_MEMBERS) throw groupTooLarge();
    await this.assertUsersExist([input.creatorId, ...others]);

    return this.db.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const chat = await chats.insertGroup(input.title, input.creatorId);
      await chats.addMembers(chat.id, [input.creatorId], 'owner');
      await chats.addMembers(chat.id, others, 'member');
      return { ...chat, members: await chats.listMembers(chat.id) };
    });
  }

  async getDetails(chatId: string): Promise<ChatDetails> {
    const chat = await this.chats.findById(chatId);
    if (!chat) throw chatNotFound(chatId);
    return { ...chat, members: await this.chats.listMembers(chatId) };
  }

  async listForUser(userId: string, opts: { limit: number; cursor?: string }): Promise<ChatPage> {
    const missing = await this.users.findMissingIds([userId]);
    if (missing.length > 0) throw notFound('USER_NOT_FOUND', `User ${userId} does not exist`);

    // Fetch one extra row to learn whether another page exists without a COUNT.
    const rows = await this.chats.listForUser(userId, {
      limit: opts.limit + 1,
      ...(opts.cursor ? { before: decodeCursor(opts.cursor) } : {}),
    });
    const chats = rows.slice(0, opts.limit);
    const last = chats.at(-1);
    const nextCursor =
      rows.length > opts.limit && last
        ? encodeCursor({ ts: (last.lastMessageAt ?? last.createdAt).getTime(), id: last.id })
        : null;
    return { chats, nextCursor };
  }

  async addGroupMembers(chatId: string, actorId: string, userIds: string[]): Promise<ChatDetails> {
    const unique = [...new Set(userIds)];
    await this.assertUsersExist(unique);

    return this.db.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      // Lock the chat row so concurrent membership changes are serialised and
      // the size cap cannot be exceeded by two racing requests.
      const chat = await this.lockGroup(chats, chatId);
      const members = await chats.listMembers(chatId);
      assertOwner(members, actorId);

      const current = new Set(members.map((m) => m.userId));
      const toAdd = unique.filter((id) => !current.has(id));
      if (current.size + toAdd.length > MAX_GROUP_MEMBERS) throw groupTooLarge();

      await chats.addMembers(chatId, toAdd, 'member');
      return { ...chat, members: await chats.listMembers(chatId) };
    });
  }

  /**
   * Removes a member, or lets a member leave. If the owner leaves, ownership
   * passes to the longest-standing remaining member; if nobody remains, the
   * chat is deleted.
   */
  async removeGroupMember(
    chatId: string,
    actorId: string,
    targetId: string,
  ): Promise<{ chatDeleted: boolean; newOwnerId: string | null }> {
    const result = await this.db.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      await this.lockGroup(chats, chatId);
      const members = await chats.listMembers(chatId);

      const actor = members.find((m) => m.userId === actorId);
      if (!actor) throw notAMember();
      const target = members.find((m) => m.userId === targetId);
      if (!target) throw notFound('MEMBER_NOT_FOUND', `User ${targetId} is not a member of this chat`);
      if (actorId !== targetId && actor.role !== 'owner') throw ownerOnly();

      await chats.removeMember(chatId, targetId);
      const remaining = members.filter((m) => m.userId !== targetId);

      if (remaining.length === 0) {
        await chats.delete(chatId);
        return { chatDeleted: true, newOwnerId: null };
      }
      if (target.role === 'owner') {
        const heir = remaining[0]!; // listMembers is ordered by joined_at
        await chats.setRole(chatId, heir.userId, 'owner');
        return { chatDeleted: false, newOwnerId: heir.userId };
      }
      return { chatDeleted: false, newOwnerId: null };
    });

    if (result.chatDeleted) {
      // Cross-store cleanup cannot be atomic with the SQL commit. Postgres is the
      // source of truth for whether a chat exists, so a failure here only leaves
      // unreachable documents behind; log it for a sweeper rather than fail the call.
      await this.messageStore.purgeChat(chatId).catch((err: unknown) => {
        this.logger.error({ err, chatId }, 'failed to purge messages of deleted chat');
      });
    }
    return result;
  }

  async renameGroup(chatId: string, actorId: string, title: string): Promise<ChatDetails> {
    return this.db.transaction(async (tx) => {
      const chats = new ChatRepository(tx);
      const chat = await this.lockGroup(chats, chatId);
      const members = await chats.listMembers(chatId);
      assertOwner(members, actorId);
      await chats.rename(chatId, title);
      return { ...chat, title, members };
    });
  }

  /** Authorisation gate used by every message operation. */
  async assertMember(chatId: string, userId: string): Promise<MemberRole> {
    const membership = await this.chats.getMembership(chatId, userId);
    if (!membership.chatExists) throw chatNotFound(chatId);
    if (!membership.role) throw notAMember();
    return membership.role;
  }

  async assertChatExists(chatId: string): Promise<void> {
    if (!(await this.chats.findById(chatId))) throw chatNotFound(chatId);
  }

  touchLastMessage(chatId: string, at: Date): Promise<void> {
    return this.chats.touchLastMessage(chatId, at);
  }

  private async lockGroup(chats: ChatRepository, chatId: string): Promise<Chat> {
    const chat = await chats.findById(chatId, { forUpdate: true });
    if (!chat) throw chatNotFound(chatId);
    if (chat.type !== 'group') {
      throw conflict('NOT_A_GROUP_CHAT', 'Membership and title can only be changed on group chats');
    }
    return chat;
  }

  private async assertUsersExist(ids: string[]): Promise<void> {
    const missing = await this.users.findMissingIds(ids);
    if (missing.length > 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'One or more users do not exist', { missingUserIds: missing });
    }
  }
}

function assertOwner(members: ChatMember[], actorId: string): void {
  const actor = members.find((m) => m.userId === actorId);
  if (!actor) throw notAMember();
  if (actor.role !== 'owner') throw ownerOnly();
}

const chatNotFound = (chatId: string): AppError => notFound('CHAT_NOT_FOUND', `Chat ${chatId} does not exist`);
const notAMember = (): AppError => forbidden('NOT_A_CHAT_MEMBER', 'The user is not a member of this chat');
const ownerOnly = (): AppError => forbidden('INSUFFICIENT_ROLE', 'Only the group owner can do this');
const groupTooLarge = (): AppError =>
  conflict('GROUP_SIZE_LIMIT', `A group can have at most ${MAX_GROUP_MEMBERS} members`);
