import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionHost,
  type ProviderDeclarationModel,
  type ProviderModuleContext,
  type SourceDeclarationProvider,
} from "./index.js";
import {
  sourceProviderCompilerExtension,
  testProviderIdentity,
  testProviderModel,
} from "./source-provider-test-support.js";
import { providerModuleContextLimits } from "./provider-resource-limits.js";

test("malformed ownership outcomes fail closed before later provider stages", () => {
  const cases: readonly {
    readonly name: string;
    readonly value: () => unknown;
  }[] = [{
    name: "null",
    value: () => null,
  }, {
    name: "missing-kind",
    value: () => ({}),
  }, {
    name: "unknown-kind",
    value: () => ({ kind: "onwed" }),
  }, {
    name: "revoked",
    value: () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    },
  }];

  for (const entry of cases) {
    const specifier = `@test/ownership-${entry.name}.js`;
    let resolveCalls = 0;
    let declarationCalls = 0;
    const sourceProvider = validProvider(
      `test.ownership.${entry.name}`,
      specifier,
      testProviderModel(specifier, `Test.Ownership.${entry.name}`),
      {
        onResolve: () => {
          resolveCalls += 1;
        },
        onDeclaration: () => {
          declarationCalls += 1;
        },
      },
    );
    Reflect.set(sourceProvider, "ownsModule", entry.value);
    const host = hostFor(sourceProvider);

    assert.doesNotThrow(() => {
      assert.equal(
        host.providers.resolveVirtualModule(specifier).kind,
        "rejected",
        entry.name,
      );
    });
    assert.equal(resolveCalls, 0, entry.name);
    assert.equal(declarationCalls, 0, entry.name);
    assert.equal(
      host.diagnostics.all().at(-1)?.extensionCode,
      "INVALID_PROVIDER_CALLBACK_RESULT",
      entry.name,
    );
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), [], entry.name);
  }
});

test("malformed resolution outcomes fail closed before declaration or publication", () => {
  const specifier = "@test/malformed-resolution.js";
  const cases: readonly {
    readonly name: string;
    readonly value: () => unknown;
    readonly expectedCode: string;
  }[] = [{
    name: "null",
    value: () => null,
    expectedCode: "INVALID_PROVIDER_MODULE_RESOLUTION",
  }, {
    name: "missing-provider-module",
    value: () => ({
      kind: "virtual",
      moduleSpecifier: specifier,
      virtualFileName: "/provider/missing-module.d.ts",
    }),
    expectedCode: "INVALID_PROVIDER_MODULE_RESOLUTION",
  }, {
    name: "wrong-specifier",
    value: () => ({
      kind: "virtual",
      moduleSpecifier: "@test/other.js",
      virtualFileName: "/provider/wrong-specifier.d.ts",
      providerModuleId: "Test.WrongSpecifier",
    }),
    expectedCode: "INVALID_PROVIDER_MODULE_RESOLUTION",
  }, {
    name: "throwing-field",
    value: () => Object.defineProperty({
      kind: "virtual",
      moduleSpecifier: specifier,
      providerModuleId: "Test.ThrowingField",
    }, "virtualFileName", {
      enumerable: true,
      get(): never {
        throw new Error("unreadable virtual file name");
      },
    }),
    expectedCode: "INVALID_PROVIDER_MODULE_RESOLUTION",
  }];

  for (const entry of cases) {
    let declarationCalls = 0;
    const sourceProvider = validProvider(
      `test.resolution.${entry.name}`,
      specifier,
      testProviderModel(specifier, `Test.Resolution.${entry.name}`),
      {
        onDeclaration: () => {
          declarationCalls += 1;
        },
      },
    );
    Reflect.set(sourceProvider, "resolveModule", entry.value);
    const host = hostFor(sourceProvider);

    assert.doesNotThrow(() => {
      assert.equal(
        host.providers.resolveVirtualModule(specifier).kind,
        "rejected",
        entry.name,
      );
    });
    assert.equal(declarationCalls, 0, entry.name);
    assert.equal(
      host.diagnostics.all().at(-1)?.extensionCode,
      entry.expectedCode,
      entry.name,
    );
    if (entry.name === "wrong-module") {
      assert.deepEqual(host.diagnostics.all().at(-1)?.evidence, [{
        message: "Declaration model rejection",
        details: {
          reason: "module-specifier-mismatch",
          path: "moduleSpecifier",
        },
      }]);
    }
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), [], entry.name);
  }
});

