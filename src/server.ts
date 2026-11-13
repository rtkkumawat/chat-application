import type { Server } from 'node:http';
import { loadEnv } from './config/env.js';
import { createPgDb } from './db/pg.js';
import { createFirestore } from './firebase/firestore.js';
import { buildApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { FirestoreMessageStore } from './modules/messages/firestore-message.store.js';
import { InMemoryMessageStore } from './modules/messages/in-memory-message.store.js';
import type { MessageStore } from './modules/messages/message.store.js';

const env = loadEnv();
const logger = createLogger(env);

const db = createPgDb({ connectionString: env.DATABASE_URL, max: env.PG_POOL_MAX, logger });

let messageStore: MessageStore;
let closeMessageStore: () => Promise<void> = async () => {};
if (env.MESSAGE_STORE === 'memory') {
  logger.warn('MESSAGE_STORE=memory: messages are not persisted and are lost on restart');
  messageStore = new InMemoryMessageStore();
} else {
  const firestore = createFirestore(env);
  messageStore = new FirestoreMessageStore(firestore);
  closeMessageStore = () => firestore.terminate();
}

const app = buildApp({ db, messageStore, logger, rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE });

const server: Server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, messageStore: env.MESSAGE_STORE }, 'chat backend listening');
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then release the datastores. A hard deadline guarantees the process exits
 * even if a connection never drains.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const deadline = setTimeout(() => {
    logger.error('shutdown deadline exceeded, forcing exit');
    process.exit(1);
  }, 10_000);
  deadline.unref();

  server.close(() => {
    Promise.allSettled([db.close(), closeMessageStore()])
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
