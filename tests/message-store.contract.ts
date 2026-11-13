import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import type { MessageStore } from '../src/modules/messages/message.store.js';

/**
 * Behavioural contract every MessageStore must satisfy. It runs against the
 * in-memory store on every test run and against Firestore whenever an emulator
 * is available, which is what keeps the two implementations interchangeable.
 */
export function messageStoreContract(name: string, makeStore: () => MessageStore): void {
  describe(`MessageStore contract: ${name}`, () => {
    const alice = randomUUID();
    const bob = randomUUID();

    const setup = () => ({ store: makeStore(), chatId: randomUUID() });
    const send = (store: MessageStore, chatId: string, text: string, senderId = alice) =>
      store.create({ chatId, messageId: uuidv7(), senderId, text }).then((r) => r.message);

    it('creates messages with a timestamp and empty receipts', async () => {
      const { store, chatId } = setup();
      const message = await send(store, chatId, 'hello');
      expect(message).toMatchObject({ chatId, senderId: alice, text: 'hello', editedAt: null, deletedAt: null, readBy: {} });
      expect(message.createdAt).toBeInstanceOf(Date);
    });

    it('treats a repeated messageId as the same message', async () => {
      const { store, chatId } = setup();
      const input = { chatId, messageId: uuidv7(), senderId: alice, text: 'once' };
      const first = await store.create(input);
      const second = await store.create({ ...input, text: 'twice' });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.message).toEqual(first.message);
      expect(await store.list(chatId, { limit: 10 })).toHaveLength(1);
    });

    it('lists newest first, scoped to the chat, and pages with a cursor', async () => {
      const { store, chatId } = setup();
      const other = randomUUID();
      await send(store, other, 'other chat');
      for (let i = 1; i <= 5; i++) await send(store, chatId, `m${i}`);

      const page1 = await store.list(chatId, { limit: 2 });
      expect(page1.map((m) => m.text)).toEqual(['m5', 'm4']);

      const last = page1.at(-1)!;
      const page2 = await store.list(chatId, { limit: 10, before: { ts: last.createdAt.getTime(), id: last.id } });
      expect(page2.map((m) => m.text)).toEqual(['m3', 'm2', 'm1']);
    });

    it('records the first read per user and ignores the sender', async () => {
      const { store, chatId } = setup();
      const message = await send(store, chatId, 'read me');

      const first = await store.markRead(chatId, message.id, bob);
      expect(first.readBy[bob]).toBeInstanceOf(Date);
      const second = await store.markRead(chatId, message.id, bob);
      expect(second.readBy[bob]).toEqual(first.readBy[bob]);

      expect((await store.markRead(chatId, message.id, alice)).readBy).not.toHaveProperty(alice);
      expect((await store.list(chatId, { limit: 1 }))[0]?.readBy).toEqual(first.readBy);
      await expect(store.markRead(chatId, randomUUID(), bob)).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    });

    it('only moves the last-seen pointer forward', async () => {
      const { store, chatId } = setup();
      const m1 = await send(store, chatId, 'one');
      const m2 = await send(store, chatId, 'two');

      expect((await store.setLastSeen(chatId, bob, m2.id)).messageId).toBe(m2.id);
      expect((await store.setLastSeen(chatId, bob, m1.id)).messageId).toBe(m2.id);
      expect((await store.setLastSeen(chatId, alice, m1.id)).messageId).toBe(m1.id);

      const all = await store.listLastSeen(chatId);
      expect(Object.fromEntries(all.map((s) => [s.userId, s.messageId]))).toEqual({ [bob]: m2.id, [alice]: m1.id });
      await expect(store.setLastSeen(chatId, bob, randomUUID())).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    });

    it('converges to the newest message under concurrent last-seen updates', async () => {
      const { store, chatId } = setup();
      const messages = [];
      for (let i = 0; i < 5; i++) messages.push(await send(store, chatId, `m${i}`));

      await Promise.all(messages.map((m) => store.setLastSeen(chatId, bob, m.id)));
      const [state] = await store.listLastSeen(chatId);
      expect(state?.messageId).toBe(messages.at(-1)!.id);
    });

    it('restricts edit and delete to the sender and keeps a tombstone', async () => {
      const { store, chatId } = setup();
      const message = await send(store, chatId, 'draft');

      await expect(store.edit(chatId, message.id, bob, 'x')).rejects.toMatchObject({ code: 'NOT_MESSAGE_SENDER' });
      const edited = await store.edit(chatId, message.id, alice, 'final');
      expect(edited).toMatchObject({ text: 'final', createdAt: message.createdAt });
      expect(edited.editedAt).toBeInstanceOf(Date);

      await expect(store.softDelete(chatId, message.id, bob)).rejects.toMatchObject({ code: 'NOT_MESSAGE_SENDER' });
      const deleted = await store.softDelete(chatId, message.id, alice);
      expect(deleted.text).toBe('');
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect((await store.softDelete(chatId, message.id, alice)).deletedAt).toEqual(deleted.deletedAt);

      await expect(store.edit(chatId, message.id, alice, 'y')).rejects.toMatchObject({ code: 'MESSAGE_DELETED' });
      expect(await store.list(chatId, { limit: 10 })).toHaveLength(1);
    });

    it('purges all data of a chat', async () => {
      const { store, chatId } = setup();
      const message = await send(store, chatId, 'gone soon');
      await store.setLastSeen(chatId, bob, message.id);

      await store.purgeChat(chatId);
      expect(await store.list(chatId, { limit: 10 })).toEqual([]);
      expect(await store.listLastSeen(chatId)).toEqual([]);
    });
  });
}
