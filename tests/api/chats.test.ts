import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, UNKNOWN_ID, type Harness } from '../helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(() => h.reset());
afterAll(() => h.close());

describe('POST /user', () => {
  it('creates a user and rejects a duplicate email case-insensitively', async () => {
    const first = await request(h.app).post('/user').send({ displayName: 'Ada', email: 'ada@example.com' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ displayName: 'Ada', email: 'ada@example.com' });

    const dup = await request(h.app).post('/user').send({ displayName: 'Ada 2', email: 'ADA@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('validates input', async () => {
    const res = await request(h.app).post('/user').send({ displayName: '', email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['displayName', 'email']);
  });
});

describe('POST /chat/create', () => {
  it('creates a direct chat, then returns the same chat for either user order', async () => {
    const [a, b] = [await h.createUser('A'), await h.createUser('B')];

    const created = await request(h.app).post('/chat/create').send({ userAId: a, userBId: b });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ chatId: expect.any(String), created: true });

    const again = await request(h.app).post('/chat/create').send({ userAId: b, userBId: a });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ chatId: created.body.chatId, created: false });
  });

  it('yields exactly one chat when many requests race', async () => {
    const [a, b] = [await h.createUser('A'), await h.createUser('B')];

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(h.app)
          .post('/chat/create')
          .send(i % 2 ? { userAId: a, userBId: b } : { userAId: b, userBId: a }),
      ),
    );

    expect(new Set(responses.map((r) => r.body.chatId)).size).toBe(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    const { rows } = await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM chats');
    expect(rows[0]?.n).toBe(1);
  });

  it('keeps chats of different pairs separate', async () => {
    const [a, b, c] = [await h.createUser('A'), await h.createUser('B'), await h.createUser('C')];
    expect(await h.createDirectChat(a, b)).not.toBe(await h.createDirectChat(a, c));
  });

  it('rejects a chat with yourself, malformed ids and unknown users', async () => {
    const a = await h.createUser('A');

    const self = await request(h.app).post('/chat/create').send({ userAId: a, userBId: a });
    expect(self.status).toBe(400);

    const malformed = await request(h.app).post('/chat/create').send({ userAId: a, userBId: 'not-a-uuid' });
    expect(malformed.status).toBe(400);

    const unknown = await request(h.app).post('/chat/create').send({ userAId: a, userBId: UNKNOWN_ID });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: 'USER_NOT_FOUND', details: { missingUserIds: [UNKNOWN_ID] } });
  });
});

describe('GET /user/:userId/chats', () => {
  it('lists chats with member ids, most recently active first', async () => {
    const [a, b, c] = [await h.createUser('A'), await h.createUser('B'), await h.createUser('C')];
    const ab = await h.createDirectChat(a, b);
    const ac = await h.createDirectChat(a, c);
    await h.createDirectChat(b, c); // not A's chat

    // Activity in the older chat moves it to the top.
    await h.send(ab, b, 'hello');

    const res = await request(h.app).get(`/user/${a}/chats`);
    expect(res.status).toBe(200);
    expect(res.body.chats.map((chat: { chatId: string }) => chat.chatId)).toEqual([ab, ac]);
    expect(res.body.chats[0]).toMatchObject({ type: 'direct', lastMessageAt: expect.any(String) });
    expect([...res.body.chats[0].memberIds].sort()).toEqual([a, b].sort());
    expect([...res.body.chats[1].memberIds].sort()).toEqual([a, c].sort());
    expect(res.body.nextCursor).toBeNull();
  });

  it('paginates with a cursor without skipping or repeating chats', async () => {
    const a = await h.createUser('A');
    const expected: string[] = [];
    for (let i = 0; i < 5; i++) {
      const chatId = await h.createDirectChat(a, await h.createUser(`U${i}`));
      await h.send(chatId, a, `m${i}`);
      expected.unshift(chatId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(h.app)
        .get(`/user/${a}/chats`)
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .expect(200);
      seen.push(...res.body.chats.map((chat: { chatId: string }) => chat.chatId));
      cursor = res.body.nextCursor as string | null;
    } while (cursor);

    expect(seen).toEqual(expected);
  });

  it('returns 404 for an unknown user and 400 for a bad cursor', async () => {
    const a = await h.createUser('A');
    expect((await request(h.app).get(`/user/${UNKNOWN_ID}/chats`)).status).toBe(404);

    const bad = await request(h.app).get(`/user/${a}/chats`).query({ cursor: 'garbage' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('HTTP plumbing', () => {
  it('answers health checks, unknown routes and malformed JSON', async () => {
    expect((await request(h.app).get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await request(h.app).get('/health/ready')).status).toBe(200);

    const missing = await request(h.app).get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(missing.headers['x-request-id']).toBeTruthy();

    const malformed = await request(h.app)
      .post('/chat/create')
      .set('content-type', 'application/json')
      .send('{"userAId":');
    expect(malformed.status).toBe(400);
  });
});
