// Pure unit — N2's guard (design.md §11.2), BI17.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotCentsRuleAmount, CENTS_RULE_OPT_IN, findUnguardedCentsRuleLiterals } from './cents-rule-fixture-guard';

const SRC_ROOT = path.resolve(__dirname, '..');

describe('cents-rule-fixture-guard — BI17: refuses a fixture amount that would trigger the simulated cents rule unless the fixture opts in, and scans every billing integration spec for an un-opted-in amount ending in 99', () => {
  it('refuses a literal amount ending in 99 minor units', () => {
    expect(() => assertNotCentsRuleAmount(24_999, 'a literal fixture')).toThrow(/cents rule/);
  });

  it('the computed half bites: a fixture of 3 × 8_333 (24_999, computed) must fail', () => {
    const computedTotal = 3 * 8_333;
    expect(computedTotal).toBe(24_999);
    expect(() => assertNotCentsRuleAmount(computedTotal, 'three lines at 8_333')).toThrow(/cents rule/);
  });

  it('does not refuse an amount that does not end in 99', () => {
    expect(() => assertNotCentsRuleAmount(25_000, 'a fine amount')).not.toThrow();
    expect(() => assertNotCentsRuleAmount(0, 'zero')).not.toThrow();
  });

  it('allows the amount when the fixture opts in explicitly', () => {
    expect(() => assertNotCentsRuleAmount(24_999, 'the deliberate R42 fixture', CENTS_RULE_OPT_IN)).not.toThrow();
  });

  it('scans every billing integration spec for an un-opted-in amount ending in 99, and the one deliberate .99 fixture (credit-rejection-parity.integration.spec.ts) is opted in and so is not reported', () => {
    const unguarded = findUnguardedCentsRuleLiterals(SRC_ROOT);

    expect(unguarded).toEqual([]);
  });

  it('the text-scan half genuinely fires on an un-opted-in fixture — proven against a temporary fixture file, not asserted vacuously', () => {
    // A synthetic fixture directory the scanner is pointed at directly,
    // so this test does not depend on (and cannot be defeated by) any
    // change to the real integration specs.
    const fixtureRoot = path.join(__dirname, '__fixtures__', 'cents-rule-guard-non-vacuity');
    const unguarded = findUnguardedCentsRuleLiterals(fixtureRoot);

    expect(unguarded).toHaveLength(1);
    expect(unguarded[0]).toMatchObject({ value: 24_999 });
  });
});
