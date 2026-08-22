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

// DI-tokens rule (review_orders_acceptance.md §12 — the DI-metadata
// divergence): `tsconfig.base.json` sets `emitDecoratorMetadata: true`, so
// `pnpm build` (`tsc`) emits `design:paramtypes` and Nest CAN infer a
// bare-typed constructor parameter's token from it — but that inference
// makes DI resolution depend on which compiler produced the running code.
// A dev-time compiler that does not emit that metadata (an esbuild-based
// watcher, for instance) resolves the SAME parameter to `undefined`,
// silently — Nest's container still builds, and the failure appears only
// at first use (`apps/orders/src/di-metadata-divergence.spec.ts`
// reproduces both sides directly). Enforced here with the built-in
// `no-restricted-syntax` rule — same "zero extra dependencies, one
// selector per block" instrument the domain-purity rule above uses —
// rather than a custom rule package.
//
// Matches a `TSParameterProperty` (a constructor parameter carrying an
// accessibility/`readonly` modifier — the only shape that becomes an
// injected, stored field in this codebase's style) with no `@Inject(...)`
// decorator of its own, inside the constructor of a class carrying one of
// the Nest DI decorators below. Provider wiring that instead uses
// `useFactory` + `inject: [...]` (every provider in every `app.module.ts`
// today) is untouched — there is no constructor for this selector to
// match.
const NEST_DI_DECORATOR_NAMES = ["Injectable", "Controller", "Catch", "CommandHandler", "EventsHandler", "QueryHandler", "Resolver"];
const REQUIRE_EXPLICIT_INJECT_SELECTOR =
  `ClassDeclaration:has(Decorator[expression.callee.name=/^(${NEST_DI_DECORATOR_NAMES.join("|")})$/]) ` +
  `MethodDefinition[kind="constructor"] ` +
  `TSParameterProperty:not(:has(Decorator[expression.callee.name="Inject"]))`;
const REQUIRE_EXPLICIT_INJECT_MESSAGE =
  "Bare-type constructor injection on a Nest-decorated class is forbidden here — add an explicit @Inject(TOKEN). Without it, DI resolution silently depends on which compiler produced the running code (tsc vs an esbuild-based dev runner) — see CLAUDE.md § Non-negotiables.";

// Every service from feature 16 onward is a HYBRID app (HTTP + NATS + Kafka).
// A `@MessagePattern`/`@EventPattern` without an explicit `Transport` argument
// binds to EVERY connected microservice transport — so a NATS-only pattern
// such as `orders.create` also gets registered on the Kafka server, which then
// tries to subscribe to a topic named "orders.create" and crashes the boot.
// Found live in feature 16; invisible to any single-transport TestingModule.
// Matches a pattern decorator carrying fewer than two arguments.
const REQUIRE_EXPLICIT_TRANSPORT_SELECTOR =
  `Decorator[expression.callee.name=/^(MessagePattern|EventPattern)$/][expression.arguments.length<2]`;
const REQUIRE_EXPLICIT_TRANSPORT_MESSAGE =
  "@MessagePattern/@EventPattern must name its Transport (e.g. Transport.NATS, Transport.KAFKA). A bare pattern binds to every connected transport and crashes hybrid apps at boot — see CLAUDE.md § Non-negotiables.";

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
  // Developer scripts run directly under Node (no bundler, no Nest), so they
  // legitimately use `process` and `console` — globals the app configs do not
  // declare. Plain ESM JavaScript, so no type-aware linting either.
  {
    files: ["scripts/**/*.{mjs,js}"],
    languageOptions: {
      sourceType: "module",
      globals: { process: "readonly", console: "readonly" },
    },
  },
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
    // Scoped to every service's app source. `test-support/` is excluded
    // deliberately: `di-metadata-probe.ts` reproduces the bare-type
    // injection failure ON PURPOSE, as the reproduction this very rule
    // exists to prevent in production code — it is never imported from a
    // production module.
    files: ["apps/*/src/**/*.{ts,mts,cts}"],
    ignores: ["**/test-support/**", "**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: REQUIRE_EXPLICIT_INJECT_SELECTOR, message: REQUIRE_EXPLICIT_INJECT_MESSAGE },
        { selector: REQUIRE_EXPLICIT_TRANSPORT_SELECTOR, message: REQUIRE_EXPLICIT_TRANSPORT_MESSAGE },
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
