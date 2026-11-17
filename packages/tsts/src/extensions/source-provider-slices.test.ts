import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import {
  ExtensionHost,
  type ProviderDeclarationModel,
  type ProviderExportDeclaration,
  type ProviderImportSlice,
  type ProviderModuleContext,
  type ProviderModuleResolveResult,
  type SourceDeclarationProvider,
} from "./index.js";
import {
  findNodes,
  sourceProviderCompilerExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
  testProviderIdentity,
} from "./source-provider-test-support.js";

const moduleSpecifier = "@test/slices.js";
const consumerModuleSpecifier = "@test/slice-consumer.js";
const providerModuleId = "Test.Slices";

test("provider slices compose subset, superset, overlap, and disjoint exports without broadening", () => {
  const declarations = ["A", "B", "C", "D"].map(classDeclaration);
  const requests = [
    ["A"],
    ["A", "B"],
    ["B", "C"],
    ["D"],
  ] as const;

  for (const orderedRequests of [requests, [...requests].reverse()]) {
    const host = hostFor(sliceProvider(declarations));
    const resolved = orderedRequests.map((names, index) =>
      host.providers.resolveVirtualModule(moduleSpecifier, contextFor(names, `/src/${index}.ts`)));
    assert.ok(resolved.every((result) => result.kind === "resolved"));
    assert.equal(host.diagnostics.all().length, 0);
    assert.equal(host.providers.getVirtualDeclarationDocuments().length, requests.length);

    for (let index = 0; index < orderedRequests.length; index += 1) {
      const result: ProviderModuleResolveResult | undefined = resolved[index];
      assert.ok(result?.kind === "resolved");
      assert.deepEqual(
        result.module.declarationModel.exports.map(sourceExportName),
        [...orderedRequests[index]!],
      );
      for (const name of orderedRequests[index]!) {
        assert.match(result.module.artifact.sourceText, new RegExp(`\\bas ${name}\\b`));
      }
      for (const name of ["A", "B", "C", "D"]) {
        if (!new Set<string>(orderedRequests[index]).has(name)) {
          assert.equal(
            new RegExp(`\\bas ${name}\\b`).test(result.module.artifact.sourceText),
            false,
            `Slice ${index} must not broaden to unrequested export ${name}.`,
          );
        }
      }
    }
  }
});

test("byte-identical provider slices reuse one artifact while distinct slices remain distinct", () => {
  const host = hostFor(sliceProvider(["A", "B"].map(classDeclaration)));
  const first = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["A"], "/src/first.ts"),
  );
  const repeated = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["A"], "/src/first.ts"),
  );
  const equivalent = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["A"], "/src/equivalent.ts"),
  );
  const distinct = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["B"], "/src/second.ts"),
  );

  assert.ok(first.kind === "resolved");
  assert.ok(repeated === first, "An exact repeated request must reuse its terminal result.");
  assert.ok(equivalent.kind === "resolved");
  assert.ok(distinct.kind === "resolved");
  assert.ok(
    equivalent.module.artifact === first.module.artifact,
    "Byte-identical rendered slices must intern one immutable artifact.",
  );
  assert.notEqual(distinct.module.artifact.fileName, first.module.artifact.fileName);
  assert.equal(host.providers.getVirtualDeclarationDocuments().length, 2);
});

test("contradictory contracts for one public provider export fail closed transactionally", () => {
  const numberValue: ProviderExportDeclaration = {
    id: "Value",
    name: "Value",
    kind: "value",
    type: { kind: "number" },
  };
  const stringValue: ProviderExportDeclaration = {
    id: "Value",
    name: "Value",
    kind: "value",
    type: { kind: "string" },
  };
  const host = hostFor(sliceProvider([numberValue], {
    declarationForContext: (context) =>
      context.containingFile === "/src/conflict.ts" ? [stringValue] : [numberValue],
  }));

  const accepted = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["Value"], "/src/accepted.ts"),
  );
  assert.equal(accepted.kind, "resolved");
  const beforeDocuments = host.providers.getVirtualDeclarationDocuments();

  const rejected = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["Value"], "/src/conflict.ts"),
  );
  assert.equal(rejected.kind, "rejected");
  assert.equal(
    rejected.kind === "rejected" ? rejected.diagnostic.extensionCode : "",
    "INVALID_PROVIDER_DECLARATION_MODEL",
  );
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), beforeDocuments);
  assert.equal(host.providers.getVirtualDeclarationDocuments().length, 1);
});

test("a requested public type family slice contains every exact arity variant", () => {
  const variants: ProviderExportDeclaration[] = [{
    id: "Task",
    name: "Task",
    kind: "class",
    sourceTypeFamily: { exportName: "Task", typeArgumentCount: 0 },
  }, {
    id: "Task_1",
    name: "Task_1",
    kind: "class",
    sourceTypeFamily: { exportName: "Task", typeArgumentCount: 1 },
    typeParameters: [{ name: "T" }],
    members: [{
      id: "Task_1::Result",
      name: "Result",
      kind: "property",
      readonly: true,
      type: { kind: "type-parameter", name: "T" },
    }],
  }];
  const host = hostFor(sliceProvider(variants));

  const result = host.providers.resolveVirtualModule(
    moduleSpecifier,
    contextFor(["Task"], "/src/task.ts", true),
  );
  assert.ok(result.kind === "resolved");
  assert.deepEqual(
    result.module.declarationModel.exports.map((entry) => [
      entry.id,
      entry.sourceTypeFamily?.typeArgumentCount,
    ]),
    [["Task", 0], ["Task_1", 1]],
  );
  assert.match(result.module.artifact.sourceText, /as Task \};/);
  assert.equal(
    result.module.artifact.sourceText.match(/\bas Task\b/g)?.length,
    1,
    "A complete type family must publish one public source export.",
  );
  assert.equal(result.module.artifact.sourceText.includes("export type Task_1"), false);
});

