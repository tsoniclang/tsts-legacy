import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { Node_Expression } from "../internal/ast/ast.js";
import { ExtensionHost, type ProviderDeclarationModel, type ProviderExportDeclaration, type ProviderMemberDeclaration } from "./host.js";
import { createSourceProgramQueries } from "./source-program.js";
import { providerIntrinsicDeclarationFactKey, providerVirtualDeclarationFactKey } from "./facts.js";
import { validateProviderDeclarationModelGraph } from "./provider-model-graph.js";
import { providerDeclarationModelLimits } from "./provider-resource-limits.js";
import { getProviderExportContractKeyMap } from "./provider-export-contract.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/native/syntax.js";
const selectedMember: ProviderMemberDeclaration = { id: "Syntax.Type", name: "type", kind: "intrinsic" };
const syntax: ProviderExportDeclaration = {
  id: "Syntax", name: "syntax", kind: "intrinsic",
  members: [selectedMember, { id: "Syntax.Items", name: "items", kind: "intrinsic" }],
};

function model(exports: readonly ProviderExportDeclaration[] = [syntax]): ProviderDeclarationModel {
  return { moduleSpecifier, providerModuleId: "Native.Syntax", exports };
}

function sessionFor(source: string, exports: readonly ProviderExportDeclaration[] = [syntax], files: Readonly<Record<string, string>> = {}) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts", ...Object.keys(files)],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": source, ...files },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model(exports)]]))] },
  });
}

