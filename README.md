# Chat Backend

A chat backend in **Node.js + TypeScript (strict)** that splits its data across two stores:

| Data | Store | Why |
| --- | --- | --- |
| Users, chats, memberships | **PostgreSQL** | Relational integrity, uniqueness guarantees, transactional membership changes |
| Messages, read receipts, last-seen pointers | **Firebase Firestore** | High-volume, append-heavy, per-chat data with server timestamps |

It supports 1:1 chats, sending and ordering messages, read receipts and last-seen tracking, plus both bonus items: **group chats** (create / add / remove / leave / rename) and **message edit / delete**.

## Quick start

Requirements: Node.js 20+, a PostgreSQL database, and either a Firebase project or the Firestore emulator.

```bash
npm install
cp .env.example .env          # then set DATABASE_URL and the Firebase settings
npm run migrate               # creates the schema
npm run dev                   # http://localhost:3000
```

Firestore can be supplied three ways (see [.env.example](.env.example)):

- **Emulator**: `npx firebase-tools emulators:start --only firestore --project demo-chat` and set `FIRESTORE_EMULATOR_HOST=localhost:8080`. No credentials required (needs Java).
- **Real project**: set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key file, or `FIREBASE_SERVICE_ACCOUNT_BASE64`.
- **No Firebase at all**: `MESSAGE_STORE=memory` runs the API on a non-persistent in-memory store. For trying the API locally only; it is rejected in production.

Or run the whole stack (PostgreSQL + Firestore emulator + API) in containers:

```bash
docker compose up --build
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run migrate` | Apply pending migrations |
| `npm test` | Test suite. Needs nothing installed: PostgreSQL runs in-process |
| `npm run test:emulator` | Same suite, plus the Firestore contract tests against the emulator |
| `npm run check` | Typecheck + lint + tests |

## API

Request and response bodies are JSON. All ids are UUIDs. A ready-to-run request collection is in [docs/api.http](docs/api.http).

### Required endpoints

| # | Endpoint | Body / query | Response |
| --- | --- | --- | --- |
| 1 | `POST /chat/create` | `{ userAId, userBId }` | `{ chatId, created }`. `201` if created, `200` if it already existed |
| 2 | `POST /chat/:chatId/message/send` | `{ senderId, text, clientMessageId? }` | The message. `201` |
| 3 | `GET /chat/:chatId/messages?limit=50&before=<cursor>` | | `{ messages, nextCursor }`, ordered by timestamp (oldest first) |
| 4 | `POST /chat/:chatId/message/:messageId/read` | `{ userId }` | The message with its `readBy` receipts |
| 5 | `POST /chat/:chatId/lastseen` | `{ userId, messageId }` | The user's last-seen pointer |
| 6 | `GET /user/:userId/chats?limit=50&cursor=<cursor>` | | `{ chats: [{ chatId, type, title, memberIds, ... }], nextCursor }` |

### Supporting and bonus endpoints

| Endpoint | Body | Purpose |
| --- | --- | --- |
| `POST /user` | `{ displayName, email }` | Create a user (chats reference users, so they must exist) |
| `GET /user/:userId` | | Fetch a user |
| `GET /chat/:chatId` | | Chat details with members and roles |
| `GET /chat/:chatId/lastseen` | | Last-seen pointer of every member |
| `POST /chat/group` | `{ creatorId, title, memberIds[] }` | **Bonus**: create a group (creator becomes owner) |
| `POST /chat/:chatId/members` | `{ actorId, userIds[] }` | **Bonus**: add members (owner only, idempotent) |
| `DELETE /chat/:chatId/members/:userId` | `{ actorId }` | **Bonus**: remove a member (owner) or leave (self) |
| `PATCH /chat/:chatId` | `{ actorId, title }` | **Bonus**: rename a group (owner only) |
| `PATCH /chat/:chatId/message/:messageId` | `{ userId, text }` | **Bonus**: edit a message (sender only) |
| `DELETE /chat/:chatId/message/:messageId` | `{ userId }` | **Bonus**: delete a message (sender only, soft delete) |
| `GET /health/live`, `GET /health/ready` | | Liveness / readiness probes |

### Example

```bash
curl -X POST localhost:3000/chat/<chatId>/message/send \
  -H 'content-type: application/json' \
  -d '{"senderId":"<userId>","text":"hello"}'
```

