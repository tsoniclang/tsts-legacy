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

`getResolvedCallableCompletionInfo(declaration)` returns the exact callable and
whether its block can fall through, using the checker's existing end-flow
reachability. For `function maybe(flag: boolean) { if (flag) return 1; }`,
`canFallThrough` is true. It is false for `() => 1` and for a function whose
body always returns, throws, or does not terminate. Bodyless declarations and
non-callable syntax have no completion result. Results are immutable and
memoized within the checked program; this query does not replay source analysis.

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

## Target AST Encoding

Targets encode their lowered TS-Go AST through `@tsonic/tsts/target-ast`.
The existing encoder accepts an optional complete resource-limit record:

```ts
import {
  defaultTargetAstEncodingLimits,
  encodeTargetSourceFileForPrinting,
  type TargetAstEncodingLimits,
} from "@tsonic/tsts/target-ast";

const limits: TargetAstEncodingLimits = {
  ...defaultTargetAstEncodingLimits,
  maximumNodeRows: 4_194_304,
  maximumEncodedBytes: 128 * 1024 * 1024,
};
const payload = encodeTargetSourceFileForPrinting(loweredSourceFile, limits);
```

Here `loweredSourceFile` is the target-owned transformed `SourceFile`. The
numbers illustrate a finite selection, not a measured production requirement.
Omitting the second argument, or passing `undefined`, uses the unchanged
frozen defaults. A supplied record must contain all eight fields; spread the
defaults to select the remaining limits deliberately. There is one encoder,
and limits do not change its output bytes.

| Limit | Default | Supported ceiling |
| --- | --- | --- |
| `maximumNodeRows` | 2,097,152 | 153,391,689 rows; each row occupies 28 bytes |
| `maximumDepth` | 1,024 | 1,024; bounds the current recursive traversal |
| `maximumStringCount` | 1,048,576 | 8,388,608 strings; each uses two offset-table entries |
| `maximumStringBytes` | 256 MiB | 4 GiB minus one byte |
| `maximumSingleStringBytes` | 64 MiB | The selected `maximumStringBytes` |
| `maximumExtendedWords` | 4,194,304 | 4,194,304 words, or 16 MiB, within the wire offset range |
| `maximumStructuredBytes` | 16 MiB | 4 GiB minus one byte |
| `maximumEncodedBytes` | 512 MiB | 4 GiB minus one byte, including the 44-byte header |

Limits must be positive safe integers supplied as own enumerable data fields.
Missing/unknown fields, accessors, nonfinite values and inconsistent string
limits are rejected. Selection is copied into an immutable per-call snapshot;
neither caller mutation nor an earlier failed call changes another call's
budget. A failure throws `TargetAstEncodingError` and returns no payload.

Rows include the sentinel row, source-file root, node-list rows and required
protocol completion nodes. Strings are counted per encoded occurrence, in
UTF-8 bytes, including source text, file names and paths. Each string also
charges eight offset-table bytes. Extended words and structured metadata
charge their own sizes. These charges count toward the encoded-byte limit
before growing the corresponding retained tables. Cycle, actual wire-value
and final encoded-length checks remain independent.

The ceilings need not all be reachable at once: the encoded-byte limit can
reject before any individual table reaches its ceiling. Increasing node
capacity does not widen the fixed string-index or extended-offset wire fields.
This is a wire-capacity budget, not a heap/RSS bound; the input AST and
serialization buffers still require an external process memory guard.

Consumers own their printer-frame and batch limits. Measure the complete
returned payload and enforce those limits before publication. A first rejected
reservation is not the complete AST size, and an adequate node limit alone
does not establish that the complete frame fits.
