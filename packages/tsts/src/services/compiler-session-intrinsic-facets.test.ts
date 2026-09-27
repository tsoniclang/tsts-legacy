import assert from "node:assert/strict";
import { test } from "node:test";
import { Node_Initializer, type Node } from "../internal/ast/ast.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import { defineExtensionFactKey, type CompilerExtension, type ProviderExportDeclaration } from "../extensions/index.js";
import type { SourceProgramQueries } from "../extensions/source-program.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { createCompilerSessionFromFiles } from "./compiler-session.js";

for (const mode of ["intrinsic", "declaration", "type-family"] as const) {
  test(`source elaboration reads the exact ${mode} facets before final source checking`, () => {
    const moduleSpecifier = "@test/native.js";
    const intrinsic = "Native.operation.macro";
    const declarations: readonly ProviderExportDeclaration[] = mode === "intrinsic"
      ? [{ id: intrinsic, name: "operation", kind: "intrinsic" }]
      : mode === "declaration" ? [{ id: "Native.operation.function", name: "operation", kind: "function",
        intrinsicId: intrinsic, signatures: [{ id: "Native.operation.call", parameters: [
          { name: "value", type: { kind: "number" } },
        ], returnType: { kind: "number" } }] }]
        : [0, 1].map(count => ({ id: `Native.operation.type${count}`, name: `Operation${count}`, kind: "interface",
          intrinsicId: intrinsic, sourceTypeFamily: { exportName: "operation", typeArgumentCount: count },
          ...(count === 0 ? {} : { typeParameters: [{ name: "Value" }] }),
        }));
    const key = defineExtensionFactKey<readonly string[]>({
      extensionId: `test.intrinsic-query.${mode}`, name: "identities", snapshot: value => Object.freeze([...value]),
    });
    const variables = (source: SourceProgramQueries): readonly Node[] => {
      const file = source.getSourceFile("/src/index.ts");
      assert.ok(file);
      return findNodes(file, source.ast.children, source.ast.is.IsVariableDeclaration)
        .filter((node): node is Node => node !== undefined);
    };
    const previous: { source: SourceProgramQueries; node: Node }[] = [];
    const extension: CompilerExtension = {
      identity: { id: key.extensionId, version: "1" },
      dependencies: { dependsOn: ["test.source-provider.extension"] },
      initialize(context) {
        context.registerSourceElaborator(key, query => {
          assert.equal("sourceFacts" in query.source, false);
          const file = query.source.ast.getSourceFile(query.node);
          assert.ok(file);
          const initializer = Node_Initializer(query.node);
          assert.ok(initializer);
          const info = query.source.getSourceFileQueries(file).checker.getIntrinsicDeclarationInfo(initializer);
          assert.ok(info);
          previous.push({ source: query.source, node: initializer });
          assert.equal(info.declaration.exportId, intrinsic);
          if (mode === "intrinsic") {
            assert.equal(info.ordinary, undefined);
            return [intrinsic];
          }
          assert.equal(info.ordinary?.kind, mode);
          if (info.ordinary?.kind === "declaration") return [intrinsic, info.ordinary.declaration.exportId!];
          assert.equal(info.ordinary?.kind, "type-family");
          if (info.ordinary?.kind !== "type-family") assert.fail("Exact ordinary type-family evidence is required.");
          return [intrinsic, ...info.ordinary.family.variants.map(variant =>
            `${variant.sourceTypeArgumentCount}:${variant.declaration.exportId}`)];
        });
      },
      elaborateSource(context) {
        for (const node of variables(context.source)) context.request(node, key);
      },
    };
    const compiler = createCompilerSessionFromFiles({
      currentDirectory: "/src", rootFiles: ["/src/core.d.ts", "/src/bridge.ts", "/src/index.ts"],
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        "/src/bridge.ts": `export { operation as renamed } from "${moduleSpecifier}";`,
        "/src/index.ts": [
          'import { renamed } from "./bridge.js";',
          `import * as native from "${moduleSpecifier}";`,
          "const first = renamed; export const second = first; export const third = native.operation;",
          ...(mode === "declaration" ? ["renamed(3);"] : []),
        ].join("\n"),
      },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true },
      extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, {
        moduleSpecifier, providerModuleId: "Native", exports: declarations,
      }]])), extension] },
    });
    const checked = compiler.checkSource();
    assert.deepEqual(checked.diagnostics, [], checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.deepEqual(checked.extensionDiagnostics, []);
    assert.equal(previous.length, 3);
    const expected = [intrinsic, ...(mode === "intrinsic" ? [] : mode === "declaration"
      ? ["Native.operation.function"] : ["0:Native.operation.type0", "1:Native.operation.type1"])];
    for (const node of variables(checked)) assert.deepEqual(checked.sourceFacts.getFact(node, key), expected);
    for (const retained of previous) {
      assert.throws(() => retained.source.getSourceFile("/src/index.ts"), /retired compiler/u);
    }
  });
}
