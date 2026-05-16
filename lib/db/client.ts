import { createClient } from '@libsql/client';

const url = process.env.TURSO_URL || 'file:./forge-local.db';
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

export const db = createClient({
  url,
  ...(authToken ? { authToken } : {}),
});
