// Configuration for the saga command dispatcher (SO4) and sweeper (SO5) —
// design.md §6.2, §6.4. Read from the process environment, the same plain
// shape `db-config.ts`/`outbox-relay.config.ts` already established.
import {
  DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG,
  type SagaCommandDispatcherConfig,
} from './saga-command-dispatcher';
import type { SagaCommandSweeperConfig } from './saga-command-sweeper.service';

export function loadSagaCommandDispatcherConfig(env: NodeJS.ProcessEnv = process.env): SagaCommandDispatcherConfig {
  return {
    timeoutMs: Number(env.SAGA_COMMAND_TIMEOUT_MS ?? DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG.timeoutMs),
    maxAttempts: Number(env.SAGA_COMMAND_MAX_ATTEMPTS ?? DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG.maxAttempts),
    backoffBaseMs: Number(env.SAGA_COMMAND_BACKOFF_MS ?? DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG.backoffBaseMs),
    parkRetryCapMs: Number(env.SAGA_PARK_RETRY_CAP_MS ?? DEFAULT_SAGA_COMMAND_DISPATCHER_CONFIG.parkRetryCapMs),
  };
}

export function loadSagaCommandSweeperConfig(env: NodeJS.ProcessEnv = process.env): SagaCommandSweeperConfig {
  return {
    enabled: (env.SAGA_SWEEPER_ENABLED ?? 'true') !== 'false',
    intervalMs: Number(env.SAGA_SWEEPER_INTERVAL_MS ?? 30_000),
    pendingGraceMs: Number(env.SAGA_PENDING_GRACE_MS ?? 10_000),
    batchLimit: Number(env.SAGA_SWEEPER_BATCH_LIMIT ?? 100),
  };
}
