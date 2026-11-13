import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Keyset ("seek") pagination cursors.
 *
 * A cursor is the sort key of the last row the client saw: `(timestamp, id)`.
 * Unlike OFFSET, the cost of fetching a page does not grow with its depth, and
 * rows inserted while the client is paging never cause skips or duplicates.
 *
 * Cursors are opaque to clients (base64url JSON) so the encoding can change
 * without breaking the API contract.
 */
export interface Cursor {
  /** Epoch milliseconds of the sort timestamp. */
  ts: number;
  /** Tie-breaker: the row/document id. */
  id: string;
}

const cursorSchema = z.object({ ts: z.number().int().nonnegative(), id: z.string().min(1).max(128) });

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('INVALID_CURSOR', 'The pagination cursor is malformed');
  }
}
