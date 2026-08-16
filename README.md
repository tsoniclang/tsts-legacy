# tsts

TSTS is a TypeScript-native TypeScript compiler project. Its frontend target is the exact TS-Go schema-level AST contract, with two long-term products:

1. A native Tsonic self-hosting compiler backend.
2. An end-user `tsc` replacement that emits JavaScript, declarations, source maps, and build outputs.

## Current Foundation

The repository currently vendors the pinned TS-Go AST schema under `schema/tsgo/` and generates TypeScript contract metadata from it.

```sh
npm install
npm run verify
```

## Contract Rule

Do not hand-maintain AST kind ids, node fields, aliases, or list aliases. They are generated from `schema/tsgo/ast.json` and checked against `schema/tsgo/VERSION.md`.

## Checked Source Contract

The public semantic boundary is `CompilerSession.checkSource()`. It returns one
immutable `CheckedSourceProgram` for the program revision:

```ts
const checked = session.checkSource();
const sourceFile = checked.getSourceFile("/src/index.ts");
const call = findCall(sourceFile, checked.ast);
const selected = checked.checker.getResolvedCallInfo(call);
```

Contextually checked object-literal members use the same atomic boundary. For
example, given `const value: Counter = { next() { return 1; } }`, a target asks
`getResolvedObjectLiteralElementInfo(nextMethod)` and receives the exact
contextual `Counter.next` symbol, declaration, and instantiated callable type.
The target does not join the authored method to `Counter.next` by spelling.

`CheckedSourceProgram` owns the one shared AST, checker-query, type-shape, and
source-fact capabilities. Targets do not construct query facades or select a
checker/source-file pair. Every query derives checker ownership from its exact
node, symbol, type, or signature subject. The complete source diagnostic gate
runs before this capability is published.

Direct queries return TS-Go semantic subjects and target-neutral selected
source evidence. They do not publish target operations, target types, runtime
carriers, or target diagnostics.

## Source Extensions

A compiler extension has two optional phases:

```ts
const extension = {
  identity: { id: "example.source", version: "1.0.0" },
  initialize(context) {
    context.registerSourceDeclarationProvider(provider);
  },
  analyzeSource(context) {
    // Read the checked source through context.source.
    // Write only source facts owned by this extension.
  },
};
```

Initialization registers immutable source capabilities. Source analysis runs
once after normal checking, in dependency order and inside one owner
transaction. Success commits source facts and diagnostics; failure rolls back
the analyzer and invalidates the complete source-fact result. There is no
target callback, deferred target observation, replay API, or compatibility
lifecycle.

## Source Provider Contract

`TstsSourceProviderContractVersion` is one strict source-only contract. TSTS
does not accept legacy declaration models.

- Provider models describe legal TypeScript declaration syntax only.
- `string`, `array`, `source-global`, `provider-ref`, and the other
  `ProviderTypeExpression` variants contain source meaning, never target
  wrappers.
- Every function type has a stable, non-empty semantic `id`.
- Provider refs are explicitly bound and validated against declared imports or
  same-module exports.
- Source type families preserve one public source name while keeping every
  arity variant distinct.
- Provider registration, models, callback results, and closure artifacts are
  immutable deterministic snapshots.
- Imports, aliases, namespace access, slice order, and provider virtual
  filenames do not redefine semantic identity.

Large providers may declare `declarationMaterialization: "incremental"`.
Their first model contains stable export identities and type headers. When
normal source checking needs the structure of an exact provider type, TSTS
requests that exact public export and, for a type family, its exact export id:

```ts
import type { List } from "@example/System.Collections.Generic.js";

declare const values: List<number>;
export const count = values.Count;
```

For this source, an incremental provider first receives:

```ts
{
  context: namedImportContext,
  materialization: { kind: "incremental", completeExports: [] },
}
```

After the checker requires `List<number>` members, the next immutable program
revision receives:

```ts
{
  context: namedImportContext,
  materialization: {
    kind: "incremental",
    completeExports: [{ exportName: "List", exportId: listProviderExportId }],
  },
}
```

Demand grows monotonically. TSTS discards the provisional program, constructs
a fresh program from the enlarged provider snapshot, and publishes only the
stable checked revision. Providers do not infer demand from member names or
source text, and targets do not replay checking. Providers declaring
`declarationMaterialization: "complete"` retain the one-model contract.