test("malformed declaration outcomes fail closed without retaining provider objects", () => {
  const specifier = "@test/malformed-declaration.js";
  const cases: readonly {
    readonly name: string;
    readonly value: () => unknown;
    readonly expectedCode: string;
  }[] = [{
    name: "null",
    value: () => null,
    expectedCode: "INVALID_PROVIDER_DECLARATION_MODEL",
  }, {
    name: "wrong-module",
    value: () => testProviderModel("@test/other.js", "Test.MalformedDeclaration"),
    expectedCode: "INVALID_PROVIDER_DECLARATION_MODEL",
  }, {
    name: "wrong-provider-module",
    value: () => testProviderModel(specifier, "Test.OtherDeclaration"),
    expectedCode: "INVALID_PROVIDER_DECLARATION_MODEL",
  }, {
    name: "extra-field",
    value: () => ({
      ...testProviderModel(specifier, "Test.MalformedDeclaration"),
      extra: true,
    }),
    expectedCode: "INVALID_PROVIDER_DECLARATION_MODEL",
  }, {
    name: "revoked",
    value: () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    },
    expectedCode: "INVALID_PROVIDER_CALLBACK_RESULT",
  }];

  for (const entry of cases) {
    const sourceProvider = validProvider(
      `test.declaration.${entry.name}`,
      specifier,
      testProviderModel(specifier, "Test.MalformedDeclaration"),
    );
    Reflect.set(sourceProvider, "getDeclarationModel", entry.value);
    const host = hostFor(sourceProvider);

    assert.doesNotThrow(() => {
      assert.equal(
        host.providers.resolveVirtualModule(specifier).kind,
        "rejected",
        entry.name,
      );
    });
    assert.equal(
      host.diagnostics.all().at(-1)?.extensionCode,
      entry.expectedCode,
      entry.name,
    );
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), [], entry.name);
  }
});

test("unreadable request contexts reject before ownership callbacks", () => {
  const specifier = "@test/unreadable-context.js";
  let ownershipCalls = 0;
  const sourceProvider = validProvider(
    "test.unreadable-context",
    specifier,
    testProviderModel(specifier, "Test.UnreadableContext"),
  );
  Reflect.set(sourceProvider, "ownsModule", () => {
    ownershipCalls += 1;
    return { kind: "owned" };
  });
  const host = hostFor(sourceProvider);
  const revoked = Proxy.revocable<ProviderModuleContext>({}, {});
  revoked.revoke();

  assert.doesNotThrow(() => {
    assert.equal(
      host.providers.resolveVirtualModule(specifier, revoked.proxy).kind,
      "rejected",
    );
  });
  assert.equal(ownershipCalls, 0);
  assert.match(
    host.diagnostics.all().at(-1)?.message ?? "",
    /unreadable module context/,
  );
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
});

test("large valid import slices reach ownership while the context bound remains closed", () => {
  const providerSpecifier = "@test/context-budget-provider.js";
  const sourceProvider = validProvider(
    "test.context-budget",
    providerSpecifier,
    testProviderModel(providerSpecifier, "Test.ContextBudget"),
  );
  let ownershipCalls = 0;
  Reflect.set(sourceProvider, "ownsModule", () => {
    ownershipCalls += 1;
    return { kind: "unowned" };
  });
  const host = hostFor(sourceProvider);
  const productContext: ProviderModuleContext = {
    importSlice: {
      moduleSpecifier: "./interface-types.js",
      kind: "named",
      requestedExports: Array.from({ length: 4_000 }, (_, index) => ({
        exportedName: `$goDynamicType_${index.toString().padStart(6, "0")}_${"x".repeat(48)}`,
        localName: `$goDynamicType_${index.toString().padStart(6, "0")}_${"x".repeat(48)}`,
        kind: "value",
      })),
    },
  };
  assert.equal(
    host.providers.resolveVirtualModule("./interface-types.js", productContext).kind,
    "unowned",
  );
  assert.equal(ownershipCalls, 1);
  assert.deepEqual(host.diagnostics.all(), []);

  const overLimit = Array.from({
    length: providerModuleContextLimits.maxTotalScalarCodeUnits
      / providerModuleContextLimits.maxStringCodeUnits,
  }, () => ({
    exportedName: "x".repeat(providerModuleContextLimits.maxStringCodeUnits),
  }));
  assert.equal(Number.isInteger(overLimit.length), true);
  assert.equal(
    host.providers.resolveVirtualModule("./too-large.js", {
      importSlice: {
        moduleSpecifier: "./too-large.js",
        kind: "named",
        requestedExports: overLimit,
      },
    }).kind,
    "rejected",
  );
  assert.equal(ownershipCalls, 1);
  assert.equal(
    host.diagnostics.all().at(-1)?.extensionCode,
    "INVALID_PROVIDER_MODULE_CONTEXT",
  );
});

