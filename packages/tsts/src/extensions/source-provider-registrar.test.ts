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
} from "./index.js";
import {
  testCoreDeclarations,
  testNoLibCompilerOptions,
  testProviderIdentity,
  testProviderModel,
} from "./source-provider-test-support.js";

// The registrar of a provider's registration is one value, registrarExtensionId: the id of the extension whose
// initializer registered the provider, or null when the embedding host registered it directly. The registry writes it
// when it makes the registration, and it is read from the documents that registration produces. Every expectation below follows from that rule; none is taken from
// a run.
//
// Extensions do not initialize in the order of the list a host is given: they initialize in the order of their
// declared edges (dependsOn, runsAfter) and, among those ready, in ascending extension id. The ids below are chosen
// so that each case's order is the one its name states, and the cases on order say so.

test("a provider the embedding host registers directly has the host as registrar", () => {
  const direct = provider("test.direct", "@test/direct.js");
  const host = new ExtensionHost({}, {});

  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);
  // The same object again, by the same path: nothing is registered a second time.
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);

  const document = resolvedDocument(host, "@test/direct.js");
  assert.equal(document.registrarExtensionId, null);
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
  assert.equal(document.registrarExtensionId, "ext.owner");
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

  assert.equal(resolvedDocument(host, "@test/first.js").registrarExtensionId, "ext.first");
  assert.equal(resolvedDocument(host, "@test/second.js").registrarExtensionId, "ext.second");
  assert.equal(resolvedDocument(host, "@test/direct.js").registrarExtensionId, null);
  // The list is in file-name order, and a public document's file name is derived by the registry from the module's
  // identity and text; so the rows are compared by provider id, and the list's order by its own rule.
  const listed = host.providers.getVirtualDeclarationDocuments();
  assert.deepEqual(
    listed.map((document) => [document.provider.id, document.registrarExtensionId] as const)
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
    [
      ["test.direct", null],
      ["test.first", "ext.first"],
      ["test.second", "ext.second"],
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

  assert.equal(resolvedDocument(host, "@test/left.js").registrarExtensionId, "ext.both");
  assert.equal(resolvedDocument(host, "@test/right.js").registrarExtensionId, "ext.both");
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
  assert.equal(withPackage.module.artifact.document.registrarExtensionId, "ext.registrar");

  const withoutPackage = host.providers.resolveVirtualModule("@test/unpackaged.js");
  assert.equal(withoutPackage.kind, "resolved");
  if (withoutPackage.kind !== "resolved") assert.fail("The unpackaged module must resolve.");
  assert.equal(withoutPackage.module.artifact.packageName, undefined);
  // The same registrar with and without a module package: neither is derived from the other.
  assert.equal(withoutPackage.module.artifact.document.registrarExtensionId, "ext.registrar");
});

test("a failed initializer leaves no registration, and a later registration of the same provider is the later extension's", () => {
  const shared = provider("test.shared", "@test/shared.js");
  const kept = provider("test.kept", "@test/kept.js");
  // Initialization order by id: ext.1-kept, ext.2-failed, ext.3-later.
  const order: string[] = [];
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.3-later", [shared], { order }),
      registering("ext.2-failed", [shared], { fail: true, order }),
      registering("ext.1-kept", [kept], { order }),
    ],
  });

  assert.deepEqual(order, ["ext.1-kept", "ext.2-failed", "ext.3-later"]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.1-kept", "ext.3-later"]);
  assert.equal(resolvedDocument(host, "@test/shared.js").registrarExtensionId, "ext.3-later");
  // The rollback removed only the failed extension's registration: the one committed before it stands.
  assert.equal(resolvedDocument(host, "@test/kept.js").registrarExtensionId, "ext.1-kept");
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

  assert.equal(resolvedDocument(host, "@test/retried.js").registrarExtensionId, null);
});

test("registering the same provider object again keeps the first registrar", () => {
  const shared = provider("test.shared", "@test/shared.js");
  const order: string[] = [];
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.first", [shared], { order, results }),
      registering("ext.second", [shared], { order, results }),
    ],
  });
  // The embedding host registers the same object after both extensions: again nothing new is registered.
  assert.equal(host.providers.registerSourceDeclarationProvider(shared), true);

  assert.deepEqual(order, ["ext.first", "ext.second"]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.first", "ext.second"]);
  assert.equal(resolvedDocument(host, "@test/shared.js").registrarExtensionId, "ext.first");
  assert.deepEqual(host.diagnostics.all(), []);
});

