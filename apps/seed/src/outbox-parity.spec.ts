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

/** Normalises whitespace (runs collapsed to one space, trimmed) so formatting differences never register as drift. Identifier quoting is already uniform (backticks) across every committed migration, so no further normalisation is needed there. */
function normalise(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim();
}

/** Every normalised statement, across every committed migration of one app, that mentions `outbox` or `processed_events`. */
function outboxAndProcessedEventsStatements(app: string): string[] {
  const statements: string[] = [];
  for (const file of migrationFiles(app)) {
    const content = readFileSync(file, 'utf8');
    for (const statement of splitStatements(content)) {
      if (/\boutbox\b|\bprocessed_events\b/.test(statement)) {
        statements.push(normalise(statement));
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
