import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Node_Type } from "../internal/ast/ast.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import {
  ExtensionHost,
  getExtensionHost,
  type CompilerExtension,
  type ProviderDeclarationModel,
  type ProviderVirtualDeclarationDocument,
  type SourceDeclarationProvider,
  type SourceDeclarationProviderRegistrar,
} from "./index.js";
import {
  testCoreDeclarations,
  testNoLibCompilerOptions,
  testProviderIdentity,
  testProviderModel,
} from "./source-provider-test-support.js";

// The registrar of a provider's registration is written by the registry when it makes the registration and is read
// from the documents that registration produces. Every expectation below follows from that rule; none is taken from
// a run.

const hostRegistrar: SourceDeclarationProviderRegistrar = { kind: "host" };

function extensionRegistrar(extensionId: string): SourceDeclarationProviderRegistrar {
  return { kind: "extension", extensionId };
}

test("a provider the embedding host registers directly has the host as registrar", () => {
  const direct = provider("test.direct", "@test/direct.js");
  const host = new ExtensionHost({}, {});

  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);
  // The same object again, by the same path: nothing is registered a second time.
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);

  const document = resolvedDocument(host, "@test/direct.js");
  assert.deepEqual(document.registrar, hostRegistrar);
  assert.ok(Object.isFrozen(document.registrar));
  assert.equal(document.provider.id, "test.direct");
  assert.deepEqual(host.extensions, []);
  assert.deepEqual(host.diagnostics.all(), []);
});

test("a provider registered in an extension's initializer has that extension as registrar", () => {
  const registered = provider("test.initialized", "@test/initialized.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.owner", [registered])],
  });

  const document = resolvedDocument(host, "@test/initialized.js");
  assert.deepEqual(document.registrar, extensionRegistrar("ext.owner"));
  assert.ok(Object.isFrozen(document.registrar));
  // The registrar is the extension, not the provider: the two identities differ and stay apart.
  assert.equal(document.provider.id, "test.initialized");
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.owner"]);
  assert.deepEqual(host.diagnostics.all(), []);
});

test("providers of two extensions each name their own extension, and a direct provider names neither", () => {
  const first = provider("test.first", "@test/first.js");
  const second = provider("test.second", "@test/second.js");
  const direct = provider("test.direct", "@test/direct.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.first", [first]), registering("ext.second", [second])],
  });
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);

  assert.deepEqual(resolvedDocument(host, "@test/first.js").registrar, extensionRegistrar("ext.first"));
  assert.deepEqual(resolvedDocument(host, "@test/second.js").registrar, extensionRegistrar("ext.second"));
  assert.deepEqual(resolvedDocument(host, "@test/direct.js").registrar, hostRegistrar);
  // The list is in file-name order, and a public document's file name is derived by the registry from the module's
  // identity and text; so the rows are compared by provider id, and the list's order by its own rule.
  const listed = host.providers.getVirtualDeclarationDocuments();
  assert.deepEqual(
    listed.map((document) => [document.provider.id, document.registrar] as const)
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
    [
      ["test.direct", hostRegistrar],
      ["test.first", extensionRegistrar("ext.first")],
      ["test.second", extensionRegistrar("ext.second")],
    ],
  );
  assert.deepEqual(listed.map((document) => document.fileName), listed.map((document) => document.fileName).sort());
  assert.deepEqual(host.diagnostics.all(), []);
});

test("one extension that registers two providers is the registrar of both", () => {
  const left = provider("test.left", "@test/left.js");
  const right = provider("test.right", "@test/right.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.both", [left, right])],
  });

  assert.deepEqual(resolvedDocument(host, "@test/left.js").registrar, extensionRegistrar("ext.both"));
  assert.deepEqual(resolvedDocument(host, "@test/right.js").registrar, extensionRegistrar("ext.both"));
});

