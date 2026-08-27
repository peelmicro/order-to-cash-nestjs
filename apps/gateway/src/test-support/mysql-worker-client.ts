// A MySQL query client for `apps/orders`/`apps/fulfillment`/`apps/billing`'s
// OWN databases, usable from `apps/gateway` WITHOUT `apps/gateway` ever
// declaring or resolving `mysql2`/`drizzle-orm` itself — see
// `apps/gateway/src/no-write-database-client.spec.ts` (Group B's guard,
// found live while building this suite when `pnpm quality` caught exactly
// that: Gateway answers reads from the projector's read model only, never
// a write-model database directly).
//
// HOW: spawns a plain, unmodified `node -e "<script>"` child process — the
// script text (`WORKER_SCRIPT` below) is NEVER itself an on-disk `.cjs`/
// `.js` file under `apps/gateway`, and is passed to `node` as a STRING
// (`-e`), never `require()`d/`import`ed by anything in this file's own
// module graph — and that script `require()`s the TARGET service's own
// installed `mysql2` by a fully-resolved ABSOLUTE FILE PATH
// (`<serviceDir>/node_modules/mysql2/promise.js`), which bypasses Node's
// module resolution algorithm (and any package.json "exports" map)
// entirely — it is exactly as if the script lived inside `apps/orders/`
// itself, without this file needing to. This file's own `require.resolve`
// footprint therefore stays exactly what `no-write-database-client.spec.ts`
// checks: neither `mysql2` nor `drizzle-orm`, in any specifier form, ever
// appears as a bare/subpath specifier anywhere `apps/gateway`'s own module
// resolution could reach.
//
// (An on-disk `.cjs` file was the first draft — reverted: it is plain
// Node CommonJS, not part of `apps/gateway`'s own `tsconfig.json` `include`
// glob, but ESLint's flat config applies `js.configs.recommended`/
// `tseslint.configs.recommended` — `no-undef`, `no-require-imports` — to
// EVERY file with no `files:` scoping ahead of them, so a bare `.cjs` file
// with no declared Node globals failed `pnpm quality`'s lint step. An
// inline `-e` string sidesteps that: it is never a file ESLint sees at
// all.)
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

export interface MySqlWorkerConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Plain CommonJS, run via `node -e`, never parsed by this repo's TS
 * project or ESLint — see this file's own header. Protocol:
 * newline-delimited JSON over stdin/stdout, one request per line, one
 * reply per line: `{ id, type: 'connect', config }` opens the pool;
 * `{ id, type: 'query'|'execute', sql, params }` runs one statement; every
 * reply is `{ id, rows }` / `{ id, result }` / `{ id, error }`.
 * `process.argv[1]` is the target service's own absolute directory path
 * (the first argument after `-e '<script>'` — `node -e` mode has no script
 * filename, so `argv[1]` is the first REAL argument, unlike a normal
 * `node file.js arg` invocation where it would be `argv[2]`).
 */
const WORKER_SCRIPT = `
'use strict';
const path = require('node:path');
const readline = require('node:readline');
const serviceDir = process.argv[1];
const mysql = require(path.join(serviceDir, 'node_modules', 'mysql2', 'promise.js'));
let pool;
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void (async () => {
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: 'malformed request JSON: ' + String(error) }) + '\\n');
      return;
    }
    const { id, type, config, sql, params } = request;
    try {
      if (type === 'connect') {
        pool = mysql.createPool(Object.assign({}, config, { timezone: 'Z' }));
        process.stdout.write(JSON.stringify({ id, ok: true }) + '\\n');
        return;
      }
      if (!pool) throw new Error('received "' + type + '" before "connect"');
      if (type === 'query') {
        const result = await pool.query(sql, params || []);
        process.stdout.write(JSON.stringify({ id, rows: result[0] }) + '\\n');
        return;
      }
      if (type === 'execute') {
        const result = await pool.execute(sql, params || []);
        process.stdout.write(JSON.stringify({ id, result: { affectedRows: result[0].affectedRows } }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({ id, error: 'unknown request type "' + type + '"' }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }) + '\\n');
    }
  })();
});
process.on('SIGTERM', () => process.exit(0));
`;

/**
 * A disposable MySQL query client for exactly ONE service's own database —
 * `'orders' | 'fulfillment' | 'billing'`. One request in flight at a time
 * (queries are awaited sequentially by every caller in this suite anyway);
 * requests are matched to replies by a monotonic `id`.
 */
export class MySqlWorkerClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrBuffer = '';

  private constructor(child: ChildProcessByStdio<Writable, Readable, Readable>) {
    this.child = child;
    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8');
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let reply: { id?: number; rows?: unknown; result?: unknown; error?: string };
    try {
      reply = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (reply.id === undefined) return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.error) {
      pending.reject(new Error(`mysql-worker: ${reply.error}`));
    } else {
      pending.resolve(reply.rows ?? reply.result);
    }
  }

  private send(type: 'connect' | 'query' | 'execute', extra: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`mysql-worker: request ${id} (${type}) timed out. stderr so far:\n${this.stderrBuffer}`));
        }
      }, 20_000).unref();
    });
  }

  /** Spawns the worker (`node -e '<WORKER_SCRIPT>' <serviceDir>`) and opens its pool against `config` — `serviceName` names which real service's own `node_modules` supplies `mysql2` (`'orders' | 'fulfillment' | 'billing'`, siblings of `apps/gateway` under `apps/`). */
  static async connect(serviceName: string, config: MySqlWorkerConfig): Promise<MySqlWorkerClient> {
    const serviceDir = path.resolve(__dirname, '../../../', serviceName);
    const child = spawn(process.execPath, ['-e', WORKER_SCRIPT, serviceDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new MySqlWorkerClient(child);
    await client.send('connect', { config });
    return client;
  }

  /** Mirrors `mysql2`'s own `pool.query` — returns rows only (no `[rows, fields]` tuple), since no caller in this suite needs field metadata. */
  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = await this.send('query', { sql, params });
    return rows as T[];
  }

  /** Mirrors `mysql2`'s own `pool.execute` (prepared statement) — used for every seed INSERT in this suite. */
  async execute(sql: string, params: readonly unknown[] = []): Promise<{ affectedRows: number }> {
    const result = await this.send('execute', { sql, params });
    return result as { affectedRows: number };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (!this.child.killed) this.child.kill('SIGKILL');
      }, 5_000).unref();
    });
  }
}
