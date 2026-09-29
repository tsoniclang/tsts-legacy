import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { ExtensionHost, type ProviderDeclarationModel, type ProviderExportDeclaration, type ProviderMemberDeclaration } from "./host.js";
import { sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/defaults.js";

function model(declaration: ProviderExportDeclaration): ProviderDeclarationModel {
  return { moduleSpecifier, providerModuleId: "Test.Defaults", exports: [declaration] };
}

function check(declaration: ProviderExportDeclaration, source: string) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": source },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model(declaration)]]))] },
  }).checkSource();
}

for (const kind of ["interface", "type", "class", "enum", "function", "value", "namespace"] as const) {
  test(`ordinary default ${kind} exports use the canonical alias renderer`, () => {
    const declaration: ProviderExportDeclaration = {
      id: `Default.${kind}`, name: "Local", kind, exportKind: "default",
      ...(kind === "type" || kind === "value" ? { type: { kind: "number" as const } } : {}),
      ...(kind === "function" ? { signatures: [{ id: "Default.Call", parameters: [], returnType: { kind: "number" as const } }] } : {}),
      ...(kind === "enum" ? { members: [{ id: "Default.Entry", name: "Entry", kind: "property" as const }] } : {}),
      ...(kind === "namespace" ? { members: [{ id: "Default.Value", name: "value", kind: "property" as const, type: { kind: "number" as const } }] } : {}),
    };
    const usage = {
      interface: "export const value: Selected = {};",
      type: "export const value: Selected = 3;",
      class: "export const value: Selected = new Selected();",
      enum: "export const value: Selected = Selected.Entry;",
      function: "export const value: number = Selected();",
      value: "export const value: number = Selected;",
      namespace: "export const value: number = Selected.value;",
    }[kind];
    const checked = check(declaration, `import Selected from "${moduleSpecifier}"; ${usage}`);
    assert.deepEqual(checked.extensionDiagnostics, []);
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
    const host = new ExtensionHost({}, { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model(declaration)]]))] });
    const resolved = host.providers.resolveVirtualModule(moduleSpecifier);
    assert.equal(resolved.kind, "resolved");
    if (resolved.kind !== "resolved") assert.fail("The valid default export must resolve.");
    const documents = host.providers.getVirtualDeclarationDocuments();
    assert.equal(documents.length, 1);
    const typeOnly = kind === "interface" || kind === "type";
    assert.ok(documents[0]!.sourceText.includes(`export ${typeOnly ? "type " : ""}{ __TstsProviderCanonical_default as default };`));
    assert.doesNotMatch(documents[0]!.sourceText, /export default /u);
    if (kind === "interface" || kind === "type") {
      const invalid = check(declaration, `import Selected from "${moduleSpecifier}"; export const value = Selected;`);
      assert.deepEqual(invalid.diagnostics.map(Diagnostic_Code), [2693]);
    }
  });
}

test("default generic type aliases preserve type arguments without manufacturing values", () => {
  const declaration: ProviderExportDeclaration = {
    id: "Default.Generic", name: "Local", kind: "type", exportKind: "default",
    typeParameters: [{ name: "Value" }], type: { kind: "type-parameter", name: "Value" },
  };
  const checked = check(declaration, `import Selected from "${moduleSpecifier}"; export const value: Selected<number> = 3;`);
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  const invalid = check(declaration, `import Selected from "${moduleSpecifier}"; export const value: Selected<number> = "wrong";`);
  assert.deepEqual(invalid.diagnostics.map(Diagnostic_Code), [2322]);
});

for (const kind of ["property", "field"] as const) {
  test(`enum publication retains ordinary ${kind} member identities`, () => {
    const declaration: ProviderExportDeclaration = { id: "Default.Enum", name: "Local", kind: "enum", exportKind: "default",
      members: [{ id: "Default.Entry", name: "Entry", kind }] };
    const checked = check(declaration, `import Selected from "${moduleSpecifier}"; export const value: Selected = Selected.Entry;`);
    assert.deepEqual(checked.extensionDiagnostics, []);
    assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  });
}

for (const kind of ["method", "constructor", "indexer"] as const) {
  test(`enum publication rejects ${kind} members rather than reclassifying them`, () => {
    const member: ProviderMemberDeclaration = { id: "Default.Entry", name: "Entry", kind };
    const declaration: ProviderExportDeclaration = { id: "Default.Enum", name: "Local", kind: "enum", members: [member] };
    const host = new ExtensionHost({}, { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model(declaration)]]))] });
    assert.equal(host.providers.resolveVirtualModule(moduleSpecifier).kind, "rejected");
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
  });
}
