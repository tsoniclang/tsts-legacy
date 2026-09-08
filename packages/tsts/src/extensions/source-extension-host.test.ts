import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionHostDiagnosticCode,
  attachExtensionHost,
  createSourceFactQueries,
  defineExtensionFactKey,
  getExtensionHost,
  hasExtensionHost,
  type CompilerExtension,
  type ExtensionDiagnostic,
  type ProviderDeclarationModel,
} from "./index.js";
import {
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";

function extension(
  id: string,
  options: Pick<CompilerExtension, "dependencies" | "initialize" | "analyzeSource"> = {},
): CompilerExtension {
  return {
    identity: {
      id,
      version: "1.0.0",
    },
    ...options,
  };
}

test("source extension host is attached sidecar state and orders dependencies deterministically", () => {
  const program = {};
  const order: string[] = [];
  const first = extension("first", { initialize: () => void order.push("first") });
  const second = extension("second", {
    dependencies: { dependsOn: ["first"] },
    initialize: () => void order.push("second"),
  });

  assert.equal(hasExtensionHost(program), false);
  const attached = attachExtensionHost(program, { extensions: [second, first] });
  assert.ok(attached.program === program, "The extension host must retain the exact compiler program.");
  assert.ok(
    getExtensionHost(program) === attached.extensionHost,
    "The program must expose the exact attached extension host.",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(program, "__extensionHost"), false);
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(attached.extensionHost.extensions.map((item) => item.identity.id), ["first", "second"]);
});

test("duplicate, missing, and cyclic source extensions fail closed with stable diagnostics", () => {
  const duplicate = extension("duplicate");
  const missing = extension("missing", { dependencies: { dependsOn: ["absent"] } });
  const left = extension("left", { dependencies: { dependsOn: ["right"] } });
  const right = extension("right", { dependencies: { dependsOn: ["left"] } });
  const host = attachExtensionHost({}, {
    extensions: [duplicate, duplicate, missing, left, right],
  }).extensionHost;

  const diagnostics = host.diagnostics.all();
  assert.equal(
    diagnostics.filter((item) => item.numericCode === ExtensionHostDiagnosticCode.duplicateExtension).length,
    1,
  );
  assert.equal(
    diagnostics.filter((item) => item.numericCode === ExtensionHostDiagnosticCode.missingDependency).length,
    1,
  );
  assert.equal(
    diagnostics.filter((item) => item.numericCode === ExtensionHostDiagnosticCode.dependencyCycle).length,
    1,
  );
  assert.deepEqual(host.extensions.map((item) => item.identity.id), ["duplicate"]);
});

test("source analyzers write only owner facts and consumers read only finalized facts", () => {
  const extensionId = "fact-owner";
  const factKey = defineExtensionFactKey<string>({
    extensionId,
    name: "value",
    snapshot: (value) => value,
  });
  const subject = {};
  const analyzer = extension(extensionId, {
    analyzeSource(context): void {
      assert.equal(context.facts.set(subject, factKey, "first"), "inserted");
      assert.equal(context.facts.set(subject, factKey, "first"), "idempotent");
    },
  });
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [analyzer] },
  });

  const host = getExtensionHost(session.program!);
  assert.ok(host !== undefined);
  assert.throws(
    () => createSourceFactQueries(host),
    /require finalized source-extension semantics/,
  );
  const checked = session.checkSource();
  assert.equal(checked.sourceFacts.getFact(subject, factKey), "first");
  assert.deepEqual(checked.extensionDiagnostics, []);
});