for (const kind of ["intrinsic", "namespace", "function"] as const) {
  test(`exact ${kind} members are readonly identities, never invented callables`, () => {
    const declaration: ProviderExportDeclaration = {
      ...syntax, kind,
      ...(kind === "function" ? { signatures: [{ id: "Syntax.Call", parameters: [], returnType: { kind: "number" as const } }] } : {}),
    };
    const session = sessionFor([
      `import { syntax } from "${moduleSpecifier}";`,
      "export type TypeIdentity = typeof syntax.type;",
      "export const selected: typeof syntax.type = syntax.type;",
      ...(kind === "function" ? ["export const ordinary: number = syntax();"] : []),
    ].join("\n"), [declaration]);
    const checked = session.checkSource();
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.deepEqual(checked.extensionDiagnostics, []);
    const file = checked.getSourceFile("/src/index.ts");
    assert.ok(file);
    const queries = checked.getSourceFileQueries(file);
    const access = findNodes(file, checked.ast.children, checked.ast.is.IsPropertyAccessExpression)[0];
    assert.ok(access);
    const info = queries.checker.getProviderReferenceInfo(access);
    assert.ok(info);
    assert.ok(info.intrinsic);
    assert.equal(info.intrinsic.exportId, "Syntax");
    assert.equal(info.intrinsic.memberId, "Syntax.Type");
    assert.equal(info.intrinsic.memberName, "type");
    assert.equal(info.intrinsic.signatureId, undefined);
    assert.equal(info.ordinary, undefined);
    assert.equal(Object.isFrozen(info.intrinsic), true);
    assert.deepEqual(checked.sourceFacts.getFact(info.symbol, providerIntrinsicDeclarationFactKey), info.intrinsic);
    assert.deepEqual(checked.sourceFacts.getFact(info.symbol, providerVirtualDeclarationFactKey), info.intrinsic);
    const owner = checked.sourceFacts.getVirtualDeclarationDocument(info.intrinsic.artifactFileName);
    assert.ok(owner);
    assert.match(owner.sourceText, /readonly type: unique symbol;/u);
    assert.doesNotMatch(owner.sourceText, /\bunknown\b|\bany\b|type\s*\(/u);
    const type = queries.checker.getTypeAtLocation(access);
    assert.deepEqual(queries.checker.getCallSignaturesOfType(type), []);
    assert.deepEqual(queries.checker.getConstructSignaturesOfType(type), []);
  });
}

test("member identity survives exact namespace access, const aliases and authored re-exports", () => {
  const session = sessionFor([
    `import * as native from "${moduleSpecifier}";`,
    'import { selected } from "./bridge.js";',
    "const owner = native.syntax;",
    'const first = owner["type"];',
    "const second = ((first));",
    "native.syntax.type();",
    'owner["type"]();',
    "second();",
    "selected();",
  ].join("\n"), [syntax], {
    "/src/bridge.ts": `import { syntax } from "${moduleSpecifier}"; export const selected = syntax.type;`,
  });
  session.ensureBound();
  const source = createSourceProgramQueries(session.program);
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = source.getSourceFileQueries(file);
  const calls = findNodes(file, source.ast.children, source.ast.is.IsCallExpression);
  assert.equal(calls.length, 4);
  const identities = calls.map(call => queries.checker.getProviderReferenceInfo(Node_Expression(call)));
  assert.ok(identities.every(info => info?.intrinsic?.memberId === "Syntax.Type"));
  assert.ok(identities.every(info => info?.symbol === identities[0]?.symbol));
  assert.deepEqual(session.getDiagnostics("semantic").map(Diagnostic_Code), Array(4).fill(2349));
});

test("member selection does not inspect invocation arguments or erase ordinary diagnostics", () => {
  const session = sessionFor(`import { syntax } from "${moduleSpecifier}"; syntax.type(notDeclared());`);
  session.ensureBound();
  const source = createSourceProgramQueries(session.program);
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  assert.ok(call);
  assert.equal(source.getSourceFileQueries(file).checker.getProviderReferenceInfo(Node_Expression(call))?.intrinsic?.memberId, "Syntax.Type");
  const diagnostics = session.getDiagnostics("semantic").map(Diagnostic_Code);
  assert.ok(diagnostics.includes(2349));
  assert.ok(diagnostics.includes(2304));
});

test("ordinary provider members use the same exact static identity query without fake intrinsics", () => {
  const member: ProviderMemberDeclaration = {
    id: "Syntax.Run", name: "run", kind: "method",
    signatures: [{ id: "Syntax.Run.Call", parameters: [{ name: "value", type: { kind: "number" } }], returnType: { kind: "number" } }],
  };
  const session = sessionFor([
    `import { syntax } from "${moduleSpecifier}";`,
    `import * as native from "${moduleSpecifier}";`,
    "const owner = syntax; const selected = owner.run;",
    "export const first = native.syntax.run(1);",
    "export const second = selected(2);",
  ].join("\n"), [{ ...syntax, kind: "namespace", members: [member] }]);
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  assert.equal("getIntrinsicDeclarationInfo" in queries.checker, false);
  const calls = findNodes(file, checked.ast.children, checked.ast.is.IsCallExpression);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const expression = Node_Expression(call);
    const reference = queries.checker.getProviderReferenceInfo(expression);
    assert.ok(reference);
    assert.equal(reference.expression, expression);
    assert.equal(reference.intrinsic, undefined);
    assert.equal("intrinsic" in reference, false);
    assert.equal(reference.ordinary?.kind, "declaration");
    if (reference.ordinary?.kind !== "declaration") assert.fail("An exact ordinary declaration is required.");
    assert.equal(reference.ordinary.declaration.memberId, member.id);
    assert.equal(reference.ordinary.declaration.exportId, syntax.id);
    assert.equal(reference.ordinary.declaration.signatureId, undefined);
    assert.equal(queries.checker.getResolvedCallInfo(call)?.outcome, "applicable");
  }
});

test("static provider reference lookup does not follow runtime member receivers", () => {
  const member: ProviderMemberDeclaration = {
    id: "Syntax.Run", name: "run", kind: "method",
    signatures: [{ id: "Syntax.Run.Call", parameters: [], returnType: { kind: "number" } }],
  };
  const session = sessionFor([
    `import { syntax } from "${moduleSpecifier}";`,
    "function produce() { return syntax; }",
    "export function run(input: typeof syntax) { return input.run() + produce().run(); }",
  ].join("\n"), [{ ...syntax, kind: "namespace", members: [member] }]);
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const calls = findNodes(file, checked.ast.children, checked.ast.is.IsCallExpression);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(queries.checker.getProviderReferenceInfo(Node_Expression(call)), undefined);
    assert.equal(queries.checker.getResolvedCallInfo(call)?.outcome, "applicable");
  }
});

