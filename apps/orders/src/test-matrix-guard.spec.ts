// H2 (progress/review_gateway_rest_auth.md, Round 3) — the traceability
// matrix (specs/shared/test-matrix.md) is the ONLY artefact in this
// repository that indexes tests and, until this file, had no guard at all.
// It has been corrected FIVE times across three review rounds of one
// feature — G1 (a stale `describe`/`it` title, after the cited guard was
// rewritten) and F6 (a cell naming a test that never existed) — never once
// by a check, always by a human or a reviewer noticing.
//
// --- Why this file lives in apps/orders, not specs/shared/ -----------------
// specs/shared/ is the stack-agnostic traceability spine of the trilogy,
// reused VERBATIM by assessments #8 (.NET) and #9 (FastAPI) — a `.spec.ts`
// inside it would be a TypeScript test embedded in a directory the other two
// assessments read as prose, which is exactly the kind of stack leakage
// CLAUDE.md forbids. This guard therefore sits beside the matrix, in the
// SAME place this repo already puts cross-cutting, whole-repo text/fs
// guards that read every apps/* directory: `idempotent-consumer.parity.spec
// .ts` (OI12) and `bare-json-nats.parity.spec.ts` (G5) both live in
// apps/orders and both walk `apps/*` from there. apps/orders also already
// hosts the saga orchestrator, the one component whose own correctness is
// defined ACROSS every other service's facts — the same "sees the whole
// repo" vantage point a traceability guard needs. Any of the other five
// services would have worked structurally; orders is the one with
// precedent.
//
// --- The verbatim/précis convention (test-matrix.md's own preamble states
// the same rule; restated here because this file is what enforces it) ------
// A cell's notation is `apps/**.spec.ts` › [`describe`] › *case name*. Per
// H2's own finding, that notation was used BOTH for verbatim quotation and
// for paraphrase, with nothing distinguishing the two. The convention fixed
// here: every backtick- or italic-quoted string that follows a `›` is
// claimed to be a VERBATIM, character-exact quotation of that string inside
// the named file — UNLESS it carries a leading `~` immediately before its
// opening backtick/asterisk (` ~*a précis, not a quotation* `), which marks
// it as a deliberate paraphrase, exempt from the exact-match check. `~` was
// chosen because it does not appear anywhere else in test-matrix.md (grep-
// verified) and collides with no existing markdown construct there.
//
// --- What this file checks, for every row ----------------------------------
//   1. Every cited `apps/**.spec.ts` OR `packages/**.spec.ts` path exists on
//      disk. (The brief asks for `apps/**.spec.ts`; `packages/**.spec.ts` is
//      included too because R1/R2/R3/R4/R11 cite `packages/shared-kernel`
//      paths and the identical risk applies to them — a strict superset of
//      the ask, not a narrowing of it.)
//   2. Every UNMARKED citation's quoted text is found, byte-for-byte after
//      normalisation, inside the file its row cites it against.
//
// --- Normalisation, and why each step is legitimate (not a weakening) ------
// A citation can be a true, exact quotation of a test's title and STILL fail
// a naive `String.includes` check, for three genuinely cosmetic reasons this
// file corrects for — verified by hand against every citation in the matrix
// before this guard was written, see progress/impl_test_matrix_guard.md:
//   a) Markdown escapes a literal `<`, `>`, `_`, `*`, `` ` `` as `\<`, `\>`,
//      `\_`, `\*`, `` \` `` in the SOURCE MARKDOWN; the rendered/intended
//      character has no backslash. (R11 — `\<aggregate\>.\<fact\>.v\<n\>`.)
//   b) A JS single-quoted string containing an apostrophe escapes it as
//      `\'` in the SOURCE .spec.ts file; the runtime string value (and the
//      matrix's plain-English citation of it) has no backslash. (R39, R52,
//      R53 — "the port\'s reason", "fact\'s rank".)
//   c) A long `it()` title is written across two adjacent JS string
//      literals joined by `+` for line-length reasons — genuinely one
//      string at runtime, but not one contiguous substring of the SOURCE
//      TEXT. (R53, R55 — `'…rank 0; ' + 'fills in the header fields…'`.)
//   d) A curly/typographic quote (’, ‘, “, ”) in the SOURCE .spec.ts file
//      vs. a straight quote in the matrix's prose, or vice versa — the same
//      character rendered two ways by two different editors. (R55 — "…
//      another order’s frames".)
// None of these loosen what counts as a match for a citation that has
// actually drifted: a renamed test, a deleted test, a summarised test, all
// still fail after every one of these normalisations, because the
// underlying WORDS differ, not just their escaping. That is proven below by
// arming exactly that: a fabricated title against a real file.
//
// --- What this guard CANNOT catch (stated honestly, not hidden) ------------
//   - A cell whose PROSE describes the wrong behaviour while citing a real,
//     correctly-named test — G1 was partly this; a textual check cannot
//     read whether a citation's surrounding sentence is TRUE, only whether
//     the quoted string exists. Human review remains the check for that.
//   - A `~`-marked précis that is an UNFAIR summary (materially
//     mischaracterises what the cited case actually proves). The marker is
//     trusted, not policed — see the précis-marker paragraph above.
//   - A citation whose claim does not follow the documented `›`-then-quote
//     shape at all. A small number of citations in this file use a
//     different lead-in ("— (1) *title*" rather than "› *title*") and are
//     therefore invisible to this guard's extraction, which anchors
//     strictly on `›` (the separator test-matrix.md's own preamble
//     documents). Widening extraction to every free-form prose shape this
//     document has ever used would trade recall for a real risk of
//     mismatching precis prose as if it were a citation (see the `*port-
//     refusal*` / `*imported*` false positives this file's own author found
//     and avoided while building the extractor — a plain "every italic span
//     is a title" rule fires on ordinary italic emphasis in the Status
//     column's prose). Anchoring strictly on `›` trades some recall for
//     zero false positives on prose, which is the honest trade for a guard
//     whose false negatives are dangerous (a G1) but whose false positives
//     would train the next implementer to stop trusting it (the OI12/F2/
//     projector-import-scan lesson this repo has already paid for three
//     times).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`test-matrix-guard: could not find pnpm-workspace.yaml walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
const MATRIX_PATH = path.join(REPO_ROOT, 'specs/shared/test-matrix.md');