```json
{
  "id": "0199c1f2-6b1e-7c7a-9d0e-2f6b7a1c3d4e",
  "chatId": "…",
  "senderId": "…",
  "text": "hello",
  "createdAt": "2026-11-13T10:15:30.123Z",
  "editedAt": null,
  "deleted": false,
  "deletedAt": null,
  "readBy": []
}
```

### Errors

Every error has the same shape, with a stable machine-readable `code`:

```json
{ "error": { "code": "NOT_A_CHAT_MEMBER", "message": "The user is not a member of this chat", "requestId": "…" } }
```

| Status | Codes |
| --- | --- |
| 400 | `VALIDATION_ERROR` (with per-field `details`), `INVALID_CURSOR` |
| 403 | `NOT_A_CHAT_MEMBER`, `NOT_MESSAGE_SENDER`, `INSUFFICIENT_ROLE` |
| 404 | `USER_NOT_FOUND`, `CHAT_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `MEMBER_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | `EMAIL_ALREADY_REGISTERED`, `IDEMPOTENCY_KEY_CONFLICT`, `NOT_A_GROUP_CHAT`, `GROUP_SIZE_LIMIT`, `MESSAGE_DELETED` |
| 429 | `RATE_LIMITED` |

## Architecture

```
            HTTP (Express 5)
  routes ─ validation (zod) ─ presenters ─ error handler
                    │
                services                    business rules, authorisation, orchestration
        ChatService      MessageService
            │                   │
   ChatRepository /        MessageStore  (port)
   UserRepository          ├─ FirestoreMessageStore   production
            │              └─ InMemoryMessageStore    tests, local dev
       Db (port)
   ├─ pg adapter (pool)
   └─ PGlite adapter (tests)
            │                   │
       PostgreSQL           Firestore
```

```
src/
  config/env.ts            environment parsing; fails fast at boot
  db/                      Db port, pg adapter, migrations + runner
  firebase/firestore.ts    Admin SDK initialisation
  http/                    app composition, routes, validation, wire format
  modules/
    users/                 repository + service
    chats/                 repository + service (direct and group chats)
    messages/              MessageStore port, Firestore + in-memory adapters, service
  server.ts                process entry point, graceful shutdown
tests/                     API tests, MessageStore contract tests, migration tests
```

The layering rule is simple: routes know HTTP, services know the rules, repositories and stores know their database. Dependencies are passed in explicitly ([src/http/app.ts](src/http/app.ts) is the composition root), which is what lets the tests build the real application around an in-process database.

### Data model

**PostgreSQL** ([src/db/migrations.ts](src/db/migrations.ts))

```
users         (id PK, display_name, email UNIQUE ci, created_at)
chats         (id PK, type 'direct'|'group', title, direct_user_low, direct_user_high,
               created_by, created_at, updated_at, last_message_at,
               UNIQUE (direct_user_low, direct_user_high))
chat_members  (chat_id FK, user_id FK, role 'owner'|'member', joined_at,
               PK (chat_id, user_id), INDEX (user_id, chat_id))
```

**Firestore** ([src/modules/messages/firestore-message.store.ts](src/modules/messages/firestore-message.store.ts))

```
chats/{chatId}/messages/{messageId}
    senderId, text, createdAt (server timestamp), editedAt, deletedAt,
    readBy: { <userId>: <timestamp> }          read receipts

chats/{chatId}/memberState/{userId}
    lastSeenMessageId, lastSeenMessageCreatedAt, updatedAt
```

## Design decisions

**One direct chat per pair, even under concurrency.** The pair is stored in canonical order (`direct_user_low < direct_user_high`, enforced by a CHECK) with a UNIQUE constraint on it. "Create or get" is `INSERT … ON CONFLICT DO NOTHING` followed by a read, inside one transaction. `(A,B)` and `(B,A)` resolve to the same row, and if two requests race, the database picks one winner; the loser blocks on the unique index and then reads the winner's row. No application-level locking, and a test fires twelve concurrent requests to prove it.

**Message ordering.** `createdAt` is a Firestore **server timestamp**, so order does not depend on the clock of whichever API instance handled the request. Firestore timestamps of this kind have millisecond resolution, so ties are real: the total order is `(createdAt, messageId)`. Server-generated ids are UUIDv7 (time-ordered), so messages created in the same millisecond by one instance still sort in creation order.

