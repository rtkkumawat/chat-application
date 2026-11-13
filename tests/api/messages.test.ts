import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, UNKNOWN_ID, type Harness } from '../helpers/harness.js';

let h: Harness;
let alice: string;
let bob: string;
let mallory: string;
let chatId: string;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  [alice, bob, mallory] = [await h.createUser('Alice'), await h.createUser('Bob'), await h.createUser('Mallory')];
  chatId = await h.createDirectChat(alice, bob);
});
afterAll(() => h.close());

const texts = (body: { messages: { text: string }[] }): string[] => body.messages.map((m) => m.text);

describe('POST /chat/:chatId/message/send', () => {
  it('stores a message with a server timestamp', async () => {
    const res = await request(h.app).post(`/chat/${chatId}/message/send`).send({ senderId: alice, text: '  hi  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      chatId,
      senderId: alice,
      text: 'hi',
      editedAt: null,
      deleted: false,
      readBy: [],
    });
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false);
  });

  it('rejects non-members, unknown chats and invalid text', async () => {
    const outsider = await request(h.app).post(`/chat/${chatId}/message/send`).send({ senderId: mallory, text: 'x' });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe('NOT_A_CHAT_MEMBER');

    const noChat = await request(h.app).post(`/chat/${UNKNOWN_ID}/message/send`).send({ senderId: alice, text: 'x' });
    expect(noChat.status).toBe(404);
    expect(noChat.body.error.code).toBe('CHAT_NOT_FOUND');

    for (const text of ['', '   ', 'x'.repeat(4001)]) {
      const res = await request(h.app).post(`/chat/${chatId}/message/send`).send({ senderId: alice, text });
      expect(res.status).toBe(400);
    }
  });

  it('is idempotent for a repeated clientMessageId and rejects key reuse', async () => {
    const clientMessageId = randomUUID();
    const body = { senderId: alice, text: 'once', clientMessageId };

    const first = await request(h.app).post(`/chat/${chatId}/message/send`).send(body);
    const retry = await request(h.app).post(`/chat/${chatId}/message/send`).send(body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body.id).toBe(clientMessageId);

    const list = await request(h.app).get(`/chat/${chatId}/messages`);
    expect(list.body.messages).toHaveLength(1);

    const reuse = await request(h.app)
      .post(`/chat/${chatId}/message/send`)
      .send({ senderId: bob, text: 'different', clientMessageId });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});

describe('GET /chat/:chatId/messages', () => {
  it('returns messages in chronological order', async () => {
    await h.send(chatId, alice, 'one');
    await h.send(chatId, bob, 'two');
    await h.send(chatId, alice, 'three');

    const res = await request(h.app).get(`/chat/${chatId}/messages`).query({ limit: 50 });
    expect(res.status).toBe(200);
    expect(texts(res.body)).toEqual(['one', 'two', 'three']);
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns the latest page first and pages backwards through history', async () => {
    for (let i = 1; i <= 7; i++) await h.send(chatId, i % 2 ? alice : bob, `m${i}`);

    const page1 = await request(h.app).get(`/chat/${chatId}/messages`).query({ limit: 3 });
    expect(texts(page1.body)).toEqual(['m5', 'm6', 'm7']);

    const page2 = await request(h.app)
      .get(`/chat/${chatId}/messages`)
      .query({ limit: 3, before: page1.body.nextCursor });
    expect(texts(page2.body)).toEqual(['m2', 'm3', 'm4']);

    const page3 = await request(h.app)
      .get(`/chat/${chatId}/messages`)
      .query({ limit: 3, before: page2.body.nextCursor });
    expect(texts(page3.body)).toEqual(['m1']);
    expect(page3.body.nextCursor).toBeNull();
  });

  it('keeps a stable, gap-free order when messages share a timestamp', async () => {
    h.clock.freeze(); // every message gets the identical createdAt
    for (let i = 1; i <= 6; i++) await h.send(chatId, alice, `m${i}`);

    const all = await request(h.app).get(`/chat/${chatId}/messages`);
    // UUIDv7 ids break the tie in creation order.
    expect(texts(all.body)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

    const page1 = await request(h.app).get(`/chat/${chatId}/messages`).query({ limit: 4 });
    const page2 = await request(h.app)
      .get(`/chat/${chatId}/messages`)
      .query({ limit: 4, before: page1.body.nextCursor });
    expect([...texts(page2.body), ...texts(page1.body)]).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('validates limit and reports unknown chats', async () => {
    expect((await request(h.app).get(`/chat/${chatId}/messages`).query({ limit: 0 })).status).toBe(400);
    expect((await request(h.app).get(`/chat/${chatId}/messages`).query({ limit: 101 })).status).toBe(400);
    expect((await request(h.app).get(`/chat/${UNKNOWN_ID}/messages`)).status).toBe(404);
    expect((await request(h.app).get(`/chat/${chatId}/messages`)).body).toEqual({ messages: [], nextCursor: null });
  });
});

describe('POST /chat/:chatId/message/:messageId/read', () => {
  it('records a read receipt once and keeps the first read time', async () => {
    const msg = await h.send(chatId, alice, 'read me');

    const first = await request(h.app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: bob });
    expect(first.status).toBe(200);
    expect(first.body.readBy).toEqual([{ userId: bob, readAt: expect.any(String) }]);

    const second = await request(h.app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: bob });
    expect(second.body.readBy).toEqual(first.body.readBy);

    const list = await request(h.app).get(`/chat/${chatId}/messages`);
    expect(list.body.messages[0].readBy).toEqual(first.body.readBy);
  });

  it('does not record a receipt for the sender', async () => {
    const msg = await h.send(chatId, alice, 'mine');
    const res = await request(h.app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: alice });
    expect(res.status).toBe(200);
    expect(res.body.readBy).toEqual([]);
  });

  it('rejects non-members and unknown messages', async () => {
    const msg = await h.send(chatId, alice, 'secret');
    const outsider = await request(h.app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: mallory });
    expect(outsider.status).toBe(403);

    const missing = await request(h.app).post(`/chat/${chatId}/message/${UNKNOWN_ID}/read`).send({ userId: bob });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('cannot reach a message through another chat', async () => {
    const otherChat = await h.createDirectChat(alice, mallory);
    const msg = await h.send(chatId, alice, 'for bob only');
    const res = await request(h.app).post(`/chat/${otherChat}/message/${msg.id}/read`).send({ userId: mallory });
    expect(res.status).toBe(404);
  });
});

describe('POST /chat/:chatId/lastseen', () => {
  it('tracks last seen per user and never moves backwards', async () => {
    const m1 = await h.send(chatId, alice, 'one');
    const m2 = await h.send(chatId, alice, 'two');

    const forward = await request(h.app).post(`/chat/${chatId}/lastseen`).send({ userId: bob, messageId: m2.id });
    expect(forward.status).toBe(200);
    expect(forward.body).toMatchObject({ chatId, userId: bob, lastSeenMessageId: m2.id });

    // A stale update (e.g. a delayed request from another device) is ignored.
    const stale = await request(h.app).post(`/chat/${chatId}/lastseen`).send({ userId: bob, messageId: m1.id });
    expect(stale.status).toBe(200);
    expect(stale.body.lastSeenMessageId).toBe(m2.id);

    await request(h.app).post(`/chat/${chatId}/lastseen`).send({ userId: alice, messageId: m1.id }).expect(200);

    const all = await request(h.app).get(`/chat/${chatId}/lastseen`);
    const byUser = Object.fromEntries(
      all.body.lastSeen.map((s: { userId: string; lastSeenMessageId: string }) => [s.userId, s.lastSeenMessageId]),
    );
    expect(byUser).toEqual({ [bob]: m2.id, [alice]: m1.id });
  });

  it('rejects non-members and unknown messages', async () => {
    const msg = await h.send(chatId, alice, 'one');
    const outsider = await request(h.app).post(`/chat/${chatId}/lastseen`).send({ userId: mallory, messageId: msg.id });
    expect(outsider.status).toBe(403);
    const missing = await request(h.app).post(`/chat/${chatId}/lastseen`).send({ userId: bob, messageId: UNKNOWN_ID });
    expect(missing.status).toBe(404);
  });
});

describe('message edit and delete (bonus)', () => {
  it('lets only the sender edit', async () => {
    const msg = await h.send(chatId, alice, 'tpyo');

    const denied = await request(h.app).patch(`/chat/${chatId}/message/${msg.id}`).send({ userId: bob, text: 'hax' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_MESSAGE_SENDER');

    const edited = await request(h.app).patch(`/chat/${chatId}/message/${msg.id}`).send({ userId: alice, text: 'typo' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ text: 'typo', editedAt: expect.any(String), createdAt: msg.createdAt });
  });

  it('soft-deletes: content is scrubbed, the tombstone keeps its place, edits are refused', async () => {
    await h.send(chatId, alice, 'before');
    const msg = await h.send(chatId, alice, 'regret');
    await h.send(chatId, bob, 'after');

    const denied = await request(h.app).delete(`/chat/${chatId}/message/${msg.id}`).send({ userId: bob });
    expect(denied.status).toBe(403);

    const deleted = await request(h.app).delete(`/chat/${chatId}/message/${msg.id}`).send({ userId: alice });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ text: null, deleted: true, deletedAt: expect.any(String) });

    const again = await request(h.app).delete(`/chat/${chatId}/message/${msg.id}`).send({ userId: alice });
    expect(again.body.deletedAt).toBe(deleted.body.deletedAt);

    const list = await request(h.app).get(`/chat/${chatId}/messages`);
    expect(list.body.messages.map((m: { text: string | null }) => m.text)).toEqual(['before', null, 'after']);

    const edit = await request(h.app).patch(`/chat/${chatId}/message/${msg.id}`).send({ userId: alice, text: 'undo' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('MESSAGE_DELETED');
  });
});
