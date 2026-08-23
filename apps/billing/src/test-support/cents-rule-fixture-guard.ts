// N2 (`review_billing_credit_simulator.md`) — every Billing test fixture is
// silently subject to the simulated `.99` cents rule (R42) wherever its
// amount reaches the credit-decision port. Design.md §11.2: BOTH halves,
// with the COMPUTED half load-bearing — an invoicing fixture's
// credit-relevant amount is usually COMPUTED, not written (a fixture of
// three lines at `8_333` minor units totals `24_999`, which ends in 99 and
// which no scan of literals would ever see).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const CENTS_RULE_OPT_IN = 'cents-rule-intentional';

/**
 * Throws unless `minorUnits % 100 !== 99` or the caller opts in
 * explicitly. Called by every harness builder whose amount can reach the
 * credit-decision port — `holdRequest(...)`, `issueRequest(...)`,
 * `seedCreditItem(...)` — on the COMPUTED total, so `3 × 8_333` fails
 * loudly at the moment the fixture is built.
 */
export function assertNotCentsRuleAmount(minorUnits: number, context: string, optIn?: typeof CENTS_RULE_OPT_IN): void {
  if (optIn === CENTS_RULE_OPT_IN) {
    return;
  }
  if (minorUnits % 100 === 99) {
    throw new Error(
      `cents-rule-fixture-guard: this amount triggers the simulated cents rule (R42) — pass CENTS_RULE_OPT_IN if that is the point of the test. context: "${context}", amount: ${minorUnits}`,
    );
  }
}

export interface UnguardedCentsRuleLiteral {
  readonly file: string;
  readonly line: number;
  readonly value: number;
}

// "Money positions" — the object-literal keys this codebase actually
// writes a minor-units amount under, across every integration spec in this
// service (credit AND invoice fixtures alike). A key: value regex, not a
// bare-number scan, so a business reference embedded in a string
// (`'INV-000099'`), an unrelated numeric argument
// (`OrderNumber.fromSequence(999_999)`), a date string
// (`'2099-01-01T...'`) or prose in a comment ("ends in 99 minor units")
// are never false positives — none of them is `<moneyKey>: <digits>`.
const MONEY_KEYS = [
  'amount',
  'unitPrice',
  'totalAmount',
  'discount',
  'requestedAmount',
  'availableCredit',
  'creditLimit',
  'heldAmount',
  'releasedAmount',
  'price',
  'initialAmount',
  'initialDiscount',
  'activeHold',
  'activeHolds',
  'exposure',
  'openExposure',
] as const;

const MONEY_POSITION_LITERAL = new RegExp(`\\b(?:${MONEY_KEYS.join('|')})\\s*:\\s*(\\d[\\d_]*)\\b`, 'g');

/** Cuts a line at its first `//` — good enough for this codebase's style (no `//` inside a string literal on a money-fixture line anywhere in these files). Run BEFORE the money-position regex so prose like "ends in 99 minor units" is never matched. */
function stripLineComment(line: string): string {
  const index = line.indexOf('//');
  return index === -1 ? line : line.slice(0, index);
}

function collectIntegrationSpecFiles(sourceRoot: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        // `__fixtures__` holds `cents-rule-fixture-guard.spec.ts`'s own
        // non-vacuity fixture — a deliberately un-opted-in `.99` literal
        // that must never pollute the real "every billing integration
        // spec" scan.
        if (entry === 'node_modules' || entry === '__fixtures__') {
          continue;
        }
        walk(absolutePath);
        continue;
      }
      if (entry.endsWith('.integration.spec.ts')) {
        files.push(absolutePath);
      }
    }
  }

  walk(sourceRoot);
  return files;
}

/**
 * The BACKSTOP: scans `apps/billing/src/**\/*.integration.spec.ts` for
 * integer literals (including this codebase's `1_000`-style
 * digit-separated form) that satisfy `value mod 100 === 99`, and reports
 * every one that is NOT marked `// cents-rule-intentional` on the same
 * line — catching a payload assembled by hand that never reaches a
 * harness builder.
 */
export function findUnguardedCentsRuleLiterals(sourceRoot: string): UnguardedCentsRuleLiteral[] {
  const results: UnguardedCentsRuleLiteral[] = [];

  for (const file of collectIntegrationSpecFiles(sourceRoot)) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (line.includes(CENTS_RULE_OPT_IN)) {
        return;
      }
      const codeOnly = stripLineComment(line);
      for (const match of codeOnly.matchAll(MONEY_POSITION_LITERAL)) {
        const raw = match[1]!;
        const value = Number(raw.replace(/_/g, ''));
        if (Number.isFinite(value) && value % 100 === 99) {
          results.push({ file, line: index + 1, value });
        }
      }
    });
  }

  return results;
}
