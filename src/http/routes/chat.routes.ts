import { Router } from 'express';
import type { ChatService } from '../../modules/chats/chat.service.js';
import type { MessageService } from '../../modules/messages/message.service.js';
import { presentChatDetails, presentLastSeen, presentMessage } from '../presenters.js';
import { parse, schemas } from '../validation.js';

/**
 * Identity note: per the brief, the acting user arrives in the request body
 * (senderId / userId / actorId). In production these would be replaced by the
 * subject of a verified token (e.g. a Firebase ID token) in one auth middleware;
 * the services already take the actor as an explicit argument, so nothing below
 * the HTTP layer would change.
 */
export function chatRoutes(chats: ChatService, messages: MessageService): Router {
  const router = Router();

  // ---------------------------------------------------------------- chats

  // 1. Create or Get Chat. 201 when created, 200 when it already existed.
  router.post('/create', async (req, res) => {
    const { userAId, userBId } = parse(schemas.createDirectChat, req.body);
    const result = await chats.createOrGetDirect(userAId, userBId);
    res.status(result.created ? 201 : 200).json(result);
  });

  // Bonus: group chats
  router.post('/group', async (req, res) => {
    const body = parse(schemas.createGroupChat, req.body);
    res.status(201).json(presentChatDetails(await chats.createGroup(body)));
  });

  router.get('/:chatId', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    res.json(presentChatDetails(await chats.getDetails(chatId)));
  });

  router.patch('/:chatId', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    const { actorId, title } = parse(schemas.renameGroup, req.body);
    res.json(presentChatDetails(await chats.renameGroup(chatId, actorId, title)));
  });

  router.post('/:chatId/members', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    const { actorId, userIds } = parse(schemas.addMembers, req.body);
    res.json(presentChatDetails(await chats.addGroupMembers(chatId, actorId, userIds)));
  });

  // Remove a member (owner) or leave the group (actorId === userId).
  router.delete('/:chatId/members/:userId', async (req, res) => {
    const { chatId, userId } = parse(schemas.memberParams, req.params);
    const { actorId } = parse(schemas.actor, req.body);
    res.json(await chats.removeGroupMember(chatId, actorId, userId));
  });

  // ------------------------------------------------------------- messages

  // 2. Send Message. Optional clientMessageId makes retries idempotent.
  router.post('/:chatId/message/send', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    const body = parse(schemas.sendMessage, req.body);
    const { message, created } = await messages.send({ chatId, ...body });
    res.status(created ? 201 : 200).json(presentMessage(message));
  });

  // 3. Get Messages. Latest `limit` messages in chronological order;
  //    follow `nextCursor` via ?before= to page back through history.
  router.get('/:chatId/messages', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    const query = parse(schemas.listMessagesQuery, req.query);
    const page = await messages.list(chatId, query);
    res.json({ messages: page.messages.map(presentMessage), nextCursor: page.nextCursor });
  });

  // 4. Mark Message Read
  router.post('/:chatId/message/:messageId/read', async (req, res) => {
    const { chatId, messageId } = parse(schemas.messageParams, req.params);
    const { userId } = parse(schemas.userRef, req.body);
    res.json(presentMessage(await messages.markRead(chatId, messageId, userId)));
  });

  // 5. Update Last Seen Message
  router.post('/:chatId/lastseen', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    const { userId, messageId } = parse(schemas.lastSeen, req.body);
    res.json(presentLastSeen(await messages.setLastSeen(chatId, userId, messageId)));
  });

  router.get('/:chatId/lastseen', async (req, res) => {
    const { chatId } = parse(schemas.chatParams, req.params);
    res.json({ lastSeen: (await messages.listLastSeen(chatId)).map(presentLastSeen) });
  });

  // Bonus: edit / delete
  router.patch('/:chatId/message/:messageId', async (req, res) => {
    const { chatId, messageId } = parse(schemas.messageParams, req.params);
    const { userId, text } = parse(schemas.editMessage, req.body);
    res.json(presentMessage(await messages.edit(chatId, messageId, userId, text)));
  });

  router.delete('/:chatId/message/:messageId', async (req, res) => {
    const { chatId, messageId } = parse(schemas.messageParams, req.params);
    const { userId } = parse(schemas.userRef, req.body);
    res.json(presentMessage(await messages.delete(chatId, messageId, userId)));
  });

  return router;
}
