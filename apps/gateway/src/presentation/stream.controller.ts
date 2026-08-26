// `GET /orders/stream` (openapi.yaml `stream` tag, R55). Bypasses Nest's
// built-in `@Sse()` decorator DELIBERATELY: it sends
// `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0,
// no-transform`, but openapi.yaml's response header is a `const`:
// `no-cache` and nothing else. Writing the raw response directly gives
// this endpoint exact control over both required headers and the precise
// frame format (`id:`/`event:`/`data:` lines) the contract's own frame-
// format section specifies verbatim.
import { Controller, Get, Headers, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { StreamHub, type StreamFrame } from '../application/stream-hub';
import type { SseConfig } from '../infrastructure/messaging/sse.config';
import { SSE_CONFIG } from './sse-config.token';

// `id` is `null` for `stream.ready`/`ping` — deliberately: per the SSE spec, any
// dispatched event carrying an `id:` line updates a browser `EventSource`'s
// `lastEventId`, heartbeat or not. `ping` fires on a fixed interval and real
// content fires rarely, so if `ping` carried an id, a client's remembered
// resume point would almost always be a heartbeat's — one the replay buffer
// never stores (`StreamHub.mintCursor()`'s docstring) — making reconnection
// answer `resumed: false` on nearly every disconnect instead of only when
// content was genuinely missed. See openapi.yaml's "Frame format" section.
function writeFrame(res: Response, id: string | null, event: string, data: unknown): void {
  if (id !== null) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

@Controller('orders')
export class StreamController {
  constructor(
    @Inject(StreamHub) private readonly hub: StreamHub,
    @Inject(SSE_CONFIG) private readonly config: SseConfig,
  ) {}

  @Get('stream')
  stream(
    @Query('orderId') orderId: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const matchesFilter = (frame: StreamFrame): boolean => orderId === undefined || frame.orderId === orderId;

    // R55's reconnection contract: resume from the bounded buffer when the
    // client's Last-Event-ID is still in it; `resumed: false` (never an
    // error) when it is not, or when there was no Last-Event-ID at all
    // (a fresh connection).
    const replay = this.hub.replayAfter(lastEventId);
    const readyCursor = lastEventId ?? this.hub.mintCursor();
    writeFrame(res, null, 'stream.ready', {
      cursor: readyCursor,
      resumed: replay.resumed,
      orderId: orderId ?? null,
    });
    for (const frame of replay.missed) {
      if (matchesFilter(frame)) {
        writeFrame(res, frame.cursor, frame.event, frame.data);
      }
    }

    const subscription = this.hub.frames$.subscribe((frame) => {
      if (matchesFilter(frame)) {
        writeFrame(res, frame.cursor, frame.event, frame.data);
      }
    });

    const pingInterval = setInterval(() => {
      this.hub.mintCursor(); // consumed for its side effect on the cursor sequence only — `ping` carries no `id:` line, see `writeFrame` above.
      writeFrame(res, null, 'ping', { at: new Date().toISOString() });
    }, this.config.pingIntervalMs);

    res.on('close', () => {
      subscription.unsubscribe();
      clearInterval(pingInterval);
    });
  }
}
