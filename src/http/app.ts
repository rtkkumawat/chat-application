import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Db } from '../db/db.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { ChatService } from '../modules/chats/chat.service.js';
import { MessageService } from '../modules/messages/message.service.js';
import type { MessageStore } from '../modules/messages/message.store.js';
import { UserService } from '../modules/users/user.service.js';
import { chatRoutes } from './routes/chat.routes.js';
import { userRoutes } from './routes/user.routes.js';

export interface AppDeps {
  db: Db;
  messageStore: MessageStore;
  logger: Logger;
  /** Requests per minute per IP; 0 or undefined disables rate limiting. */
  rateLimitPerMinute?: number;
}

/**
 * Composition root for the HTTP application. Everything the app needs is passed
 * in, so tests build the exact same app around an in-process database and an
 * in-memory message store.
 */
export function buildApp(deps: AppDeps): Express {
  const { db, messageStore, logger } = deps;

  const userService = new UserService(db);
  const chatService = new ChatService(db, messageStore, logger);
  const messageService = new MessageService(chatService, messageStore, logger);

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      // Honour an upstream request id so one request can be traced across services.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );

  // Liveness: the process is up. Readiness: it can reach its primary datastore.
  // Firestore is deliberately not probed here (each probe would be a billed read).
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  if (deps.rateLimitPerMinute) {
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: deps.rateLimitPerMinute,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests')),
      }),
    );
  }

  app.use(express.json({ limit: '64kb' }));

  app.use('/user', userRoutes(userService, chatService));
  app.use('/chat', chatRoutes(chatService, messageService));

  app.use((req, _res, next) => {
    next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
  });

  app.use(errorHandler(logger));
  return app;
}

/** The single place where errors become HTTP responses. */
function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const requestId = String(req.id ?? '');

    if (err instanceof AppError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId },
      });
      return;
    }

    // Errors raised by body-parser (malformed JSON, payload too large, ...).
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: { code: 'VALIDATION_ERROR', message: 'Malformed request body', requestId },
      });
      return;
    }

    (req.log ?? logger).error({ err }, 'unhandled error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId },
    });
  };
}