test("the registrar of an object two extensions register is the one that initializes first: by id, not by list order", () => {
  for (const listed of [["ext.a", "ext.b"], ["ext.b", "ext.a"]] as const) {
    const shared = provider("test.shared", "@test/shared.js");
    const order: string[] = [];
    const host = new ExtensionHost({}, {
      extensions: listed.map((extensionId) => registering(extensionId, [shared], { order })),
    });

    // Both permutations of the supplied list give one order and one registrar.
    assert.deepEqual(order, ["ext.a", "ext.b"], listed.join(","));
    assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.a", "ext.b"], listed.join(","));
    assert.equal(resolvedDocument(host, "@test/shared.js").registrarExtensionId, "ext.a", listed.join(","));
    assert.deepEqual(host.diagnostics.all(), [], listed.join(","));
  }
});

test("a declared edge reverses the id order, and the registrar is then the other extension", () => {
  for (const edge of ["runsAfter", "dependsOn"] as const) {
    for (const listed of [["ext.a", "ext.b"], ["ext.b", "ext.a"]] as const) {
      const shared = provider("test.shared", "@test/shared.js");
      const order: string[] = [];
      const host = new ExtensionHost({}, {
        extensions: listed.map((extensionId) => registering(extensionId, [shared], {
          order,
          ...(extensionId !== "ext.a" ? {}
            : { dependencies: edge === "runsAfter" ? { runsAfter: ["ext.b"] } : { dependsOn: ["ext.b"] } }),
        })),
      });

      const label = `${edge} ${listed.join(",")}`;
      assert.deepEqual(order, ["ext.b", "ext.a"], label);
      assert.equal(resolvedDocument(host, "@test/shared.js").registrarExtensionId, "ext.b", label);
      assert.deepEqual(host.diagnostics.all(), [], label);
    }
  }
});

test("when the first extension by id fails, the registrar is the next one that registers the object", () => {
  const shared = provider("test.shared", "@test/shared.js");
  const order: string[] = [];
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.b", [shared], { order }),
      registering("ext.a", [shared], { fail: true, order }),
    ],
  });

  assert.deepEqual(order, ["ext.a", "ext.b"]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.b"]);
  assert.equal(resolvedDocument(host, "@test/shared.js").registrarExtensionId, "ext.b");
});

test("one extension registering the same object twice registers it once", () => {
  const repeated = provider("test.repeated", "@test/repeated.js");
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.repeat", [repeated, repeated, repeated], { results })],
  });

  // The two repeat calls returned early; nothing of them is left for the next registration.
  const direct = provider("test.direct", "@test/direct.js");
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);

  assert.deepEqual(results, [true, true, true]);
  assert.equal(resolvedDocument(host, "@test/repeated.js").registrarExtensionId, "ext.repeat");
  assert.equal(resolvedDocument(host, "@test/direct.js").registrarExtensionId, null);
  assert.deepEqual(
    host.providers.getVirtualDeclarationDocuments().map((document) => document.provider.id).sort(),
    ["test.direct", "test.repeated"],
  );
  assert.deepEqual(host.diagnostics.all(), []);
});

test("a second registration of the same object by an extension that then fails leaves the first registration", () => {
  const shared = provider("test.shared", "@test/shared.js");
  // Initialization order by id: ext.1-first, then ext.2-failed.
  const order: string[] = [];
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [
      registering("ext.1-first", [shared], { order, results }),
      registering("ext.2-failed", [shared], { fail: true, order, results }),
    ],
  });

  assert.deepEqual(order, ["ext.1-first", "ext.2-failed"]);
  // The failed extension's call returned true and registered nothing, so its rollback removes nothing.
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.1-first"]);
  assert.equal(resolvedDocument(host, "@test/shared.js").registrarExtensionId, "ext.1-first");
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
  assert.equal(resolvedDocument(host, "@test/same.js").registrarExtensionId, "ext.first");
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

  assert.equal(resolvedDocument(host, "@test/direct.js").registrarExtensionId, null);
});

