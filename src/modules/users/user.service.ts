import type { Db } from '../../db/db.js';
import { conflict, isPgError, notFound, PG_UNIQUE_VIOLATION } from '../../lib/errors.js';
import { UserRepository, type User } from './user.repository.js';

export class UserService {
  private readonly users: UserRepository;

  constructor(db: Db) {
    this.users = new UserRepository(db);
  }

  async create(input: { displayName: string; email: string }): Promise<User> {
    try {
      return await this.users.create(input);
    } catch (err) {
      // Let the unique index be the arbiter instead of check-then-insert, which races.
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw conflict('EMAIL_ALREADY_REGISTERED', 'A user with this email already exists');
      }
      throw err;
    }
  }

  async getById(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw notFound('USER_NOT_FOUND', `User ${id} does not exist`);
    return user;
  }
}
