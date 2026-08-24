// COPY OF — apps/orders/src/infrastructure/messaging/idempotent-consumer.ts
//
// Divergence: this is NOT a copy of the canonical MySQL pattern (§6.3) — it
// is a reference "documented variant" used only by
// `idempotent-consumer.parity.spec.ts` to prove
// `idempotent-consumer-conformance.ts`'s suite is genuinely behavioural and
// non-vacuous, without requiring Docker in the fast `pnpm quality` gate.
// Its backing store is a JSON file on disk instead of a MySQL table or a
// MongoDB collection — deliberately a REAL, durable store (not an
// in-memory Map): a fresh instance re-reads the file, so it exhibits the
// same "durable across restart" property a real variant (e.g. the
// projector's MongoDB ledger, feature 24) must have, and fails the
// conformance suite's case 3 if that property is ever broken. It is not
// itself a production pattern to copy; a real variant is free to look
// nothing like this file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class FileBackedIdempotentConsumer {
  constructor(private readonly storeFile: string) {
    const dir = path.dirname(storeFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(storeFile)) {
      writeFileSync(storeFile, JSON.stringify([]));
    }
  }

  private readKeys(): string[] {
    return JSON.parse(readFileSync(this.storeFile, 'utf8')) as string[];
  }

  private writeKeys(keys: string[]): void {
    writeFileSync(this.storeFile, JSON.stringify(keys));
  }

  /**
   * Insert-first, same discipline as the canonical (design.md §6.1): the
   * key is recorded BEFORE `work` runs, so a redelivery observed after a
   * crash mid-`work` still reports `duplicate` on retry rather than
   * re-running an already-attempted side effect.
   */
  async runOnce(eventId: string, consumer: string, work: () => Promise<void>): Promise<'processed' | 'duplicate'> {
    const key = `${eventId}::${consumer}`;
    const keys = this.readKeys();
    if (keys.includes(key)) {
      return 'duplicate';
    }
    this.writeKeys([...keys, key]);
    await work();
    return 'processed';
  }
}
