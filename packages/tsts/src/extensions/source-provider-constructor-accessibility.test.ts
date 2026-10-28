import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, providerVirtualDeclarationFactKey } from "../index.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import type { ProviderDeclarationModel } from "./index.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/native-constructors.js";
const model: ProviderDeclarationModel = {
  moduleSpecifier,
  providerModuleId: "Test.NativeConstructors",
  exports: [{
    id: "Mixed",
    name: "Mixed",
    kind: "class",
    members: [{
      id: "Mixed::.ctor",
      name: "constructor",
      kind: "constructor",
      signatures: [{
        id: "Mixed::.ctor(number)",
        accessibility: "public",
        parameters: [{ name: "value", type: { kind: "number" } }],
      }, {
        id: "Mixed::.ctor(string)",
        accessibility: "protected",
        parameters: [{ name: "value", type: { kind: "string" } }],
      }],
    }],
  }, {
    id: "ProtectedOnly",
    name: "ProtectedOnly",
    kind: "class",
    members: [{
      id: "ProtectedOnly::.ctor",
      name: "constructor",
      kind: "constructor",
      signatures: [{
        id: "ProtectedOnly::.ctor()",
        accessibility: "protected-internal",
        parameters: [],
      }],
    }],
  }],
};

function check(sourceText: string) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": sourceText },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))] },
  }).checkSource();
}

test("provider constructor overloads preserve selected physical access and derived calls", () => {
  const checked = check(`
    import { Mixed, ProtectedOnly } from "${moduleSpecifier}";
    export const direct = new Mixed(1);
    export class Derived extends Mixed { constructor() { super("protected"); } }
    export class InternalDerived extends ProtectedOnly { constructor() { super(); } }
  `);
  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const constructions = findNodes(sourceFile, checked.ast.children, checked.ast.is.IsNewExpression);
  assert.equal(constructions.length, 1);
  const selected = source.checker.getResolvedCallInfo(constructions[0]);
  const declaration = source.checker.getSignatureDeclaration(selected?.selectedSignature);
  assert.equal(checked.sourceFacts?.getFact(declaration, providerVirtualDeclarationFactKey)?.signatureId,
    "Mixed::.ctor(number)");
});

for (const [name, construction] of [
  ["protected mixed overload", 'new Mixed("protected")'],
  ["protected-internal only", "new ProtectedOnly()"],
] as const) {
  test(`direct construction rejects the ${name} provider signature`, () => {
    const checked = check(`import { Mixed, ProtectedOnly } from "${moduleSpecifier}"; export const value = ${construction};`);
    assert.equal(checked.extensionDiagnostics.length, 0);
    assert.deepEqual(checked.diagnostics.map(Diagnostic_Code), [2674]);
  });
}

test("an unmatched provider constructor preserves the ordinary overload diagnostic", () => {
  const checked = check(`import { Mixed } from "${moduleSpecifier}"; export const value = new Mixed(true);`);
  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.deepEqual(checked.diagnostics.map(Diagnostic_Code), [2769]);
});

test("authored constructor overloads retain the ordinary visibility diagnostic", () => {
  const checked = check(`
    class Ordinary {
      public constructor(value: number);
      protected constructor(value: string);
      constructor(value: number | string) {}
    }
  `);
  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.equal(checked.diagnostics.some(diagnostic => Diagnostic_Code(diagnostic) === 2385), true,
    checked.diagnostics.map(Diagnostic_String).join("\n"));
});
