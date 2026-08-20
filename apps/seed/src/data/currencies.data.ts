// The three seeded currencies (feature_list.json #12 acceptance: "3
// currencies"). Matches domain-model.md §2.1 / §7.2 — ISO 4217 alpha-3
// codes, and the decimal-places metadata used only for *rendering*, never
// for arithmetic (which stays integer minor units everywhere).
import { deterministicId } from '../deterministic';

export interface CurrencySeed {
  id: string;
  code: string;
  isoNumber: string;
  symbol: string;
  decimalPoints: number;
}

export const CURRENCIES: readonly CurrencySeed[] = [
  {
    id: deterministicId('currency:USD'),
    code: 'USD',
    isoNumber: '840',
    symbol: '$',
    decimalPoints: 2,
  },
  {
    id: deterministicId('currency:EUR'),
    code: 'EUR',
    isoNumber: '978',
    symbol: '€',
    decimalPoints: 2,
  },
  {
    id: deterministicId('currency:GBP'),
    code: 'GBP',
    isoNumber: '826',
    symbol: '£',
    decimalPoints: 2,
  },
] as const;

export function currencyIdByCode(code: string): string {
  const found = CURRENCIES.find((currency) => currency.code === code);
  if (!found) {
    throw new Error(`currencyIdByCode: unknown currency code "${code}"`);
  }
  return found.id;
}