test("the package of a resolved module is not the registrar and the registrar names no package", () => {
  const packaged = provider("test.packaged", "@test/packaged.js", { packageName: "@other/pkg", packageVersion: "2.0.0" });
  const unpackaged = provider("test.unpackaged", "@test/unpackaged.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.registrar", [packaged, unpackaged])],
  });

  const withPackage = host.providers.resolveVirtualModule("@test/packaged.js");
  assert.equal(withPackage.kind, "resolved");
  if (withPackage.kind !== "resolved") assert.fail("The packaged module must resolve.");
  assert.equal(withPackage.module.artifact.packageName, "@other/pkg");
  assert.equal(withPackage.module.artifact.packageVersion, "2.0.0");
  assert.deepEqual(withPackage.module.artifact.document.registrar, extensionRegistrar("ext.registrar"));

  const withoutPackage = host.providers.resolveVirtualModule("@test/unpackaged.js");
  assert.equal(withoutPackage.kind, "resolved");
  if (withoutPackage.kind !== "resolved") assert.fail("The unpackaged module must resolve.");
  assert.equal(withoutPackage.module.artifact.packageName, undefined);
  // The same registrar with and without a module package: neither is derived from the other.
  assert.deepEqual(withoutPackage.module.artifact.document.registrar, extensionRegistrar("ext.registrar"));
});

test("a failed initializer leaves no registration, and a later registration of the same provider is the later extension's", () => {
  const shared = provider("test.shared", "@test/shared.js");
  const kept = provider("test.kept", "@test/kept.js");
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.kept", [kept]),
      registering("ext.failed", [shared], { fail: true }),
      registering("ext.later", [shared]),
    ],
  });

  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.kept", "ext.later"]);
  assert.deepEqual(resolvedDocument(host, "@test/shared.js").registrar, extensionRegistrar("ext.later"));
  // The rollback removed only the failed extension's registration.
  assert.deepEqual(resolvedDocument(host, "@test/kept.js").registrar, extensionRegistrar("ext.kept"));
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["EXTENSION_INITIALIZE_FAILED"],
  );
});

test("a failed initializer with no later registration leaves the module unowned and no document", () => {
  const lost = provider("test.lost", "@test/lost.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.failed", [lost], { fail: true })],
  });

  assert.deepEqual(host.extensions, []);
  assert.equal(host.providers.hasSourceDeclarationProviders, false);
  assert.equal(host.providers.resolveVirtualModule("@test/lost.js").kind, "unowned");
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
});

test("after a failed initializer the embedding host can register the same provider and is its registrar", () => {
  const retried = provider("test.retried", "@test/retried.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.failed", [retried], { fail: true })],
  });
  assert.equal(host.providers.registerSourceDeclarationProvider(retried), true);

  assert.deepEqual(resolvedDocument(host, "@test/retried.js").registrar, hostRegistrar);
});

test("registering the same provider object again keeps the first registrar", () => {
  const shared = provider("test.shared", "@test/shared.js");
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.first", [shared], { results }),
      registering("ext.second", [shared], { results }),
    ],
  });
  // The embedding host registers the same object after both extensions: again nothing new is registered.
  assert.equal(host.providers.registerSourceDeclarationProvider(shared), true);

  assert.deepEqual(results, [true, true]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.first", "ext.second"]);
  assert.deepEqual(resolvedDocument(host, "@test/shared.js").registrar, extensionRegistrar("ext.first"));
  assert.deepEqual(host.diagnostics.all(), []);
});

test("a second registration of the same object by an extension that then fails leaves the first registration", () => {
  const shared = provider("test.shared", "@test/shared.js");
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.first", [shared]),
      registering("ext.failed", [shared], { fail: true }),
    ],
  });

  // The failed extension registered nothing (the object was registered), so its rollback removes nothing.
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.first"]);
  assert.deepEqual(resolvedDocument(host, "@test/shared.js").registrar, extensionRegistrar("ext.first"));
});

test("a different provider object with a registered identity is refused and the first registrar stands", () => {
  const first = provider("test.same", "@test/same.js");
  const other = provider("test.same", "@test/same.js");
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.first", [first], { results }),
      registering("ext.other", [other], { results }),
    ],
  });
  // The embedding host is refused in the same way.
  const direct = provider("test.same", "@test/same.js");
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), false);

  assert.deepEqual(results, [true, false]);
  // A refused registration does not fail the initializer that asked for it.
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.first", "ext.other"]);
  assert.deepEqual(resolvedDocument(host, "@test/same.js").registrar, extensionRegistrar("ext.first"));
  // One diagnostic: the store keeps one diagnostic per identity, and both refusals have the identity of the provider id.
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["DUPLICATE_SOURCE_DECLARATION_PROVIDER"],
  );
});

