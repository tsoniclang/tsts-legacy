import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { SourceFile_FileName, Node_Type } from "../internal/ast/ast.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import {
  ExtensionHost,
  getExtensionHost,
  type ProviderDeclarationModel,
  type ProviderExportDeclaration,
  type ProviderModuleContext,
  type ProviderModuleResolution,
  type SourceDeclarationProvider,
  type SourceAnalysisFactResolver,
  type ProviderVirtualDeclarationDocument,
} from "./index.js";
import {
  sourceProviderCompilerExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
  testProviderIdentity,
  testProviderModel,
} from "./source-provider-test-support.js";

test("published provider documents and declaration models are stable immutable values", () => {
  const specifier = "@test/publication.js";
  const values: ProviderExportDeclaration[] = [{
    id: "Container",
    name: "Container",
    kind: "interface",
    members: [{
      id: "Container::values",
      name: "values",
      kind: "property",
      readonly: true,
      type: { kind: "array", elementType: { kind: "number" } },
    }, {
      id: "Container::pending",
      name: "pending",
      kind: "property",
      readonly: true,
      type: {
        kind: "source-global",
        name: "Promise",
        typeArguments: [{ kind: "string" }],
      },
    }],
  }];
  const model: ProviderDeclarationModel = {
    moduleSpecifier: specifier,
    providerModuleId: "Test.Publication",
    exports: values,
  };
  const host = hostFor(modelProvider(new Map([[specifier, model]])));
  const first = host.providers.resolveVirtualModule(specifier);
  const repeated = host.providers.resolveVirtualModule(specifier);

  assert.ok(first.kind === "resolved");
  assert.ok(repeated === first, "An exact provider request must retain one terminal result.");
  const artifact = first.module.artifact;
  const documents = host.providers.getVirtualDeclarationDocuments();
  assert.equal(documents.length, 1);
  assert.ok(
    host.providers.getVirtualDeclarationDocument(artifact.fileName) === artifact.document,
    "The public document lookup must retain the published document identity.",
  );
  assert.ok(
    host.providers.getVirtualArtifactByFileName(artifact.fileName) === artifact,
    "The public artifact lookup must retain the published artifact identity.",
  );
  assert.equal(artifact.kind, "public");
  assert.equal(artifact.document.readOnly, true);
  assert.equal(artifact.document.uri, artifact.fileName);
  assert.equal(artifact.document.sourceText, artifact.sourceText);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.document), true);
  assert.equal(Object.isFrozen(artifact.provider), true);
  assert.equal(Object.isFrozen(artifact.declarationModel), true);
  assert.equal(Object.isFrozen(artifact.declarationModel.exports), true);
  const declaration = artifact.declarationModel.exports[0];
  const valuesMember = declaration?.members?.[0];
  const pendingMember = declaration?.members?.[1];
  assert.equal(Object.isFrozen(declaration), true);
  assert.equal(Object.isFrozen(declaration?.members), true);
  assert.equal(Object.isFrozen(valuesMember), true);
  assert.equal(Object.isFrozen(valuesMember?.type), true);
  assert.equal(Object.isFrozen(pendingMember?.type), true);
  assert.equal(
    pendingMember?.type?.kind === "source-global"
      && Object.isFrozen(pendingMember.type.typeArguments),
    true,
  );

  values.push({ id: "Late", name: "Late", kind: "class" });
  assert.deepEqual(
    artifact.declarationModel.exports.map((entry) => entry.id),
    ["Container"],
  );
});

