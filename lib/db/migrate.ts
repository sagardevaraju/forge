import { db } from './client';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function migrate() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  const stmts = schema
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    await db.execute(stmt);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  migrate()
    .then(() => {
      console.log('Migration complete');
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