**Pagination is keyset, not offset.** Both list endpoints use an opaque cursor that encodes the last `(timestamp, id)` seen. Cost is independent of page depth, and new messages arriving while a client pages back never cause skipped or duplicated rows. `GET /messages` returns the latest `limit` messages in chronological order; `nextCursor` walks back through history. PostgreSQL timestamps are `timestamptz(3)` so they round-trip through a JS `Date` exactly, which a cursor depends on.

**Idempotent sends.** A client may pass `clientMessageId` (a UUID). It becomes the Firestore document id and the write uses `create()`, which fails if the document exists. A retried request after a timeout therefore returns the original message instead of creating a duplicate; reusing the key for a different message is a `409`.

**Read receipts vs. last seen.** These are two different tools. A receipt is a per-message fact ("Bob read this at 10:15"), stored as a `readBy` map on the message, so a page of messages comes back with its receipts and no extra reads. Recording is transactional and keeps the *first* read time; the sender never gets a receipt on their own message. Last seen is a per-user watermark ("Bob has seen everything up to here"): one small document that covers any number of messages with a single write. It is **monotonic**: updates are compared inside a transaction, so a delayed or out-of-order request from another device can never move the pointer backwards.

**PostgreSQL is the authority for access.** Every message operation first checks membership in PostgreSQL (one indexed lookup that also distinguishes "no such chat" from "not a member"). Firestore is never trusted for authorisation, and [firestore.rules](firestore.rules) denies all direct client access.

**Cross-store consistency.** There is no distributed transaction across PostgreSQL and Firestore, so each dual write is ordered to fail safe:

- *Send*: the message is written to Firestore first; updating `chats.last_message_at` (used only to sort chat lists) is best effort and logged on failure. Failing the request there would make clients retry a message that is already stored.
- *Deleting an emptied group*: the SQL delete commits first, then Firestore data is purged best effort. A failure leaves unreachable documents, never a chat that exists without its access rules.

**Group membership changes are serialised.** Add / remove / rename lock the chat row (`SELECT … FOR UPDATE`), so the size cap and the "exactly one owner" invariant hold under concurrent requests. If the owner leaves, ownership passes to the longest-standing member; if the last member leaves, the chat is deleted.

**Deletes are soft.** Deleting a message scrubs its text and keeps a tombstone, so ordering, cursors and last-seen pointers that reference it stay valid.

**Operational basics.** Environment validated at boot; structured JSON logs with request ids (message text is redacted); helmet, body-size limit and rate limiting; statement and idle-transaction timeouts on the pool; liveness and readiness probes; graceful shutdown with a deadline; migrations guarded by an advisory lock so several instances can boot at once.

## Testing

```bash
npm test
```

- **API tests** drive the real Express app over HTTP (supertest) for every endpoint: happy paths, validation, authorisation, concurrency, pagination and tie-breaking.
- **PostgreSQL is real, not mocked.** By default the suite runs on [PGlite](https://pglite.dev) (PostgreSQL compiled to WASM, in-process), so `npm test` works on a clean machine. With `TEST_DATABASE_URL` set, the same suite runs against a real server through the production `pg` adapter.
- **MessageStore contract tests** ([tests/message-store.contract.ts](tests/message-store.contract.ts)) define the behaviour any message store must have. They always run against the in-memory store, and against **Firestore via the emulator** when `FIRESTORE_EMULATOR_HOST` is set (`npm run test:emulator`). This is what justifies using the in-memory store in the API tests.
- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck, lint, build, and the full suite against PostgreSQL 17 and the Firestore emulator.

## Assumptions and what I would do next

- **Authentication is out of scope**, as in the brief: the acting user is passed in the request (`senderId`, `userId`, `actorId`). In production this would be the subject of a verified Firebase ID token, read in one middleware; services already take the actor as an explicit argument, so nothing below the HTTP layer changes. For the same reason `GET /chat/:chatId/messages` cannot check membership yet, since the brief gives it no user.
- **Group size is capped at 100** because receipts live on the message document. For very large groups I would move receipts to a subcollection, or rely on last-seen watermarks alone.
- **Real-time delivery** (WebSocket / FCM push, or a Firestore listener behind a token-scoped rule) is the natural next feature; the write path would not change.
- **Stronger cross-store guarantees**: a transactional outbox in PostgreSQL with a small worker for `last_message_at` and for purging deleted chats, replacing today's best-effort calls.
- **Unread counts** per chat, derived from the last-seen watermark.
- **Hot-path caching**: membership checks are a primary-key lookup today; at scale they would sit behind a short-TTL cache invalidated on membership change.
