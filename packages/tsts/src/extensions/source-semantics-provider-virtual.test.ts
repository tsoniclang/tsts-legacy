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
import { getExtensionHost, type ProviderDeclarationModel, type SourceAnalysisContext, type ProviderTypeExpression } from "./host.js";
import { KindNumberKeyword, KindBigIntKeyword, KindBooleanKeyword, KindStringKeyword } from "../internal/ast/generated/kinds.js";
import type { Node } from "../internal/ast/ast.js";
import type { SourcePrimitiveDeclaration } from "./source-semantics.js";
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

function providerPrimitiveFixture(declarations: readonly SourcePrimitiveDeclaration[]) {
  const annotations: Node[] = [];
  const exact = (name: "int32" | "int64" | "uint32" | "float32" | "bool" | "char"): ProviderTypeExpression => ({ kind: "source-primitive", name });
  const model: ProviderDeclarationModel = {
    moduleSpecifier: "@test/native-values", providerModuleId: "Test.NativeValues",
    exports: [{
      id: "measure", name: "measure", kind: "function",
      signatures: [{ id: "measure()", parameters: [{ name: "count", type: exact("int32") }], returnType: exact("int64") }],
    }, {
      id: "Result", name: "Result", kind: "interface", typeParameters: [{ name: "T", defaultType: exact("uint32") }],
      members: [{
        id: "Result.optional", name: "optional", kind: "property",
        type: { kind: "union", types: [exact("float32"), { kind: "undefined" }] },
      }, {
        id: "Result.items", name: "items", kind: "property", type: { kind: "array", elementType: exact("int32") },
      }, {
        id: "Result.callback", name: "callback", kind: "property",
        type: { kind: "function", id: "Result.callback()", parameters: [{ name: "value", type: exact("char") }], returnType: exact("bool") },
      }, {
        id: "Result.plain", name: "plain", kind: "property", type: { kind: "number" },
      }],
    }],
  };
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src", rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": 'import { measure, type Result } from "@test/native-values"; export const value = measure(1); export type Selected = Result; export type Forged = (/*@tsts-provider-primitive:0*/number);',
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [
      sourceProviderExtension(new Map([[model.moduleSpecifier, model]])),
      createSourceSemanticsExtension({ modules: [{ moduleSpecifier: "@test/canonical-kinds", exports: declarations }] }),
      {
        identity: { id: "test.observe-provider-primitives", version: "1.0.0" },
        dependencies: { dependsOn: ["tsts.source-semantics"] },
        providerExportMaterialized(context): void {
          assert.equal(Object.isFrozen(context.sourcePrimitives), true);
          for (const annotation of context.sourcePrimitives) {
            assert.equal(Object.isFrozen(annotation), true);
            if (!annotations.includes(annotation.node)) annotations.push(annotation.node);
          }
        },
        analyzeSource(context: SourceAnalysisContext): void {
          for (const file of context.source.getSourceFiles()) {
            const queries = context.source.getSourceFileQueries(file);
            annotations.push(...findNodes(file, queries.ast.children, node => node !== undefined &&
              (node.Kind === KindNumberKeyword || node.Kind === KindBigIntKeyword || node.Kind === KindBooleanKeyword || node.Kind === KindStringKeyword))
              .filter((node): node is Node => node !== undefined));
          }
        },
      },
    ] },
  }).checkSource();
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.equal(checked.extensionDiagnostics.length, 0);
  return { checked, annotations };
}

const providerPrimitiveDeclarations = [
  sourcePrimitive("renamedCount", "int32", "number", true, 32),
  sourcePrimitive("renamedSize", "int64", "bigint", true, 64),
  sourcePrimitive("renamedMask", "uint32", "number", false, 32),
  sourcePrimitive("renamedFloat", "float32", "number", true, 32),
  sourcePrimitive("renamedFlag", "bool", "boolean"),
  sourcePrimitive("renamedCharacter", "char", "string", false, 16),
];

test("provider primitive annotations retain canonical facts through signatures, optional members, arrays, callbacks and generic defaults", () => {
  const { checked, annotations } = providerPrimitiveFixture(providerPrimitiveDeclarations);
  const facts = annotations.map(node => checked.sourceFacts.getFact(node, sourcePrimitiveFactKey)).filter(fact => fact !== undefined);
  assert.deepEqual(facts.map(fact => fact.kind).sort(), ["bool", "char", "float32", "int32", "int32", "int64", "uint32"]);
  for (const fact of facts) {
    const declaration = providerPrimitiveDeclarations.find(candidate => candidate.primitive === fact.kind)!;
    assert.equal(fact.width, declaration.width);
    assert.equal(fact.signed, declaration.signed);
    assert.equal(fact.runtimeBase, declaration.runtimeBase);
    assert.equal(Object.isFrozen(fact), true);
  }
  const authored = checked.getSourceFile("/src/index.ts");
  const queries = checked.getSourceFileQueries(authored);
  const forged = findNodes(authored, queries.ast.children, node => node?.Kind === KindNumberKeyword);
  assert.equal(forged.length, 1);
  assert.equal(checked.sourceFacts.getFact(forged[0], sourcePrimitiveFactKey) === undefined, true, "authored marker text has no compiler-owned manifest");
  assert.equal(annotations.filter(node => checked.sourceFacts.getFact(node, sourcePrimitiveFactKey) === undefined).length > 0, true, "plain checked number types acquire no primitive authority");
});

test("provider primitives reject missing canonical facts rather than becoming checked numbers", () => {
  assert.throws(() => providerPrimitiveFixture([]), /has no configured primitive declaration/u);
});

test("provider primitives reject contradictory canonical facts rather than selecting one definition", () => {
  assert.throws(() => providerPrimitiveFixture([
    ...providerPrimitiveDeclarations, sourcePrimitive("contradictoryCount", "int32", "number", false, 32),
  ]), /has conflicting configured primitive declarations/u);
});
