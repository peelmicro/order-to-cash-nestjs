// D2 (review_orders_acceptance.md): `NestApplication#onApplicationShutdown`
// only ever runs from `app.close()`, and only `app.enableShutdownHooks()`
// wires SIGTERM/SIGINT to that call. `main.ts` was missing that one line,
// so `NatsConnectionCloser` (app.module.ts) and `OutboxRelayService`'s
// graceful drain (outbox-relay.service.ts, feature 14) were both
// permanently inert.
//
// Proved here against a REAL child process receiving a REAL SIGTERM — not
// a mocked Nest lifecycle — using the same `NestFactory.create(...)` +
// `enableShutdownHooks()` shape `main.ts` now uses
// (`test-support/shutdown-probe-with-hooks.ts`), contrasted with the exact
// pre-fix shape that omits the call
// (`test-support/shutdown-probe-without-hooks.ts`) to demonstrate the
// failure the fix closes.
//
// A fixed 300ms settle delay between the probe reporting itself ready and
// the SIGTERM being sent: `tsx`'s launcher shim execs from `/bin/sh` into
// the real `node` process, and sending the signal in the same tick the
// child's readiness file appears can race that exec/bootstrap sequence on
// a loaded machine, even though the signal listener is registered
// synchronously at module load — reproduced directly (15/15 clean runs
// with the delay, ~40% silent-drop rate without it).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TSX_BIN = path.resolve(__dirname, '../node_modules/.bin/tsx');
const SIGNAL_SETTLE_DELAY_MS = 300;

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function readLogLines(logPath: string): string[] {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

interface ProbeRun {
  readonly lines: string[];
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
}

function runProbe(scriptRelativePath: string): Promise<ProbeRun> {
  workDir = mkdtempSync(path.join(tmpdir(), 'otc-shutdown-probe-'));
  const logPath = path.join(workDir, 'probe.log');

  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, scriptRelativePath);
    const child = spawn(TSX_BIN, [scriptPath, logPath], { stdio: ['ignore', 'ignore', 'ignore'] });

    let sentSignal = false;
    const readyPoll = setInterval(() => {
      if (sentSignal) return;
      if (readLogLines(logPath).includes('PROBE_READY')) {
        sentSignal = true;
        clearInterval(readyPoll);
        setTimeout(() => child.kill('SIGTERM'), SIGNAL_SETTLE_DELAY_MS);
      }
    }, 20);

    const overallTimeout = setTimeout(() => {
      clearInterval(readyPoll);
      child.kill('SIGKILL');
      reject(new Error(`probe ${scriptRelativePath} did not exit within the test timeout`));
    }, 60_000); // Child process cap: allow cold NestFactory startup under parallel workspace load

    child.on('exit', (code, signal) => {
      clearInterval(readyPoll);
      clearTimeout(overallTimeout);
      resolve({ lines: readLogLines(logPath), exitCode: code, exitSignal: signal });
    });
    child.on('error', (err) => {
      clearInterval(readyPoll);
      clearTimeout(overallTimeout);
      reject(err);
    });
  });
}

/** True once the OS confirms the probe process actually terminated in
 * response to the SIGTERM — however Node's `child_process` surfaces it (a
 * `signal` of `'SIGTERM'`, or the conventional `128 + 15 = 143` exit code
 * some platforms report instead). Not itself the D2 assertion — see the log
 * content checks below for that — just confirms the probe process is really
 * gone rather than still running. */
function terminatedBySigterm(run: ProbeRun): boolean {
  return run.exitSignal === 'SIGTERM' || run.exitCode === 143;
}

describe('app.enableShutdownHooks() — SIGTERM firing (D2 regression)', () => {
  it('fires onApplicationShutdown on SIGTERM when enableShutdownHooks() is called (the FIXED shape main.ts now uses)', async () => {
    const run = await runProbe('test-support/shutdown-probe-with-hooks.ts');

    expect(run.lines).toContain('PROBE_READY');
    expect(run.lines).toContain('SHUTDOWN_HOOK_FIRED:SIGTERM');
    expect(terminatedBySigterm(run)).toBe(true);
  }, 90_000); // spawnSync tsx: allow cold start under parallel workspace test load

  it('does NOT fire onApplicationShutdown on SIGTERM without enableShutdownHooks() (the OLD, pre-fix shape) — proves the fix is real', async () => {
    const run = await runProbe('test-support/shutdown-probe-without-hooks.ts');

    expect(run.lines).toContain('PROBE_READY');
    expect(run.lines.some((line) => line.startsWith('SHUTDOWN_HOOK_FIRED'))).toBe(false);
    expect(terminatedBySigterm(run)).toBe(true);
  }, 90_000); // spawnSync tsx: allow cold start under parallel workspace test load
});
