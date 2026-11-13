import type { ChatDetails } from '../modules/chats/chat.service.js';
import type { ChatSummary } from '../modules/chats/chat.repository.js';
import type { LastSeen, Message } from '../modules/messages/message.store.js';
import type { User } from '../modules/users/user.repository.js';

/**
 * The wire format lives here, apart from domain and storage types, so an
 * internal rename can never silently change the public API.
 */
export const presentUser = (user: User) => ({
  id: user.id,
  displayName: user.displayName,
  email: user.email,
  createdAt: user.createdAt.toISOString(),
});

export const presentChatSummary = (chat: ChatSummary) => ({
  chatId: chat.id,
  type: chat.type,
  title: chat.title,
  memberIds: chat.memberIds,
  createdAt: chat.createdAt.toISOString(),
  lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
});

export const presentChatDetails = (chat: ChatDetails) => ({
  chatId: chat.id,
  type: chat.type,
  title: chat.title,
  createdBy: chat.createdBy,
  createdAt: chat.createdAt.toISOString(),
  lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
  members: chat.members.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.joinedAt.toISOString() })),
});

export const presentMessage = (message: Message) => ({
  id: message.id,
  chatId: message.chatId,
  senderId: message.senderId,
  text: message.deletedAt ? null : message.text,
  createdAt: message.createdAt.toISOString(),
  editedAt: message.editedAt?.toISOString() ?? null,
  deleted: message.deletedAt !== null,
  deletedAt: message.deletedAt?.toISOString() ?? null,
  readBy: Object.entries(message.readBy)
    .map(([userId, readAt]) => ({ userId, readAt: readAt.toISOString() }))
    .sort((a, b) => a.readAt.localeCompare(b.readAt) || a.userId.localeCompare(b.userId)),
});

export const presentLastSeen = (state: LastSeen) => ({
  chatId: state.chatId,
  userId: state.userId,
  lastSeenMessageId: state.messageId,
  lastSeenMessageCreatedAt: state.messageCreatedAt.toISOString(),
  updatedAt: state.updatedAt.toISOString(),
});
