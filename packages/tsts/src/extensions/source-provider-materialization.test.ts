import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  createCompilerSessionFromFiles,
  TstsSourceProviderContractVersion,
  type CheckedSourceProgram,
  type CompilerSession,
  type ProviderDeclarationModel,
  type ProviderDeclarationRequest,
} from "../index.js";
import type { Node } from "../internal/ast/ast.js";
import type { GoPtr } from "../go/compat.js";
import {
  sourceProviderExtension,
  sourceProviderCompilerExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";
import { ExtensionHost, type SourceDeclarationProvider } from "./host.js";

test("incremental providers materialize only exact structured exports demanded by source checking", () => {
  const moduleSpecifier = "@test/lazy/model.js";
  const requests: ProviderDeclarationRequest[] = [];
  const baseModel = lazyModel(moduleSpecifier, completeRequest());
  const extension = sourceProviderExtension(new Map([[moduleSpecifier, baseModel]]), {
    declarationMaterialization: "incremental",
    getDeclarationModel(_resolution, _model, request) {
      requests.push(request);
      assertFrozenRequest(request);
      return lazyModel(moduleSpecifier, request);
    },
  });
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { Root } from "${moduleSpecifier}";`,
        "declare const root: Root;",
        "export const value = root.next.value;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [extension] },
  });
  const initialProgram = session.program;

  const checked = session.checkSource();

  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map((diagnostic) => Diagnostic_String(diagnostic)).join("\n"),
  );
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.notEqual(checked.program, initialProgram);
  const materializations = distinctMaterializations(requests);
  assert.deepEqual(materializations, [
    [],
    ["Root#Test.Root"],
    ["Leaf#Test.Leaf", "Root#Test.Root"],
  ]);
  assert.equal(materializations.flat().some((entry) => entry.includes("Unused")), false);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile !== undefined);
  const rootUse = findIdentifier(checked, sourceFile, "root");
  assert.ok(rootUse !== undefined);
  const sourceQueries = checked.getSourceFileQueries(sourceFile);
  assert.doesNotThrow(() => sourceQueries.typeShape.getPropertyInfos(
    sourceQueries.checker.getTypeAtLocation(rootUse)?.type,
  ));
});

test("incremental provider missing members converge to the ordinary TypeScript diagnostic", () => {
  const moduleSpecifier = "@test/lazy/missing.js";
  const requests: ProviderDeclarationRequest[] = [];
  const baseModel = lazyModel(moduleSpecifier, completeRequest());
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { Root } from "${moduleSpecifier}";`,
        "declare const root: Root;",
        "export const value = root.missing;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderExtension(new Map([[moduleSpecifier, baseModel]]), {
        declarationMaterialization: "incremental",
        getDeclarationModel(_resolution, _model, request) {
          requests.push(request);
          return lazyModel(moduleSpecifier, request);
        },
      })],
    },
  });

  const checked = session.checkSource();

  assert.deepEqual(checked.diagnostics.map((diagnostic) => Diagnostic_Code(diagnostic)), [2339]);
  assert.deepEqual(distinctMaterializations(requests), [[], ["Root#Test.Root"]]);
  assert.deepEqual(checked.extensionDiagnostics, []);
});

test("incremental provider type families demand the exact selected arity variant", () => {
  const moduleSpecifier = "@test/lazy/family.js";
  const requests: ProviderDeclarationRequest[] = [];
  const extension = sourceProviderExtension(
    new Map([[moduleSpecifier, familyModel(moduleSpecifier, completeRequest())]]),
    {
      declarationMaterialization: "incremental",
      getDeclarationModel(_resolution, _model, request) {
        requests.push(request);
        return familyModel(moduleSpecifier, request);
      },
    },
  );
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { Family } from "${moduleSpecifier}";`,
        "declare const value: Family<number>;",
        "export const selected = value.generic;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [extension] },
  });

  const checked = session.checkSource();

  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map((diagnostic) => Diagnostic_String(diagnostic)).join("\n"),
  );
  assert.deepEqual(distinctMaterializations(requests), [[], ["Family#Test.Family`1"]]);
  assert.deepEqual(checked.extensionDiagnostics, []);
});

test("direct provider registry use requests one complete immutable declaration model", () => {
  const moduleSpecifier = "@test/lazy/direct.js";
  let observed: ProviderDeclarationRequest | undefined;
  const provider: SourceDeclarationProvider = {
    identity: {
      id: "test.lazy.direct",
      version: "1.0.0",
      extensionContractVersion: TstsSourceProviderContractVersion,
    },
    declarationMaterialization: "incremental",
    ownsModule: (specifier) => specifier === moduleSpecifier
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule: (specifier) => ({
      kind: "virtual",
      moduleSpecifier: specifier,
      virtualFileName: "/provider/Test.Lazy.d.ts",
      providerModuleId: "Test.Lazy",
    }),
    getDeclarationModel(_resolution, request) {
      observed = request;
      return lazyModel(moduleSpecifier, request);
    },
  };
  const host = new ExtensionHost({}, {
    extensions: [sourceProviderCompilerExtension(provider)],
  });

  assert.equal(host.providers.resolveVirtualModule(moduleSpecifier, {
    containingFile: "/src/index.ts",
    resolutionMode: "import",
  }).kind, "resolved");
  assert.deepEqual(observed, {
    context: {
      containingFile: "/src/index.ts",
      resolutionMode: "import",
    },
    materialization: { kind: "complete" },
  });
  assertFrozenRequest(observed!);
});