test("an extension whose id equals its provider's id is the registrar by its extension id", () => {
  const sameId = provider("test.same-id", "@test/same-id.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("test.same-id", [sameId])],
  });

  const document = resolvedDocument(host, "@test/same-id.js");
  assert.equal(document.registrarExtensionId, "test.same-id");
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
  assert.equal(resolvedDocument(followed, "@test/one.js").registrarExtensionId, "ext.later");
  assert.equal(resolvedDocument(followed, "@test/two.js").registrarExtensionId, "ext.later");
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
  assert.equal(resolvedDocument(host, "@test/accepted.js").registrarExtensionId, "ext.mixed");
  assert.deepEqual(
    host.providers.getVirtualDeclarationDocuments().map((document) => document.provider.id),
    ["test.accepted"],
  );
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["PROVIDER_CONTRACT_MISMATCH"],
  );
});

test("an extension with the empty id is still an extension: its registrations read the empty string, not null", () => {
  // The host admits an empty extension id today (it refuses only a repeated id). Null is reserved for a direct
  // registration by the embedding host, whatever the id's content.
  const registered = provider("test.of-empty", "@test/of-empty.js");
  const direct = provider("test.direct", "@test/direct.js");
  const host = new ExtensionHost({}, {
    extensions: [registering("", [registered])],
  });
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);

  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), [""]);
  assert.equal(resolvedDocument(host, "@test/of-empty.js").registrarExtensionId, "");
  assert.equal(resolvedDocument(host, "@test/direct.js").registrarExtensionId, null);
});

test("a registration asked from inside another registration is refused, and no later registration sees a stale registrant", () => {
  // While the host serves ext.nesting's capability call for `outer`, the registry reads outer's identity. That
  // read asks the same capability to register `inner`. The owner is suspended for the outer call, so the host
  // refuses the inner one; the refusal is thrown inside the read of the identity, which makes `outer` an invalid
  // registration. Neither is registered. The next registration of the same initializer, of the next extension and
  // of the embedding host each record their own registrar.
  const inner = provider("test.inner", "@test/inner.js");
  const third = provider("test.third", "@test/third.js");
  const next = provider("test.next", "@test/next.js");
  const direct = provider("test.direct", "@test/direct.js");
  const results: boolean[] = [];
  let nested: (() => boolean) | undefined;
  let nestedRefusal = "";
  const outer: SourceDeclarationProvider = {
    ...provider("test.outer", "@test/outer.js"),
    get identity() {
      try {
        nested?.();
      } catch (error) {
        nestedRefusal = error instanceof Error ? error.message : String(error);
        throw error;
      }
      return testProviderIdentity("test.outer");
    },
  };
  const host = new ExtensionHost({}, {
    extensions: [
      {
        identity: { id: "ext.1-nesting", version: "1.0.0" },
        initialize(context): void {
          nested = () => context.registerSourceDeclarationProvider(inner);
          results.push(context.registerSourceDeclarationProvider(outer));
          nested = undefined;
          results.push(context.registerSourceDeclarationProvider(third));
        },
      },
      registering("ext.2-next", [next], { results }),
    ],
  });
  assert.equal(host.providers.registerSourceDeclarationProvider(direct), true);

  assert.match(nestedRefusal, /Host-owned extension registration is required to register source declaration provider state for 'ext\.1-nesting'/);
  assert.deepEqual(results, [false, true, true]);
  assert.deepEqual(host.extensions.map((extension) => extension.identity.id), ["ext.1-nesting", "ext.2-next"]);
  assert.equal(host.providers.resolveVirtualModule("@test/outer.js").kind, "unowned");
  assert.equal(host.providers.resolveVirtualModule("@test/inner.js").kind, "unowned");
  assert.equal(resolvedDocument(host, "@test/third.js").registrarExtensionId, "ext.1-nesting");
  assert.equal(resolvedDocument(host, "@test/next.js").registrarExtensionId, "ext.2-next");
  assert.equal(resolvedDocument(host, "@test/direct.js").registrarExtensionId, null);
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["INVALID_SOURCE_DECLARATION_PROVIDER"],
  );
});

