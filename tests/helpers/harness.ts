import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import type { Db } from '../../src/db/db.js';
import { buildApp } from '../../src/http/app.js';
import { InMemoryMessageStore } from '../../src/modules/messages/in-memory-message.store.js';
import { createTestDb, resetDb } from './test-db.js';

/** A controllable clock, so ordering tests never depend on wall-clock timing. */
export class TestClock {
  // Starts ahead of the wall clock: chat rows are stamped by the database's
  // now(), and a message must never appear older than the chat it belongs to.
  private ms = Date.now() + 60 * 60 * 1000;
  private frozen = false;

  /** Every reading advances by 1ms unless frozen. */
  now = (): Date => new Date(this.frozen ? this.ms : ++this.ms);

  freeze(): void {
    this.frozen = true;
  }
  unfreeze(): void {
    this.frozen = false;
  }
}

export interface Harness {
  app: Express;
  db: Db;
  clock: TestClock;
  reset(): Promise<void>;
  close(): Promise<void>;
  createUser(name: string): Promise<string>;
  createDirectChat(userAId: string, userBId: string): Promise<string>;
  send(chatId: string, senderId: string, text: string): Promise<{ id: string; createdAt: string }>;
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDb();
  const clock = new TestClock();
  let app = build();

  function build(): Express {
    return buildApp({
      db,
      messageStore: new InMemoryMessageStore(clock.now),
      logger: pino({ level: 'silent' }),
    });
  }

  let userSeq = 0;
  const harness: Harness = {
    get app() {
      return app;
    },
    db,
    clock,
    async reset() {
      await resetDb(db);
      clock.unfreeze();
      app = build(); // fresh, empty message store
    },
    close: () => db.close(),
    async createUser(name) {
      const res = await request(app)
        .post('/user')
        .send({ displayName: name, email: `${name.toLowerCase()}.${++userSeq}@example.com` })
        .expect(201);
      return res.body.id as string;
    },
    async createDirectChat(userAId, userBId) {
      const res = await request(app).post('/chat/create').send({ userAId, userBId });
      return res.body.chatId as string;
    },
    async send(chatId, senderId, text) {
      const res = await request(app).post(`/chat/${chatId}/message/send`).send({ senderId, text }).expect(201);
      return res.body as { id: string; createdAt: string };
    },
  };
  return harness;
}

export const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