test("a direct registration made first is not replaced by a registrar of another kind", () => {
  const direct = provider("test.direct", "@test/direct.js");
  const sameIdentity = provider("test.direct", "@test/direct.js");
  const host = new ExtensionHost({}, {});
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);
  assert.equal(host.providers.registerSourceDeclarationProvider(sameIdentity), false);

  assert.deepEqual(resolvedDocument(host, "@test/direct.js").registrar, hostRegistrar);
});

test("an extension whose id equals its provider's id is the registrar by its extension id", () => {
  const sameId = provider("test.same-id", "@test/same-id.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("test.same-id", [sameId])],
  });

  const document = resolvedDocument(host, "@test/same-id.js");
  assert.deepEqual(document.registrar, extensionRegistrar("test.same-id"));
  assert.equal(document.provider.id, "test.same-id");
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["test.same-id"]);
  assert.deepEqual(host.diagnostics.all(), []);
});

test("a failed initializer that registered two providers leaves neither, and a later extension can register both", () => {
  const one = provider("test.one", "@test/one.js");
  const two = provider("test.two", "@test/two.js");

  const alone = new ExtensionHost({}, {
    extensions: [registering("ext.failed", [one, two], { fail: true })],
  });
  assert.deepEqual(alone.extensions, []);
  assert.equal(alone.providers.hasSourceDeclarationProviders, false);
  assert.equal(alone.providers.resolveVirtualModule("@test/one.js").kind, "unowned");
  assert.equal(alone.providers.resolveVirtualModule("@test/two.js").kind, "unowned");
  assert.deepEqual(alone.providers.getVirtualDeclarationDocuments(), []);

  const results: boolean[] = [];
  const followed = new ExtensionHost({}, {
    extensions: [
      registering("ext.failed", [one, two], { fail: true }),
      registering("ext.later", [one, two], { results }),
    ],
  });
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(followed.extensions.map((extension) => extension.identity.id), ["ext.later"]);
  assert.deepEqual(resolvedDocument(followed, "@test/one.js").registrar, extensionRegistrar("ext.later"));
  assert.deepEqual(resolvedDocument(followed, "@test/two.js").registrar, extensionRegistrar("ext.later"));
  assert.deepEqual(
    followed.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["EXTENSION_INITIALIZE_FAILED"],
  );
});

test("a registration refused inside a successful initializer leaves no registration and no document", () => {
  const refused: SourceDeclarationProvider = {
    ...provider("test.refused", "@test/refused.js"),
    identity: { ...testProviderIdentity("test.refused"), extensionContractVersion: "tsts.source-provider.unknown" },
  };
  const accepted = provider("test.accepted", "@test/accepted.js");
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.mixed", [refused, accepted], { results })],
  });

  assert.deepEqual(results, [false, true]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.mixed"]);
  assert.equal(host.providers.resolveVirtualModule("@test/refused.js").kind, "unowned");
  const documents = host.providers.getVirtualDeclarationDocuments();
  assert.deepEqual(documents, []);
  assert.deepEqual(resolvedDocument(host, "@test/accepted.js").registrar, extensionRegistrar("ext.mixed"));
  assert.deepEqual(
    host.providers.getVirtualDeclarationDocuments().map((document) => document.provider.id),
    ["test.accepted"],
  );
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["PROVIDER_CONTRACT_MISMATCH"],
  );
});

test("every reader of a document returns the one document with its registrar", () => {
  const read = provider("test.read", "@test/read.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.read", [read])],
  });

  const resolved = host.providers.resolveVirtualModule("@test/read.js");
  assert.equal(resolved.kind, "resolved");
  if (resolved.kind !== "resolved") assert.fail("The module must resolve.");
  const document = resolved.module.artifact.document;
  assert.equal(host.providers.getVirtualDeclarationDocument(document.uri), document);
  assert.equal(host.providers.getVirtualDeclarationDocument(document.fileName), document);
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), [document]);
  assert.deepEqual(document.registrar, extensionRegistrar("ext.read"));
  assert.ok(Object.isFrozen(document));
});

