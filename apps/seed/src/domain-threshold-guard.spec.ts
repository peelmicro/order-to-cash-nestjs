// N3 — the domain-threshold vacuity guard (review_sonarqube_quality_gates.md
// §5, feature 34's approved review — recommended as a follow-up rather than
// a gate condition, filed here). A vitest.config.mts that declares a
// 'src/domain/**' coverage.thresholds group is only a meaningful gate if
// `src/domain/` actually contains source matched by that glob — an empty
// (or `.gitkeep`-only) domain/ folder makes the group vacuously satisfied:
// zero files can ever violate an 80% threshold, so a green run is then
// indistinguishable from a genuinely well-covered domain layer. This
// repository has been bitten by exactly this class of guard-that-guards-
// nothing three times already (feature 17's FS5 re-reserve branch, feature
// 19's R39 port-refusal branch, and the emission-deletion convention in
// CLAUDE.md that exists because of them) — this test is the config-level
// version of that lesson, applied to coverage.thresholds itself.
//
// Pure text/filesystem, no Docker, no framework: runs inside `pnpm quality`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (readdirSync(dir).includes('pnpm-workspace.yaml')) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`domain-threshold-guard.spec: could not find pnpm-workspace.yaml walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);

// The six NestJS services whose vitest.config.mts carries the two-tier
// (80% domain / 60% overall) gate (phase 21). apps/web and apps/seed have
// no domain/ layer and declare no 'src/domain/**' threshold group at all,
// so they are out of scope for this guard by construction (checked below,
// not assumed).
const NESTJS_SERVICES = ['orders', 'fulfillment', 'billing', 'gateway', 'notifications', 'projector'] as const;

// apps/notifications is the one documented, reviewed exception: it is a
// stateless fact-consumer with no aggregate (confirmed by
// progress/review_sonarqube_quality_gates.md §5 — its
// application/notification-dispatch.service.ts is idempotency/compensation
// orchestration, an application concern; infrastructure/templates/* are
// pure email-rendering functions; infrastructure/persistence holds only the
// processed_events dedup ledger; presentation is @EventPattern controllers
// only — no domain concern anywhere). Its `src/domain/` folder holds only
// `.gitkeep`, a scaffolding placeholder, not a hidden gap, and its 80%
// threshold is *known and accepted* to be currently vacuous rather than
// silently so. Any OTHER service on NESTJS_SERVICES failing this guard is a
// real regression, not a design choice — that is the whole point of naming
// the exemption here instead of writing a guard notifications would also
// satisfy by construction.
const EXEMPT_VACUOUS_DOMAIN = new Set<string>(['notifications']);

function readConfigSource(app: string): string {
  return readFileSync(path.join(REPO_ROOT, 'apps', app, 'vitest.config.mts'), 'utf8');
}

/** Whether this service's vitest.config.mts declares a 'src/domain/**' coverage.thresholds group at all. */
function declaresDomainThreshold(configSource: string): boolean {
  return /['"]src\/domain\/\*\*['"]/.test(configSource);
}

/** Every file under apps/<app>/src/domain, recursively, excluding directories and `.gitkeep` placeholders — i.e. the files the 'src/domain/**' glob can actually match coverage against. */
function nonPlaceholderDomainFiles(app: string): string[] {
  const domainDir = path.join(REPO_ROOT, 'apps', app, 'src', 'domain');
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // directory does not exist at all — equally vacuous
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry !== '.gitkeep') {
        found.push(full);
      }
    }
  };
  walk(domainDir);
  return found;
}

describe('domain-threshold-guard — N3: every declared src/domain/** coverage threshold is backed by real domain source', () => {
  // Non-vacuity of the guard itself: at least one service actually declares
  // the group, so the checks below are exercising something real.
  it('at least one NestJS service declares a src/domain/** threshold group', () => {
    const declaring = NESTJS_SERVICES.filter((app) => declaresDomainThreshold(readConfigSource(app)));
    expect(declaring.length).toBeGreaterThan(0);
  });

  for (const app of NESTJS_SERVICES) {
    it(`apps/${app}: if vitest.config.mts declares a src/domain/** threshold, src/domain/ is non-empty (unless explicitly exempted)`, () => {
      const configSource = readConfigSource(app);
      if (!declaresDomainThreshold(configSource)) {
        // This service's config does not declare the group at all — nothing
        // to guard.
        return;
      }

      const files = nonPlaceholderDomainFiles(app);

      if (EXEMPT_VACUOUS_DOMAIN.has(app)) {
        // Documented, reviewed exception — see the comment above this
        // constant. Not asserting files.length > 0 here is the point: this
        // branch exists so a future reader who greps for "notifications"
        // and "domain" finds a written reason, not a silent skip.
        return;
      }

      expect(
        files.length,
        `apps/${app}/vitest.config.mts declares a 'src/domain/**' coverage threshold, but apps/${app}/src/domain/ has no source files other than .gitkeep — the 80% domain gate would be VACUOUSLY satisfied (zero files can never violate a threshold). Either add real domain source, or if this service genuinely has no domain layer, remove the 'src/domain/**' threshold group from its vitest.config.mts and add "${app}" to EXEMPT_VACUOUS_DOMAIN in domain-threshold-guard.spec.ts with a written reason.`,
      ).toBeGreaterThan(0);
    });
  }
});
