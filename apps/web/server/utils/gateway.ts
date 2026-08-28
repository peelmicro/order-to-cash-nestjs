import type { H3Event } from 'h3';
import { FetchError } from 'ofetch';
import { requireGatewayToken } from './session';

export interface GatewayRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, unknown>;
  body?: Record<string, unknown> | unknown[];
  headers?: Record<string, string>;
}

function forwardProblem(error: unknown): never {
  if (error instanceof FetchError) {
    // Forward the Gateway's own RFC 9457 problem+json body and status
    // rather than a generic 500 — the client needs `code`/`detail` to show
    // anything useful (openapi.yaml's Problem schema).
    throw createError({
      statusCode: error.statusCode ?? 502,
      statusMessage: error.statusMessage ?? 'Gateway request failed',
      data: error.data,
    });
  }
  throw error;
}

/**
 * The ONLY place in this app that calls the Gateway. Every Nitro server
 * route (`server/api/**`) that needs Gateway data goes through this — the
 * browser itself never does (progress/current.md, "F14 resolved"): it only
 * ever talks to Nuxt's own origin, and this function is what attaches the
 * real `Authorization: Bearer` header server-side before forwarding.
 */
export async function gatewayFetch<T>(event: H3Event, path: string, options: GatewayRequestOptions = {}): Promise<T> {
  const config = useRuntimeConfig(event);
  const token = await requireGatewayToken(event);

  try {
    const response = await $fetch(path, {
      method: options.method,
      query: options.query,
      body: options.body,
      baseURL: config.gatewayBaseUrl,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    return response as T;
  } catch (error) {
    forwardProblem(error);
  }
}

export interface GatewayRawResponse<T> {
  status: number;
  data: T;
}

/**
 * Like `gatewayFetch`, but also returns the real HTTP status the Gateway
 * answered with, instead of only the parsed body. Needed for `GET /orders/{id}`:
 * its `202`/`ProjectionPending` case (R55) is a genuine 2xx success as far as
 * `$fetch` is concerned (it never throws), so the only way for this route's
 * own response to honestly forward "not projected yet" to the browser is to
 * read the status the Gateway actually sent and set the same one here,
 * rather than always answering `200`.
 */
export async function gatewayFetchWithStatus<T>(event: H3Event, path: string, options: GatewayRequestOptions = {}): Promise<GatewayRawResponse<T>> {
  const config = useRuntimeConfig(event);
  const token = await requireGatewayToken(event);
  let status = 200;

  try {
    const data = await $fetch<T>(path, {
      method: options.method,
      query: options.query,
      body: options.body,
      baseURL: config.gatewayBaseUrl,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      onResponse({ response }) {
        status = response.status;
      },
    });
    return { status, data: data as T };
  } catch (error) {
    forwardProblem(error);
  }
}

/** Calls the Gateway with no session/auth requirement — `POST /auth/login` and the token-bearing `GET /auth/me` call right after it, before a session exists yet. */
export async function gatewayFetchPublic<T>(event: H3Event, path: string, options: GatewayRequestOptions = {}): Promise<T> {
  const config = useRuntimeConfig(event);
  try {
    const response = await $fetch(path, {
      method: options.method,
      query: options.query,
      body: options.body,
      baseURL: config.gatewayBaseUrl,
      headers: options.headers,
    });
    return response as T;
  } catch (error) {
    forwardProblem(error);
  }
}
