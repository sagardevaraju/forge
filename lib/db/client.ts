/**
 * libSQL client + Task P3.7 WORM (write-once, read-many) guard.
 *
 * The `db` export is the same `@libsql/client` Client every existing call
 * site uses — but its `execute` and `batch` methods are wrapped so SQL that
 * would violate WORM on the audit tables (`decisions`, `chat_audit`) throws
 * `WormViolationError` before it ever reaches libSQL.
 *
 * WORM scope (column-level on `decisions`, blanket on `chat_audit`):
 *
 *   • `decisions` — INSERT + SELECT pass. UPDATE is allowed ONLY on the
 *     lifecycle columns: `notices_sent_at`, `executed_at`, `reversed_at`,
 *     `reversed_by`. Any UPDATE touching `id`, `solve_ts`, `operator`,
 *     `inputs_hash`, `inputs_json`, `outputs_hash`, or `outputs_json`
 *     throws. DELETE always throws.
 *
 *   • `chat_audit` — INSERT + SELECT pass. UPDATE and DELETE always throw.
 *
 *   • Out-of-WORM tables (policies, simulations, pins, claims_history,
 *     adjusters, staging_zones, storm_events, anything else) pass through
 *     unmodified.
 *
 * Bypass:
 *   `unsafeExecute(sql)` is the documented escape hatch for migration
 *   scripts and test teardown. Production code MUST use `db.execute` so
 *   the WORM guard applies — `unsafeExecute` is a privileged call you
 *   only reach for when wiping a test DB or applying schema migrations.
 *
 * Why app-layer, not SQL trigger:
 *   SQLite/libSQL doesn't ship row-level WORM, and triggers would still
 *   be re-bypassable by a direct DB connection. App-layer is defense in
 *   depth — the bigger guarantee comes from running the whole DB behind
 *   an S3 Object Lock backup tier (P3.X follow-up). This code stops the
 *   accidental UPDATE / DELETE that an over-eager script could otherwise
 *   issue.
 *
 * Trade-off accepted:
 *   The guard is a regex/string parser, not a real SQL grammar. It
 *   handles every shape the codebase emits today (single-statement
 *   INSERTs and the four-column lifecycle UPDATEs) plus the common
 *   adversary shapes (quoted identifiers, case variants, COALESCE
 *   expressions, multi-column SETs). Exotic SQL — CTEs that wrap an
 *   UPDATE, semicolon-stacked statements, `;` inside a string literal —
 *   would slip past. The guard's job is preventing accidents, not
 *   defending against a determined operator with DB access.
 */
import { createClient, type Client, type InStatement } from '@libsql/client';

const url = process.env.TURSO_URL || 'file:./forge-local.db';
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const rawDb: Client = createClient({
  url,
  ...(authToken ? { authToken } : {}),
});

// ────────────────────────────────────────────────────────────────────────
// WORM policy.
// ────────────────────────────────────────────────────────────────────────

/**
 * Per-table allowlist of columns that may legitimately mutate after
 * INSERT. Empty set = strictly append-only (chat_audit).
 */
const WORM_COLUMN_POLICY: Record<string, ReadonlySet<string>> = {
  decisions: new Set(['notices_sent_at', 'executed_at', 'reversed_at', 'reversed_by']),
  chat_audit: new Set<string>(),
};

const WORM_TABLES: ReadonlySet<string> = new Set(Object.keys(WORM_COLUMN_POLICY));

export class WormViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WormViolationError';
  }
}

/**
 * Strip a single layer of backticks or double-quotes from an identifier,
 * then lower-case. SQLite/libSQL treat both as quoted identifiers.
 */
