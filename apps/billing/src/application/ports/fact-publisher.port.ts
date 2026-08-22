// The relay's requirement of the outside world — design.md §5.3. Publishes
// already-assembled envelopes; knows nothing about MySQL, kafkajs or how
// the envelope was built. `key` is the Kafka partition key (R15,
// `correlationId`), separated from `envelope` so the adapter never has to
// reach back into the envelope to find it.
import type { Envelope } from '@otc/contracts';

export const FACT_PUBLISHER = Symbol('FactPublisher');

export interface PublishableFact {
  /** The partition key = correlationId (R15). */
  readonly key: string;
  /** The generated @otc/contracts envelope type — the wire shape. */
  readonly envelope: Envelope;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FactPublisher {
  /**
   * Resolves only when the broker has acknowledged every fact; rejects
   * otherwise. Never partially reports success (R14, OI8).
   */
  publish(facts: readonly PublishableFact[]): Promise<void>;
}
