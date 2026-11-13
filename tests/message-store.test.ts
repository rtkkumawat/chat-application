import { describe, it } from 'vitest';
import { createFirestore } from '../src/firebase/firestore.js';
import { FirestoreMessageStore } from '../src/modules/messages/firestore-message.store.js';
import { InMemoryMessageStore } from '../src/modules/messages/in-memory-message.store.js';
import { messageStoreContract } from './message-store.contract.js';

// A strictly increasing clock: in-memory timestamps are otherwise only as
// fine-grained as Date.now(), which would make "newest first" assertions flaky.
let tick = Date.parse('2026-01-01T00:00:00.000Z');
const store = new InMemoryMessageStore(() => new Date(++tick));
messageStoreContract('in-memory', () => store);

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (emulatorHost) {
  const firestore = createFirestore({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? 'demo-chat',
    FIRESTORE_EMULATOR_HOST: emulatorHost,
    FIREBASE_SERVICE_ACCOUNT_BASE64: undefined,
  });
  const firestoreStore = new FirestoreMessageStore(firestore);
  messageStoreContract('firestore (emulator)', () => firestoreStore);
} else {
  describe('MessageStore contract: firestore (emulator)', () => {
    it.skip('skipped: set FIRESTORE_EMULATOR_HOST or run `npm run test:emulator`', () => {});
  });
}