interface Citation {
  rowId: string;
  citedPath: string;
  kind: 'describe' | 'title';
  text: string;
  verbatim: boolean;
}

interface Violation {
  rowId: string;
  citedPath: string;
  kind: 'describe' | 'title' | 'path';
  text: string;
  reason: string;
}

const PATH_ANCHOR_RE = /`((?:apps|packages)\/[a-zA-Z0-9_./-]*\.spec\.ts)`/g;

/**
 * Strips exactly the cosmetic drift normalisation (a) and (d) documented in
 * this file's header — markdown/JS backslash escapes and typographic
 * quotes — from a string, whichever side of the comparison it is applied
 * to. Symmetric on purpose: the matrix's prose and the source file's raw
 * text each carry a DIFFERENT subset of these artefacts, so both sides are
 * normalised the same way rather than guessing which side needs it.
 */
function normaliseQuoting(value: string): string {
  return value
    .replace(/\\([<>_*`\\'"])/g, '$1')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

/**
 * On top of normaliseQuoting, merges adjacent JS string-literal
 * concatenation (`'…' + '…'` or `"…" + "…"`) — normalisation (c) — so a
 * title split across two literals for line length is compared as the ONE
 * runtime string it actually is. Applied only to FILE text: the matrix
 * itself never contains this pattern, and merging it there would risk
 * hiding a genuine `... + ...` appearing in unrelated prose.
 */
function normaliseFileText(rawText: string): string {
  return normaliseQuoting(rawText)
    .replace(/'(\s*\+\s*)'/g, '')
    .replace(/"(\s*\+\s*)"/g, '');
}

/**
 * Extracts every citation from one row's raw markdown line. A "citation" is
 * whatever immediately follows a `›` — the separator test-matrix.md's own
 * preamble documents as introducing the test case name — associated with
 * the NEAREST PRECEDING `apps/**.spec.ts` / `packages/**.spec.ts` path
 * anchor on the same line. Handles the two shapes this file actually uses:
 *   - a single backtick `describe` segment (path › `describe` › ...)
 *   - a chain of one or more comma/"and"/"plus"-joined *italic case names*
 *     (R4, R42-R44's own multi-case cells)
 * Each claim may carry a leading `~` (with, or without, a preceding space)
 * marking it as a deliberate précis, exempt from the exact-match check.
 */
function extractCitations(rowLine: string, rowId: string): Citation[] {
  const anchors: { citedPath: string; index: number }[] = [];
  PATH_ANCHOR_RE.lastIndex = 0;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = PATH_ANCHOR_RE.exec(rowLine)) !== null) {
    anchors.push({ citedPath: anchorMatch[1]!, index: anchorMatch.index });
  }

  function nearestAnchor(position: number): { citedPath: string; index: number } | undefined {
    let found: { citedPath: string; index: number } | undefined;
    for (const anchor of anchors) {
      if (anchor.index < position) {
        found = anchor;
      } else {
        break;
      }
    }
    return found;
  }

  const citations: Citation[] = [];
  let searchFrom = 0;
  let separatorIndex: number;
  while ((separatorIndex = rowLine.indexOf('›', searchFrom)) !== -1) {
    const after = rowLine.slice(separatorIndex + 1);
    const anchor = nearestAnchor(separatorIndex);
    searchFrom = separatorIndex + 1;
    if (!anchor) {
      continue;
    }

    const describeMatch = after.match(/^\s*~?`([^`]+)`/);
    const titleRunMatch = after.match(/^\s*~?\*([^*]+)\*((?:\s*(?:,|and|plus)\s*~?\*[^*]+\*)*)/);

    if (describeMatch && !describeMatch[1]!.endsWith('.spec.ts')) {
      citations.push({
        rowId,
        citedPath: anchor.citedPath,
        kind: 'describe',
        text: describeMatch[1]!,
        verbatim: !describeMatch[0].trimStart().startsWith('~'),
      });
      continue;
    }

    if (titleRunMatch) {
      const wholeRun = titleRunMatch[0];
      const titleRe = /~?\*([^*]+)\*/g;
      let titleMatch: RegExpExecArray | null;
      titleRe.lastIndex = 0;
      while ((titleMatch = titleRe.exec(wholeRun)) !== null) {
        citations.push({
          rowId,
          citedPath: anchor.citedPath,
          kind: 'title',
          text: titleMatch[1]!,
          verbatim: !titleMatch[0].startsWith('~'),
        });
      }
    }
  }
  return citations;
}

function rowLinesOf(matrixText: string): { rowId: string; line: string }[] {
  return matrixText
    .split('\n')
    .filter((line) => /^\|\s*\*\*R\d+\*\*/.test(line))
    .map((line) => ({ rowId: line.match(/\*\*(R\d+)\*\*/)![1]!, line }));
}

/**
 * The guard's whole decision procedure, factored out as a pure function of
 * (markdown text, repo root) so both the real matrix AND the self-test's
 * synthetic fixtures below run through the IDENTICAL logic — the same
 * discipline OI12/G5 use their `SERVICE_*_MODE` registries for: the thing
 * proven non-vacuous is the actual checker, not a parallel toy version of
 * it.
 */
function findViolations(matrixText: string, repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const { rowId, line } of rowLinesOf(matrixText)) {
    const citations = extractCitations(line, rowId);
    const citedPaths = new Set(citations.map((c) => c.citedPath));
    for (const citedPath of citedPaths) {
      if (!existsSync(path.join(repoRoot, citedPath))) {
        violations.push({
          rowId,
          citedPath,
          kind: 'path',
          text: citedPath,
          reason: `${rowId} cites "${citedPath}", which does not exist on disk`,
        });
      }
    }
    for (const citation of citations) {
      if (!citation.verbatim) {
        continue;
      }
      const filePath = path.join(repoRoot, citation.citedPath);
      if (!existsSync(filePath)) {
        // Already reported once above per unique path; do not duplicate.
        continue;
      }
      const fileText = normaliseFileText(readFileSync(filePath, 'utf8'));
      const needle = normaliseQuoting(citation.text);
      if (!fileText.includes(needle)) {
        violations.push({
          rowId: citation.rowId,
          citedPath: citation.citedPath,
          kind: citation.kind,
          text: citation.text,
          reason:
            `${citation.rowId}'s ${citation.kind} citation of "${citation.citedPath}" claims the ` +
            `verbatim text "${citation.text}", which was not found (after normalisation) inside that ` +
            `file. If this is a deliberate paraphrase, mark it with a leading ~ per this document's own ` +
            `preamble; if not, the citation has drifted from the actual test.`,
        });
      }
    }
  }
  return violations;
}

