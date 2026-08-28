import type { OrderStreamUpdate, StreamReady, TimelineStreamEntry } from '#shared/types/gateway';

export type StreamConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'gave-up';

/** The minimal shape this client needs from `EventSource` — real `window.EventSource` and the `eventsource` npm package (used in tests, over a real local HTTP server) both satisfy it exactly. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  readonly readyState: number;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface OrderStreamCallbacks {
  onOrderUpdated: (update: OrderStreamUpdate) => void;
  onTimelineAppended: (entry: TimelineStreamEntry) => void;
  /** `stream.ready` answered `resumed: false` — the replay buffer aged out. openapi.yaml is explicit: the stream is a notification channel, not the source of truth, so the honest response is to re-fetch, never to keep showing possibly-stale data. */
  onResync: () => void;
  onStatusChange: (status: StreamConnectionStatus) => void;
}

const READY_STATE_CLOSED = 2;

/** After this many consecutive `error` events with no successful frame in between, stop treating this as "still trying" and surface `gave-up` — a genuine, visible connection-status distinct from an indefinitely silent "connecting…". A caller can still invoke `connect()` again to retry by hand. */
const DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_ERRORS = 6;

/**
 * The client-side half of `GET /orders/stream` (R55): connects, applies
 * `order.updated`/`timeline.appended` frames, deduplicates on `eventId`
 * (R51 — delivery is at-least-once, so a redelivered frame must never
 * reach the caller's handlers twice), and reacts honestly to the two
 * reconnection outcomes the contract documents (`resumed: true` needs no
 * special handling — the missed frames simply arrive and flow through the
 * same handlers; `resumed: false` triggers `onResync`).
 *
 * Framework-free by design (no Vue import) so it is testable directly
 * against a real `EventSource`-shaped transport, in or out of a component —
 * `useOrderStream` (the Vue composable) is a thin reactive wrapper around
 * exactly this class, nothing more.
 */
export class OrderStreamClient {
  private source: EventSourceLike | null = null;
  private consecutiveErrors = 0;
  // Dedup is scoped PER frame type, not shared. The projector deliberately
  // stamps the SAME eventId onto both the `order.updated` and
  // `timeline.appended` payloads it emits for a single fact (see
  // apps/projector/src/infrastructure/signal/nats-update-signal.publisher.ts) —
  // that is correct and intentional (openapi.yaml documents eventId as "the
  // fact that caused the update"), but it means a shared Set would treat the
  // second frame type to arrive for a fact as a duplicate of the first,
  // silently dropping genuinely new information. R51's dedup exists to catch
  // REDELIVERY of the same frame type, never a same-eventId sighting across
  // two different event types.
  private readonly seenOrderUpdateIds = new Set<string>();
  private readonly seenTimelineEntryIds = new Set<string>();

  constructor(
    private readonly url: string,
    private readonly callbacks: OrderStreamCallbacks,
    private readonly factory: EventSourceFactory,
    private readonly giveUpAfterConsecutiveErrors: number = DEFAULT_GIVE_UP_AFTER_CONSECUTIVE_ERRORS,
  ) {}

  /** Seeds dedup with the `eventId`s already rendered from the initial `GET /orders/{id}` snapshot, so a frame the stream redelivers for a fact already on screen is silently dropped rather than reprocessed (R51). Seeds BOTH per-type Sets with the same ids: the initial snapshot's timeline entries and its order-level state derive from the same already-applied facts, so a redelivered frame of either type for one of those facts must be dropped, not just one type of it. */
  seedSeenEventIds(eventIds: Iterable<string>): void {
    for (const id of eventIds) {
      this.seenOrderUpdateIds.add(id);
      this.seenTimelineEntryIds.add(id);
    }
  }

  connect(): void {
    this.disconnect();
    this.consecutiveErrors = 0;
    this.callbacks.onStatusChange('connecting');

    const source = this.factory(this.url);
    this.source = source;

    source.addEventListener('stream.ready', (event) => {
      this.consecutiveErrors = 0;
      this.callbacks.onStatusChange('connected');
      const data = JSON.parse(event.data) as StreamReady;
      if (!data.resumed) {
        this.callbacks.onResync();
      }
    });

    source.addEventListener('order.updated', (event) => {
      this.consecutiveErrors = 0;
      this.callbacks.onStatusChange('connected');
      const data = JSON.parse(event.data) as OrderStreamUpdate;
      if (this.seenOrderUpdateIds.has(data.eventId)) return;
      this.seenOrderUpdateIds.add(data.eventId);
      this.callbacks.onOrderUpdated(data);
    });

    source.addEventListener('timeline.appended', (event) => {
      this.consecutiveErrors = 0;
      this.callbacks.onStatusChange('connected');
      const data = JSON.parse(event.data) as TimelineStreamEntry;
      if (this.seenTimelineEntryIds.has(data.eventId)) return;
      this.seenTimelineEntryIds.add(data.eventId);
      this.callbacks.onTimelineAppended(data);
    });

    // `ping` carries no resumable content — its only job here is to confirm
    // the connection is genuinely still alive (openapi.yaml's own reason
    // for `ping` never carrying an `id:` line applies symmetrically on the
    // client: it must never affect dedup or resume state).
    source.addEventListener('ping', () => {
      this.consecutiveErrors = 0;
      this.callbacks.onStatusChange('connected');
    });

    source.addEventListener('error', () => {
      this.consecutiveErrors += 1;
      const closed = source.readyState === READY_STATE_CLOSED;
      if (closed || this.consecutiveErrors >= this.giveUpAfterConsecutiveErrors) {
        this.callbacks.onStatusChange('gave-up');
        this.disconnect();
        return;
      }
      this.callbacks.onStatusChange('reconnecting');
    });
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }
}
