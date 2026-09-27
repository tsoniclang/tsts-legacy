import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import type { ProviderDeclarationModel } from "./index.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/namespace-names.js";
const model: ProviderDeclarationModel = {
  moduleSpecifier,
  providerModuleId: "Test.NamespaceNames",
  exports: [{
    id: "factory", name: "factory", exportName: "Factory", kind: "namespace",
    members: [{
      id: "factory::default", name: "default", kind: "method",
      signatures: [
        { id: "default(number)", parameters: [{ name: "value", type: { kind: "number" } }], returnType: { kind: "number" } },
        { id: "default(string)", parameters: [{ name: "value", type: { kind: "string" } }], returnType: { kind: "string" } },
      ],
    }, {
      id: "factory::class", name: "class", kind: "property", type: { kind: "number" },
    }, {
      id: "factory::collision", name: "__tstsProviderMember0", kind: "method",
      signatures: [{ id: "collision()", parameters: [], returnType: { kind: "boolean" } }],
    }, {
      id: "factory::constructor", name: "constructor", kind: "method",
      signatures: [{ id: "constructor()", parameters: [], returnType: { kind: "string" } }],
    }],
  }],
};

function check(source: string) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src", rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": source },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))] },
  }).checkSource();
}

test("namespace reserved names, export aliases and renderer collisions retain exact selected facts", () => {
  const checked = check(`
    import { Factory as selected } from "${moduleSpecifier}";
    import * as library from "${moduleSpecifier}";
    export const first: number = selected.default(1);
    export const second: string = library.Factory.default("two");
    export const constant: number = selected.class;
    export const collision: boolean = selected.__tstsProviderMember0();
    export const namedConstructor: string = selected.constructor();
    const ordinary = { default(value: number): number { return value; } };
    export const plain = ordinary.default(3);
  `);
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const calls = findNodes(sourceFile, source.ast.children, source.ast.is.IsCallExpression);
  const facts = calls.map(call => checked.sourceFacts?.getFact(
    source.checker.getSignatureDeclaration(source.checker.getResolvedCallInfo(call)?.selectedSignature),
    providerVirtualDeclarationFactKey,
  ));
  assert.deepEqual(facts.map(fact => [fact?.memberId, fact?.signatureId]), [
    ["factory::default", "default(number)"], ["factory::default", "default(string)"],
    ["factory::collision", "collision()"], ["factory::constructor", "constructor()"], [undefined, undefined],
  ]);
  const properties = findNodes(sourceFile, source.ast.children, source.ast.is.IsPropertyAccessExpression);
  const propertyFacts = properties.map(property => checked.sourceFacts?.getFact(
    source.checker.getResolvedPropertyAccessInfo(property)?.selectedDeclaration, providerVirtualDeclarationFactKey,
  ));
  assert.ok(propertyFacts.some(fact => fact?.memberId === "factory::class"));
});

test("namespace aliases retain argument checking, immutable constants and no construction signature", () => {
  for (const expression of ["Factory.default(true)", "Factory.class = 1", "new Factory()", "Factory.__tstsProviderMember1()", "const result: number = Factory.constructor()"] ) {
    const checked = check(`import { Factory } from "${moduleSpecifier}"; ${expression};`);
    assert.deepEqual(checked.extensionDiagnostics, []);
    assert.ok(checked.diagnostics.length > 0, expression);
  }
});
