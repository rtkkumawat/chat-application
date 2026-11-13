import { applicationDefault, cert, getApps, initializeApp, type AppOptions } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { Env } from '../config/env.js';

type FirebaseEnv = Pick<
  Env,
  'FIREBASE_PROJECT_ID' | 'FIRESTORE_EMULATOR_HOST' | 'FIREBASE_SERVICE_ACCOUNT_BASE64'
>;

/**
 * Credential resolution, in order:
 *  1. Emulator (FIRESTORE_EMULATOR_HOST): no credentials at all.
 *  2. FIREBASE_SERVICE_ACCOUNT_BASE64: inline service account, for platforms
 *     where mounting a key file is awkward.
 *  3. Application Default Credentials: GOOGLE_APPLICATION_CREDENTIALS locally,
 *     or the attached service account on GCP (the preferred production setup,
 *     since no key material has to be distributed).
 */
export function createFirestore(env: FirebaseEnv): Firestore {
  const options: AppOptions = {};
  if (env.FIREBASE_PROJECT_ID) options.projectId = env.FIREBASE_PROJECT_ID;

  if (!env.FIRESTORE_EMULATOR_HOST) {
    options.credential = env.FIREBASE_SERVICE_ACCOUNT_BASE64
      ? cert(JSON.parse(Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')) as object)
      : applicationDefault();
  }

  const app = getApps()[0] ?? initializeApp(options);
  return getFirestore(app);
}
