import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { migrate } from './migrate.js';
import { createPgDb } from './pg.js';

const env = loadEnv();
const logger = createLogger(env);
const db = createPgDb({ connectionString: env.DATABASE_URL, max: 1, logger });

try {
  const applied = await migrate(db);
  logger.info({ applied }, applied.length ? 'migrations applied' : 'schema already up to date');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await db.close();
}
