import { readFile } from 'node:fs/promises';
import { load as loadYaml } from 'js-yaml';
import { compile } from 'json-schema-to-typescript';
import { bannerFor } from './banner.mjs';

/**
 * Generator choice for the messaging contract — recorded here, not just in
 * `progress/impl_contracts_package.md`, because it is load-bearing for
 * anyone regenerating this file.
 *
 * AsyncAPI 3.0 tooling is thin. `@asyncapi/modelina` targets *models*
 * (payload shapes) but has no first-class notion of "give me every
 * `components.schemas` entry as one faithful, cross-referencing TypeScript
 * module" — it is built to walk `channels`/`messages` per-message, which
 * would require re-deriving the schema graph anyway and loses the shared
 * `Envelope` intersection style this spec uses (`allOf: [Envelope, {...}]`).
 *
 * `json-schema-to-typescript` is a plain JSON-Schema → TS compiler: no
 * opinion about AsyncAPI at all. `components.schemas` in this document
 * *is* JSON Schema (draft-07-shaped, `$ref`-only, no AsyncAPI-specific
 * keywords) — every one of the 95 schema definitions, all thirteen fact
 * *Event and *Payload pairs, all fourteen RPC *RequestPayload/*ReplyPayload
 * pairs, the envelope, both header shapes and every RPC common structure,
 * compile 1:1 with no post-processing. This is the "extract
 * components.schemas and feed a JSON-Schema-to-TS generator" path the task
 * explicitly sanctions as honest when the AsyncAPI-native tooling does not
 * fit — chosen here because it is what actually fits, not as a fallback of
 * last resort.
 */

interface JsonSchemaLike {
  [key: string]: unknown;
}

/**
 * Recursively:
 *  1. rewrites every `#/components/schemas/X` $ref to `#/definitions/X`, so
 *     json-schema-to-typescript's internal $RefParser resolves them as plain
 *     JSON Schema `definitions` without needing to know anything about
 *     AsyncAPI's document shape;
 *  2. drops every `title` keyword. Three of the ninety-five schemas in this
 *     document carry a human-readable `title` for the rendered spec
 *     (`Envelope: title: Fact envelope`, `RpcError: title: RPC error reply`,
 *     `RpcTimeout: title: RPC timeout — the absence of a reply`).
 *     json-schema-to-typescript prefers `title` over the definition key when
 *     naming a type, which would make the exported name depend on prose
 *     wording instead of the schema key — for `RpcTimeout` that title
 *     produces `RPCTimeoutTheAbsenceOfAReply`, useless as a TypeScript name
 *     and unfaithful to the one property that actually identifies a schema
 *     uniquely: its key. Stripping `title` here (harmless — `description`
 *     survives untouched and still lands in the generated doc comment)
 *     keeps every exported type name identical to its `components.schemas`
 *     key, which is what `index.spec.ts`'s completeness assertion checks
 *     for.
 */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(rewriteRefs);
  }
  if (node && typeof node === 'object') {
    const input = node as JsonSchemaLike;
    const output: JsonSchemaLike = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'title') {
        continue;
      }
      if (key === '$ref' && typeof value === 'string') {
        output[key] = value.replace(/^#\/components\/schemas\//, '#/definitions/');
        continue;
      }
      output[key] = rewriteRefs(value);
    }
    return output;
  }
  return node;
}

function sortKeys<T extends Record<string, unknown>>(input: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = input[key];
  }
  return sorted as T;
}

/**
 * Reads `specs/shared/asyncapi.yaml`, extracts `components.schemas`, and
 * compiles every one of them into a named TypeScript interface/type alias in
 * one deterministic module: same input, byte-identical output, every time —
 * definitions are sorted alphabetically before compilation so the emitted
 * order never depends on YAML key order or object-iteration incidentals.
 */
export async function generateAsyncApiTypes(specPath: string): Promise<string> {
  const raw = await readFile(specPath, 'utf8');
  const doc = loadYaml(raw) as JsonSchemaLike;

  const componentsRaw = doc.components as JsonSchemaLike | undefined;
  const schemas = componentsRaw?.schemas as Record<string, JsonSchemaLike> | undefined;
  if (!schemas || Object.keys(schemas).length === 0) {
    throw new Error(`No components.schemas found in ${specPath}`);
  }

  const definitions = sortKeys(rewriteRefs(schemas) as Record<string, JsonSchemaLike>);

  const rootSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'AsyncApiComponents',
    type: 'object' as const,
    definitions,
  };

  const compiled = await compile(rootSchema, 'AsyncApiComponents', {
    bannerComment: '',
    unreachableDefinitions: true,
    additionalProperties: false,
    style: { semi: true, singleQuote: true, printWidth: 100, trailingComma: 'all' },
  });

  // json-schema-to-typescript always emits an interface for the root schema
  // itself (here just the `definitions` wrapper, of no use to a consumer —
  // it has no `properties` of its own, only `definitions`, which the tool
  // never renders as members). Strip it: it is the one artefact of the
  // wrapping trick that should not leak into the public surface.
  //
  // The root interface's body is guaranteed brace-free (no `properties`
  // means no nested object literal can appear inside it), so `[^{}]*` safely
  // bounds the match without risking a runaway non-greedy scan swallowing
  // real content — j2ts renders an *empty* body as `{}` on one line (no
  // `\n` before the closing brace), which a naive `[\s\S]*?\n\}` pattern
  // does not match and will instead run on to consume the next unrelated
  // interface's closing brace. Caught by `index.spec.ts`'s completeness
  // assertion, which is exactly why that assertion exists.
  const withoutRootInterface = compiled.replace(
    /export interface AsyncApiComponents \{[^{}]*\}\n+/,
    '',
  );

  return bannerFor('specs/shared/asyncapi.yaml') + withoutRootInterface.trimEnd() + '\n';
}
