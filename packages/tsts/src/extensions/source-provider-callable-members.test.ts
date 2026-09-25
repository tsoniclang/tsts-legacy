import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import type { ProviderDeclarationModel } from "./index.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/callable-members.js";

function callableModel(exportForm: "named" | "renamed" | "default"): ProviderDeclarationModel {
  return {
    moduleSpecifier,
    providerModuleId: "Test.CallableMembers",
    exports: [{
      id: "select",
      name: "select",
      kind: "function",
      ...(exportForm === "default" ? { exportKind: "default" as const } : {}),
      ...(exportForm === "renamed" ? { exportName: "externalSelect" } : {}),
      signatures: [
        { id: "select(number)", parameters: [{ name: "value", type: { kind: "number" } }], returnType: { kind: "number" } },
        { id: "select(string)", parameters: [{ name: "value", type: { kind: "string" } }], returnType: { kind: "string" } },
      ],
      members: [{
        id: "select::module",
        name: "module",
        kind: "method",
        signatures: [{ id: "select::module<T>(T)", typeParameters: [{ name: "T" }],
          parameters: [{ name: "value", type: { kind: "type-parameter", name: "T" } }],
          returnType: { kind: "type-parameter", name: "T" } }],
      }, {
        id: "select::version", name: "version", kind: "property", type: { kind: "string" },
      }],
    }],
  };
}

for (const exportForm of ["named", "renamed", "default"] as const) {
  test(`provider callable namespace members retain one export and exact overload identities, export=${exportForm}`, () => {
    const model = callableModel(exportForm);
    const exportName = exportForm === "renamed" ? "externalSelect" : exportForm === "default" ? "default" : "select";
    const session = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/core.d.ts", "/src/index.ts"],
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        "/src/index.ts": `
          import ${exportForm === "default" ? "choose" : `{ ${exportName} as choose }`} from "${moduleSpecifier}";
          import * as library from "${moduleSpecifier}";
          export const count: number = choose(1);
          export const label: string = choose("one");
          export const selected: boolean = choose.module(true);
          export const version: string = choose.version;
          export const namespaced: number = library.${exportName}.module(2);
        `,
      },
      compilerOptions: testNoLibCompilerOptions,
      extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))] },
    });
    const checked = session.checkSource();
    assert.deepEqual(checked.extensionDiagnostics, []);
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    const sourceFile = checked.getSourceFile("/src/index.ts");
    const source = checked.getSourceFileQueries(sourceFile);
    const calls = findNodes(sourceFile, source.ast.children, source.ast.is.IsCallExpression);
    const facts = calls.map(call => checked.sourceFacts?.getFact(
      source.checker.getSignatureDeclaration(source.checker.getResolvedCallInfo(call)?.selectedSignature),
      providerVirtualDeclarationFactKey,
    ));
    assert.deepEqual(facts.map(fact => [fact?.exportId, fact?.memberId, fact?.signatureId]), [
      ["select", undefined, "select(number)"],
      ["select", undefined, "select(string)"],
      ["select", "select::module", "select::module<T>(T)"],
      ["select", "select::module", "select::module<T>(T)"],
    ]);
    assert.deepEqual(session.checkSource().diagnostics, checked.diagnostics);
  });
}