test("provider request caches preserve every callback-visible context distinction", () => {
  const specifier = "@test/context-cache.js";
  const observed: ProviderModuleContext[] = [];
  const sourceProvider: SourceDeclarationProvider = {
    identity: testProviderIdentity("test.context-cache"),
    declarationMaterialization: "complete",
    ownsModule: (candidate) => candidate === specifier
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule(candidate, context) {
      observed.push(context);
      return resolution(candidate, "Test.ContextCache", "/provider/context-cache.d.ts");
    },
    getDeclarationModel: () => testProviderModel(specifier, "Test.ContextCache"),
  };
  const host = hostFor(sourceProvider);
  const contexts: readonly ProviderModuleContext[] = [
    {},
    { resolutionMode: undefined },
    { resolutionMode: "none" },
    { resolutionMode: "require" },
    {
      containingFile: "/src/first.ts",
      resolutionMode: "import",
      importSlice: {
        moduleSpecifier: specifier,
        kind: "named",
        requestedExports: [],
      },
    },
    {
      containingFile: "/src/second.ts",
      resolutionMode: "import",
      importSlice: {
        moduleSpecifier: specifier,
        kind: "named",
        requestedExports: [{ exportedName: "Value", kind: "value" }],
      },
    },
  ];

  for (const context of contexts) {
    const first = host.providers.resolveVirtualModule(specifier, context);
    const repeated = host.providers.resolveVirtualModule(specifier, context);
    assert.ok(first.kind === "resolved");
    assert.ok(repeated === first, "Each exact context must have one terminal cache entry.");
  }
  assert.equal(observed.length, contexts.length);
  assert.deepEqual(observed, contexts);
  assert.ok(observed.every(Object.isFrozen));
});

test("provider resolution outputs are captured once before immutable publication", () => {
  const specifier = "@test/resolution-capture.js";
  let fileNameReads = 0;
  const exports: ProviderExportDeclaration[] = [{
    id: "Value",
    name: "Value",
    kind: "value",
    type: { kind: "number" },
  }];
  const sourceProvider: SourceDeclarationProvider = {
    identity: testProviderIdentity("test.resolution-capture"),
    declarationMaterialization: "complete",
    ownsModule: (candidate) => candidate === specifier
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule: (candidate) => ({
      kind: "virtual",
      moduleSpecifier: candidate,
      get virtualFileName(): string {
        fileNameReads += 1;
        if (fileNameReads !== 1) {
          throw new Error("virtualFileName was read more than once");
        }
        return "/provider/resolution-capture.d.ts";
      },
      providerModuleId: "Test.ResolutionCapture",
    }),
    getDeclarationModel: () => ({
      moduleSpecifier: specifier,
      providerModuleId: "Test.ResolutionCapture",
      exports,
    }),
  };
  const host = hostFor(sourceProvider);
  const result = host.providers.resolveVirtualModule(specifier);

  assert.ok(result.kind === "resolved");
  assert.equal(fileNameReads, 1);
  assert.equal(host.diagnostics.hasErrors(), false);
  exports.push({ id: "Late", name: "Late", kind: "class" });
  assert.deepEqual(
    result.module.declarationModel.exports.map((entry) => entry.id),
    ["Value"],
  );
  assert.equal(Object.isFrozen(result.module.context), true);
  assert.equal(Object.isFrozen(result.module.resolution), true);
  assert.equal(Object.isFrozen(result.module.declarationModel), true);
});

test("failed provider slices publish no file ownership or partial documents", () => {
  const firstSpecifier = "@test/rejected-owner.js";
  const laterSpecifier = "@test/later-owner.js";
  const rejectedFileName = "/provider/rejected-owner.d.ts";
  let conflict = false;
  const sourceProvider: SourceDeclarationProvider = {
    identity: testProviderIdentity("test.transactional-publication"),
    declarationMaterialization: "complete",
    ownsModule: (candidate) =>
      candidate === firstSpecifier || candidate === laterSpecifier
        ? { kind: "owned" }
        : { kind: "unowned" },
    resolveModule(candidate, context) {
      conflict = candidate === firstSpecifier
        && context.containingFile === "/src/conflict.ts";
      return resolution(
        candidate,
        candidate === firstSpecifier ? "Test.RejectedOwner" : "Test.LaterOwner",
        conflict || candidate === laterSpecifier
          ? rejectedFileName
          : "/provider/accepted-owner.d.ts",
      );
    },
    getDeclarationModel(module) {
      return {
        moduleSpecifier: module.moduleSpecifier,
        providerModuleId: module.providerModuleId,
        exports: [{
          id: module.moduleSpecifier === firstSpecifier ? "Value" : "Later",
          name: module.moduleSpecifier === firstSpecifier ? "Value" : "Later",
          kind: "value",
          type: conflict ? { kind: "string" } : { kind: "number" },
        }],
      };
    },
  };
  const host = hostFor(sourceProvider);

  assert.equal(
    host.providers.resolveVirtualModule(
      firstSpecifier,
      { containingFile: "/src/accepted.ts" },
    ).kind,
    "resolved",
  );
  const before = host.providers.getVirtualDeclarationDocuments().map((entry) => entry.fileName);
  assert.equal(
    host.providers.resolveVirtualModule(
      firstSpecifier,
      { containingFile: "/src/conflict.ts" },
    ).kind,
    "rejected",
  );
  assert.deepEqual(
    host.providers.getVirtualDeclarationDocuments().map((entry) => entry.fileName),
    before,
  );
  assert.equal(
    host.providers.resolveVirtualModule(
      laterSpecifier,
      { containingFile: "/src/later.ts" },
    ).kind,
    "resolved",
  );
});

