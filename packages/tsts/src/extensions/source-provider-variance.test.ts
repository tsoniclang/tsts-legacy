import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type ProviderDeclarationModel } from "../index.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/provider-variance";

function checked(kind: "class" | "interface", different: boolean) {
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.ProviderVariance",
    exports: [{
      id: "Test.ProviderVariance::Extent",
      name: "Extent",
      kind,
      typeParameters: [{ name: "Length", variance: "invariant" }],
      members: [{
        id: "Test.ProviderVariance::Extent.echo",
        name: "echo",
        kind: "method",
        signatures: [{
          id: "Test.ProviderVariance::Extent.echo<Value>",
          typeParameters: [{ name: "Value" }],
          parameters: [{ name: "value", type: { kind: "type-parameter", name: "Value" } }],
          returnType: { kind: "type-parameter", name: "Value" },
        }],
      }],
    }],
  };
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": `import type { Extent } from "${moduleSpecifier}";
        declare const input: Extent<2n>;
        export const result: Extent<${different ? "3n" : "2n"}> = input;`,
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))] },
  }).checkSource();
}

for (const kind of ["class", "interface"] as const) {
  test(`provider ${kind} invariant phantom parameter rejects a different exact extent`, () => {
    const result = checked(kind, true);
    assert.equal(result.extensionDiagnostics.length, 0, "the actual provider declaration is valid");
    assert.deepEqual(result.diagnostics.map(Diagnostic_Code), [2322],
      result.diagnostics.map(Diagnostic_String).join("\n"));
  });

  test(`provider ${kind} invariant parameter admits the same extent and ordinary method binder`, () => {
    const result = checked(kind, false);
    assert.equal(result.extensionDiagnostics.length, 0, "the actual provider declaration is valid");
    assert.equal(result.diagnostics.length, 0, result.diagnostics.map(Diagnostic_String).join("\n"));
  });
}
