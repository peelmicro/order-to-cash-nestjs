// Deterministic derivation helpers — the backbone of "re-running the seed
// changes nothing" (feature_list.json #12 acceptance: "idempotent:
// re-running changes nothing"). Every id, GLN and EAN this seed writes is a
// pure function of a stable string namespace, never `randomUUID()` /
// `Date.now()` — so two runs of `pnpm seed` against an empty database
// produce byte-identical rows.
import { createHash } from 'node:crypto';
import { GLN } from '@otc/shared-kernel';

/**
 * A UUID-**shaped** (RFC 4122 version 4 bit pattern), fully deterministic
 * identifier derived from `namespace` via SHA-256. Not a real random UUIDv4
 * — the version/variant nibbles are forced so the value satisfies
 * `UniqueId.from()`'s v4 shape check (shared-kernel/src/domain/unique-id.ts)
 * — but two calls with the same `namespace` always return the same string,
 * which is the property this seed depends on, not cryptographic randomness.
 */
export function deterministicId(namespace: string): string {
  const hex = createHash('sha256').update(`otc-seed:${namespace}`).digest('hex');
  const timeLow = hex.slice(0, 8);
  const timeMid = hex.slice(8, 12);
  const timeHiAndVersion = `4${hex.slice(13, 16)}`; // version nibble forced to 4
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  const clockSeqAndReserved = `${variantNibble}${hex.slice(17, 20)}`;
  const node = hex.slice(20, 32);
  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeqAndReserved}-${node}`.toLowerCase();
}

/**
 * A valid 13-digit GLN (domain-model.md §2.4) built from a small integer
 * sequence: a fixed 12-digit body (a GS1 prefix followed by the zero-padded
 * sequence) plus the genuine GS1 mod-10 check digit, computed by the same
 * `GLN.computeCheckDigit` the domain uses to validate one — never an
 * invented digit.
 */
export function makeGln(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999_999) {
    throw new Error(`makeGln: sequence out of range: ${sequence}`);
  }
  const body = String(540_000_000_000 + sequence);
  if (body.length !== 12) {
    throw new Error(`makeGln: computed body is not 12 digits: ${body}`);
  }
  const checkDigit = GLN.computeCheckDigit(body);
  const value = `${body}${checkDigit}`;
  // Fail loudly at seed time rather than write an invalid party identifier
  // (see progress/impl_seed_job.md — "the GLN check digits must be
  // genuinely valid").
  GLN.of(value);
  return value;
}

/**
 * A 13-digit EAN barcode with a genuine mod-10 (weights 1/3, rightmost
 * weight 1) check digit — cosmetic (the `products.ean` column carries no
 * domain validation), but a fabricated catalogue should not carry an
 * obviously-fake barcode either.
 */
export function makeEan13(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new Error(`makeEan13: sequence out of range: ${sequence}`);
  }
  const body = `590100${String(sequence).padStart(6, '0')}`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return `${body}${checkDigit}`;
}
