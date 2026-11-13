import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let owner: string;
let bob: string;
let carol: string;
let dave: string;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  [owner, bob, carol, dave] = [
    await h.createUser('Owner'),
    await h.createUser('Bob'),
    await h.createUser('Carol'),
    await h.createUser('Dave'),
  ];
});
afterAll(() => h.close());

type Member = { userId: string; role: string };
const roles = (body: { members: Member[] }): Record<string, string> =>
  Object.fromEntries(body.members.map((m) => [m.userId, m.role]));

async function createGroup(memberIds: string[] = [bob, carol]): Promise<string> {
  const res = await request(h.app).post('/chat/group').send({ creatorId: owner, title: 'Team', memberIds }).expect(201);
  return res.body.chatId as string;
}

describe('group chats (bonus)', () => {
  it('creates a group with the creator as owner and de-duplicated members', async () => {
    const res = await request(h.app)
      .post('/chat/group')
      .send({ creatorId: owner, title: ' Team ', memberIds: [bob, carol, bob, owner] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'group', title: 'Team', createdBy: owner });
    expect(roles(res.body)).toEqual({ [owner]: 'owner', [bob]: 'member', [carol]: 'member' });

    const list = await request(h.app).get(`/user/${carol}/chats`);
    expect(list.body.chats).toHaveLength(1);
    expect([...list.body.chats[0].memberIds].sort()).toEqual([owner, bob, carol].sort());
  });

  it('lets every member message the group, with per-member read receipts', async () => {
    const chatId = await createGroup();
    const msg = await h.send(chatId, bob, 'hello team');

    await request(h.app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: carol }).expect(200);
    const res = await request(h.app).post(`/chat/${chatId}/message/${msg.id}/read`).send({ userId: owner });
    expect(res.body.readBy.map((r: { userId: string }) => r.userId).sort()).toEqual([carol, owner].sort());

    const outsider = await request(h.app).post(`/chat/${chatId}/message/send`).send({ senderId: dave, text: 'hi' });
    expect(outsider.status).toBe(403);
  });

  it('lets only the owner add members and rename; adding is idempotent', async () => {
    const chatId = await createGroup();

    const denied = await request(h.app).post(`/chat/${chatId}/members`).send({ actorId: bob, userIds: [dave] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_ROLE');

    const added = await request(h.app).post(`/chat/${chatId}/members`).send({ actorId: owner, userIds: [dave, bob] });
    expect(added.status).toBe(200);
    expect(Object.keys(roles(added.body)).sort()).toEqual([owner, bob, carol, dave].sort());

    await request(h.app).post(`/chat/${chatId}/message/send`).send({ senderId: dave, text: 'made it' }).expect(201);

    expect((await request(h.app).patch(`/chat/${chatId}`).send({ actorId: bob, title: 'Nope' })).status).toBe(403);
    const renamed = await request(h.app).patch(`/chat/${chatId}`).send({ actorId: owner, title: 'Renamed' });
    expect(renamed.body.title).toBe('Renamed');
    expect((await request(h.app).get(`/chat/${chatId}`)).body.title).toBe('Renamed');
  });

  it('supports removal by the owner and leaving; a removed member loses access', async () => {
    const chatId = await createGroup();

    const denied = await request(h.app).delete(`/chat/${chatId}/members/${carol}`).send({ actorId: bob });
    expect(denied.status).toBe(403);

    await request(h.app).delete(`/chat/${chatId}/members/${carol}`).send({ actorId: owner }).expect(200);
    const blocked = await request(h.app).post(`/chat/${chatId}/message/send`).send({ senderId: carol, text: 'still here?' });
    expect(blocked.status).toBe(403);
    expect((await request(h.app).get(`/user/${carol}/chats`)).body.chats).toEqual([]);

    const again = await request(h.app).delete(`/chat/${chatId}/members/${carol}`).send({ actorId: owner });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('hands ownership to the longest-standing member when the owner leaves, and deletes an empty group', async () => {
    const chatId = await createGroup([bob]);
    await h.send(chatId, owner, 'bye');

    const left = await request(h.app).delete(`/chat/${chatId}/members/${owner}`).send({ actorId: owner });
    expect(left.body).toEqual({ chatDeleted: false, newOwnerId: bob });
    expect(roles((await request(h.app).get(`/chat/${chatId}`)).body)).toEqual({ [bob]: 'owner' });

    const last = await request(h.app).delete(`/chat/${chatId}/members/${bob}`).send({ actorId: bob });
    expect(last.body).toEqual({ chatDeleted: true, newOwnerId: null });
    expect((await request(h.app).get(`/chat/${chatId}`)).status).toBe(404);
    expect((await request(h.app).get(`/chat/${chatId}/messages`)).status).toBe(404);
  });

  it('refuses membership changes on direct chats and enforces the size cap', async () => {
    const direct = await h.createDirectChat(owner, bob);
    const res = await request(h.app).post(`/chat/${direct}/members`).send({ actorId: owner, userIds: [carol] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_A_GROUP_CHAT');

    // Fill a group to the cap directly in SQL, then try to add one more.
    const chatId = await createGroup([bob]);
    await h.db.query(
      `WITH filler AS (
         INSERT INTO users (display_name, email)
         SELECT 'Filler ' || i, 'filler' || i || '@example.com' FROM generate_series(1, 98) AS i
         RETURNING id
       )
       INSERT INTO chat_members (chat_id, user_id) SELECT $1, id FROM filler`,
      [chatId],
    );
    const full = await request(h.app).post(`/chat/${chatId}/members`).send({ actorId: owner, userIds: [dave] });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('GROUP_SIZE_LIMIT');
  });
});
