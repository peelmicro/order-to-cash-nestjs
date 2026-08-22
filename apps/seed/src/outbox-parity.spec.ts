// OI11 — the byte-identity guard for the `outbox` / `processed_events`
// shape across the three write models. Reads every committed
// `apps/{orders,fulfillment,billing}/drizzle/*.sql` file, keeps only the
// statements that mention `outbox` or `processed_events`, normalises
// whitespace and identifier quoting, and asserts the three resulting
// statement sets are equal (design.md §3.4). Pure text, no Docker — this is
// what replaces the manual six-way diff `progress/review_db_billing.md` §3
// did by hand, and it is exactly what makes the coordinated migration of
// `outbox_and_idempotency` (feature 14) safe to land in all three databases
// at once.
//
// `apps/seed` is the right home: it is the one package that legitimately
// spans all three databases (design.md §3.4), and this test is pure text so
// it runs inside `pnpm quality`.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APPS_WITH_OUTBOX = ['orders', 'fulfillment', 'billing'] as const;

/** Every committed `*.sql` migration file for one app, in filename (= applied) order. */
function migrationFiles(app: string): string[] {
  const dir = path.join(REPO_ROOT, 'apps', app, 'drizzle');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Splits a migration file's content into individual SQL statements — drizzle-kit's own statement separator. */
function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Strips SQL comment text — block comments (`/* … *\/`) first, then
 * line comments (`-- …` to end of line) — so a migration's PROSE can never
 * be constrained by, nor accidentally satisfy, this guard (`N1`, `BC18`).
 * Without this, `outboxAndProcessedEventsStatements` matched its
 * `outbox|processed_events` regex against the RAW statement text, so a
 * `--` comment merely mentioning either table turned a comment-only chunk
 * into a compared "statement" — which is why migration `0002`'s header had
 * to call the outbox "the fact-relay table" to avoid self-triggering.
 */
function stripSqlComments(statement: string): string {
  return statement.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/** Normalises whitespace (runs collapsed to one space, trimmed) so formatting differences never register as drift. Identifier quoting is already uniform (backticks) across every committed migration, so no further normalisation is needed there. Comments are stripped FIRST (`stripSqlComments`) so only executable SQL is ever compared. */
function normalise(statement: string): string {
  return stripSqlComments(statement).replace(/\s+/g, ' ').trim();
}

/** Every normalised, EXECUTABLE statement (comments stripped, `N1`/`BC18`), across every committed migration of one app, that mentions `outbox` or `processed_events`. A statement that normalises to empty (comment-only) contributes nothing. */
function outboxAndProcessedEventsStatements(app: string): string[] {
  const statements: string[] = [];
  for (const file of migrationFiles(app)) {
    const content = readFileSync(file, 'utf8');
    for (const statement of splitStatements(content)) {
      const executable = normalise(statement);
      if (executable.length > 0 && /\boutbox\b|\bprocessed_events\b/.test(executable)) {
        statements.push(executable);
      }
    }
  }
  return statements;
}

describe('outbox-parity — OI11: outbox and processed_events definitions stay identical in all three write models', () => {
  it('defines outbox and processed_events identically in the three committed migration sets', () => {
    const [orders, fulfillment, billing] = APPS_WITH_OUTBOX.map(outboxAndProcessedEventsStatements);

    // Non-vacuity: every app's committed migrations actually mention the
    // two tables (a passing-because-empty comparison would prove nothing).
    expect(orders.length).toBeGreaterThan(0);
    expect(fulfillment.length).toBeGreaterThan(0);
    expect(billing.length).toBeGreaterThan(0);

    expect(fulfillment).toEqual(orders);
    expect(billing).toEqual(orders);
  });
});

describe('outbox-parity — BC18: ignores SQL comment text when comparing the three write models\' outbox and processed_events definitions', () => {
  it('a fixture statement that is ONLY a comment mentioning "outbox" contributes nothing', () => {
    const commentOnlyLineComment = '-- this table is the outbox for facts';
    const commentOnlyBlockComment = '/* processed_events lives here too */';
    const realStatement = 'CREATE TABLE `outbox` (`id` char(36) NOT NULL);';

    expect(normalise(commentOnlyLineComment)).toBe('');
    expect(normalise(commentOnlyBlockComment)).toBe('');
    expect(normalise(realStatement)).not.toBe('');
  });

  it('strips a trailing line comment from an otherwise-real statement without losing the statement itself', () => {
    const statementWithTrailingComment = 'CREATE TABLE `outbox` (`id` char(36) NOT NULL); -- the fact-relay table';

    expect(normalise(statementWithTrailingComment)).toBe('CREATE TABLE `outbox` (`id` char(36) NOT NULL);');
  });
});
