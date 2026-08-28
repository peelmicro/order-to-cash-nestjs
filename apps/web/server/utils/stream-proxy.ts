export interface UpstreamOrderStreamOptions {
  gatewayBaseUrl: string;
  token: string;
  orderId?: string;
  lastEventId?: string;
  signal?: AbortSignal;
}

/**
 * Opens the real upstream `GET /orders/stream` connection with the Gateway,
 * attaching the real bearer token server-side (never exposed to the
 * browser — same F14 principle as `gatewayFetch`, different plumbing since
 * this one is a genuine long-lived byte stream, not a buffered call) and
 * forwarding the incoming request's `Last-Event-ID` verbatim. That header
 * is what lets a browser's automatic `EventSource` reconnect actually
 * resume from its own remembered cursor against the Gateway's bounded
 * replay buffer (openapi.yaml's "Reconnection" section) instead of the
 * cursor silently getting dropped somewhere in this proxy.
 *
 * Deliberately framework-free — no Nitro/h3 auto-imports, no `useRuntimeConfig`,
 * no `H3Event` — so this one function, the part that actually decides what
 * gets sent upstream, can be unit-tested directly against a real local HTTP
 * server standing in for the Gateway, without booting the whole Nitro app.
 * `server/api/orders/stream.get.ts` is the thin h3 wrapper around it.
 */
export async function openUpstreamOrderStream(options: UpstreamOrderStreamOptions): Promise<Response> {
  const url = new URL('/orders/stream', options.gatewayBaseUrl);
  if (options.orderId) {
    url.searchParams.set('orderId', options.orderId);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    Accept: 'text/event-stream',
  };
  if (options.lastEventId) {
    headers['Last-Event-ID'] = options.lastEventId;
  }

  return fetch(url, { headers, signal: options.signal });
}
