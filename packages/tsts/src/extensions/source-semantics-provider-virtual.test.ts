import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalIdentityFactKey,
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  sourcePrimitive,
  sourcePrimitiveFactKey,
} from "../index.js";
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
