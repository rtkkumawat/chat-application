/**
 * Every failure the API can report on purpose is an AppError carrying a stable,
 * machine-readable `code`. Clients branch on `code`; `message` is for humans.
 * Anything that is not an AppError is treated as a bug and surfaces as a 500
 * without leaking internals.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CURSOR'
  | 'USER_NOT_FOUND'
  | 'CHAT_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'MEMBER_NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'NOT_A_CHAT_MEMBER'
  | 'NOT_MESSAGE_SENDER'
  | 'INSUFFICIENT_ROLE'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'NOT_A_GROUP_CHAT'
  | 'GROUP_SIZE_LIMIT'
  | 'MESSAGE_DELETED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: ErrorCode, message: string, details?: unknown): AppError =>
  new AppError(400, code, message, details);
export const forbidden = (code: ErrorCode, message: string): AppError => new AppError(403, code, message);
export const notFound = (code: ErrorCode, message: string): AppError => new AppError(404, code, message);
export const conflict = (code: ErrorCode, message: string): AppError => new AppError(409, code, message);

/** Postgres SQLSTATE codes we handle explicitly. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export function isPgError(err: unknown, sqlState: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === sqlState;
}
