import {
  FieldPath,
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import type { Cursor } from '../../lib/cursor.js';
import { messageDeleted, messageNotFound, notMessageSender } from './message.errors.js';
import {
  compareByPosition,
  type CreateMessageInput,
  type LastSeen,
  type Message,
  type MessageStore,
} from './message.store.js';

/**
 * Firestore layout
 *
 *   chats/{chatId}/messages/{messageId}
 *     senderId   string
 *     text       string
 *     createdAt  timestamp   server-assigned; the ordering key
 *     editedAt   timestamp | null
 *     deletedAt  timestamp | null
 *     readBy     map<userId, timestamp>   read receipts
 *
 *   chats/{chatId}/memberState/{userId}
 *     lastSeenMessageId         string
 *     lastSeenMessageCreatedAt  timestamp
 *     updatedAt                 timestamp
 *
 * Why this shape:
 *  - Messages live in a per-chat subcollection, so every query is scoped to one
 *    chat and served by the automatic single-field index on `createdAt`
 *    (ordered with the document id as tie-breaker). No composite index needed.
 *  - Receipts are a map on the message: reading a page of messages returns its
 *    receipts with no extra reads. This is the right trade-off for 1:1 chats
 *    and bounded groups (group size is capped well below the 1 MiB doc limit).
 *  - Last-seen is one small document per (chat, user): a watermark that covers
 *    any number of messages with a single write.
 *
 * Clocks: `createdAt` uses the Firestore server timestamp because it defines
 * message order and must not depend on the clock of whichever API instance
 * handled the request. Receipt/edit/delete times are informational and use the
 * instance clock, which avoids a read-back round trip per write.
 */
interface MessageDoc {
  senderId: string;
  text: string;
  createdAt: Timestamp;
  editedAt: Timestamp | null;
  deletedAt: Timestamp | null;
  readBy: Record<string, Timestamp>;
}

interface MemberStateDoc {
  lastSeenMessageId: string;
  lastSeenMessageCreatedAt: Timestamp;
  updatedAt: Timestamp;
}

/** gRPC status code for ALREADY_EXISTS. */
const GRPC_ALREADY_EXISTS = 6;

export class FirestoreMessageStore implements MessageStore {
  constructor(private readonly firestore: Firestore) {}

  async create(input: CreateMessageInput): Promise<{ message: Message; created: boolean }> {
    const ref = this.messages(input.chatId).doc(input.messageId);
    let created = true;
    try {
      // create() fails if the document exists, which is what makes a retried
      // send (same messageId) idempotent instead of producing a duplicate.
      await ref.create({
        senderId: input.senderId,
        text: input.text,
        createdAt: FieldValue.serverTimestamp(),
        editedAt: null,
        deletedAt: null,
        readBy: {},
      });
    } catch (err) {
      if ((err as { code?: unknown }).code !== GRPC_ALREADY_EXISTS) throw err;
      created = false;
    }
    // Read back to learn the server-assigned createdAt.
    const snap = await ref.get();
    return { message: toMessage(input.chatId, snap), created };
  }

  async list(chatId: string, opts: { limit: number; before?: Cursor }): Promise<Message[]> {
    let query = this.messages(chatId)
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(opts.limit);
    if (opts.before) {
      query = query.startAfter(Timestamp.fromMillis(opts.before.ts), opts.before.id);
    }
    const snap = await query.get();
    return snap.docs.map((doc) => toMessage(chatId, doc));
  }

  async markRead(chatId: string, messageId: string, userId: string): Promise<Message> {
    const ref = this.messages(chatId).doc(messageId);
    return this.firestore.runTransaction(async (tx) => {
      const message = toMessage(chatId, await tx.get(ref));
      if (message.senderId === userId || message.readBy[userId]) return message;

      const readAt = Timestamp.now();
      // FieldPath (not a dotted string) so a user id can never be misparsed as a path.
      tx.update(ref, new FieldPath('readBy', userId), readAt);
      return { ...message, readBy: { ...message.readBy, [userId]: readAt.toDate() } };
    });
  }

  async setLastSeen(chatId: string, userId: string, messageId: string): Promise<LastSeen> {
    const messageRef = this.messages(chatId).doc(messageId);
    const stateRef = this.memberState(chatId).doc(userId);

    return this.firestore.runTransaction(async (tx) => {
      const [messageSnap, stateSnap] = await Promise.all([tx.get(messageRef), tx.get(stateRef)]);
      const message = toMessage(chatId, messageSnap);
      const current = stateSnap.exists ? toLastSeen(chatId, stateSnap) : null;

      // Requests can arrive out of order (retries, several devices). Compare
      // positions inside the transaction so the pointer only ever advances.
      if (
        current &&
        compareByPosition(
          { createdAtMs: current.messageCreatedAt.getTime(), id: current.messageId },
          { createdAtMs: message.createdAt.getTime(), id: message.id },
        ) >= 0
      ) {
        return current;
      }

      const updatedAt = Timestamp.now();
      const next: MemberStateDoc = {
        lastSeenMessageId: message.id,
        lastSeenMessageCreatedAt: Timestamp.fromDate(message.createdAt),
        updatedAt,
      };
      tx.set(stateRef, next);
      return {
        chatId,
        userId,
        messageId: message.id,
        messageCreatedAt: message.createdAt,
        updatedAt: updatedAt.toDate(),
      };
    });
  }

  async listLastSeen(chatId: string): Promise<LastSeen[]> {
    const snap = await this.memberState(chatId).get();
    return snap.docs.map((doc) => toLastSeen(chatId, doc));
  }

  async edit(chatId: string, messageId: string, editorId: string, text: string): Promise<Message> {
    const ref = this.messages(chatId).doc(messageId);
    return this.firestore.runTransaction(async (tx) => {
      const message = toMessage(chatId, await tx.get(ref));
      if (message.senderId !== editorId) throw notMessageSender();
      if (message.deletedAt) throw messageDeleted();

      const editedAt = Timestamp.now();
      tx.update(ref, { text, editedAt });
      return { ...message, text, editedAt: editedAt.toDate() };
    });
  }

  async softDelete(chatId: string, messageId: string, deleterId: string): Promise<Message> {
    const ref = this.messages(chatId).doc(messageId);
    return this.firestore.runTransaction(async (tx) => {
      const message = toMessage(chatId, await tx.get(ref));
      if (message.senderId !== deleterId) throw notMessageSender();
      if (message.deletedAt) return message;

      const deletedAt = Timestamp.now();
      tx.update(ref, { text: '', deletedAt });
      return { ...message, text: '', deletedAt: deletedAt.toDate() };
    });
  }

  async purgeChat(chatId: string): Promise<void> {
    await this.firestore.recursiveDelete(this.firestore.collection('chats').doc(chatId));
  }

  private messages(chatId: string): CollectionReference {
    return this.firestore.collection('chats').doc(chatId).collection('messages');
  }

  private memberState(chatId: string): CollectionReference {
    return this.firestore.collection('chats').doc(chatId).collection('memberState');
  }
}

function toMessage(chatId: string, snap: DocumentSnapshot): Message {
  const data = snap.data() as MessageDoc | undefined;
  if (!data) throw messageNotFound(snap.id);
  return {
    id: snap.id,
    chatId,
    senderId: data.senderId,
    text: data.text,
    createdAt: data.createdAt.toDate(),
    editedAt: data.editedAt?.toDate() ?? null,
    deletedAt: data.deletedAt?.toDate() ?? null,
    readBy: Object.fromEntries(Object.entries(data.readBy ?? {}).map(([userId, at]) => [userId, at.toDate()])),
  };
}

function toLastSeen(chatId: string, snap: DocumentSnapshot): LastSeen {
  const data = snap.data() as MemberStateDoc;
  return {
    chatId,
    userId: snap.id,
    messageId: data.lastSeenMessageId,
    messageCreatedAt: data.lastSeenMessageCreatedAt.toDate(),
    updatedAt: data.updatedAt.toDate(),
  };
}