test("a direct registration made from inside another direct registration is the host's too", () => {
  const inner = provider("test.inner", "@test/inner.js");
  const results: boolean[] = [];
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.before", [provider("test.before", "@test/before.js")])],
  });
  const outer: SourceDeclarationProvider = {
    ...provider("test.outer", "@test/outer.js"),
    get identity() {
      results.push(host.providers.registerSourceDeclarationProvider(inner));
      return testProviderIdentity("test.outer");
    },
  };
  assert.equal(host.providers.registerSourceDeclarationProvider(outer), true);

  assert.deepEqual(results, [true]);
  assert.equal(resolvedDocument(host, "@test/outer.js").registrarExtensionId, null);
  assert.equal(resolvedDocument(host, "@test/inner.js").registrarExtensionId, null);
  assert.equal(resolvedDocument(host, "@test/before.js").registrarExtensionId, "ext.before");
});

test("a registration asked from a provider callback during resolution is closed and records nothing", () => {
  const late = provider("test.late", "@test/late.js");
  const results: boolean[] = [];
  let registry: ExtensionHost["providers"] | undefined;
  const asking: SourceDeclarationProvider = {
    ...provider("test.asking", "@test/asking.js"),
    ownsModule: (candidate) => {
      if (registry !== undefined) results.push(registry.registerSourceDeclarationProvider(late));
      return candidate === "@test/asking.js" ? { kind: "owned" } : { kind: "unowned" };
    },
  };
  const host = new ExtensionHost({}, {
    extensions: [registering("ext.asking", [asking])],
  });
  registry = host.providers;

  assert.equal(resolvedDocument(host, "@test/asking.js").registrarExtensionId, "ext.asking");
  assert.deepEqual(results, [false]);
  assert.equal(host.providers.resolveVirtualModule("@test/late.js").kind, "unowned");
  assert.ok(host.diagnostics.all().some((diagnostic) => diagnostic.extensionCode === "EXTENSION_REGISTRATION_CLOSED"));
});

test("a registry call made while an extension owner is active is refused and registers nothing", () => {
  // During source analysis the analyzing extension is the active owner. Its direct call on the registry is refused
  // by the registry's host-owned assertion, as it was before registrars existed.
  const refused = provider("test.refused-direct", "@test/refused-direct.js");
  const kept = provider("test.kept", "@test/kept.js");
  let refusal = "";
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [
        registering("ext.1-kept", [kept]),
        {
          identity: { id: "ext.2-analyzing", version: "1.0.0" },
          analyzeSource(): void {
            const registry = getExtensionHost(session.program!)?.providers;
            assert.ok(registry);
            try {
              registry.registerSourceDeclarationProvider(refused);
            } catch (error) {
              refusal = error instanceof Error ? error.message : String(error);
            }
          },
        },
      ],
    },
  });
  session.checkSource();

  assert.equal(
    refusal,
    "Extension 'ext.2-analyzing' must register source declaration provider state through its owner-bound initialization capability.",
  );
  const registry = getExtensionHost(session.program!)?.providers;
  assert.ok(registry);
  assert.equal(registry.resolveVirtualModule("@test/refused-direct.js").kind, "unowned");
  const keptModule = registry.resolveVirtualModule("@test/kept.js");
  assert.equal(keptModule.kind, "resolved");
  if (keptModule.kind !== "resolved") assert.fail("The module registered in an initializer must resolve.");
  assert.equal(keptModule.module.artifact.document.registrarExtensionId, "ext.1-kept");
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
  assert.equal(document.registrarExtensionId, "ext.read");
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
  assert.equal(publicDocuments[0]!.registrarExtensionId, "ext.owners");

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
  assert.equal(owner.registrarExtensionId, "ext.owners");
  assert.equal(owner.provider.id, "test.owners");
  // The facts' lookup hands through the registry's own documents, for both kinds.
  const registry = getExtensionHost(session.program!)?.providers;
  assert.ok(registry);
  assert.equal(registry.getVirtualDeclarationDocument(fact.artifactFileName), owner);
  assert.equal(checked.sourceFacts.getVirtualDeclarationDocument(publicDocuments[0]!.fileName), publicDocuments[0]);
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
  options: {
    readonly fail?: boolean;
    readonly results?: boolean[];
    readonly order?: string[];
    readonly dependencies?: NonNullable<CompilerExtension["dependencies"]>;
  } = {},
): CompilerExtension {
  return {
    identity: { id: extensionId, version: "1.0.0" },
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    initialize(context): void {
      options.order?.push(extensionId);
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