test("source analyzer conflicts and foreign writes roll back the complete transaction", () => {
  const extensionId = "rollback-owner";
  const factKey = defineExtensionFactKey<string>({
    extensionId,
    name: "value",
    snapshot: (value) => value,
  });
  const foreignKey = defineExtensionFactKey<string>({
    extensionId: "rollback-foreign-owner",
    name: "value",
    snapshot: (value) => value,
  });
  const subject = {};
  const analyzer = extension(extensionId, {
    analyzeSource(context): void {
      assert.equal(context.facts.set(subject, factKey, "first"), "inserted");
      assert.equal(context.facts.set(subject, factKey, "second"), "conflict");
      assert.equal(context.facts.set(subject, foreignKey, "foreign"), "conflict");
    },
  });
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [analyzer] },
  });

  const host = getExtensionHost(session.program!);
  assert.ok(host !== undefined);
  assert.throws(() => session.checkSource(), /Cannot commit an extension fact transaction/);
  assert.equal(host.facts.get(subject, factKey), undefined);
  assert.equal(host.facts.get(subject, foreignKey), undefined);
  assert.equal(
    host.diagnostics.all().filter((item) => item.extensionCode === "FACT_CONFLICT").length,
    1,
  );
  assert.equal(
    host.diagnostics.all().filter((item) =>
      item.extensionCode === "FACT_WRITER_OWNERSHIP_VIOLATION").length,
    1,
  );
});

test("source fact resolvers are owner-scoped, lazy, cached, and sealed before consumers run", () => {
  const extensionId = "resolved-fact";
  const factKey = defineExtensionFactKey<number>({
    extensionId,
    name: "answer",
    snapshot: (value) => value,
  });
  const subject = {};
  let calls = 0;
  const resolver = extension(extensionId, {
    initialize(context): void {
      context.registerFactResolver(factKey, (candidate) => {
        calls += 1;
        return candidate === subject ? { value: 42 } : undefined;
      });
    },
    analyzeSource(context): void {
      assert.equal(context.factResolver.resolve(subject, factKey), 42);
      assert.equal(context.factResolver.resolve(subject, factKey), 42);
    },
  });
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [resolver] },
  });

  const checked = session.checkSource();
  assert.equal(calls, 1);
  assert.equal(checked.sourceFacts.getFact(subject, factKey), 42);
  assert.equal(getExtensionHost(session.program!)?.facts.sealed, true);
});

test("source extensions receive frozen least-authority capability views", () => {
  const extensionId = "least-authority";
  const factKey = defineExtensionFactKey<number>({
    extensionId,
    name: "answer",
    snapshot: (value) => value,
  });
  const subject = {};
  let capturedWrite: (() => unknown) | undefined;
  let capturedDiagnostic: (() => unknown) | undefined;
  const analyzer = extension(extensionId, {
    initialize(context): void {
      assert.equal(Object.isFrozen(context), true);
      assert.deepEqual(
        Object.keys(context).sort(),
        ["diagnostics", "registerFactResolver", "registerSourceDeclarationProvider"],
      );
      assert.equal(Object.isFrozen(context.diagnostics), true);
      assert.deepEqual(Object.keys(context.diagnostics), ["append"]);
      capturedDiagnostic = () => context.diagnostics.append({
        extensionId,
        extensionCode: "LATE_DIAGNOSTIC",
        numericCode: 9900001,
        category: "error",
        message: "late",
      });
      context.registerFactResolver(factKey, (candidate, resolverContext) => {
        assert.equal(Object.isFrozen(resolverContext), true);
        assert.equal(Object.isFrozen(resolverContext.facts), true);
        assert.equal(Object.isFrozen(resolverContext.diagnostics), true);
        assert.deepEqual(Object.keys(resolverContext.facts).sort(), ["get", "getEntry", "has"]);
        assert.deepEqual(Object.keys(resolverContext.diagnostics), ["append"]);
        return candidate === subject ? { value: 42 } : undefined;
      });
    },
    analyzeSource(context): void {
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.facts), true);
      assert.equal(Object.isFrozen(context.factResolver), true);
      assert.equal(Object.isFrozen(context.diagnostics), true);
      assert.deepEqual(Object.keys(context.facts).sort(), ["get", "getEntry", "has", "set"]);
      assert.deepEqual(Object.keys(context.factResolver), ["getVirtualDeclarationDocument", "resolve"]);
      assert.deepEqual(Object.keys(context.diagnostics), ["append"]);
      assert.equal(context.factResolver.resolve(subject, factKey), 42);
      capturedWrite = () => context.facts.set(subject, factKey, 42);
    },
  });
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [analyzer] },
  });

  const checked = session.checkSource();
  assert.equal(checked.sourceFacts.getFact(subject, factKey), 42);
  assert.throws(
    () => capturedWrite?.(),
    /cannot be used outside their host-owned callback/,
  );
  assert.throws(
    () => capturedDiagnostic?.(),
    /cannot be used outside their host-owned callback/,
  );
  assert.equal(checked.sourceFacts.getFact(subject, factKey), 42);
  assert.equal(
    getExtensionHost(session.program!)?.diagnostics.all().length,
    checked.extensionDiagnostics.length,
  );
});

