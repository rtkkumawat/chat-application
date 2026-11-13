import { conflict, forbidden, notFound, type AppError } from '../../lib/errors.js';

export const messageNotFound = (messageId: string): AppError =>
  notFound('MESSAGE_NOT_FOUND', `Message ${messageId} does not exist in this chat`);

export const notMessageSender = (): AppError =>
  forbidden('NOT_MESSAGE_SENDER', 'Only the sender can modify this message');

export const messageDeleted = (): AppError => conflict('MESSAGE_DELETED', 'A deleted message cannot be edited');
