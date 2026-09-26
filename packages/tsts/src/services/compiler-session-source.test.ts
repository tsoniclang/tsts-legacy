import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceFile } from "../internal/ast/ast.js";
import { Node_Locals, Node_Symbol, SourceFile_IsBound } from "../internal/ast/ast.js";
import type { SourceFileParseOptions } from "../internal/ast/parseoptions.js";
import { BindSourceFile } from "../internal/binder/binder.js";
import type { CompilerHost } from "../internal/compiler/host.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { createSourceProgramQueries } from "../extensions/source-program.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "../extensions/source-provider-test-support.js";
import type { ProviderDeclarationModel } from "../extensions/host.js";
import { createCompilerSession, createCompilerSessionFromFiles } from "./compiler-session.js";
import { createCompilerHost, createInMemoryFileSystem } from "./embedding-host.js";
import { createCompilerSessionHost } from "./compiler-session-source.js";
import { createAstReader } from "./ast-reader.js";

const sourceName = "/src/index.ts";
const sourceText = "export function read(value: number): number { const Δ = value; return Δ; }";
const parseOptions: SourceFileParseOptions = { FileName: sourceName, Path: sourceName };

test("session source acquisition retains fresh syntax and the host's receiver", () => {
  const host = physicalHost(sourceText);
  const sourceFile = host.GetSourceFile(parseOptions);
  assert.ok(sourceFile);
  const calls: string[] = [];
  const cachedHost: CompilerHost = {
    ...host,
    GetSourceFile(options) {
      assert.equal(this, cachedHost);
      calls.push(options.FileName);
      return sourceFile;
    },
  };
  const sessionHost = createCompilerSessionHost(cachedHost);
  assert.equal(sessionHost.GetSourceFile(parseOptions), sourceFile);
  assert.deepEqual(calls, [sourceName]);
  assert.equal(sessionHost.FS(), host.FS());
  assert.equal(sessionHost.GetCurrentDirectory(), host.GetCurrentDirectory());
  assert.equal(sessionHost.DefaultLibraryPath(), host.DefaultLibraryPath());
});

test("session source acquisition reparses cached syntax before another epoch binds it", () => {
  const host = physicalHost(sourceText);
  const sourceFile = host.GetSourceFile(parseOptions);
  assert.ok(sourceFile);
  const sessionHost = createCompilerSessionHost({ ...host, GetSourceFile: () => sourceFile });
  const first = sessionHost.GetSourceFile(parseOptions);
  const second = sessionHost.GetSourceFile(parseOptions);
  assert.equal(first, sourceFile);
  assert.ok(second);
  assert.notEqual(second, first);
  const ast = createAstReader();
  const firstNodes = new Set(findNodes(first, ast.children, () => true));
  assert.equal(findNodes(second, ast.children, () => true).some(node => firstNodes.has(node)), false);
  assert.equal(second.Text(), sourceFile.Text());
  assert.equal(second.ScriptKind, sourceFile.ScriptKind);
  assert.deepEqual(second.parseOptions, parseOptions);
  assert.equal(SourceFile_IsBound(first), false);
  assert.equal(SourceFile_IsBound(second), false);
  BindSourceFile(first);
  BindSourceFile(second);
  assert.ok(Node_Symbol(first));
  assert.ok(Node_Symbol(second));
  assert.notEqual(Node_Symbol(second), Node_Symbol(first));
  assert.notEqual(Node_Locals(second), Node_Locals(first));
});

test("session source acquisition never resets a host's prebound tree", () => {
  const host = physicalHost(sourceText);
  const sourceFile = host.GetSourceFile(parseOptions);
  assert.ok(sourceFile);
  BindSourceFile(sourceFile);
  const originalSymbol = Node_Symbol(sourceFile);
  const originalLocals = Node_Locals(sourceFile);
  const sessionHost = createCompilerSessionHost({ ...host, GetSourceFile: () => sourceFile });
  const acquired = sessionHost.GetSourceFile(parseOptions);
  assert.ok(acquired);
  assert.notEqual(acquired, sourceFile);
  assert.equal(SourceFile_IsBound(acquired), false);
  assert.equal(SourceFile_IsBound(sourceFile), true);
  assert.equal(Node_Symbol(sourceFile), originalSymbol);
  assert.equal(Node_Locals(sourceFile), originalLocals);
  assert.equal(Node_Symbol(acquired), undefined);
});

test("session source acquisition preserves absent files and current parse options", () => {
  const host = physicalHost("const value = 1;");
  const sourceFile = host.GetSourceFile(parseOptions);
  assert.ok(sourceFile);
  const sessionHost = createCompilerSessionHost({
    ...host,
    GetSourceFile: options => options.FileName === sourceName ? sourceFile : undefined,
  });
  assert.equal(sessionHost.GetSourceFile({ FileName: "/src/missing.ts", Path: "/src/missing.ts" }), undefined);
  assert.equal(sessionHost.GetSourceFile(parseOptions), sourceFile);
  const forcedModule = sessionHost.GetSourceFile({
    ...parseOptions,
    ExternalModuleIndicatorOptions: { Force: true, JSX: false },
  });
  assert.ok(forcedModule);
  assert.equal(sourceFile.ExternalModuleIndicator, undefined);
  assert.equal(forcedModule.ExternalModuleIndicator, forcedModule);
  assert.equal(forcedModule.Text(), sourceFile.Text());
});