test("the public document and the canonical owner document of one provider both carry its registrar", () => {
  const specifier = "@test/owners.js";
  const withClass = provider("test.owners", specifier, {
    model: testProviderModel(specifier, "Test.Owners", [{ id: "PublicClass", name: "PublicClass", kind: "class" }]),
  });
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
    extensionHostOptions: { extensions: [registering("ext.owners", [withClass])] },
  });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.deepEqual(checked.extensionDiagnostics, []);

  const publicDocuments = getExtensionHost(session.program!)?.providers.getVirtualDeclarationDocuments() ?? [];
  assert.deepEqual(publicDocuments.map((document) => document.artifactKind), ["public"]);
  assert.deepEqual(publicDocuments[0]!.registrar, extensionRegistrar("ext.owners"));

  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile);
  const checker = checked.getSourceFileQueries(sourceFile).checker;
  const statement = checked.ast.as.AsVariableStatement(checked.ast.statements(sourceFile)[1]);
  const variables = checked.ast.as.AsVariableDeclarationList(statement?.DeclarationList)?.Declarations?.Nodes;
  const symbol = checker.getTypeSymbol(checker.getTypeFromTypeNode(Node_Type(variables?.[0])));
  const fact = checked.sourceFacts.getFact(symbol, providerVirtualDeclarationFactKey);
  assert.ok(fact);
  // The reader a consumer of a checked program has: the facts' document lookup.
  const owner = checked.sourceFacts.getVirtualDeclarationDocument(fact.artifactFileName);
  assert.ok(owner);
  assert.equal(owner.artifactKind, "canonical-export-owner");
  assert.notEqual(owner.fileName, publicDocuments[0]!.fileName);
  assert.deepEqual(owner.registrar, extensionRegistrar("ext.owners"));
  assert.equal(owner.provider.id, "test.owners");
  // The facts' lookup hands through the registry's own documents, for both kinds.
  const registry = getExtensionHost(session.program!)?.providers;
  assert.ok(registry);
  assert.equal(registry.getVirtualDeclarationDocument(fact.artifactFileName), owner);
  assert.equal(checked.sourceFacts.getVirtualDeclarationDocument(publicDocuments[0]!.fileName), publicDocuments[0]);
  assert.ok(Object.isFrozen(owner.registrar));
  assert.ok(Object.isFrozen(publicDocuments[0]!.registrar));
});

function resolvedDocument(host: ExtensionHost, specifier: string): ProviderVirtualDeclarationDocument {
  const resolved = host.providers.resolveVirtualModule(specifier);
  if (resolved.kind !== "resolved") {
    assert.fail(`'${specifier}' must resolve; it is ${resolved.kind}.`);
  }
  return resolved.module.artifact.document;
}

function registering(
  extensionId: string,
  providers: readonly SourceDeclarationProvider[],
  options: { readonly fail?: boolean; readonly results?: boolean[] } = {},
): CompilerExtension {
  return {
    identity: { id: extensionId, version: "1.0.0" },
    initialize(context): void {
      for (const registered of providers) {
        const result = context.registerSourceDeclarationProvider(registered);
        options.results?.push(result);
      }
      if (options.fail === true) {
        throw new Error(`initialization of ${extensionId} fails after its registrations`);
      }
    },
  };
}

function provider(
  id: string,
  specifier: string,
  options: {
    readonly model?: ProviderDeclarationModel;
    readonly packageName?: string;
    readonly packageVersion?: string;
  } = {},
): SourceDeclarationProvider {
  const model = options.model ?? testProviderModel(specifier, id);
  return {
    identity: testProviderIdentity(id),
    declarationMaterialization: "complete",
    ownsModule: (candidate) => candidate === specifier
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule: (candidate) => ({
      kind: "virtual" as const,
      moduleSpecifier: candidate,
      virtualFileName: `/provider/${model.providerModuleId}.d.ts`,
      providerModuleId: model.providerModuleId,
      ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
      ...(options.packageVersion === undefined ? {} : { packageVersion: options.packageVersion }),
    }),
    getDeclarationModel: () => model,
  };
}
