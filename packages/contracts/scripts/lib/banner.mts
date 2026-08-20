/**
 * Shared DO-NOT-EDIT banner for every generated file in this package.
 *
 * Deliberately contains no timestamp, tool version or absolute path — any of
 * those would make `pnpm contracts:generate` non-deterministic between runs
 * (see `scripts/check.mts`, which diffs two runs byte-for-byte).
 */
export function bannerFor(sourceSpecRelativePath: string): string {
  return [
    '/**',
    ' * DO NOT EDIT — generated file.',
    ' *',
    ` * Produced by \`pnpm contracts:generate\` from`,
    ` * \`${sourceSpecRelativePath}\`.`,
    ' *',
    ' * Regenerate with `pnpm --filter @otc/contracts run generate` (or the',
    ' * root-level `pnpm contracts:generate`). Never hand-edit this file — a',
    ' * manual change here will be silently discarded the next time the',
    ' * generator runs, and `pnpm contracts:check` will fail loudly on the',
    ' * drift in the meantime.',
    ' */',
    '',
    '/* eslint-disable */',
    '',
  ].join('\n');
}
