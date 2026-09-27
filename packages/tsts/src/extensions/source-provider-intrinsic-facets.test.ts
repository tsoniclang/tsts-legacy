import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { Node_Expression, Node_Initializer } from "../internal/ast/ast.js";
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
    const info = queries.checker.getProviderReferenceInfo(Node_Expression(call));
    assert.ok(info);
    assert.ok(info.intrinsic);
    assert.equal(info.intrinsic.exportId, identity);
    assert.equal(info.ordinary?.kind, "declaration");
    assert.equal(info.ordinary?.kind === "declaration" && info.ordinary.declaration.exportId, functionDeclaration.id);
    assert.equal(Object.isFrozen(info), true);
    assert.equal(Object.isFrozen(info.ordinary), true);
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

test("an intrinsic-only export has no manufactured ordinary declaration facet", () => {
  const checked = check([{ id: identity, name: "shared", kind: "intrinsic" }], [
    `import { shared } from "${moduleSpecifier}";`,
    `import * as native from "${moduleSpecifier}";`,
    "const alias = shared; export const selected = alias;",
    "export const other = native.shared;",
  ].join("\n"));
  assert.deepEqual(checked.diagnostics, [], checked.diagnostics.map(Diagnostic_String).join("\n"));
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const variables = findNodes(file, checked.ast.children, checked.ast.is.IsVariableDeclaration);
  assert.equal(variables.length, 3);
  for (const variable of variables) {
    const info = queries.checker.getProviderReferenceInfo(Node_Initializer(variable));
    assert.ok(info);
    assert.ok(info.intrinsic);
    assert.equal(info.intrinsic.exportId, identity);
    assert.equal(info.ordinary, undefined);
    assert.equal("ordinary" in info, false);
  }
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
    const info = queries.checker.getProviderReferenceInfo(expression);
    assert.ok(info);
    assert.ok(info.intrinsic);
    assert.equal(info.intrinsic.exportId, identity);
    assert.equal(info.ordinary?.kind, "declaration");
    assert.equal(info.ordinary?.kind === "declaration" && info.ordinary.declaration.exportId, declaration.id);
    assert.equal(checked.sourceFacts.getFact(info.symbol, providerVirtualDeclarationFactKey)?.exportId, declaration.id);
    if (kind === "type" || kind === "interface") {
      assert.deepEqual(queries.checker.getCallSignaturesOfType(queries.checker.getTypeAtLocation(expression)), []);
      const document = checked.sourceFacts.getVirtualDeclarationDocument(info.intrinsic.artifactFileName);
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

test("ordinary type families retain exact arities without inventing an intrinsic or value facet", () => {
  const declarations = familyDeclarations().map(({ intrinsicId: _intrinsic, ...declaration }) => declaration);
  const checked = check(declarations, [
    `import { Shared } from "${moduleSpecifier}";`,
    "export const first: Shared = {};",
    "export const second: Shared<number> = {};",
  ].join("\n"));
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const types = findNodes(file, checked.ast.children, checked.ast.is.IsTypeReferenceNode);
  assert.equal(types.length, 2);
  for (const type of types) {
    const reference = queries.checker.getProviderReferenceInfo(checked.ast.as.AsTypeReferenceNode(type)!.TypeName);
    assert.ok(reference);
    assert.equal(reference.intrinsic, undefined);
    assert.equal("intrinsic" in reference, false);
    assert.equal(reference.ordinary?.kind, "type-family");
    if (reference.ordinary?.kind !== "type-family") assert.fail("The exact ordinary family is required.");
    assert.deepEqual(reference.ordinary.family.variants.map(variant => variant.sourceTypeArgumentCount), [0, 1]);
  }
});

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
  const info = queries.checker.getProviderReferenceInfo(expression);
  assert.equal(info?.intrinsic?.exportId, identity);
  assert.equal(info?.ordinary?.kind, "type-family");
  if (info?.ordinary?.kind !== "type-family") assert.fail("The exact type-family facet is required.");
  assert.deepEqual(info.ordinary.family.variants.map(variant => [variant.sourceTypeArgumentCount, variant.declaration.exportId]),
    [[0, "Native.Shared.Type0"], [1, "Native.Shared.Type1"]]);
  assert.equal(Object.isFrozen(info.ordinary), true);
  assert.equal(Object.isFrozen(info.ordinary.family), true);
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
