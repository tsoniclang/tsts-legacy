import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalIdentityFactKey,
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  sourcePrimitive,
  sourcePrimitiveFactKey,
  sourceSemanticsExtensionId,
} from "../index.js";
import type { Node, SourcePrimitiveFact } from "../index.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import type { ProviderDeclarationModel } from "./host.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";

test("source semantics keep provider declarations and authored aliases in separate identity domains", () => {
  const moduleSpecifier = "@test/provider-primitives.js";
  const providerModuleId = "Test.ProviderPrimitives";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId,
    exports: [{
      id: "Test.Int32",
      name: "int",
      kind: "type",
      type: { kind: "number" },
    }],
  };
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { int } from "${moduleSpecifier}";`,
        "export type Value = int;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [
        sourceProviderExtension(new Map([[moduleSpecifier, model]])),
        createSourceSemanticsExtension({
          modules: [{
            moduleSpecifier,
            packageName: "@test/provider-primitives",
            subpath: "types.js",
            capabilities: ["primitive"],
            exports: [sourcePrimitive("int", "int32", "number", true, 32)],
          }],
        }),
      ],
    },
  }).checkSource();

  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map(Diagnostic_String).join("\n"),
  );
  assert.deepEqual(checked.extensionDiagnostics, []);

  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const importSpecifiers = findNodes(
    sourceFile,
    source.ast.children,
    source.ast.is.IsImportSpecifier,
  );
  assert.equal(importSpecifiers.length, 1);
  const localSymbol = Node_Symbol(importSpecifiers[0]);
  assert.ok(localSymbol !== undefined);
  const selectedSymbol = source.checker.getAliasedSymbol(localSymbol);
  assert.ok(selectedSymbol !== undefined);
  assert.notEqual(selectedSymbol, localSymbol);

  assert.deepEqual(
    checked.sourceFacts.getFact(localSymbol, canonicalIdentityFactKey),
    {
      kind: "export",
      id: `${moduleSpecifier}::int`,
      packageName: "@test/provider-primitives",
      subpath: "types.js",
      exportName: "int",
      importKind: "type",
      canonicalSymbolId: checked.sourceFacts.getFact(localSymbol, canonicalIdentityFactKey)?.canonicalSymbolId,
    },
  );
  assert.deepEqual(
    checked.sourceFacts.getFact(selectedSymbol, canonicalIdentityFactKey),
    {
      kind: "export",
      id: `${providerModuleId}::int`,
      subpath: moduleSpecifier,
      exportName: "int",
      canonicalSymbolId: checked.sourceFacts.getFact(selectedSymbol, canonicalIdentityFactKey)?.canonicalSymbolId,
    },
  );
  assert.equal(checked.sourceFacts.getFact(localSymbol, sourcePrimitiveFactKey)?.kind, "int32");
  assert.equal(checked.sourceFacts.getFact(selectedSymbol, sourcePrimitiveFactKey), undefined);

  const typeReferences = findNodes(
    sourceFile,
    source.ast.children,
    source.ast.is.IsTypeReferenceNode,
  );
  assert.equal(typeReferences.length, 1);
  assert.equal(checked.sourceFacts.getFact(typeReferences[0], sourcePrimitiveFactKey)?.kind, "int32");
});

const primitiveModule = "@test/primitives.js";
const primitiveModel: ProviderDeclarationModel = {
  moduleSpecifier: primitiveModule,
  providerModuleId: "Test.Primitives",
  exports: [
    { id: "Word", name: "word", kind: "type", type: { kind: "number" } },
    { id: "Wide", name: "wide", kind: "type", type: { kind: "bigint" } },
    { id: "Unsigned", name: "unsigned", kind: "type", type: { kind: "bigint" } },
  ],
};

for (const selection of [
  { name: "direct", source: `import type { word } from "${primitiveModule}"; export type Value = word;`, kind: "int32", runtimeBase: "number", signed: true, width: 32 },
  { name: "renamed", source: `import type { wide as Exact } from "${primitiveModule}"; export type Value = Exact;`, kind: "int64", runtimeBase: "bigint", signed: true, width: 64 },
  { name: "namespace", source: `import type * as native from "${primitiveModule}"; export type Value = native.unsigned;`, kind: "uint64", runtimeBase: "bigint", signed: false, width: 64 },
  { name: "reexport", source: 'import type { Renamed } from "./bridge.js"; export type Value = Renamed;', kind: "int64", runtimeBase: "bigint", signed: true, width: 64 },
  { name: "namespace reexport", source: 'import type * as bridge from "./bridge.js"; export type Value = bridge.Renamed;', kind: "int64", runtimeBase: "bigint", signed: true, width: 64 },
] as const) {
  test(`source primitive ${selection.name} has one exact early and final fact`, () => {
    let subject: Node | undefined;
    let early: SourcePrimitiveFact | undefined;
    const checked = primitiveSession(selection.source, (node, fact) => {
      subject = node;
      early = fact;
      const { kind, runtimeBase, signed, width } = selection;
      assert.deepEqual(fact, { kind, runtimeBase, signed, width });
      assert.equal(Object.isFrozen(fact), true);
    });
    assert.ok(subject);
    assert.equal(checked.sourceFacts.getFact(subject, sourcePrimitiveFactKey), early);
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.deepEqual(checked.extensionDiagnostics, []);
  });
}

for (const selection of [
  { name: "local declaration", source: "type word = number; export type Value = word;" },
  { name: "type parameter", source: `import type { word } from "${primitiveModule}"; export type Value<word> = word;` },
  { name: "unconfigured provider", source: 'import type { word } from "@test/foreign.js"; export type Value = word;' },
  { name: "unconfigured namespace", source: 'import type * as foreign from "@test/foreign.js"; export type Value = foreign.word;' },
]) {
  test(`source primitive demands do not recognize an unrelated ${selection.name}`, () => {
    let subject: Node | undefined;
    const checked = primitiveSession(selection.source, (node, fact) => {
      subject = node;
      assert.equal(fact, undefined);
    });
    assert.ok(subject);
    assert.equal(checked.sourceFacts.getFact(subject, sourcePrimitiveFactKey), undefined);
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.deepEqual(checked.extensionDiagnostics, []);
  });
}

test("early primitive demands retain ordinary source errors", () => {
  const checked = primitiveSession(
    `import type { word } from "${primitiveModule}"; export const invalid: word = "not a number";`,
    (_node, fact) => assert.equal(fact?.kind, "int32"),
  );
  assert.equal(checked.diagnostics.length, 1);
  assert.match(Diagnostic_String(checked.diagnostics[0]), /not assignable/);
  assert.deepEqual(checked.extensionDiagnostics, []);
});

function primitiveSession(
  sourceText: string,
  inspect: (node: Node, fact: SourcePrimitiveFact | undefined) => void,
) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": sourceText,
      "/src/bridge.ts": `export type { wide as Renamed } from "${primitiveModule}";`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true },
    extensionHostOptions: {
      extensions: [
        sourceProviderExtension(new Map([
          [primitiveModule, primitiveModel],
          ["@test/foreign.js", { ...primitiveModel, moduleSpecifier: "@test/foreign.js", providerModuleId: "Test.Foreign" }],
        ])),
        createSourceSemanticsExtension({ modules: [{
          moduleSpecifier: primitiveModule,
          exports: [
            sourcePrimitive("word", "int32", "number", true, 32),
            sourcePrimitive("wide", "int64", "bigint", true, 64),
            sourcePrimitive("unsigned", "uint64", "bigint", false, 64),
          ],
        }] }),
        {
          identity: { id: "test.primitive-demand", version: "1" },
          dependencies: { dependsOn: [sourceSemanticsExtensionId] },
          elaborateSource(context) {
            const file = context.source.getSourceFile("/src/index.ts");
            const source = context.source.getSourceFileQueries(file);
            const references = findNodes(file, source.ast.children, source.ast.is.IsTypeReferenceNode);
            assert.equal(references.length, 1);
            const node = references[0];
            assert.ok(node);
            const fact = context.factResolver.resolve(node, sourcePrimitiveFactKey);
            inspect(node, fact);
            assert.equal(context.factResolver.resolve(node, sourcePrimitiveFactKey), fact);
          },
        },
      ],
    },
  }).checkSource();
}
