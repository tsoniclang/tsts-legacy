import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompilerSessionFromFiles,
  defineExtensionFactKey,
  type CompilerExtension,
  type ProviderDeclarationModel,
} from "../index.js";
import { getExtensionHost } from "../extensions/host.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "../extensions/source-provider-test-support.js";

test("direct source queries are canonical and side-effect free across query order", () => {
  const moduleSpecifier = "@test/direct-query.js";
  const extensionId = "test.direct-query";
  const analyzedFactKey = defineExtensionFactKey<string>({
    extensionId,
    name: "analyzed",
    snapshot: (value) => value,
  });
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.DirectQuery",
    exports: [{
      id: "Box",
      name: "Box",
      kind: "class",
      members: [{
        id: "Box::.ctor",
        name: "constructor",
        kind: "constructor",
        signatures: [{
          id: "Box::.ctor(number)",
          parameters: [{ name: "value", type: { kind: "number" } }],
        }],
      }, {
        id: "Box::value",
        name: "value",
        kind: "property",
        readonly: true,
        type: { kind: "number" },
      }, {
        id: "Box::read",
        name: "read",
        kind: "method",
        signatures: [{
          id: "Box::read()",
          parameters: [],
          returnType: { kind: "number" },
        }],
      }, {
        id: "Box::index",
        name: "index",
        kind: "indexer",
        readonly: true,
        signatures: [{
          id: "Box::index(number)",
          parameters: [{ name: "index", type: { kind: "number" } }],
          returnType: { kind: "number" },
        }],
      }],
    }],
  };
  const provider = sourceProviderExtension(new Map([[moduleSpecifier, model]]), {
    extensionId,
    providerId: "test.direct-query.provider",
  });
  const extension: CompilerExtension = {
    ...provider,
    analyzeSource(context): void {
      const sourceFile = context.source.getSourceFile("/src/index.ts");
      assert.ok(sourceFile !== undefined);
      assert.equal(context.facts.set(sourceFile, analyzedFactKey, "complete"), "inserted");
    },
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import { Box } from "${moduleSpecifier}";`,
        "const box = new Box(1);",
        "const called = box.read();",
        "const property = box.value;",
        "const element = box[0];",
        "const asserted = called as number;",
        "const sum = property + element;",
        "for (const item of [sum]) { void item; }",
        "function maybe(flag: boolean) { if (flag) return sum; }",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [extension] },
  });

  const checked = session.checkSource();
  assert.deepEqual(checked.diagnostics.map((diagnostic) => diagnostic?.code), []);
  assert.equal(checked.extensionDiagnostics.length, 0);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile !== undefined);
  const source = checked.getSourceFileQueries(sourceFile);
  const construction = findNodes(sourceFile, source.ast.children, source.ast.is.IsNewExpression)[0];
  const call = findNodes(sourceFile, source.ast.children, source.ast.is.IsCallExpression)[0];
  const properties = findNodes(sourceFile, source.ast.children, source.ast.is.IsPropertyAccessExpression);
  const property = properties.find((node) => source.ast.text(source.ast.name(node)) === "value");
  const element = findNodes(sourceFile, source.ast.children, source.ast.is.IsElementAccessExpression)[0];
  const assertion = findNodes(sourceFile, source.ast.children, source.ast.is.IsAsExpression)[0];
  const binary = findNodes(sourceFile, source.ast.children, source.ast.is.IsBinaryExpression)[0];
  const iteration = findNodes(sourceFile, source.ast.children, source.ast.is.IsForOfStatement)[0];
  assert.ok(construction !== undefined);
  assert.ok(call !== undefined);
  assert.ok(property !== undefined);
  assert.ok(element !== undefined);
  assert.ok(assertion !== undefined);
  assert.ok(binary !== undefined);
  assert.ok(iteration !== undefined);
  const callable = findNodes(sourceFile, source.ast.children, source.ast.is.IsFunctionDeclaration)[0];
  assert.ok(callable !== undefined);

  const host = getExtensionHost(session.program!);
  assert.ok(host !== undefined);
  const diagnosticsBefore = checked.diagnostics;
  const extensionDiagnosticsBefore = host.diagnostics.all();
  const factsBefore = checked.sourceFacts?.getFacts(sourceFile);
  const documentsBefore = host.providers.getVirtualDeclarationDocuments();
  const sourceFilesBefore = checked.sourceFiles;
  const queries = [
    () => source.checker.getResolvedCallInfo(construction),
    () => source.checker.getResolvedCallInfo(call),
    () => source.checker.getResolvedPropertyAccessInfo(property),
    () => source.checker.getResolvedElementAccessInfo(element),
    () => source.checker.getTypeAtLocation(assertion),
    () => source.checker.getTypeAtLocation(binary),
    () => source.checker.getResolvedIterationInfo(iteration),
    () => source.checker.getResolvedCallableCompletionInfo(callable),
  ] as const;

  const first = queries.map((query) => query());
  const repeated = queries.map((query) => query());
  for (let index = 0; index < first.length; index += 1) {
    assert.ok(repeated[index] === first[index]);
  }
  for (let index = queries.length - 1; index >= 0; index -= 1) {
    const query = queries[index];
    assert.ok(query !== undefined);
    assert.ok(query() === first[index]);
  }

  assert.deepEqual(session.checkSource().diagnostics, diagnosticsBefore);
  assert.deepEqual(host.diagnostics.all(), extensionDiagnosticsBefore);
  assert.deepEqual(checked.sourceFacts?.getFacts(sourceFile), factsBefore);
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), documentsBefore);
  assert.deepEqual(session.checkSource().sourceFiles, sourceFilesBefore);
  assert.equal(checked.sourceFacts?.getFact(sourceFile, analyzedFactKey), "complete");
});
