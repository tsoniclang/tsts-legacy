import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  defineExtensionFactKey,
  providerVirtualDeclarationFactKey,
  sourceMarkerFactKey,
  type ProviderDeclarationModel,
  type ProviderExportMaterializationContext,
  type SourceAnalysisFactAccess,
} from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  extensionHostProviderExportMaterialized,
  getExtensionHost,
} from "./host.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";

test("provider export notifications publish exact owned markers before source analysis and sealing", () => {
  const configuredModule = "@test/materialized.js";
  const foreignModule = "@test/foreign-materialized.js";
  const owner = "test.materialized-observer";
  const published = defineExtensionFactKey<boolean>({
    extensionId: owner,
    name: "published",
    snapshot: value => value,
    equals: (left, right) => left === right,
  });
  const models = new Map<string, ProviderDeclarationModel>();
  for (const moduleSpecifier of [configuredModule, foreignModule]) {
    models.set(moduleSpecifier, {
      moduleSpecifier,
      providerModuleId: moduleSpecifier,
      exports: [{
        id: "ExactText",
        name: "ExactText",
        kind: "interface",
        members: [],
      }, {
        id: "make",
        name: "make",
        kind: "function",
        signatures: [{
          id: "make()",
          parameters: [],
          returnType: { kind: "provider-ref", moduleSpecifier, exportName: "ExactText" },
        }],
      }],
    });
  }
  const events: ProviderExportMaterializationContext[] = [];
  let sourceAnalyzed = false;
  let writer: Pick<SourceAnalysisFactAccess, "set"> | undefined;
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import { make } from "${configuredModule}";`,
        `import { make as foreign } from "${foreignModule}";`,
        "export const actual = make();",
        "export const other = foreign();",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [
        sourceProviderExtension(models),
        createSourceSemanticsExtension({
          modules: [{
            moduleSpecifier: configuredModule,
            capabilities: ["type-marker"],
            exports: [{ kind: "type-marker", exportName: "ExactText", marker: "js-string" }],
          }],
        }),
        {
          identity: { id: owner, version: "1.0.0" },
          dependencies: { runsAfter: ["tsts.source-semantics"] },
          providerExportMaterialized(context): void {
            assert.equal(sourceAnalyzed, false, "binding publishes before any source analyzer reads");
            assert.equal(Object.isFrozen(context), true);
            assert.equal(Object.isFrozen(context.declaration), true);
            assert.equal(context.facts.set(context.symbol, published, true), "inserted");
            events.push(context);
            writer = context.facts;
          },
          analyzeSource(context): void {
            sourceAnalyzed = true;
            assert.equal(events.length > 0, true, "materialization is not deferred until a sealed consumer");
            for (const event of events) {
              assert.equal(context.facts.get(event.symbol, providerVirtualDeclarationFactKey)
                === event.declaration, true, "the notification carries the already-published exact identity");
              assert.equal(context.facts.get(event.symbol, published), true);
              if (event.declaration.exportName !== "ExactText") continue;
              assert.equal(context.facts.get(event.symbol, sourceMarkerFactKey)?.marker,
                event.declaration.moduleSpecifier === configuredModule ? "js-string" : undefined);
            }
          },
        },
      ],
    },
  }).checkSource();
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.equal(checked.extensionDiagnostics.length, 0, "owned binding-time publication has no conflicts");
  const eventCount = events.length;
  const file = checked.getSourceFile("/src/index.ts");
  const queries = checked.getSourceFileQueries(file);
  const variables = findNodes(file, queries.ast.children, queries.ast.is.IsVariableDeclaration);
  assert.equal(variables.length, 2);
  for (const [index, variable] of variables.entries()) {
    const symbol = queries.checker.getTypeSymbol(queries.checker.getTypeAtLocation(variable));
    assert.equal(events.some(event => event.symbol === symbol && event.declaration.exportName === "ExactText"),
      true, "an inferred type has the exact pre-seal materialized owner without a type import");
    assert.equal(checked.sourceFacts.getFact(symbol, sourceMarkerFactKey)?.marker,
      index === 0 ? "js-string" : undefined);
  }
  assert.equal(events.length, eventCount, "post-seal type queries never trigger marker publication");
  const event = events[0];
  const retainedWriter = writer;
  const host = getExtensionHost(checked.program!);
  assert.ok(event !== undefined && retainedWriter !== undefined && host !== undefined);
  assert.throws(() => retainedWriter.set(event.symbol, published, true), {
    name: "Error",
    message: "Extension callback capabilities cannot be used outside their host-owned callback.",
  });
  assert.throws(() => host[extensionHostProviderExportMaterialized](event.symbol),
    /before semantic finalization/u);
  assert.equal(events.length, eventCount);
});