describe('test-matrix-guard — H2 (traceability spine of specs/shared/test-matrix.md)', () => {
  it('cites only apps/**.spec.ts and packages/**.spec.ts paths that exist on disk, and quotes only verbatim text that is actually there', () => {
    const matrixText = readFileSync(MATRIX_PATH, 'utf8');
    const violations = findViolations(matrixText, REPO_ROOT);

    expect(
      violations,
      violations.map((v) => `  - [${v.rowId}] (${v.kind}) ${v.reason}`).join('\n'),
    ).toEqual([]);
  });

  it('is non-vacuous: the real matrix cites more than forty apps/**.spec.ts paths and more than one hundred quoted citations', () => {
    const matrixText = readFileSync(MATRIX_PATH, 'utf8');
    const rows = rowLinesOf(matrixText);
    const allCitations = rows.flatMap(({ rowId, line }) => extractCitations(line, rowId));
    const uniqueAppsPaths = new Set(
      allCitations
        .map((c) => c.citedPath)
        .filter((p) => p.startsWith('apps/')),
    );

    // 44 unique apps/**.spec.ts paths are reachable from a `›`-triggered
    // citation (this guard's extraction is deliberately narrower than a
    // whole-file grep for backtick paths — see this file's header on what
    // it cannot catch — so this is smaller than the 53 the Round 3 review
    // counted by reading every backtick span in the document, not just
    // those in the `›` citation position).
    expect(rows.length).toBe(62); // R1–R62, per the matrix's own "Verification" section (R62 minted by observability_reliability)
    expect(uniqueAppsPaths.size).toBeGreaterThan(40);
    expect(allCitations.length).toBeGreaterThan(100);
  });

  // --- Self-test: proves the checker itself fires, and fires naming the
  // offending row/cell, WITHOUT mutating the real matrix. Two synthetic
  // rows below deliberately fail; the third is a genuine control, built
  // from a real file this repo already ships, proving the checker is not
  // vacuously red either.
  describe('self-test — armed against synthetic fixture rows (does not touch the real matrix)', () => {
    it('fails, naming the row and the path, when a cited apps/**.spec.ts path does not exist', () => {
      const fixtureRow =
        '| **R9001** | fixture only | domain unit | n/a | ' +
        'DONE — `apps/orders/src/domain/__this-file-does-not-exist__.spec.ts` › ' +
        '`some describe block` › *some case name* |';

      const violations = findViolations(fixtureRow, REPO_ROOT);

      expect(violations).toHaveLength(1);
      expect(violations[0]!.rowId).toBe('R9001');
      expect(violations[0]!.kind).toBe('path');
      expect(violations[0]!.citedPath).toBe(
        'apps/orders/src/domain/__this-file-does-not-exist__.spec.ts',
      );
      expect(violations[0]!.reason).toContain(
        'R9001 cites "apps/orders/src/domain/__this-file-does-not-exist__.spec.ts", which does not exist on disk',
      );
    });

    it('fails, naming the row, the file and the fabricated text, when an unmarked citation quotes a title the real file does not contain', () => {
      // A real, existing file — order.spec.ts — cited against a title no
      // developer has ever written, in the UNMARKED (claimed-verbatim)
      // position.
      const fixtureRow =
        '| **R9002** | fixture only | domain unit | n/a | ' +
        'DONE — `apps/orders/src/domain/order.spec.ts` › ' +
        '*this exact sentence has never appeared in any test title anywhere in this repository, XK7Q* |';

      const violations = findViolations(fixtureRow, REPO_ROOT);

      expect(violations).toHaveLength(1);
      expect(violations[0]!.rowId).toBe('R9002');
      expect(violations[0]!.kind).toBe('title');
      expect(violations[0]!.citedPath).toBe('apps/orders/src/domain/order.spec.ts');
      expect(violations[0]!.text).toContain('XK7Q');
      expect(violations[0]!.reason).toContain('was not found (after normalisation) inside that file');
    });

    it('does NOT fail on the same fabricated title once it is marked ~ as a précis (the escape hatch works, and only for marked cells)', () => {
      const fixtureRow =
        '| **R9003** | fixture only | domain unit | n/a | ' +
        'DONE — `apps/orders/src/domain/order.spec.ts` › ' +
        '~*this exact sentence has never appeared in any test title anywhere in this repository, XK7Q* |';

      const violations = findViolations(fixtureRow, REPO_ROOT);

      expect(violations).toEqual([]);
    });

    it('does NOT fail on a genuine, real citation of a real title in a real file (the checker is not vacuously red)', () => {
      // R5's own real citation, reproduced here to prove the mechanism
      // finds a TRUE positive-free match against production evidence, not
      // just against tiny synthetic fixtures.
      const fixtureRow =
        '| **R9004** | fixture only | domain unit | n/a | ' +
        'DONE — `apps/orders/src/domain/order.spec.ts` › `Order.place — R5` › ' +
        '*refuses to create an order with no lines and to remove the last remaining line* |';

      const violations = findViolations(fixtureRow, REPO_ROOT);

      expect(violations).toEqual([]);
    });
  });
});