test("runtime lookalikes and dynamic receivers cannot manufacture an intrinsic member", () => {
  const session = sessionFor([
    `import { syntax as native } from "${moduleSpecifier}";`,
    "const syntax = { type() { return 1; } };",
    "syntax.type();",
    "let mutable = native; mutable.type();",
    "function selected(input: typeof native) { input.type(); }",
    'const key = "type"; native[key]();',
    "native?.type();",
    "const wrapped = { get value() { return native; } }; wrapped.value.type();",
    "function produce() { return native; } produce().type();",
    "const instance = { value: native }; instance.value.type();",
    "const copy: typeof native = { type: native.type, items: native.items }; copy.type();",
  ].join("\n"));
  session.ensureBound();
  const source = createSourceProgramQueries(session.program);
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = source.getSourceFileQueries(file);
  const calls = findNodes(file, source.ast.children, source.ast.is.IsCallExpression);
  assert.equal(calls.length, 10);
  for (const call of calls) {
    assert.equal(queries.checker.getProviderReferenceInfo(Node_Expression(call)), undefined);
  }
  assert.equal(queries.checker.getResolvedCallInfo(calls[0])?.outcome, "applicable");
});

test("intrinsic members reject mutation and callable substitution", () => {
  const checked = sessionFor([
    `import { syntax } from "${moduleSpecifier}";`,
    "syntax.type = syntax.items;",
    "const callable: () => void = syntax.type;",
  ].join("\n")).checkSource();
  const codes = checked.diagnostics.map(Diagnostic_Code);
  assert.ok(codes.includes(2540));
  assert.ok(codes.includes(2322));
});

test("intrinsic member model snapshots and ABI keys retain exact identity", () => {
  const member = { ...selectedMember };
  const input = model([{ ...syntax, members: [member] }]);
  const result = validateProviderDeclarationModelGraph(input);
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(Object.isFrozen(result.model.exports[0]?.members?.[0]), true);
  assert.equal(Reflect.set(member, "id", "Changed"), true);
  assert.equal(result.model.exports[0]?.members?.[0]?.id, "Syntax.Type");
  const originalKey = getProviderExportContractKeyMap(moduleSpecifier, result.model.exports).get("syntax");
  const changedKey = getProviderExportContractKeyMap(moduleSpecifier, input.exports).get("syntax");
  assert.notEqual(originalKey, changedKey);
  const oversized = model([{ ...syntax, members: [{ ...selectedMember, id: "x".repeat(providerDeclarationModelLimits.maxStringCodeUnits + 1) }] }]);
  assert.equal(validateProviderDeclarationModelGraph(oversized).kind, "invalid");
});

test("intrinsic members reject unused shapes, runtime instance placement and duplicate identities", () => {
  const invalidMembers: readonly Partial<ProviderMemberDeclaration>[] = [
    { type: { kind: "number" } },
    { signatures: [{ id: "Fake", parameters: [], returnType: { kind: "number" } }] },
    { signatures: [] }, { static: true }, { static: false }, { readonly: true }, { optional: true },
  ];
  const invalidExports: ProviderExportDeclaration[] = [
    ...invalidMembers.map(member => ({ ...syntax, members: [{ ...selectedMember, ...member }] })),
    ...(["class", "interface", "enum"] as const).map(kind => ({ ...syntax, kind })),
    { ...syntax, members: [selectedMember, selectedMember] },
    { ...syntax, members: [selectedMember, { ...selectedMember, id: "Distinct" }] },
    { ...syntax, members: [selectedMember, { ...selectedMember, name: "distinct" }] },
  ];
  for (const declaration of invalidExports) {
    const host = new ExtensionHost({}, {
      extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model([declaration])]]))],
    });
    const resolved = host.providers.resolveVirtualModule(moduleSpecifier);
    assert.equal(resolved.kind, "rejected", JSON.stringify(declaration));
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
  }
});
