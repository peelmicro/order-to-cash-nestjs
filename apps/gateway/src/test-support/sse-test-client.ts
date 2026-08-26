// A minimal raw-HTTP SSE test client — deliberately NOT `EventSource` (not
// available in this Node test runtime without a polyfill, and it would hide
// exactly the header/frame-format details `stream.integration.spec.ts` and
// `stream-projector-e2e.integration.spec.ts` exist to assert on: the raw
// `id:`/`event:`/`data:` block shape, `Last-Event-ID`, and the precise
// `Cache-Control`/`Connection` headers). Extracted from
// `stream.integration.spec.ts` (Group D) so `stream-projector-e2e.integration.spec.ts`
// (group E) does not re-implement the same SSE-frame parser.
import http from 'node:http';

export interface SseFrame {
  // `undefined` for `stream.ready`/`ping` — per openapi.yaml's "Frame
  // format" section, those two event types deliberately carry no `id:`
  // line on the wire at all (see `stream.controller.ts`'s `writeFrame`).
  // Only `order.updated`/`timeline.appended` frames have one.
  id: string | undefined;
  event: string;
  data: unknown;
}

/** Parses complete `event:`/`data:`\n\n blocks (with an optional leading `id:` line) out of an accumulating SSE text buffer, returning the parsed frames and the unconsumed remainder. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    if (!block.trim()) continue;
    const idLine = block.match(/^id: (.*)$/m);
    const eventLine = block.match(/^event: (.*)$/m);
    const dataLine = block.match(/^data: (.*)$/m);
    if (eventLine && dataLine) {
      frames.push({ id: idLine?.[1], event: eventLine[1]!, data: JSON.parse(dataLine[1]!) });
    }
  }
  return { frames, rest };
}

export function openSseConnection(
  port: number,
  token: string,
  query = '',
  lastEventId?: string,
): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/orders/stream${query}`, headers: { Authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) } },
      (res) => resolve({ req, res }),
    );
    req.on('error', reject);
    req.end();
  });
}

// --- collectUntil's per-connection state (review finding F4) ---------------
//
// A previous version started a brand-new `buffer`/`collected` pair, and a
// brand-new `res.on('data', …)` listener, on EVERY `collectUntil` call, and
// simply discarded whatever unconsumed remainder sat in the previous call's
// closure when it resolved. Two sequential `collectUntil` calls against the
// SAME `res` (both the E2E spec and several Group D tests do this) could
// therefore lose a frame that straddled the exact chunk boundary at which
// the first call's predicate became true: any bytes left in that closure's
// local `buffer` variable, and any prior listener, simply vanished once a
// new call registered its own fresh listener and fresh empty buffer.
//
// The fix keeps exactly ONE `data` listener and ONE running buffer/collected
// pair per `res`, keyed by a `WeakMap` so it is invisible to callers and
// garbage-collects with the response. Every `collectUntil` call against the
// same `res` shares that state: unconsumed bytes persist across calls, and
// a predicate that is already true against frames collected by an EARLIER
// call resolves immediately, without waiting on a new chunk at all.
interface Waiter {
  predicate: (frames: SseFrame[]) => boolean;
  resolve: (frames: SseFrame[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SseClientState {
  buffer: string;
  collected: SseFrame[];
  waiters: Waiter[];
}

const connectionStates = new WeakMap<http.IncomingMessage, SseClientState>();

function createState(res: http.IncomingMessage): SseClientState {
  const state: SseClientState = { buffer: '', collected: [], waiters: [] };

  res.on('data', (chunk: Buffer) => {
    state.buffer += chunk.toString('utf8');
    const { frames, rest } = parseSseFrames(state.buffer);
    state.buffer = rest;
    if (frames.length === 0) return;
    state.collected.push(...frames);

    const stillWaiting: Waiter[] = [];
    for (const waiter of state.waiters) {
      if (waiter.predicate(state.collected)) {
        clearTimeout(waiter.timer);
        waiter.resolve([...state.collected]);
      } else {
        stillWaiting.push(waiter);
      }
    }
    state.waiters = stillWaiting;
  });

  res.on('error', (error: Error) => {
    for (const waiter of state.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    state.waiters = [];
  });

  return state;
}

function getState(res: http.IncomingMessage): SseClientState {
  const existing = connectionStates.get(res);
  if (existing) return existing;
  const created = createState(res);
  connectionStates.set(res, created);
  return created;
}

export function collectUntil(res: http.IncomingMessage, predicate: (frames: SseFrame[]) => boolean, timeoutMs = 5000): Promise<SseFrame[]> {
  const state = getState(res);

  if (predicate(state.collected)) {
    return Promise.resolve([...state.collected]);
  }

  return new Promise<SseFrame[]>((resolve, reject) => {
    const waiter: Waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        state.waiters = state.waiters.filter((w) => w !== waiter);
        reject(new Error(`collectUntil: timed out, collected so far: ${JSON.stringify(state.collected)}`));
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}
