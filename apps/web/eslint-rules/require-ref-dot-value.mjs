// Local ESLint rule — closes a gap the published rulesets cannot close.
//
// The bug this rule exists to catch (see progress/impl_web_app.md's
// "Placing…"/stuck-disabled-button regression): `<script setup>` only
// auto-unwraps a TOP-LEVEL ref *identifier*. `placeOrder.isPending` (a real
// `Ref<boolean>` reached through an object PROPERTY — `useMutation()`'s
// `toRefs()`-shaped return value) silently resolves to the raw, always-
// truthy `Ref` object wherever it is used without an explicit `.value`.
//
// Two published options were tried first and both fall short, for two
// different, confirmed reasons:
//
//   - `vue/no-ref-as-operand` (eslint-plugin-vue) only tracks identifiers
//     assigned directly from a `ref()`/`computed()`/`toRefs()` call visible
//     in the SAME file's static scope. `useMutation()`'s own internal
//     `toRefs()` call lives inside `@tanstack/vue-query`, a different
//     module entirely — invisible to that rule's scope analysis.
//
//   - `@typescript-eslint/no-unnecessary-condition` (wired in
//     eslint.config.mjs with typescript-eslint's project service) DOES
//     catch this pattern — proven directly against a throwaway fixture
//     (`const obj: {a:number} = {a:1}; if (obj) {}`) — but ONLY inside
//     `<script>` code. Confirmed empirically, the same way, that it does
//     NOT catch the identical pattern written inside a `<template>`
//     expression container: vue-eslint-parser does not currently wire
//     template expressions into the TypeScript type-checker for typed
//     linting. Since the real bug happened specifically in template code
//     (`{{ placeOrder.isPending ? ... }}`, `:disabled="placeOrder.isPending
//     || ..."`), a rule that only reaches `<script>` would not have caught
//     it.
//
// A plain `no-restricted-syntax` selector was tried next and *also* falls
// short, for a third, distinct, and more fundamental reason: vue-eslint-parser
// deliberately keeps the template body OUT of the standard `Program.body`
// traversal (it hangs off `Program.templateBody` instead) specifically so
// that ordinary ESLint rules do not see it by accident — only a rule that
// explicitly opts in via `context.sourceCode.parserServices
// .defineTemplateBodyVisitor()` (exactly what every eslint-plugin-vue rule
// does internally) gets template nodes at all. `no-restricted-syntax`,
// like any other plain core rule, uses ordinary traversal — it silently
// sees nothing inside `<template>`, confirmed by running it against this
// exact fixture and getting zero diagnostics.
//
// This rule is the minimal thing that actually reaches both places: one
// shared node-level check, wired into both the script visitor AND (via
// `defineTemplateBodyVisitor`) the template visitor. It is deliberately
// name-based, not type-based — narrower in what it recognizes (only the
// TanStack Query boolean state-flag names below) but wider in where it
// looks (script AND template) than the type-aware rule above; the two are
// complementary.

const FLAG_NAMES = new Set([
  "isPending",
  "isLoading",
  "isFetching",
  "isError",
  "isSuccess",
  "isRefetching",
  "isPaused",
]);

function isWrappedInDotValue(memberExpressionNode) {
  const parent = memberExpressionNode.parent;
  return (
    parent &&
    parent.type === "MemberExpression" &&
    parent.object === memberExpressionNode &&
    !parent.computed &&
    parent.property.type === "Identifier" &&
    parent.property.name === "value"
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require .value on a TanStack Query boolean state flag (isPending/isLoading/isFetching/isError/isSuccess/isRefetching/isPaused) reached through an object property, in both <script> and <template>",
    },
    schema: [],
    messages: {
      requireDotValue:
        "'{{name}}' reached through an object property is a real Ref<boolean> — <script setup> only auto-unwraps a TOP-LEVEL ref identifier, never a nested member access, and vue-eslint-parser does not extend typed linting into <template> either. Used without .value, the Ref object itself is always truthy regardless of its real value. Add .value.",
    },
  },
  create(context) {
    function check(node) {
      if (
        !node.computed &&
        node.property.type === "Identifier" &&
        FLAG_NAMES.has(node.property.name) &&
        !isWrappedInDotValue(node)
      ) {
        context.report({ node, messageId: "requireDotValue", data: { name: node.property.name } });
      }
    }

    const visitor = { MemberExpression: check };
    const parserServices = context.sourceCode.parserServices;
    if (parserServices && parserServices.defineTemplateBodyVisitor) {
      return parserServices.defineTemplateBodyVisitor(visitor, visitor);
    }
    return visitor;
  },
};

export default rule;
