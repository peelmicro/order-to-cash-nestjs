// PR5 › subscribes from the beginning of every fact topic so the read
// model is reconstructible by replay — deliberately the OPPOSITE of
// Notifications' `fromBeginning: false`. Pure text scan over main.ts, same
// discipline every structural guard in this codebase uses.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_TS_PATH = path.resolve(__dirname, 'main.ts');

describe('main-kafka-options — PR5', () => {
  it('subscribes fromBeginning: true (never false) — the read model is a derived store rebuilt by replay', () => {
    const mainTs = readFileSync(MAIN_TS_PATH, 'utf8');

    expect(mainTs).toMatch(/fromBeginning:\s*true/);
    expect(mainTs).not.toMatch(/fromBeginning:\s*false/);
  });

  it('runs ensureReadModelIndexes and backfillLegacyDocuments BEFORE startAllMicroservices (design.md §11)', () => {
    const mainTs = readFileSync(MAIN_TS_PATH, 'utf8');

    const indexesCall = mainTs.indexOf('ensureReadModelIndexes(');
    const backfillCall = mainTs.indexOf('backfillLegacyDocuments(');
    const startAllMicroservicesCall = mainTs.indexOf('startAllMicroservices(');

    expect(indexesCall).toBeGreaterThan(-1);
    expect(backfillCall).toBeGreaterThan(-1);
    expect(startAllMicroservicesCall).toBeGreaterThan(-1);
    expect(indexesCall).toBeLessThan(startAllMicroservicesCall);
    expect(backfillCall).toBeLessThan(startAllMicroservicesCall);
  });

  it('connects Kafka under the projector consumer group', () => {
    const mainTs = readFileSync(MAIN_TS_PATH, 'utf8');
    expect(mainTs).toMatch(/groupId:\s*kafkaConfig\.groupId/);
  });
});