test("successful provider closure reserves transitive public file identities", () => {
  const rootSpecifier = "@test/closure-root.js";
  const dependencySpecifier = "@test/closure-dependency.js";
  const collidingSpecifier = "@test/closure-collision.js";
  const sharedFileName = "/provider/closure-shared.d.ts";
  const sourceProvider: SourceDeclarationProvider = {
    identity: testProviderIdentity("test.closure-publication"),
    declarationMaterialization: "complete",
    ownsModule: (candidate) =>
      [rootSpecifier, dependencySpecifier, collidingSpecifier].includes(candidate)
        ? { kind: "owned" }
        : { kind: "unowned" },
    resolveModule(candidate) {
      return resolution(
        candidate,
        candidate === rootSpecifier
          ? "Test.ClosureRoot"
          : candidate === dependencySpecifier
            ? "Test.ClosureDependency"
            : "Test.ClosureCollision",
        candidate === rootSpecifier ? "/provider/closure-root.d.ts" : sharedFileName,
      );
    },
    getDeclarationModel(module) {
      if (module.moduleSpecifier === rootSpecifier) {
        return {
          moduleSpecifier: rootSpecifier,
          providerModuleId: module.providerModuleId,
          imports: [{
            moduleSpecifier: dependencySpecifier,
            namedImports: [{ exportedName: "Dependency", kind: "type" }],
            typeOnly: true,
          }],
          exports: [{
            id: "Root",
            name: "Root",
            kind: "interface",
            members: [{
              id: "Root::dependency",
              name: "dependency",
              kind: "property",
              readonly: true,
              type: {
                kind: "provider-ref",
                moduleSpecifier: dependencySpecifier,
                exportName: "Dependency",
              },
            }],
          }],
        };
      }
      const name = module.moduleSpecifier === dependencySpecifier
        ? "Dependency"
        : "Collision";
      return {
        moduleSpecifier: module.moduleSpecifier,
        providerModuleId: module.providerModuleId,
        exports: [{ id: name, name, kind: "interface" }],
      };
    },
  };
  const host = hostFor(sourceProvider);

  assert.equal(host.providers.resolveVirtualModule(rootSpecifier).kind, "resolved");
  const before = host.providers.getVirtualDeclarationDocuments().map((entry) => entry.fileName);
  const collision = host.providers.resolveVirtualModule(collidingSpecifier);
  assert.equal(collision.kind, "rejected");
  assert.equal(
    collision.kind === "rejected" ? collision.diagnostic.extensionCode : "",
    "INVALID_PROVIDER_MODULE_RESOLUTION",
  );
  assert.deepEqual(
    host.providers.getVirtualDeclarationDocuments().map((entry) => entry.fileName),
    before,
  );
});

