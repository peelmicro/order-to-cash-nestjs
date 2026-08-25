export interface SseConfig {
  readonly bufferCapacity: number;
  readonly pingIntervalMs: number;
}

export function loadSseConfig(env: NodeJS.ProcessEnv = process.env): SseConfig {
  return {
    bufferCapacity: Number(env.GATEWAY_SSE_BUFFER_CAPACITY ?? 500),
    pingIntervalMs: Number(env.GATEWAY_SSE_PING_INTERVAL_MS ?? 15000),
  };
}
