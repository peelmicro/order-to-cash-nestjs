// Flat ESLint config (ESLint 10, config-file-only — no .eslintrc anywhere).
//
// Domain-purity rule: this is the point of phase 5. We enforce it with the
// built-in `no-restricted-imports` rule rather than `import-x/no-restricted-paths`
// because:
//   - it ships with ESLint core, so it adds zero extra dependencies;
//   - our violations are always spellable in the import specifier itself
//     (you cannot import "@nestjs/common" or "../infrastructure/x" without
//     that string appearing literally in the `import`/`require` call), so a
//     specifier-pattern rule is sufficient — we do not need `import-x`'s
//     resolved-path "zone" matching, which exists for cases where the
//     violation is only visible after resolving a bare specifier to a file.
//   - it scopes cleanly per `files: [...]` block in flat config, one block
//     per rule, with no extra parser/resolver wiring.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const DOMAIN_PURITY_MESSAGE =
  "Domain layer must stay framework/infrastructure free (see CLAUDE.md § Non-negotiables).";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.nuxt/**",
      "**/.output/**",
      "**/.nitro/**",
      "**/.data/**",
      "**/.vite/**",
      // Generated code (packages/contracts/scripts/generate.mts) — never
      // hand-patched to satisfy lint; the generator's own output carries a
      // `/* eslint-disable */` banner too, but excluding the directory here
      // means it is also never even parsed by the flat config's TS project
      // service, which is faster and avoids false positives from code this
      // repo does not own the shape of.
      "packages/contracts/src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The domain-purity rule. Applies to every src/domain/** file in every
    // app, plus the whole of packages/shared-kernel/src — that package *is*
    // domain code by definition (CLAUDE.md § Non-negotiables: "packages/
    // shared-kernel (dependency-free)"). No NestJS, Drizzle, Kafka, NATS or
    // MongoDB import, and no relative import reaching sideways/outwards
    // into infrastructure/ or presentation/.
    files: [
      "apps/*/src/domain/**/*.{ts,mts,cts}",
      "packages/shared-kernel/src/**/*.{ts,mts,cts}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "drizzle-orm", message: DOMAIN_PURITY_MESSAGE },
            { name: "kafkajs", message: DOMAIN_PURITY_MESSAGE },
            { name: "nats", message: DOMAIN_PURITY_MESSAGE },
            { name: "mongodb", message: DOMAIN_PURITY_MESSAGE },
          ],
          patterns: [
            {
              group: [
                "@nestjs/*",
                "drizzle-orm/*",
                "kafkajs/*",
                "nats/*",
                "mongodb/*",
              ],
              message: DOMAIN_PURITY_MESSAGE,
            },
            {
              group: [
                "**/infrastructure/**",
                "**/infrastructure",
                "**/presentation/**",
                "**/presentation",
              ],
              message:
                "Domain layer must not reach into infrastructure/ or presentation/ (see CLAUDE.md § Non-negotiables).",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