function normalizeIdent(raw: string): string {
  const trimmed = raw.trim();
  const m =
    /^(`)([^`]+)`$/.exec(trimmed) ||
    /^(")([^"]+)"$/.exec(trimmed);
  if (m) return m[2].toLowerCase();
  return trimmed.toLowerCase();
}

/**
 * Split a SET clause on top-level commas (commas inside parens stay with
 * their expression). Returns the column names on the LHS of each
 * assignment.
 *
 * Example: `notices_sent_at = COALESCE(?, notices_sent_at), executed_at = ?`
 *          → ['notices_sent_at', 'executed_at']
 */
function parseSetColumns(setClause: string): string[] {
  const cols: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= setClause.length; i++) {
    const c = setClause[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ',' && depth === 0) || i === setClause.length) {
      const part = setClause.slice(start, i).trim();
      const eq = part.indexOf('=');
      if (eq > 0) cols.push(normalizeIdent(part.slice(0, eq)));
      start = i + 1;
    }
  }
  return cols;
}

/**
 * Inspect a SQL statement and throw `WormViolationError` if it would
 * violate WORM on `decisions` or `chat_audit`.
 *
 * Allowed:
 *   - SELECT, INSERT (anywhere)
 *   - UPDATE on out-of-WORM tables
 *   - UPDATE on `decisions` if SET touches ONLY lifecycle columns
 *
 * Blocked:
 *   - UPDATE on `chat_audit` (any column)
 *   - UPDATE on `decisions` touching any content column
 *   - DELETE on `decisions` or `chat_audit`
 */
export function assertWormSafe(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) return;

  // DELETE FROM <table>
  const deleteMatch = /^DELETE\s+FROM\s+([`"]?)(\w+)\1/i.exec(trimmed);
  if (deleteMatch) {
    const table = deleteMatch[2].toLowerCase();
    if (WORM_TABLES.has(table)) {
      throw new WormViolationError(
        `DELETE on ${table} is forbidden — P3.7 WORM. Use unsafeExecute only for migrations / test teardown.`,
      );
    }
    return;
  }

  // UPDATE <table> SET <set-clause> [WHERE …]
  // Capture the SET clause up to WHERE / RETURNING / end-of-statement.
  const updateMatch =
    /^UPDATE\s+([`"]?)(\w+)\1\s+SET\s+([\s\S]+?)(?:\s+WHERE\b[\s\S]*|\s+RETURNING\b[\s\S]*|;?\s*$)/i.exec(
      trimmed,
    );
  if (updateMatch) {
    const table = updateMatch[2].toLowerCase();
    if (!WORM_TABLES.has(table)) return;
    const setClause = updateMatch[3];
    const cols = parseSetColumns(setClause);
    if (cols.length === 0) {
      // We can't see what's being updated — refuse rather than guess.
      throw new WormViolationError(
        `UPDATE on ${table} with unparseable SET clause is refused — P3.7 WORM.`,
      );
    }
    const allowed = WORM_COLUMN_POLICY[table];
    for (const col of cols) {
      if (!allowed.has(col)) {
        const mutable = [...allowed].join(', ') || '(none)';
        throw new WormViolationError(
          `UPDATE on ${table}.${col} is forbidden — P3.7 WORM. Mutable columns on ${table}: ${mutable}.`,
        );
      }
    }
    return;
  }

  // SELECT / INSERT / CREATE / etc. — pass through.
}

// ────────────────────────────────────────────────────────────────────────
// Wrapped client.
// ────────────────────────────────────────────────────────────────────────

function sqlOf(stmt: InStatement | string): string {
  return typeof stmt === 'string' ? stmt : stmt.sql;
}

/**
 * The exported `db`. Same shape as the libsql Client, with `execute` and
 * `batch` wrapped to enforce WORM on every statement.
 */
export const db: Client = new Proxy(rawDb, {
  get(target, prop, receiver) {
    if (prop === 'execute') {
      return async (stmt: InStatement | string) => {
        assertWormSafe(sqlOf(stmt));
        return target.execute(stmt as InStatement);
      };
    }
    if (prop === 'batch') {
      return async (
        stmts: Array<InStatement | string>,
        mode?: Parameters<Client['batch']>[1],
      ) => {
        for (const s of stmts) {
          assertWormSafe(sqlOf(s));
        }
        return target.batch(stmts as InStatement[], mode);
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});

/**
 * Bypass the WORM guard.
 *
 * ONLY for:
 *   - Migration scripts (`npm run migrate` via `lib/db/migrate.ts`)
 *   - Test teardown (`beforeEach`/`afterEach` resetting WORM tables)
 *   - Privileged maintenance scripts
 *
 * Production code paths MUST use `db.execute` so the WORM guard applies.
 * The loud name is the contract: every call site should be obviously
 * privileged on inspection.
 */
export const unsafeExecute = rawDb.execute.bind(rawDb);
