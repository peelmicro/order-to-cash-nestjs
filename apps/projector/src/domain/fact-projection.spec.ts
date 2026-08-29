// PR2 › covers exactly the thirteen eventTypes read as text from
// domain-model.md §7.2, and fails when the catalogue and the handler table
// disagree in either direction (both directions, non-vacuity proven against
// a temporary extra entry).
// PR14 unit half › never reads a clock — the delta's timestamps come from
// the envelope's own occurredAt alone.
// PR28 › builds a store-agnostic ProjectionDelta with no framework, driver
// or clock import anywhere under domain/.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_FACT_ENVELOPE_BUILDERS } from '../test-support/envelope-fixtures';
import { HANDLED_EVENT_TYPES, projectFact, UnknownFactTypeError } from './fact-projection';

const DOMAIN_MODEL_PATH = path.resolve(__dirname, '../../../../specs/shared/domain-model.md');

/** Reads the thirteen `eventType`s out of domain-model.md §7.2's table, as TEXT — no Markdown parser, same discipline as kafka.config.spec.ts. */
function eventTypesFromDomainModel(): string[] {
  const text = readFileSync(DOMAIN_MODEL_PATH, 'utf8');
  const section = text.match(/### 7\.2 The fourteen facts\n([\s\S]*?)\n> \*\*Fact, not command/);
  if (!section) {
    throw new Error('fact-projection.spec: could not locate domain-model.md §7.2\'s table');
  }
  const rows = section[1]!.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  const types = rows.map((row) => {
    const cell = row.split('|')[2]!.trim();
    const match = cell.match(/`([a-z._]+\.v\d+)`/);
    if (!match) {
      throw new Error(`fact-projection.spec: could not parse eventType out of row: ${row}`);
    }
    return match[1]!;
  });
  return types;
}

describe('fact-projection — PR2 › structural coverage of the fourteen facts', () => {
  const catalogueTypes = eventTypesFromDomainModel();
  const handledTypes: string[] = [...HANDLED_EVENT_TYPES];

  it('domain-model.md §7.2 genuinely lists fourteen facts (non-vacuity of the text-scan itself)', () => {
    expect(catalogueTypes).toHaveLength(14);
  });

  it('the handler table covers exactly the fourteen eventTypes the shared catalogue declares', () => {
    expect([...handledTypes].sort()).toEqual([...catalogueTypes].sort());
  });

  it('fails when the catalogue has an eventType the handler table does not (catalogue -> table direction)', () => {
    const catalogueWithExtra = [...catalogueTypes, 'stock.teleported.v1'];
    expect(catalogueWithExtra.some((type) => !handledTypes.includes(type))).toBe(true);
  });

  it('fails when the handler table has an eventType the catalogue does not (table -> catalogue direction)', () => {
    const handledWithExtra = [...handledTypes, 'stock.teleported.v1'];
    expect(handledWithExtra.some((type) => !catalogueTypes.includes(type))).toBe(true);
  });

  it.each(handledTypes)('%s: projectFact succeeds (no UnknownFactTypeError) for a handled type', (eventType) => {
    const envelope = ALL_FACT_ENVELOPE_BUILDERS[eventType]!();
    expect(() => projectFact(envelope)).not.toThrow();
  });

  it('throws UnknownFactTypeError for an eventType outside the fourteen', () => {
    const envelope = ALL_FACT_ENVELOPE_BUILDERS['order.placed.v1']!({ eventType: 'stock.teleported.v1' });
    expect(() => projectFact(envelope)).toThrow(UnknownFactTypeError);
  });
});

describe('fact-projection — PR14 unit half › never reads a clock, timestamps come from occurredAt alone', () => {
  it.each(Object.entries(ALL_FACT_ENVELOPE_BUILDERS))('%s: entry.occurredAt equals the envelope\'s own occurredAt, not the wall clock', (_type, build) => {
    const occurredAt = '2020-01-01T00:00:00.000Z'; // deliberately far from "now"
    const envelope = build({ occurredAt });
    const delta = projectFact(envelope);
    expect(delta.entry.occurredAt).toBe(occurredAt);
  });
});

describe('fact-projection — PR30 (A1) › the entry carries the envelope\'s causationId verbatim, and no eventType-derived ordering key', () => {
  it.each(Object.entries(ALL_FACT_ENVELOPE_BUILDERS))('%s: entry.causationId equals the envelope\'s own causationId', (_type, build) => {
    const envelope = build({ causationId: 'a-deliberately-distinctive-causation-id' });
    const delta = projectFact(envelope);
    expect(delta.entry.causationId).toBe('a-deliberately-distinctive-causation-id');
  });

  it.each(Object.entries(ALL_FACT_ENVELOPE_BUILDERS))('%s: no timeline entry carries statusRank or any other eventType-derived ordering key', (_type, build) => {
    const delta = projectFact(build());
    expect(delta.entry).not.toHaveProperty('statusRank');
    // The ONLY ordering-relevant fields on an entry are occurredAt (already
    // asserted), eventId and causationId — a literal, recorded edge, never
    // a derived rank (PR10's own final sentence).
    expect(Object.keys(delta.entry).sort()).toEqual(
      ['causationId', 'detail', 'eventId', 'eventType', 'occurredAt', 'summary'].filter(
        (key) => key !== 'detail' || 'detail' in delta.entry,
      ),
    );
  });
});

describe('fact-projection — PR28 › no framework, driver or clock import anywhere under domain/', () => {
  const DOMAIN_DIR = path.resolve(__dirname, '.');
  const FORBIDDEN = [/@nestjs\//, /drizzle-orm/, /kafkajs/, /['"]nats['"]/, /['"]mongodb['"]/, /new Date\(\)/, /Date\.now\(\)/];

  it('no domain/ source file imports a framework, a driver, or reads the wall clock', () => {
    const files = readdirSync(DOMAIN_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const content = readFileSync(path.join(DOMAIN_DIR, file), 'utf8');
      for (const pattern of FORBIDDEN) {
        expect(content, `${file} matches forbidden pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
