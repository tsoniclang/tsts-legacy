import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { createSourceProgramQueries } from "./source-program.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { Node_Expression } from "../internal/ast/ast.js";
import {
  ExtensionHost,
  getExtensionHost,
  type ProviderDeclarationModel,
  type ProviderExportDeclaration,
} from "./host.js";
import { providerIntrinsicDeclarationFactKey, providerVirtualDeclarationFactKey } from "./facts.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/native/intrinsics.js";
const intrinsic: ProviderExportDeclaration = { id: "Native.Emit", name: "emit", kind: "intrinsic" };
const ordinary: ProviderExportDeclaration = {
  id: "Native.Ordinary", name: "ordinary", kind: "function",
  signatures: [{ id: "Native.Ordinary.call", parameters: [], returnType: { kind: "number" } }],
};

function model(exports: readonly ProviderExportDeclaration[] = [intrinsic, ordinary]): ProviderDeclarationModel {
  return { moduleSpecifier, providerModuleId: "Native.Intrinsics", exports };
}

function sessionFor(source: string, files: Readonly<Record<string, string>> = {}) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts", ...Object.keys(files)],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": source, ...files },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model()]]))] },
  });
}

test("native intrinsic exports bind exact aliases and typeof without callable signatures", () => {
  const session = sessionFor([
    `import { emit as selected, ordinary } from "${moduleSpecifier}";`,
    `import * as native from "${moduleSpecifier}";`,
    "export type Identity = typeof selected;",
    "export const direct: typeof selected = native.emit;",
    "export const normal = ordinary();",
  ].join("\n"));
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(checked.extensionDiagnostics, []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const namespaceUse = findNodes(file, checked.ast.children, checked.ast.is.IsPropertyAccessExpression)[0];
  assert.ok(namespaceUse);
  const info = queries.checker.getIntrinsicDeclarationInfo(namespaceUse);
  assert.ok(info);
  assert.equal(info.expression, namespaceUse);
  assert.equal(info.declaration.exportId, "Native.Emit");
  assert.equal(info.declaration.moduleSpecifier, moduleSpecifier);
  assert.equal(Object.isFrozen(info), true);
  assert.equal(Object.isFrozen(info.declaration), true);
  assert.deepEqual(checked.sourceFacts.getFact(info.symbol, providerIntrinsicDeclarationFactKey), info.declaration);
  assert.deepEqual(checked.sourceFacts.getFact(info.symbol, providerVirtualDeclarationFactKey), info.declaration);
  const owner = checked.sourceFacts.getVirtualDeclarationDocument(info.declaration.artifactFileName);
  assert.ok(owner);
  assert.match(owner.sourceText, /:\s*unique symbol;/u);
  assert.doesNotMatch(owner.sourceText, /\bunknown\b|\bany\b|=>/u);
  const type = queries.checker.getTypeAtLocation(namespaceUse);
  assert.deepEqual(queries.checker.getCallSignaturesOfType(type), []);
  assert.deepEqual(queries.checker.getConstructSignaturesOfType(type), []);
  const normal = findNodes(file, checked.ast.children, checked.ast.is.IsCallExpression)[0];
  assert.ok(normal);
  assert.equal(queries.checker.getIntrinsicDeclarationInfo(Node_Expression(normal)), undefined);
  assert.equal(queries.checker.getResolvedCallInfo(normal)?.outcome, "applicable");
});

test("intrinsic binding lookup does not ask for a call signature or inspect invocation arguments", () => {
  const session = sessionFor([
    `import { emit as expand } from "${moduleSpecifier}";`,
    "expand(notDeclaredAnywhere());",
  ].join("\n"));
  session.ensureBound();
  const source = createSourceProgramQueries(session.program);
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = source.getSourceFileQueries(file);
  const outer = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  assert.ok(outer);
  const info = queries.checker.getIntrinsicDeclarationInfo(Node_Expression(outer));
  assert.equal(info?.declaration.exportId, "Native.Emit");
  const diagnostics = session.getDiagnostics("semantic").map(Diagnostic_Code);
  assert.ok(diagnostics.includes(2349), "An intrinsic without elaboration cannot be called as a function.");
  assert.ok(diagnostics.includes(2304), "No source diagnostics are suppressed by identity lookup.");
});

test("intrinsic identities survive authored re-exports and exclude same-spelled functions", () => {
  const session = sessionFor([
    'import { forwarded as emit } from "./bridge.js";',
    "emit();",
    "export function ordinaryScope(): number {",
    "  function emit(): number { return 4; }",
    "  return emit();",
    "}",
  ].join("\n"), {
    "/src/bridge.ts": `export { emit as forwarded } from "${moduleSpecifier}";`,
  });
  session.ensureBound();
  const source = createSourceProgramQueries(session.program);
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = source.getSourceFileQueries(file);
  const calls = findNodes(file, source.ast.children, source.ast.is.IsCallExpression);
  assert.equal(calls.length, 2);
  const first = queries.checker.getIntrinsicDeclarationInfo(Node_Expression(calls[0]));
  const second = queries.checker.getIntrinsicDeclarationInfo(Node_Expression(calls[1]));
  assert.equal(first?.declaration.exportId, "Native.Emit");
  assert.equal(second, undefined);
  assert.equal(queries.checker.getResolvedCallInfo(calls[1])?.outcome, "applicable");
  assert.deepEqual(session.getDiagnostics("semantic").map(Diagnostic_Code), [2349]);
});

test("intrinsic identity cannot be supplied by a foreign source epoch", () => {
  const source = `import { emit } from "${moduleSpecifier}"; emit();`;
  const first = sessionFor(source);
  const second = sessionFor(source);
  first.ensureBound();
  second.ensureBound();
  const firstSource = createSourceProgramQueries(first.program);
  const secondSource = createSourceProgramQueries(second.program);
  const firstFile = firstSource.getSourceFile("/src/index.ts");
  const secondFile = secondSource.getSourceFile("/src/index.ts");
  assert.ok(firstFile);
  assert.ok(secondFile);
  const call = findNodes(firstFile, firstSource.ast.children, firstSource.ast.is.IsCallExpression)[0];
  assert.ok(call);
  assert.throws(() => secondSource.getSourceFileQueries(secondFile).checker.getIntrinsicDeclarationInfo(
    Node_Expression(call),
  ), /owning compiler program/u);
});

test("intrinsic provider snapshots retain one immutable canonical declaration", () => {
  const declaration: ProviderExportDeclaration = { ...intrinsic };
  const host = new ExtensionHost({}, {
    extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model([declaration])]]))],
  });
  const resolved = host.providers.resolveVirtualModule(moduleSpecifier);
  assert.equal(resolved.kind, "resolved");
  if (resolved.kind !== "resolved") return;
  assert.equal(Object.isFrozen(resolved.module.declarationModel.exports[0]), true);
  assert.match(resolved.module.artifact.sourceText, /export \{/u);
  assert.equal(Reflect.set(declaration, "kind", "function"), true);
  assert.equal(resolved.module.declarationModel.exports[0]?.kind, "intrinsic");
});

