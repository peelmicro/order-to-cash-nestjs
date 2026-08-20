// Fixed, past UTC instants — CLAUDE.md "Dates: UTC everywhere" plus this
// feature's "deterministic" acceptance criterion: every timestamp this seed
// writes is computed from SEED_EPOCH, never `new Date()`, so two runs
// produce byte-identical datetimes.
//
// Today (see the session that authored this file) is 2026-08-20; every
// instant below is comfortably in the past.
export const SEED_EPOCH = new Date('2026-06-01T09:00:00.000Z');

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
