import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { Node_Expression } from "../internal/ast/ast.js";
import { ExtensionHost, type ProviderDeclarationModel, type ProviderExportDeclaration } from "./host.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import { getProviderExportContractKeyMap, getProviderIncrementalExportContractMap } from "./provider-export-contract.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/native/facets.js";
const identity = "Native.Shared.Intrinsic";

function model(exports: readonly ProviderExportDeclaration[]): ProviderDeclarationModel {
  return { moduleSpecifier, providerModuleId: "Native.Facets", exports };
}

function check(exports: readonly ProviderExportDeclaration[], source: string, files: Readonly<Record<string, string>> = {}) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts", ...Object.keys(files)],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": source, ...files },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model(exports)]]))] },
  }).checkSource();
}

const functionDeclaration: ProviderExportDeclaration = {
  id: "Native.Shared.Function", intrinsicId: identity, name: "shared", kind: "function",
  signatures: [{
    id: "Native.Shared.Function.call",
    parameters: [{ name: "value", type: { kind: "number" } }],
    returnType: { kind: "number" },
  }],
};

test("ordinary and intrinsic facets preserve distinct identities through aliases and re-exports", () => {
  const checked = check([functionDeclaration], [
    'import { renamed as shared } from "./bridge.js";',
    `import * as native from "${moduleSpecifier}";`,
    "export const first: number = shared(4);",
    "export const second: number = native.shared(8);",
  ].join("\n"), {
    "/src/bridge.ts": `export { shared as renamed } from "${moduleSpecifier}";`,
  });
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(checked.extensionDiagnostics, []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const calls = findNodes(file, checked.ast.children, checked.ast.is.IsCallExpression);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const info = queries.checker.getIntrinsicDeclarationInfo(Node_Expression(call));
    assert.ok(info);
    assert.equal(info.declaration.exportId, identity);
    assert.equal(checked.sourceFacts.getFact(info.symbol, providerVirtualDeclarationFactKey)?.exportId, functionDeclaration.id);
    assert.equal(queries.checker.getResolvedCallInfo(call)?.outcome, "applicable");
    assert.equal(queries.checker.getCallSignaturesOfType(queries.checker.getTypeAtLocation(Node_Expression(call))).length, 1);
  }
});

test("adding an intrinsic facet does not loosen an ordinary signature", () => {
  const checked = check([functionDeclaration], [
    `import { shared } from "${moduleSpecifier}";`,
    'shared("wrong");',
  ].join("\n"));
  assert.deepEqual(checked.diagnostics.map(Diagnostic_Code), [2345]);
});

for (const kind of ["type", "interface", "class", "enum", "value", "namespace"] as const) {
  test(`${kind} declarations retain their ordinary facet and exact intrinsic identity`, () => {
    const declaration: ProviderExportDeclaration = {
      id: `Native.Shared.${kind}`, intrinsicId: identity, name: "shared", kind,
      ...(kind === "type" || kind === "value" ? { type: { kind: "number" as const } } : {}),
    };
    const checked = check([declaration], [
      `import { shared } from "${moduleSpecifier}";`,
      `import * as native from "${moduleSpecifier}";`,
      "export const selected: typeof shared = native.shared;",
      ...(kind === "type" ? ["export const ordinary: shared = 4;"] : []),
      ...(kind === "interface" ? ["export const ordinary: shared = {};"] : []),
      ...(kind === "class" ? ["export const ordinary: shared = new shared();"] : []),
      ...(kind === "value" ? ["export const ordinary: number = shared;"] : []),
    ].join("\n"));
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.deepEqual(checked.extensionDiagnostics, []);
    const file = checked.getSourceFile("/src/index.ts");
    assert.ok(file);
    const queries = checked.getSourceFileQueries(file);
    const expression = findNodes(file, checked.ast.children, checked.ast.is.IsPropertyAccessExpression)[0];
    assert.ok(expression);
    const info = queries.checker.getIntrinsicDeclarationInfo(expression);
    assert.ok(info);
    assert.equal(info.declaration.exportId, identity);
    assert.equal(checked.sourceFacts.getFact(info.symbol, providerVirtualDeclarationFactKey)?.exportId, declaration.id);
    if (kind === "type" || kind === "interface") {
      assert.deepEqual(queries.checker.getCallSignaturesOfType(queries.checker.getTypeAtLocation(expression)), []);
      const document = checked.sourceFacts.getVirtualDeclarationDocument(info.declaration.artifactFileName);
      assert.ok(document);
      assert.match(document.sourceText, /:\s*unique symbol;/u);
    }
  });
}

