// `GET /orders/stream` (openapi.yaml `stream` tag, R55) — the browser's own
// `EventSource` connects ONLY to this Nuxt origin, never the Gateway
// directly (progress/impl_web_app.md, "F14 resolved" — same mechanism as
// every other proxied route, different plumbing because this one is a
// genuine long-lived byte stream). `gatewayFetch`/`$fetch` are buffered —
// they resolve only once the whole response has arrived, which would never
// let an open SSE connection through. This route instead uses the platform
// `fetch` (via `openUpstreamOrderStream`) to open the real upstream
// connection and `h3`'s `sendWebResponse` to pipe its byte stream straight
// through to the browser, unbuffered, as frames arrive.
import { sendWebResponse } from 'h3';
import { requireGatewayToken } from '../../utils/session';
import { openUpstreamOrderStream } from '../../utils/stream-proxy';

export default defineEventHandler(async (event) => {
  const token = await requireGatewayToken(event);
  const config = useRuntimeConfig(event);
  const orderIdParam = getQuery(event).orderId;
  const orderId = typeof orderIdParam === 'string' ? orderIdParam : undefined;
  // Browsers send this automatically on `EventSource` reconnect — forwarded
  // verbatim to the Gateway so its bounded replay buffer can honour it
  // (`stream-proxy.spec.ts` proves this specific forwarding, byte for byte).
  const lastEventId = getHeader(event, 'last-event-id');

  // If the browser disconnects, stop holding the upstream connection open
  // on its behalf — the Gateway's own `res.on('close', ...)` cleans up its
  // side the same way.
  const controller = new AbortController();
  event.node.req.on('close', () => controller.abort());

  const upstream = await openUpstreamOrderStream({
    gatewayBaseUrl: config.gatewayBaseUrl,
    token,
    orderId,
    lastEventId,
    signal: controller.signal,
  });

  if (!upstream.ok || !upstream.body) {
    throw createError({ statusCode: upstream.status || 502, statusMessage: 'Gateway stream request failed' });
  }

  return sendWebResponse(event, upstream);
});
