// @vitest-environment node
//
// Source pre-check for number-like boxes (progress/impl_web_number_inputs.md,
// Round 3). It sits BESIDE the render-based guard (`number-inputs.population.spec.ts`)
// and covers what that one cannot: a literal number box in ANY `.vue` under
// `app/` (layouts, `app.vue`, components, pages), in any state, including
// states the render guard's drivers never reach (a dialog, a second line, a
// box behind a `v-if`). The render guard covers what syntax cannot: boxes
// built by a render function, a dynamic component or an attribute spread.
// Neither alone is claimed to be the population; together they are.
//
// Unit: every `<input>` / `<Input>` / `<component>` / number-field-like tag in
// a `.vue` file's template, found by a quote-aware scan (a `>` inside an
// attribute value does not end the tag). Number-like means: type number
// (quoted with either quote, or unquoted), a dynamic type, an attribute
// spread, an `inputmode`, `<component is|:is>` naming an input, or a
// number-field-like tag name. The found set must equal a literal; each member
// must be `type="text"` with `inputmode`. The scanner is tested on sentinels.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_DIR = dirname(fileURLToPath(import.meta.url));

interface FoundTag {
  name: string;
  attrs: string;
  testId: string | undefined;
}

/** The markup of an SFC: `<script>` and `<style>` blocks and HTML comments removed (they are not rendered inputs). Never empty because the template is not located by a line anchor. */
function markupOf(source: string): string {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Every `<input` / `<Input` / `<component` / number-field-like tag, with quote-aware attribute scanning. */
export function scanMarkup(source: string): FoundTag[] {
  const markup = markupOf(source);
  const found: FoundTag[] = [];
  const tagStart = /<([A-Za-z][\w-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagStart.exec(markup)) !== null) {
    const name = match[1] ?? '';
    let i = tagStart.lastIndex;
    let quote: string | undefined;
    for (; i < markup.length; i++) {
      const ch = markup[i];
      if (quote) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    const attrs = markup.slice(tagStart.lastIndex, i);
    if (/^(input|Input|component)$/.test(name) || /number|stepper|spinbutton/i.test(name)) {
      found.push({ name, attrs, testId: /data-testid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>/]+))/.exec(attrs)?.slice(1).find(Boolean) });
    }
  }
  return found;
}

export function isNumberLike(tag: FoundTag): boolean {
  return (
    /number|stepper|spinbutton/i.test(tag.name) ||
    /\btype\s*=\s*(?:"number"|'number'|number(?![\w-]))/.test(tag.attrs) ||
    /(^|\s)(:|v-bind:)type\b/.test(tag.attrs) ||
    /(^|\s)v-bind\s*=/.test(tag.attrs) ||
    /(^|\s):?inputmode\b/.test(tag.attrs) ||
    (tag.name === 'component' && /(^|\s):?is\s*=/.test(tag.attrs) && (/(^|\s)is\s*=\s*(?:"input"|'input'|input(?![\w-]))/i.test(tag.attrs) || /(^|\s):is\b/.test(tag.attrs)))
  );
}

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.vue'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const EXPECTED = [
  'pages/orders/place.vue#quantity-input',
  'pages/orders/place.vue#unit-price-input',
  'pages/orders/place.vue#line-discount-input',
  'pages/billing/index.vue#payment-amount-input',
  'pages/stock/index.vue#replenish-units-input',
];

function population(): Map<string, FoundTag> {
  const members = new Map<string, FoundTag>();
  for (const file of vueFiles(APP_DIR)) {
    for (const tag of scanMarkup(readFileSync(file, 'utf8')).filter(isNumberLike)) {
      members.set(`${relative(APP_DIR, file)}#${tag.testId ?? `(no data-testid: <${tag.name} ${tag.attrs.trim()}>)`}`, tag);
    }
  }
  return members;
}

describe('number-like boxes in every .vue under app/ — source pre-check', () => {
  it('scans a real population: layouts, app.vue, pages and components are all in the file list', () => {
    const files = vueFiles(APP_DIR).map((f) => relative(APP_DIR, f));
    expect(files).toContain('app.vue');
    expect(files).toContain('layouts/default.vue');
    expect(files).toContain('pages/orders/place.vue');
    expect(files.some((f) => f.startsWith('components/'))).toBe(true);
  });

  it('the found set equals the literal expected set (nothing extra, nothing missing)', () => {
    const found = [...population().keys()].sort();
    const expected = [...EXPECTED].sort();
    // Joined to a string so a failure names the box instead of printing `Array(1)`.
    expect(found.filter((k) => !expected.includes(k)).join(' | '), 'number-like boxes with no listed refusal').toBe('');
    expect(expected.filter((k) => !found.includes(k)).join(' | '), 'listed boxes that no longer exist').toBe('');
  });

  it.each(EXPECTED)('%s is a text box asking for a numeric keyboard, not type="number"', (key) => {
    const tag = population().get(key);
    expect(tag, key).toBeDefined();
    expect(tag!.attrs).toMatch(/\btype="text"/);
    expect(tag!.attrs).toMatch(/(^|\s):?inputmode\b/);
    expect(tag!.attrs).not.toMatch(/\btype\s*=\s*(?:"number"|'number'|number(?![\w-]))/);
  });
});

describe('the scanner — sentinels it must catch, and ones it must ignore', () => {
  const wrap = (body: string) => `<script setup lang="ts">\nconst x = 1;\n</script>\n\n<template>\n${body}\n</template>\n`;
  const hits = (body: string) => scanMarkup(wrap(body)).filter(isNumberLike);
  it('catches type="number" quoted with double quotes, single quotes, and unquoted', () => {
    expect(hits('<input type="number" v-model="n">')).toHaveLength(1);
    expect(hits("<input type='number' v-model=\"n\">")).toHaveLength(1);
    expect(hits('<input type=number data-testid="ghost" />')).toHaveLength(1);
  });
  it('catches <component is="input"> (static and dynamic), a dynamic :type, an attribute spread', () => {
    expect(hits('<component is="input" type="number" />')).toHaveLength(1);
    expect(hits('<component :is="kind" />')).toHaveLength(1);
    expect(hits('<Input :type="kind" />')).toHaveLength(1);
    expect(hits('<Input v-bind="$attrs" />')).toHaveLength(1);
  });
  it('catches a number-field component and an inputmode box; ignores a plain text input and a non-input <component>', () => {
    expect(hits('<NumberFieldInput />')).toHaveLength(1);
    expect(hits('<Input type="text" inputmode="decimal" />')).toHaveLength(1);
    expect(hits('<Input type="password" />')).toHaveLength(0);
    expect(hits('<component is="div" />')).toHaveLength(0);
  });
  it('is not fooled by `=>` or `>` inside an attribute value', () => {
    const tags = hits('<Input data-testid="a" @update:model-value="(v) => (x = v > 1)" type="number" min="0" />');
    expect(tags).toHaveLength(1);
    expect(tags[0]?.testId).toBe('a');
  });
  it('ignores a number input that sits in an HTML comment or a script string (not rendered)', () => {
    const source = `<script setup lang="ts">\nconst s = '<input type="number">';\n</script>\n\n<template>\n<!-- <input type="number"> -->\n<Input type="text" />\n</template>\n`;
    expect(scanMarkup(source).filter(isNumberLike)).toHaveLength(0);
  });
  it('finds a box in a file with no <template> at line start (markup is not located by a line anchor)', () => {
    expect(scanMarkup('<div>\n  <input type="number">\n</div>').filter(isNumberLike)).toHaveLength(1);
  });
});
