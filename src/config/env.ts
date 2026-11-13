import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(600),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

    MESSAGE_STORE: z.enum(['firestore', 'memory']).default('firestore'),
    FIREBASE_PROJECT_ID: z.string().min(1).optional(),
    FIRESTORE_EMULATOR_HOST: z.string().min(1).optional(),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
    FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MESSAGE_STORE === 'memory' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['MESSAGE_STORE'],
        message: 'the in-memory message store must not be used in production',
      });
    }
    if (env.MESSAGE_STORE === 'firestore' && env.FIRESTORE_EMULATOR_HOST && !env.FIREBASE_PROJECT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_PROJECT_ID'],
        message: 'FIREBASE_PROJECT_ID is required when using the Firestore emulator',
      });
    }
  });

export type Env = z.infer<typeof schema>;

/**
 * Parses and validates process.env once, at boot. A misconfigured process should
 * fail immediately with a readable message rather than at the first request.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