test("intrinsic-only declarations reject callable, value and type payloads rather than hiding them", () => {
  const invalid: readonly Partial<ProviderExportDeclaration>[] = [
    { type: { kind: "number" } },
    { signatures: ordinary.signatures! },
    { typeParameters: [{ name: "T" }] },
    { sourceTypeFamily: { exportName: "Emit", typeArgumentCount: 0 } },
    { members: [{ id: "Member", name: "member", kind: "property", type: { kind: "number" } }] },
    { heritage: [{ kind: "extends", type: { kind: "object" } }] },
  ];
  for (const shape of invalid) {
    const host = new ExtensionHost({}, {
      extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model([{ ...intrinsic, ...shape }])]]))],
    });
    const resolved = host.providers.resolveVirtualModule(moduleSpecifier);
    assert.equal(resolved.kind, "rejected", JSON.stringify(shape));
    assert.equal(host.providers.getVirtualDeclarationDocuments().length, 0);
  }
});

test("an intrinsic token does not satisfy a source function type", () => {
  const session = sessionFor([
    `import { emit } from "${moduleSpecifier}";`,
    "export const callable: () => void = emit;",
  ].join("\n"));
  const checked = session.checkSource();
  assert.deepEqual(checked.diagnostics.map(Diagnostic_Code), [2322]);
  const host = getExtensionHost(session.program!);
  assert.ok(host);
  assert.deepEqual(host.diagnostics.all(), []);
});