for (const invalidAssignment of [false, true]) {
  test(`provider replay uses fresh binding epochs with a cached host (${invalidAssignment ? "invalid" : "valid"} source)`, () => {
    const moduleSpecifier = "@test/epoch/model.js";
    const model: ProviderDeclarationModel = {
      moduleSpecifier,
      providerModuleId: "Test.Epoch",
      exports: [{ id: "Test.Value", name: "Value", kind: "class" }],
    };
    let requests = 0;
    const provider = sourceProviderExtension(new Map([[moduleSpecifier, model]]), {
      declarationMaterialization: "incremental",
      getDeclarationModel(_resolution, _model, request) {
        requests += 1;
        const complete = request.materialization.kind === "complete" ||
          request.materialization.completeExports.some(entry => entry.exportName === "Value");
        return {
          ...model,
          exports: [{
            ...model.exports[0]!,
            ...(complete ? { members: [{
              id: "Test.Value.count", name: "count", kind: "property" as const,
              readonly: true, type: { kind: "number" as const },
            }] } : {}),
          }],
        };
      },
    });
    const base = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/core.d.ts", sourceName],
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        [sourceName]: [
          `import type { Value } from "${moduleSpecifier}";`,
          "declare const value: Value;",
          `export const count: ${invalidAssignment ? "string" : "number"} = value.count;`,
          "export function identity(input: number): number { return input; }",
          "export const answer = identity(42);",
        ].join("\n"),
      },
      compilerOptions: testNoLibCompilerOptions,
    });
    const cache = new Map<string, SourceFile>();
    const cachingHost: CompilerHost = {
      ...base.host,
      GetSourceFile(options) {
        const cached = cache.get(options.Path);
        if (cached !== undefined) return cached;
        const sourceFile = base.host.GetSourceFile(options);
        if (sourceFile !== undefined) cache.set(options.Path, sourceFile);
        return sourceFile;
      },
    };
    const session = createCompilerSession({
      programOptions: { Host: cachingHost, Config: base.config },
      extensionHostOptions: { extensions: [provider] },
    });
    const original = createSourceProgramQueries(session.program).getSourceFile(sourceName);
    assert.ok(original);
    session.ensureBound();
    const originalSymbol = Node_Symbol(original);
    const originalQueries = createSourceProgramQueries(session.program);
    const originalQuery = originalQueries.getSourceFileQueries(original);
    const originalCall = findNodes(original, originalQuery.ast.children, originalQuery.ast.is.IsCallExpression)[0];
    assert.ok(originalCall);
    const originalCallInfo = originalQuery.checker.getResolvedCallInfo(originalCall);
    const originalType = originalQuery.checker.getTypeAtLocation(originalCall);
    const originalSignature = originalQuery.checker.getResolvedSignature(originalCall);
    assert.ok(originalCallInfo);
    assert.ok(originalType);
    assert.ok(originalSignature);
    const checked = session.checkSource();
    const current = checked.getSourceFile(sourceName);
    assert.ok(current);
    assert.ok(requests >= 2);
    assert.notEqual(current, original);
    assert.notEqual(Node_Symbol(current), originalSymbol);
    assert.equal(Node_Symbol(original), originalSymbol);
    assert.equal(cache.get(sourceName), original);
    assert.deepEqual(checked.extensionDiagnostics, []);
    assert.deepEqual(checked.diagnostics.map(Diagnostic_Code), invalidAssignment ? [2322] : [],
      checked.diagnostics.map(Diagnostic_String).join("\n"));
    assert.throws(() => checked.getSourceFileQueries(original), /different compiler program or epoch/u);
    const query = checked.getSourceFileQueries(current);
    const retired = /retired compiler program or epoch/u;
    assert.throws(() => originalQueries.getSourceFiles(), retired);
    assert.throws(() => originalQueries.getSourceFile(sourceName), retired);
    assert.throws(() => originalQueries.getSourceFileQueries(original), retired);
    assert.throws(() => originalQuery.checker.getResolvedCallInfo(originalCall), retired);
    assert.throws(() => originalQuery.checker.getTypeAtLocation(originalCall), retired);
    assert.throws(() => originalQuery.checker.getReturnTypeOfSignature(originalSignature), retired);
    assert.throws(() => originalQuery.typeShape.isNumberLike(originalType), retired);
    assert.throws(() => originalQuery.typeShape.getPropertyInfos(originalType), retired);
    assert.throws(() => query.checker.getTypeAtLocation(originalCall), /different compiler program or epoch/u);
    assert.throws(() => query.checker.typeToString(originalType), retired);
    assert.throws(() => query.typeShape.isNumberLike(originalType), retired);
    assert.throws(() => query.typeShape.getReturnTypeOfSignature(originalSignature), /different compiler program or epoch/u);
    const access = findNodes(current, query.ast.children, query.ast.is.IsPropertyAccessExpression)[0];
    assert.ok(access);
    assert.equal(query.checker.typeToString(query.checker.getTypeAtLocation(access)), "number");
  });
}

function physicalHost(text: string): CompilerHost {
  return createCompilerHost({
    currentDirectory: "/src",
    fileSystem: createInMemoryFileSystem({ files: { [sourceName]: text } }),
  });
}