test("complete providers retain one compiler program and one complete declaration request", () => {
  const fixture = createLazyRootSession("complete");
  const initialProgram = fixture.session.program;

  assert.deepEqual(fixture.session.getDiagnostics("semantic"), []);
  const checked = fixture.session.checkSource();

  assert.equal(checked.program, initialProgram);
  assert.equal(fixture.session.program, initialProgram);
  assert.equal(fixture.session.checkSource(), checked);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(distinctMaterializations(fixture.requests), [["*"]]);
  assertFrozenRequest(fixture.requests[0]!);
});

test("every semantic compiler-session entrypoint converges exact provider demand", () => {
  const entrypoints: readonly (readonly [string, (session: CompilerSession) => unknown])[] = [
    ["ensureChecked", (session) => session.ensureChecked()],
    ["semantic diagnostics", (session) => session.getDiagnostics("semantic")],
    ["source files to emit", (session) => session.getSourceFilesToEmit()],
  ];

  for (const [name, invoke] of entrypoints) {
    const fixture = createLazyRootSession("incremental");
    const initialProgram = fixture.session.program;

    invoke(fixture.session);

    assert.notEqual(fixture.session.program, initialProgram, name);
    assert.deepEqual(distinctMaterializations(fixture.requests), [
      [],
      ["Root#Test.Root"],
      ["Leaf#Test.Leaf", "Root#Test.Root"],
    ], name);
    const checked = fixture.session.checkSource();
    assert.equal(checked.program, fixture.session.program, name);
    assert.equal(checked.diagnostics.length, 0, name);
    assert.deepEqual(checked.extensionDiagnostics, [], name);
  }
});

test("duplicate alias namespace and re-export uses produce one ordered demand set", () => {
  const moduleSpecifier = "@test/lazy/multiple.js";
  const observedByOrder: (readonly (readonly string[])[])[] = [];
  for (const expression of [
    "aliased.value + namespaced.value + other.value",
    "other.value + namespaced.value + aliased.value",
  ]) {
    const requests: ProviderDeclarationRequest[] = [];
    const baseModel = multipleModel(moduleSpecifier, completeRequest());
    const extension = sourceProviderExtension(new Map([[moduleSpecifier, baseModel]]), {
      declarationMaterialization: "incremental",
      getDeclarationModel(_resolution, _model, request) {
        requests.push(request);
        assertFrozenRequest(request);
        return multipleModel(moduleSpecifier, request);
      },
    });
    const checked = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/core.d.ts", "/src/bridge.ts", "/src/index.ts"],
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        "/src/bridge.ts": `export type { A as AliasA } from "${moduleSpecifier}";`,
        "/src/index.ts": [
          'import type { AliasA } from "./bridge.js";',
          `import type * as provider from "${moduleSpecifier}";`,
          "declare const aliased: AliasA;",
          "declare const namespaced: provider.A;",
          "declare const other: provider.B;",
          `export const total = ${expression};`,
        ].join("\n"),
      },
      compilerOptions: testNoLibCompilerOptions,
      extensionHostOptions: { extensions: [extension] },
    }).checkSource();

    assert.equal(
      checked.diagnostics.length,
      0,
      checked.diagnostics.map((diagnostic) => Diagnostic_String(diagnostic)).join("\n"),
    );
    assert.deepEqual(checked.extensionDiagnostics, []);
    observedByOrder.push(distinctMaterializations(requests));
  }

  const expected = [[], ["A#Test.A", "B#Test.B"]];
  assert.deepEqual(observedByOrder, [expected, expected]);
  assert.equal(observedByOrder.flat(2).some((entry) => entry.includes("Unused")), false);
});

function createLazyRootSession(
  declarationMaterialization: SourceDeclarationProvider["declarationMaterialization"],
): { readonly session: CompilerSession; readonly requests: ProviderDeclarationRequest[] } {
  const moduleSpecifier = "@test/lazy/session.js";
  const requests: ProviderDeclarationRequest[] = [];
  const baseModel = lazyModel(moduleSpecifier, completeRequest());
  const extension = sourceProviderExtension(new Map([[moduleSpecifier, baseModel]]), {
    declarationMaterialization,
    getDeclarationModel(_resolution, _model, request) {
      requests.push(request);
      return lazyModel(moduleSpecifier, request);
    },
  });
  return {
    session: createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/core.d.ts", "/src/index.ts"],
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        "/src/index.ts": [
          `import type { Root } from "${moduleSpecifier}";`,
          "declare const root: Root;",
          "export const value = root.next.value;",
        ].join("\n"),
      },
      compilerOptions: testNoLibCompilerOptions,
      extensionHostOptions: { extensions: [extension] },
    }),
    requests,
  };
}