test("extension registration is an immutable program-revision snapshot", () => {
  const extensionId = "immutable-registration";
  const factKey = defineExtensionFactKey<string>({
    extensionId,
    name: "value",
    snapshot: (value) => value,
  });
  const subject = {};
  let originalCalls = 0;
  let replacementCalls = 0;
  const registered = extension(extensionId, {
    analyzeSource(context): void {
      originalCalls += 1;
      assert.equal(context.facts.set(subject, factKey, "original"), "inserted");
    },
  });
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [registered] },
  });

  const mutable = registered as {
    identity: { id: string };
    analyzeSource?: CompilerExtension["analyzeSource"];
  };
  mutable.identity.id = "mutated-registration";
  mutable.analyzeSource = () => {
    replacementCalls += 1;
  };

  const checked = session.checkSource();
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.equal(checked.sourceFacts.getFact(subject, factKey), "original");
});

test("failed extension initialization rolls back provider and resolver registrations atomically", () => {
  const model: ProviderDeclarationModel = {
    moduleSpecifier: "@test/atomic.js",
    providerModuleId: "Test.Atomic",
    exports: [{ id: "Value", name: "Value", kind: "class" }],
  };
  const failedProvider = sourceProviderExtension(new Map([[model.moduleSpecifier, model]]), {
    extensionId: "failed-provider",
    providerId: "shared-provider",
  });
  const failed: CompilerExtension = {
    ...failedProvider,
    initialize(context): void {
      failedProvider.initialize?.(context);
      throw new Error("rollback");
    },
  };
  const succeeding = sourceProviderExtension(new Map([[model.moduleSpecifier, model]]), {
    extensionId: "succeeding-provider",
    providerId: "shared-provider",
  });
  const host = attachExtensionHost({}, { extensions: [failed, succeeding] }).extensionHost;

  assert.deepEqual(host.extensions.map((item) => item.identity.id), ["succeeding-provider"]);
  assert.equal(host.providers.hasSourceDeclarationProviders, true);
  assert.equal(host.providers.resolveVirtualModule(model.moduleSpecifier).kind, "resolved");
  assert.equal(
    host.diagnostics.all().filter((item) => item.extensionCode === "EXTENSION_INITIALIZE_FAILED").length,
    1,
  );
  assert.equal(
    host.diagnostics.all().filter((item) => item.extensionCode === "DUPLICATE_SOURCE_DECLARATION_PROVIDER").length,
    0,
  );
});

test("provider callback failure is terminally cached and never falls back", () => {
  const model: ProviderDeclarationModel = {
    moduleSpecifier: "@test/failing.js",
    providerModuleId: "Test.Failing",
    exports: [{ id: "Value", name: "Value", kind: "class" }],
  };
  let modelCalls = 0;
  const provider = sourceProviderExtension(new Map([[model.moduleSpecifier, model]]), {
    getDeclarationModel(): ExtensionDiagnostic {
      modelCalls += 1;
      return {
        extensionId: "test.source-provider",
        extensionCode: "TEST_PROVIDER_REJECTED",
        numericCode: 9900002,
        category: "error",
        message: "Rejected by test provider.",
      };
    },
  });
  const host = attachExtensionHost({}, { extensions: [provider] }).extensionHost;

  assert.equal(host.providers.resolveVirtualModule(model.moduleSpecifier).kind, "rejected");
  assert.equal(host.providers.resolveVirtualModule(model.moduleSpecifier).kind, "rejected");
  assert.equal(modelCalls, 1);
  assert.equal(
    host.diagnostics.all().filter((item) => item.extensionCode === "TEST_PROVIDER_REJECTED").length,
    1,
  );
});
