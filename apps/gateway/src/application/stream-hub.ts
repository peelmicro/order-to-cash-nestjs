// The live hub behind `GET /orders/stream` (Group D, R55): one process-wide
// bounded replay buffer plus an RxJS fan-out `Subject` every open SSE
// connection subscribes to. A plain class (no `@Injectable()` needed — it
// carries no NestJS-resolved dependency of its own beyond the `Clock` port,
// composed once in `app.module.ts` via `useFactory`, the same
// "class-token, useFactory-composed" shape `ProjectionApplyService` and
// `NotificationDispatchService` already establish elsewhere in this repo).
//
// Deliberately NOT a `@CommandHandler`/`@QueryHandler`: it has no command or
// query of its own — it is fed by `infrastructure/messaging/nats-stream-signal.adapter.ts`
// (an inbound NATS core subscription, not RPC and not a fact — the
// projector's own "update signal", design.md §7) and read by
// `presentation/stream.controller.ts`'s SSE endpoint. `@nestjs/cqrs`
// governs commands and queries; this is neither. (Review finding F12: this
// comment previously cited `infrastructure/signal/...` — the projector's
// own directory name for its analogous publisher; this service's copy
// lives under `infrastructure/messaging/`, alongside its other NATS
// adapters.)
import { Subject, type Observable } from 'rxjs';
import { CursorGenerator, type CursorClock } from '../domain/sse/cursor';
import { ReplayBuffer, type ReplayResult } from '../domain/sse/replay-buffer';

export type StreamEventType = 'order.updated' | 'timeline.appended';

export interface StreamFrame {
  readonly cursor: string;
  readonly event: StreamEventType;
  readonly orderId: string;
  readonly data: Record<string, unknown>;
}

const DEFAULT_CAPACITY = 500;

export class StreamHub {
  private readonly buffer: ReplayBuffer<StreamFrame>;
  private readonly cursorGenerator: CursorGenerator;
  private readonly subject = new Subject<StreamFrame>();

  constructor(clock: CursorClock, capacity: number = DEFAULT_CAPACITY) {
    this.cursorGenerator = new CursorGenerator(clock);
    this.buffer = new ReplayBuffer<StreamFrame>(capacity);
  }

  publish(event: StreamEventType, orderId: string, data: Record<string, unknown>): StreamFrame {
    const frame: StreamFrame = { cursor: this.cursorGenerator.next(), event, orderId, data };
    this.buffer.push(frame.cursor, frame);
    this.subject.next(frame);
    return frame;
  }

  replayAfter(cursor: string | undefined): ReplayResult<StreamFrame> {
    return this.buffer.replayAfter(cursor);
  }

  /** A fresh cursor NOT pushed to the replay buffer — used for `stream.ready`/`ping` frames, which name a moment in time but carry no re-playable content of their own. */
  mintCursor(): string {
    return this.cursorGenerator.next();
  }

  get frames$(): Observable<StreamFrame> {
    return this.subject.asObservable();
  }
}