function multipleModel(
  moduleSpecifier: string,
  request: ProviderDeclarationRequest,
): ProviderDeclarationModel {
  return {
    moduleSpecifier,
    providerModuleId: "Test.Lazy.Multiple",
    exports: ["A", "B", "Unused"].map((name) => ({
      id: `Test.${name}`,
      name,
      kind: "class" as const,
      ...(isComplete(request, name, `Test.${name}`)
        ? {
          members: [{
            id: `Test.${name}.value`,
            name: "value",
            kind: "property" as const,
            readonly: true,
            type: { kind: "number" as const },
          }],
        }
        : {}),
    })),
  };
}

function lazyModel(
  moduleSpecifier: string,
  request: ProviderDeclarationRequest,
): ProviderDeclarationModel {
  return {
    moduleSpecifier,
    providerModuleId: "Test.Lazy",
    exports: [{
      id: "Test.Root",
      name: "Root",
      kind: "class",
      ...(isComplete(request, "Root", "Test.Root")
        ? {
          members: [{
            id: "Test.Root.next",
            name: "next",
            kind: "property" as const,
            readonly: true,
            type: {
              kind: "provider-ref" as const,
              moduleSpecifier,
              exportName: "Leaf",
            },
          }, {
            id: "Test.Root.unused",
            name: "unused",
            kind: "property" as const,
            readonly: true,
            type: {
              kind: "provider-ref" as const,
              moduleSpecifier,
              exportName: "Unused",
            },
          }],
        }
        : {}),
    }, {
      id: "Test.Leaf",
      name: "Leaf",
      kind: "class",
      ...(isComplete(request, "Leaf", "Test.Leaf")
        ? {
          members: [{
            id: "Test.Leaf.value",
            name: "value",
            kind: "property" as const,
            readonly: true,
            type: { kind: "number" as const },
          }],
        }
        : {}),
    }, {
      id: "Test.Unused",
      name: "Unused",
      kind: "class",
      ...(isComplete(request, "Unused", "Test.Unused")
        ? {
          members: [{
            id: "Test.Unused.hidden",
            name: "hidden",
            kind: "property" as const,
            readonly: true,
            type: { kind: "number" as const },
          }],
        }
        : {}),
    }],
  };
}

function completeRequest(): ProviderDeclarationRequest {
  return Object.freeze({
    context: Object.freeze({}),
    materialization: Object.freeze({ kind: "complete" }),
  });
}

function familyModel(
  moduleSpecifier: string,
  request: ProviderDeclarationRequest,
): ProviderDeclarationModel {
  return {
    moduleSpecifier,
    providerModuleId: "Test.Lazy.Family",
    exports: [{
      id: "Test.Family",
      name: "Family0",
      kind: "class",
      sourceTypeFamily: { exportName: "Family", typeArgumentCount: 0 },
      ...(isComplete(request, "Family", "Test.Family")
        ? {
          members: [{
            id: "Test.Family.value",
            name: "value",
            kind: "property" as const,
            readonly: true,
            type: { kind: "number" as const },
          }],
        }
        : {}),
    }, {
      id: "Test.Family`1",
      name: "Family1",
      kind: "class",
      sourceTypeFamily: { exportName: "Family", typeArgumentCount: 1 },
      typeParameters: [{ name: "T" }],
      ...(isComplete(request, "Family", "Test.Family`1")
        ? {
          members: [{
            id: "Test.Family`1.generic",
            name: "generic",
            kind: "property" as const,
            readonly: true,
            type: { kind: "type-parameter" as const, name: "T" },
          }],
        }
        : {}),
    }],
  };
}

function isComplete(
  request: ProviderDeclarationRequest,
  exportName: string,
  exportId: string,
): boolean {
  return request.materialization.kind === "complete"
    || request.materialization.completeExports.some((entry) =>
      entry.exportName === exportName
      && (entry.exportId === undefined || entry.exportId === exportId)
    );
}

function distinctMaterializations(
  requests: readonly ProviderDeclarationRequest[],
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const request of requests) {
    const materialization = request.materialization.kind === "complete"
      ? ["*"]
      : request.materialization.completeExports.map((entry) =>
        `${entry.exportName}#${entry.exportId ?? "*"}`
      );
    const key = JSON.stringify(materialization);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(materialization);
    }
  }
  return result;
}

function assertFrozenRequest(request: ProviderDeclarationRequest): void {
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.context), true);
  assert.equal(Object.isFrozen(request.materialization), true);
  if (request.materialization.kind === "incremental") {
    assert.equal(Object.isFrozen(request.materialization.completeExports), true);
    assert.equal(request.materialization.completeExports.every(Object.isFrozen), true);
  }
}

function findIdentifier(
  checked: CheckedSourceProgram,
  root: GoPtr<Node>,
  text: string,
): GoPtr<Node> {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    if (checked.ast.is.IsIdentifier(node) && checked.ast.text(node) === text) {
      return node;
    }
    pending.push(...checked.ast.children(node));
  }
  return undefined;
}