test("provider registration captures identity and callback methods exactly once", () => {
  const specifier = "@test/registration-capture.js";
  const identity = {
    ...testProviderIdentity("test.registration-capture"),
    displayName: "Original",
  };
  let versionReads = 0;
  Object.defineProperty(identity, "version", {
    configurable: true,
    enumerable: true,
    get() {
      versionReads += 1;
      return versionReads === 1 ? "1.0.0" : "unstable";
    },
  });
  let ownershipCalls = 0;
  const sourceProvider: SourceDeclarationProvider = {
    identity,
    declarationMaterialization: "complete",
    ownsModule: (candidate) => {
      ownershipCalls += 1;
      return candidate === specifier ? { kind: "owned" } : { kind: "unowned" };
    },
    resolveModule: (candidate) =>
      resolution(candidate, "Test.RegistrationCapture"),
    getDeclarationModel: () =>
      testProviderModel(specifier, "Test.RegistrationCapture"),
  };
  const host = hostFor(sourceProvider);

  Object.defineProperty(identity, "version", { value: "2.0.0" });
  Reflect.set(sourceProvider, "ownsModule", () => ({ kind: "unowned" }));
  const first = host.providers.resolveVirtualModule(specifier);
  const repeated = host.providers.resolveVirtualModule(specifier);

  assert.ok(first.kind === "resolved");
  assert.ok(repeated === first, "Registration capture must retain one exact callback result.");
  assert.equal(first.module.artifact.provider.version, "1.0.0");
  assert.equal(first.module.artifact.provider.displayName, "Original");
  assert.equal(versionReads, 1);
  assert.equal(ownershipCalls, 1);
  assert.equal(host.diagnostics.hasErrors(), false);
});

test("throwing provider registration accessors reject atomically", () => {
  const sourceProvider = validProvider(
    "test.throwing-registration",
    "@test/throwing-registration.js",
    testProviderModel(
      "@test/throwing-registration.js",
      "Test.ThrowingRegistration",
    ),
  );
  Object.defineProperty(sourceProvider, "resolveModule", {
    enumerable: true,
    get(): never {
      throw new Error("unreadable callback");
    },
  });
  const host = hostFor(sourceProvider);

  assert.equal(host.providers.hasSourceDeclarationProviders, false);
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["INVALID_SOURCE_DECLARATION_PROVIDER"],
  );
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
});

test("provider declaration materialization mode is explicit and fail-closed", () => {
  const sourceProvider = validProvider(
    "test.invalid-materialization-mode",
    "@test/invalid-materialization-mode.js",
    testProviderModel(
      "@test/invalid-materialization-mode.js",
      "Test.InvalidMaterializationMode",
    ),
  );
  Reflect.set(sourceProvider, "declarationMaterialization", "eager");

  const host = hostFor(sourceProvider);

  assert.equal(host.providers.hasSourceDeclarationProviders, false);
  assert.deepEqual(
    host.diagnostics.all().map((diagnostic) => diagnostic.extensionCode),
    ["INVALID_SOURCE_DECLARATION_PROVIDER"],
  );
});

function hostFor(sourceProvider: SourceDeclarationProvider): ExtensionHost {
  return new ExtensionHost({}, {
    extensions: [sourceProviderCompilerExtension(sourceProvider)],
  });
}

function validProvider(
  id: string,
  specifier: string,
  model: ProviderDeclarationModel,
  hooks: {
    readonly onResolve?: () => void;
    readonly onDeclaration?: () => void;
  } = {},
): SourceDeclarationProvider {
  return {
    identity: testProviderIdentity(id),
    declarationMaterialization: "complete",
    ownsModule: (candidate) => candidate === specifier
      ? { kind: "owned" }
      : { kind: "unowned" },
    resolveModule(candidate) {
      hooks.onResolve?.();
      return resolution(candidate, model.providerModuleId);
    },
    getDeclarationModel() {
      hooks.onDeclaration?.();
      return model;
    },
  };
}

function resolution(moduleSpecifier: string, providerModuleId: string) {
  return {
    kind: "virtual" as const,
    moduleSpecifier,
    virtualFileName: `/provider/${providerModuleId}.d.ts`,
    providerModuleId,
  };
}
