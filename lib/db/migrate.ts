import { db } from './client';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strip `-- ...` line comments and outer whitespace from a SQL statement. */
function stripComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

export async function migrate() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  const stmts = schema
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    // schema.sql is split on raw ';', which can produce comment-only
    // fragments when an inline comment contains a semicolon. Skip any
    // statement that's pure comments after stripping. This also lets future
    // schema edits add ALTER/CREATE statements without worrying about
    // semicolons inside `-- ...` documentation.
    const code = stripComments(stmt);
    if (!code) continue;
    try {
      await db.execute(code);
    } catch (e: unknown) {
      // Task P2.39: ALTER TABLE ADD COLUMN is how we ship additive
      // migrations. SQLite errors with "duplicate column name" once the
      // column exists, so re-running migrate on an already-migrated DB
      // would explode without this tolerance. Any OTHER ALTER error
      // still propagates.
      const haystack: string[] = [];
      const visit = (x: unknown) => {
        if (!x || typeof x !== 'object') return;
        const o = x as Record<string, unknown>;
        if (typeof o.message === 'string') haystack.push(o.message);
        if (typeof o.code === 'string') haystack.push(o.code);
        if (o.cause) visit(o.cause);
      };
      visit(e);
      const joined = haystack.join(' | ');
      const isAlter = code.toUpperCase().startsWith('ALTER TABLE');
      const isDuplicateColumn = /duplicate column name/i.test(joined);
      if (!(isAlter && isDuplicateColumn)) {
        throw e;
      }
    }
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