test("slice identity remains one public checker symbol across generated and source imports", () => {
  const declarations = ["A", "B", "C"].map(classDeclaration);
  const provider = multiModuleSliceProvider(new Map([
    [moduleSpecifier, declarations],
    [consumerModuleSpecifier, [{
      id: "Consumer",
      name: "Consumer",
      kind: "class",
      members: [{
        id: "Consumer::value",
        name: "value",
        kind: "property",
        readonly: true,
        type: {
          kind: "provider-ref",
          moduleSpecifier,
          exportName: "A",
        },
      }],
    }]],
  ]));
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { Consumer } from "${consumerModuleSpecifier}";`,
        `import type { A, B, C } from "${moduleSpecifier}";`,
        "declare const consumer: Consumer;",
        "export const value: A = consumer.value;",
        "export declare const b: B;",
        "export declare const c: C;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderCompilerExtension(provider)],
    },
  });

  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const imports = findNodes(sourceFile, source.ast.children, source.ast.is.IsImportSpecifier);
  const importedA = imports.find((node) => source.ast.text(source.ast.name(node)) === "A");
  assert.ok(importedA !== undefined);
  const importedAlias = source.checker.getSymbolAtLocation(source.ast.name(importedA));
  const importedSymbol = source.checker.getAliasedSymbol(importedAlias);
  const property = findNodes(
    sourceFile,
    source.ast.children,
    source.ast.is.IsPropertyAccessExpression,
  )[0];
  const propertyTypeSymbol = source.checker.getTypeSymbol(
    source.checker.getTypeAtLocation(property)?.type,
  );
  assert.ok(
    propertyTypeSymbol === importedSymbol,
    "Generated narrow and source broad slices must resolve A to one checker symbol.",
  );
});

function hostFor(sourceProvider: SourceDeclarationProvider): ExtensionHost {
  return new ExtensionHost({}, {
    extensions: [sourceProviderCompilerExtension(sourceProvider)],
  });
}

function classDeclaration(name: string): ProviderExportDeclaration {
  return { id: name, name, kind: "class" };
}

function sourceExportName(declaration: ProviderExportDeclaration): string {
  return declaration.sourceTypeFamily?.exportName
    ?? (declaration.exportKind === "default"
      ? "default"
      : declaration.exportName ?? declaration.name);
}

function contextFor(
  names: readonly string[],
  containingFile: string,
  typeOnly = false,
): ProviderModuleContext {
  return {
    containingFile,
    resolutionMode: "import",
    importSlice: {
      moduleSpecifier,
      kind: "named",
      requestedExports: names.map((exportedName) => ({
        exportedName,
        kind: typeOnly ? "type" : "value",
      })),
      typeOnly,
    },
  };
}

function sliceProvider(
  declarations: readonly ProviderExportDeclaration[],
  options: {
    readonly declarationForContext?: (
      context: ProviderModuleContext,
    ) => readonly ProviderExportDeclaration[];
  } = {},
): SourceDeclarationProvider {
  return multiModuleSliceProvider(new Map([[moduleSpecifier, declarations]]), options);
}

function multiModuleSliceProvider(
  declarationsByModule: ReadonlyMap<string, readonly ProviderExportDeclaration[]>,
  options: {
    readonly declarationForContext?: (
      context: ProviderModuleContext,
    ) => readonly ProviderExportDeclaration[];
  } = {},
): SourceDeclarationProvider {
  const modelsByFile = new Map<string, ProviderDeclarationModel>();
  return {
    identity: testProviderIdentity("test.slices"),
    declarationMaterialization: "complete",
    ownsModule: (specifier) => declarationsByModule.has(specifier)
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule(specifier, context) {
      const available = options.declarationForContext?.(context)
        ?? declarationsByModule.get(specifier)
        ?? [];
      const requested = requestedExportNames(context.importSlice);
      const selected = requested === undefined
        ? available
        : available.filter((declaration) => requested.has(sourceExportName(declaration)));
      const key = selected.map((declaration) => declaration.id).join("-");
      const contextKey = context.containingFile === "/src/conflict.ts" ? "-conflict" : "";
      const moduleId = specifier === moduleSpecifier ? providerModuleId : "Test.SliceConsumer";
      const fileName = `/provider/${moduleId}.${key || "bare"}${contextKey}.d.ts`;
      modelsByFile.set(fileName, {
        moduleSpecifier: specifier,
        providerModuleId: moduleId,
        ...(specifier === consumerModuleSpecifier
          ? {
              imports: [{
                moduleSpecifier,
                namedImports: [{ exportedName: "A", kind: "type" as const }],
                typeOnly: true,
              }],
            }
          : {}),
        exports: selected,
      });
      return {
        kind: "virtual",
        moduleSpecifier: specifier,
        virtualFileName: fileName,
        providerModuleId: moduleId,
      };
    },
    getDeclarationModel(module) {
      const model = modelsByFile.get(module.virtualFileName);
      if (model === undefined) {
        throw new Error(`No exact provider model exists for ${module.virtualFileName}.`);
      }
      return model;
    },
  };
}

function requestedExportNames(slice: ProviderImportSlice | undefined): ReadonlySet<string> | undefined {
  if (slice?.broadImport === true || slice?.requestedExports === undefined) {
    return undefined;
  }
  return new Set(slice.requestedExports.map((entry) => entry.exportedName));
}
