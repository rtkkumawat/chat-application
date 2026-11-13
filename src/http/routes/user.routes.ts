import { Router } from 'express';
import type { ChatService } from '../../modules/chats/chat.service.js';
import type { UserService } from '../../modules/users/user.service.js';
import { presentChatSummary, presentUser } from '../presenters.js';
import { parse, schemas } from '../validation.js';

export function userRoutes(users: UserService, chats: ChatService): Router {
  const router = Router();

  // Not in the brief, but chats reference users by FK, so they must be creatable.
  router.post('/', async (req, res) => {
    const body = parse(schemas.createUser, req.body);
    res.status(201).json(presentUser(await users.create(body)));
  });

  router.get('/:userId', async (req, res) => {
    const { userId } = parse(schemas.userParams, req.params);
    res.json(presentUser(await users.getById(userId)));
  });

  // 6. List User Chats
  router.get('/:userId/chats', async (req, res) => {
    const { userId } = parse(schemas.userParams, req.params);
    const query = parse(schemas.listChatsQuery, req.query);
    const page = await chats.listForUser(userId, query);
    res.json({ chats: page.chats.map(presentChatSummary), nextCursor: page.nextCursor });
  });

  return router;
}