for (const kind of ["interface", "type"] as const) {
  test(`default ${kind} exports retain both facets without duplicate default declarations`, () => {
    const checked = check([{
      id: "Native.Default.Type", intrinsicId: identity, name: "Local", kind, exportKind: "default",
      ...(kind === "type" ? { type: { kind: "number" as const } } : {}),
    }], [
      `import Selected from "${moduleSpecifier}";`,
      "export const token: typeof Selected = Selected;",
      kind === "type" ? "export const value: Selected = 3;" : "export const value: Selected = {};",
    ].join("\n"));
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.deepEqual(checked.extensionDiagnostics, []);
  });
}

function familyDeclarations(intrinsicId: string | undefined = identity): readonly ProviderExportDeclaration[] {
  return [0, 1].map((typeArgumentCount) => ({
    id: `Native.Shared.Type${typeArgumentCount}`,
    ...(intrinsicId === undefined ? {} : { intrinsicId }),
    name: `Shared${typeArgumentCount}`, kind: "interface" as const,
    sourceTypeFamily: { exportName: "Shared", typeArgumentCount },
    ...(typeArgumentCount === 0 ? {} : { typeParameters: [{ name: "T" }] }),
  }));
}

test("type families expose one intrinsic identity alongside every exact type arity", () => {
  const checked = check(familyDeclarations(), [
    `import { Shared } from "${moduleSpecifier}";`,
    `import * as native from "${moduleSpecifier}";`,
    "export const token: typeof Shared = native.Shared;",
    "export const first: Shared = {};",
    "export const second: Shared<number> = {};",
  ].join("\n"));
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(checked.extensionDiagnostics, []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const expression = findNodes(file, checked.ast.children, checked.ast.is.IsPropertyAccessExpression)[0];
  assert.ok(expression);
  const queries = checked.getSourceFileQueries(file);
  assert.equal(queries.checker.getIntrinsicDeclarationInfo(expression)?.declaration.exportId, identity);
  assert.deepEqual(queries.checker.getCallSignaturesOfType(queries.checker.getTypeAtLocation(expression)), []);
});

test("intrinsic facets are immutable and included in canonical and incremental contracts", () => {
  const declaration = { ...functionDeclaration };
  const host = new ExtensionHost({}, {
    extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model([declaration])]]))],
  });
  const resolved = host.providers.resolveVirtualModule(moduleSpecifier);
  assert.equal(resolved.kind, "resolved");
  if (resolved.kind !== "resolved") return;
  const changed = { ...declaration, intrinsicId: "Native.Other.Intrinsic" };
  assert.notDeepEqual(getProviderExportContractKeyMap(moduleSpecifier, [declaration]), getProviderExportContractKeyMap(moduleSpecifier, [changed]));
  assert.notDeepEqual(getProviderIncrementalExportContractMap(moduleSpecifier, [declaration]), getProviderIncrementalExportContractMap(moduleSpecifier, [changed]));
  assert.equal(Reflect.set(declaration, "intrinsicId", changed.intrinsicId), true);
  assert.equal(resolved.module.declarationModel.exports[0]?.intrinsicId, identity);
  assert.equal(Object.isFrozen(resolved.module.declarationModel.exports[0]), true);
});

test("conflicting and malformed intrinsic facets reject before publication", () => {
  const invalid: readonly (readonly ProviderExportDeclaration[])[] = [
    [{ ...functionDeclaration, intrinsicId: "" }],
    [{ ...functionDeclaration, intrinsicId: functionDeclaration.id }],
    [{ id: "Native.Intrinsic", name: "shared", kind: "intrinsic", intrinsicId: identity }],
    familyDeclarations().map((declaration, index) => ({ ...declaration, intrinsicId: `${identity}.${index}` })),
    familyDeclarations().map((declaration, index) => index === 0 ? declaration : {
      id: declaration.id, name: declaration.name, kind: declaration.kind,
      sourceTypeFamily: declaration.sourceTypeFamily!, typeParameters: declaration.typeParameters!,
    }),
  ];
  for (const declarations of invalid) {
    const host = new ExtensionHost({}, {
      extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model(declarations)]]))],
    });
    assert.equal(host.providers.resolveVirtualModule(moduleSpecifier).kind, "rejected", JSON.stringify(declarations));
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
  }
  for (const value of [4, null, {}, []]) {
    const declaration = { ...functionDeclaration };
    Reflect.set(declaration, "intrinsicId", value);
    const host = new ExtensionHost({}, {
      extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model([declaration])]]))],
    });
    assert.equal(host.providers.resolveVirtualModule(moduleSpecifier).kind, "rejected");
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
  }
});
