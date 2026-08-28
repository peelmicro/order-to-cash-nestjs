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
import path from "node:path";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginVue from "eslint-plugin-vue";
import vueEslintParser from "vue-eslint-parser";
import requireRefDotValue from "./apps/web/eslint-rules/require-ref-dot-value.mjs";

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

// The ref-unwrapping footgun (apps/web's own regression — see
// progress/impl_web_app.md's "Placing…"/stuck-disabled-button bug):
// `<script setup>` only auto-unwraps a TOP-LEVEL ref identifier.
// `placeOrder.isPending` — a ref reached through an object PROPERTY
// (`useMutation()`'s `toRefs()`-shaped return value) — silently resolves to
// the raw, always-truthy `Ref` object instead of its real boolean value,
// wherever it is used without an explicit `.value`.
//
// The type-aware rule below (`@typescript-eslint/no-unnecessary-condition`,
// wired for `.vue` files via typescript-eslint's project service) catches
// this pattern in `<script>` code, but not inside `<template>` expression
// containers — vue-eslint-parser does not wire template expressions into
// the TypeScript type-checker for typed linting. Since the real bug
// happened specifically in template code, `apps/web/eslint-rules
// /require-ref-dot-value.mjs` (a small local rule, registered below as
// `local/require-ref-dot-value`) closes that gap directly, using
// `defineTemplateBodyVisitor` — the same mechanism every eslint-plugin-vue
// rule uses internally to see template nodes at all. Full rationale,
// including why a plain `no-restricted-syntax` selector was tried first and
// does not work here either, is in that file's own header comment.

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
  // Vue-aware linting for apps/web (Nuxt 4). Before this block, `pnpm lint`
  // (`eslint .` at the repo root — the only lint entry point in this
  // monorepo; no app, including apps/web, has ever had a package-level
  // `lint` script of its own) never parsed a single `.vue` file: the root
  // flat config had no Vue parser configured. `eslint-plugin-vue`'s own
  // `flat/recommended` preset is an array of config objects, some of which
  // carry no `files` glob of their own (global plugin registration) — each
  // entry is remapped to `apps/web/**/*.vue` explicitly here so the preset
  // stays scoped to this one app, exactly like every other rule block in
  // this file, rather than registering the `vue` plugin repo-wide.
  ...eslintPluginVue.configs["flat/recommended"].map((c) => ({
    ...c,
    files: ["apps/web/**/*.vue"],
  })),
  // Type-aware linting inside `.vue` files (`<script setup lang="ts">` and
  // template expression containers alike), via typescript-eslint's project
  // service + `extraFileExtensions` — the documented way to extend typed
  // linting past `.ts`/`.tsx` into Vue SFCs. This is what actually catches
  // the exact bug class that shipped once already
  // (progress/impl_web_app.md's "Placing…" regression, `place.vue`'s
  // `placeOrder.isPending` used directly instead of `.isPending.value`):
  // `@typescript-eslint/no-unnecessary-condition` flags a condition whose
  // *type* is always truthy — a `Ref<boolean>` accessed without `.value` is
  // a non-nullable object, always truthy, regardless of the wrapped
  // boolean's real value. Deliberately NOT relying on
  // `vue/no-ref-as-operand` (already included by `flat/recommended` above)
  // for this: that rule only tracks identifiers assigned directly from a
  // `ref()`/`computed()`/`toRefs()` call visible in the *same file's*
  // static scope — `useMutation()`'s own internal `toRefs()` call lives in
  // `@tanstack/vue-query`, a different module entirely, invisible to that
  // rule's scope analysis, so it does not and cannot catch this pattern.
  // The type-aware rule below reasons from the resolved TypeScript type
  // instead, which resolves correctly across module boundaries.
  {
    files: ["apps/web/**/*.vue"],
    languageOptions: {
      parser: vueEslintParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
        sourceType: "module",
        projectService: true,
        tsconfigRootDir: path.join(import.meta.dirname, "apps/web"),
      },
    },
    plugins: {
      local: { rules: { "require-ref-dot-value": requireRefDotValue } },
    },
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "error",
      "local/require-ref-dot-value": "error",
      // Same reasoning `tseslint.configs.recommended` already applies to
      // every `.ts`/`.tsx`/`.mts`/`.cts` file in this repo (see that
      // preset's own `no-undef: 'off'`, which does not reach `.vue` files
      // since its `files` glob is TS-extension-only): Nuxt's entire
      // auto-import surface (`definePageMeta`, `navigateTo`, `useRoute`,
      // the implicit Vue reactivity APIs, etc.) is realized as ambient
      // TypeScript globals in `.nuxt/nuxt.d.ts`/`.nuxt/types/imports.d.ts`
      // — invisible to the plain-JS `no-undef` rule, which cannot read
      // `.d.ts` ambient declarations, but fully visible to and enforced by
      // `nuxi typecheck` (`pnpm --filter @otc/web run typecheck`, already a
      // mandatory quality gate) — a genuinely undefined identifier still
      // fails the build there. Confirmed live: without this line, every
      // page in this app (`definePageMeta`, `navigateTo`, `useRoute`,
      // `computed` used via auto-import rather than an explicit `vue`
      // import) reported a false-positive `no-undef` the instant `.vue`
      // files started being parsed at all.
      "no-undef": "off",
      // Nuxt's file-based routing (`pages/index.vue`, `pages/login.vue`,
      // `pages/orders/place.vue`) and shadcn-vue's own single-word
      // primitive names (`Button.vue`, `Card.vue`, `Input.vue`, ...) are
      // both real, intentional conventions this rule exists to discourage
      // in hand-authored, manually-registered components — neither
      // applies here.
      "vue/multi-word-component-names": "off",
    },
  },
  {
    // shadcn-vue's UI primitives under app/components/ui/** are vendored,
    // copied in verbatim by its own CLI (documented in
    // progress/impl_web_app.md), not hand-authored in this repo — exempt
    // them from the type-aware condition rule above rather than rewriting
    // third-party component style to satisfy a rule this pass added.
    files: ["apps/web/app/components/ui/**/*.vue"],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
      // shadcn-vue's own generated prop shape (`withDefaults`-free optional
      // `class`/`variant`/`size` props destructured via `defineProps`) is
      // the library's documented pattern, unrelated to this pass.
      "vue/require-default-prop": "off",
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