test("canonical provider owner files remain hidden from public source traversal", () => {
  const specifier = "@test/hidden-owners.js";
  const model = testProviderModel(specifier, "Test.HiddenOwners", [{
    id: "PublicClass",
    name: "PublicClass",
    kind: "class",
  }]);
  let analyzedDocument: ProviderVirtualDeclarationDocument | undefined;
  let retainedResolver: SourceAnalysisFactResolver | undefined;
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { PublicClass } from "${specifier}";`,
        "export declare const value: PublicClass;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderCompilerExtension(
        modelProvider(new Map([[specifier, model]])),
      ), {
        identity: { id: "test.provider-document-analysis", version: "1" },
        analyzeSource(context) {
          retainedResolver = context.factResolver;
          const sourceFile = context.source.getSourceFile("/src/index.ts");
          const queries = context.source.getSourceFileQueries(sourceFile);
          const statement = queries.ast.as.AsVariableStatement(queries.ast.statements(sourceFile)[1]);
          const variables = queries.ast.as.AsVariableDeclarationList(statement?.DeclarationList)?.Declarations?.Nodes;
          const type = queries.checker.getTypeFromTypeNode(Node_Type(variables?.[0]));
          const identity = context.facts.get(queries.checker.getTypeSymbol(type), providerVirtualDeclarationFactKey);
          assert.ok(identity);
          analyzedDocument = context.factResolver.getVirtualDeclarationDocument(identity.artifactFileName);
          assert.ok(analyzedDocument);
          assert.equal(context.factResolver.getVirtualDeclarationDocument(analyzedDocument.uri), analyzedDocument);
          assert.ok(Object.isFrozen(analyzedDocument.declarationModel));
          assert.equal(context.factResolver.getVirtualDeclarationDocument("missing-owner"), undefined);
        },
      }],
    },
  });
  const checked = session.checkSource();

  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  const publicDocuments = getExtensionHost(session.program!)?.providers
    .getVirtualDeclarationDocuments() ?? [];
  assert.equal(publicDocuments.length, 1);
  assert.deepEqual(
    checked.sourceFiles.map(SourceFile_FileName).sort(),
    ["/src/core.d.ts", "/src/index.ts", publicDocuments[0]!.fileName].sort(),
  );
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile);
  const checker = checked.getSourceFileQueries(sourceFile).checker;
  const statement = checked.ast.as.AsVariableStatement(checked.ast.statements(sourceFile)[1]);
  const variables = checked.ast.as.AsVariableDeclarationList(statement?.DeclarationList)?.Declarations?.Nodes;
  const type = checker.getTypeFromTypeNode(Node_Type(variables?.[0]));
  const symbol = checker.getTypeSymbol(type);
  const identity = checked.sourceFacts.getFact(symbol, providerVirtualDeclarationFactKey);
  assert.ok(identity);
  const document = checked.sourceFacts.getVirtualDeclarationDocument(identity.artifactFileName);
  assert.equal(document?.artifactKind, "canonical-export-owner");
  assert.equal(analyzedDocument, document);
  assert.throws(() => retainedResolver!.getVirtualDeclarationDocument(identity.artifactFileName), /active|revoked|expired/i);
  assert.equal(document?.declarationModel.exports[0]?.id, "PublicClass");
  assert.ok(Object.isFrozen(document));
  assert.equal(checked.sourceFacts.getVirtualDeclarationDocument(identity.artifactFileName), document);
  assert.equal(checked.sourceFacts.getVirtualDeclarationDocument("missing-owner"), undefined);
  assert.equal(getExtensionHost(session.program!)?.providers.getVirtualDeclarationDocuments().length, 1);
});

function hostFor(sourceProvider: SourceDeclarationProvider): ExtensionHost {
  return new ExtensionHost({}, {
    extensions: [sourceProviderCompilerExtension(sourceProvider)],
  });
}

function modelProvider(
  models: ReadonlyMap<string, ProviderDeclarationModel>,
): SourceDeclarationProvider {
  return {
    identity: testProviderIdentity("test.publication"),
    declarationMaterialization: "complete",
    ownsModule: (specifier) => models.has(specifier)
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule(specifier) {
      const model = models.get(specifier);
      if (model === undefined) {
        throw new Error(`No provider model exists for ${specifier}.`);
      }
      return resolution(
        specifier,
        model.providerModuleId,
        `/provider/${model.providerModuleId}.d.ts`,
      );
    },
    getDeclarationModel(module) {
      const model = models.get(module.moduleSpecifier);
      if (model === undefined) {
        throw new Error(`No declaration model exists for ${module.moduleSpecifier}.`);
      }
      return model;
    },
  };
}

function resolution(
  moduleSpecifier: string,
  providerModuleId: string,
  virtualFileName: string,
): ProviderModuleResolution {
  return {
    kind: "virtual",
    moduleSpecifier,
    providerModuleId,
    virtualFileName,
  };
}
