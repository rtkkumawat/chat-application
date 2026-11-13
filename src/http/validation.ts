import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

/** Parses untrusted input against a schema, or throws a 400 listing every issue. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw badRequest(
      'VALIDATION_ERROR',
      'Request validation failed',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

/** UUIDs are compared and ordered as strings, so normalise case at the edge. */
export const uuid = z.uuid().transform((value) => value.toLowerCase());

export const pageLimit = z.coerce.number().int().min(1).max(100).default(50);

export const messageText = z
  .string()
  .trim()
  .min(1, 'text must not be empty')
  .max(4000, 'text must be at most 4000 characters');

export const schemas = {
  // users
  createUser: z.object({
    displayName: z.string().trim().min(1).max(100),
    email: z.email().max(320),
  }),
  userParams: z.object({ userId: uuid }),
  listChatsQuery: z.object({ limit: pageLimit, cursor: z.string().min(1).optional() }),

  // chats
  createDirectChat: z
    .object({ userAId: uuid, userBId: uuid })
    .refine((body) => body.userAId !== body.userBId, {
      path: ['userBId'],
      message: 'a direct chat needs two different users',
    }),
  createGroupChat: z.object({
    creatorId: uuid,
    title: z.string().trim().min(1).max(120),
    memberIds: z.array(uuid).min(1).max(99),
  }),
  chatParams: z.object({ chatId: uuid }),
  renameGroup: z.object({ actorId: uuid, title: z.string().trim().min(1).max(120) }),
  addMembers: z.object({ actorId: uuid, userIds: z.array(uuid).min(1).max(99) }),
  memberParams: z.object({ chatId: uuid, userId: uuid }),
  actor: z.object({ actorId: uuid }),

  // messages
  messageParams: z.object({ chatId: uuid, messageId: uuid }),
  sendMessage: z.object({ senderId: uuid, text: messageText, clientMessageId: uuid.optional() }),
  listMessagesQuery: z.object({ limit: pageLimit, before: z.string().min(1).optional() }),
  userRef: z.object({ userId: uuid }),
  lastSeen: z.object({ userId: uuid, messageId: uuid }),
  editMessage: z.object({ userId: uuid, text: messageText }),
};
