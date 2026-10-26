import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalIdentityFactKey,
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  sourcePrimitive,
  sourcePrimitiveFactKey,
  sourceMarkerFactKey,
} from "../index.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import { Type_Symbol } from "../internal/checker/types.js";
import { getExtensionHost, type ProviderDeclarationModel, type SourceAnalysisContext } from "./host.js";
import type { SourceMarkerFact } from "./facts.js";
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

for (const [explicitImport, conflicting] of [[false, false], [true, false], [false, true]]) {
  test(`canonical provider type markers are published before finalization with explicit import=${explicitImport}, conflicting=${conflicting}`, () => {
    const typesModule = "@test/exact/types.js";
    const valuesModule = "@test/exact/values.js";
    const foreignModule = "@test/foreign/types.js";
    const exact = { kind: "provider-ref", moduleSpecifier: typesModule, exportName: "JsString" } as const;
    const models: ReadonlyMap<string, ProviderDeclarationModel> = new Map([
      [typesModule, {
        moduleSpecifier: typesModule,
        providerModuleId: "Test.Exact.Types",
        exports: [{
          id: "Test.Exact.JsString", name: "JsString", kind: "interface",
          members: [{ id: "Test.Exact.length", name: "length", kind: "property", readonly: true, type: { kind: "number" } }],
        }, {
          id: "Test.Exact.Callback", name: "Callback", kind: "type",
          type: { kind: "function", id: "Test.Exact.Callback.signature", parameters: [{ name: "value", type: exact }], returnType: exact },
        }],
      }],
      [foreignModule, {
        moduleSpecifier: foreignModule,
        providerModuleId: "Test.Foreign.Types",
        exports: [{
          id: "Test.Foreign.JsString", name: "JsString", kind: "interface",
          members: [{ id: "Test.Foreign.length", name: "length", kind: "property", readonly: true, type: { kind: "number" } }],
        }],
      }],
      [valuesModule, {
        moduleSpecifier: valuesModule,
        providerModuleId: "Test.Exact.Values",
        imports: [{
          moduleSpecifier: typesModule,
          typeOnly: true,
          namedImports: [{ exportedName: "JsString", kind: "type" }, { exportedName: "Callback", kind: "type" }],
        }, {
          moduleSpecifier: foreignModule,
          typeOnly: true,
          namedImports: [{ exportedName: "JsString", localName: "ForeignString", kind: "type" }],
        }],
        exports: [{
          id: "Test.Exact.make", name: "make", kind: "function",
          signatures: [{ id: "Test.Exact.make()", parameters: [], returnType: exact }],
        }, {
          id: "Test.Exact.use", name: "use", kind: "function",
          signatures: [{ id: "Test.Exact.use(Callback)", parameters: [{
            name: "callback", type: { kind: "provider-ref", moduleSpecifier: typesModule, exportName: "Callback" },
          }], returnType: { kind: "number" } }],
        }, {
          id: "Test.Exact.foreign", name: "foreign", kind: "function",
          signatures: [{ id: "Test.Exact.foreign()", parameters: [], returnType: {
            kind: "provider-ref", moduleSpecifier: foreignModule, exportName: "JsString", localName: "ForeignString",
          } }],
        }],
      }],
    ]);
    let conflictingSymbol: ReturnType<typeof Type_Symbol> = undefined;
    const session = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/core.d.ts", "/src/index.ts"],
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        "/src/index.ts": [
          `import { make, use, foreign } from "${valuesModule}";`,
          ...(explicitImport ? [`import type { JsString } from "${typesModule}";`] : []),
          "const temporary = make();",
          "const stored = temporary;",
          "function factory() { return make(); }",
          "const returned = factory();",
          "use(value => value);",
          "const other = foreign();",
          "const plain = \"plain\";",
        ].join("\n"),
      },
      compilerOptions: testNoLibCompilerOptions,
      extensionHostOptions: {
        extensions: [
          sourceProviderExtension(models),
          createSourceSemanticsExtension({
            modules: [{
              moduleSpecifier: typesModule,
              exports: [{ kind: "type-marker", exportName: "JsString", marker: "js-string" }],
            }],
          }),
          ...(conflicting ? [{
            identity: { id: "test.conflicting-type-marker", version: "1.0.0" },
            dependencies: { dependsOn: ["tsts.source-semantics"] },
            analyzeSource(context: SourceAnalysisContext): void {
              const file = context.source.getSourceFile("/src/index.ts");
              const queries = context.source.getSourceFileQueries(file);
              const declaration = findNodes(file, queries.ast.children, queries.ast.is.IsVariableDeclaration)
                .find(node => queries.ast.text(queries.ast.name(node)) === "temporary");
              const type = queries.checker.getTypeAtLocation(declaration);
              const symbol = Type_Symbol(type);
              if (symbol === undefined) throw new Error("the inverse requires the actual canonical checked symbol");
              conflictingSymbol = symbol;
              assert.deepEqual(context.facts.get(symbol, sourceMarkerFactKey), { kind: "type-marker", marker: "js-string" });
              const conflictingMarker: SourceMarkerFact = { kind: "type-marker", marker: "fixed-array" };
              assert.equal(context.facts.set(symbol, sourceMarkerFactKey, conflictingMarker, []), "conflict");
            },
          }] : []),
        ],
      },
    });
    if (conflicting) {
      const host = getExtensionHost(session.program!);
      assert.ok(host !== undefined);
      assert.throws(() => session.checkSource(), /Cannot commit an extension fact transaction after a fact write failed/u);
      assert.equal(host.diagnostics.all().filter(diagnostic =>
        diagnostic.extensionCode === "FACT_WRITER_OWNERSHIP_VIOLATION").length, 1);
      assert.ok(conflictingSymbol !== undefined);
      assert.equal(host.facts.get(conflictingSymbol, sourceMarkerFactKey) === undefined, true, "a rejected transaction publishes no semantic marker");
      return;
    }
    const checked = session.checkSource();
    assert.equal(checked.diagnostics.length, 0, [
      ...checked.diagnostics.map(Diagnostic_String),
      ...checked.extensionDiagnostics.map(diagnostic => diagnostic.extensionCode + ": " + diagnostic.message),
    ].join("\n"));
    assert.equal(checked.extensionDiagnostics.length, 0, "the exact provider source is checked");
    const sourceFile = checked.getSourceFile("/src/index.ts");
    const source = checked.getSourceFileQueries(sourceFile);
    const declarations = findNodes(sourceFile, source.ast.children, source.ast.is.IsVariableDeclaration);
    const canonical = declarations.find(node => source.ast.text(source.ast.name(node)) === "temporary");
    assert.equal(canonical !== undefined, true, "the original factory value is present");
    const canonicalType = source.checker.getTypeAtLocation(canonical);
    const canonicalSymbol = Type_Symbol(canonicalType);
    assert.equal(canonicalSymbol !== undefined, true, "the checked canonical type has its bound symbol");
    for (const declaration of declarations) {
      const name = source.ast.text(source.ast.name(declaration));
      const type = source.checker.getTypeAtLocation(declaration);
      const symbol = Type_Symbol(type);
      if (name === "other" || name === "plain") {
        assert.equal(checked.sourceFacts.getFact(symbol, sourceMarkerFactKey) === undefined, true, name);
      } else {
        assert.equal(symbol === canonicalSymbol, true, name + ": exact checked native type identity");
        assert.deepEqual(checked.sourceFacts.getFact(symbol, sourceMarkerFactKey), { kind: "type-marker", marker: "js-string" }, name);
      }
    }
    const parameters = findNodes(sourceFile, source.ast.children, source.ast.is.IsParameterDeclaration);
    assert.equal(parameters.length, 1, "the genuinely unannotated callback is retained");
    const parameterType = source.checker.getTypeAtLocation(parameters[0]);
    assert.equal(Type_Symbol(parameterType) === canonicalSymbol, true, "contextual callback alias uses the canonical symbol");
    assert.deepEqual(checked.sourceFacts.getFact(Type_Symbol(parameterType), sourceMarkerFactKey), { kind: "type-marker", marker: "js-string" });
  });
}
