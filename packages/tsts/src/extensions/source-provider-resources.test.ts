import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExtensionHost,
  type ExtensionDiagnostic,
  type ProviderDeclarationModel,
  type ProviderModuleResolution,
  type SourceDeclarationProvider,
} from "./index.js";
import { providerDeclarationClosureLimits } from "./provider-resource-limits.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import { sourceProviderExtension } from "./source-provider-test-support.js";
import {
  sourceProviderCompilerExtension,
  testProviderIdentity,
} from "./source-provider-test-support.js";

const rejectedChainModuleCount = providerDeclarationClosureLimits.maxCandidates + 1;

test("provider resource members admit both exact well-known disposal symbols", () => {
  const moduleSpecifier = "@test/disposable-resource.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.DisposableResource",
    exports: [{ id: "Resource", name: "Resource", kind: "interface", members:
      (["dispose", "asyncDispose"] as const).map(name => ({ id: `Resource.${name}`,
        name: { kind: "well-known-symbol", name }, kind: "method", signatures: [{
          id: `Resource.${name}()`, parameters: [], returnType: name === "dispose" ? { kind: "void" }
            : { kind: "source-global", name: "Promise", typeArguments: [{ kind: "void" }] },
        }],
      })),
    }],
  };
  const host = new ExtensionHost({}, { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))] });
  const resolved = host.providers.resolveVirtualModule(moduleSpecifier);
  assert.equal(resolved.kind, "resolved", "native provider disposal members resolve");
  assert.equal(host.diagnostics.all().length, 0, "no boundary rejection for supported symbols");
  const documents = host.providers.getVirtualDeclarationDocuments();
  assert.equal(documents.length, 1, "one canonical provider module");
  for (const name of ["dispose", "asyncDispose"] as const) {
    const selected = providerVirtualDeclarationFactKey.snapshot({
      providerId: "test.source-provider", providerVersion: "1.0.0", providerModuleId: model.providerModuleId,
      moduleSpecifier, artifactFileName: "/provider/Test/DisposableResource.d.ts", exportId: "Resource",
      memberId: `Resource.${name}`, memberKey: { kind: "well-known-symbol", name },
    });
    assert.equal(selected.memberKey?.kind, "well-known-symbol", `${name}: exact symbol namespace`);
    assert.equal(selected.memberKey?.name, name, `${name}: immutable fact retains exact symbol identity`);
    assert.equal(Object.isFrozen(selected.memberKey), true, `${name}: sealed member key`);
  }
});

test("provider disposal validation does not admit arbitrary symbol names", () => {
  assert.throws(() => providerVirtualDeclarationFactKey.snapshot({
    providerId: "test.source-provider", providerVersion: "1.0.0", providerModuleId: "Test.Resource",
    moduleSpecifier: "@test/resource.js", artifactFileName: "/provider/Test/Resource.d.ts",
    memberKey: { kind: "well-known-symbol", name: "notDispose" as "dispose" },
  }), /ProviderMemberKey kind\/name 'well-known-symbol:notDispose' is invalid/u);
});

test("distinct rejected provider closures share one exact provider budget rejection", () => {
  const fixture = rejectedChainFixture(["first", "second"]);
  const first = fixture.host.providers.resolveVirtualModule(fixture.rootSpecifier("first"));
  assert.equal(first.kind, "rejected");
  const declarationCallsAfterFirst = fixture.declarationCalls();
  const repeatedFirst = fixture.host.providers.resolveVirtualModule(fixture.rootSpecifier("first"));
  assert.equal(repeatedFirst, first);
  assert.equal(fixture.declarationCalls(), declarationCallsAfterFirst);

  const second = fixture.host.providers.resolveVirtualModule(fixture.rootSpecifier("second"));
  assert.equal(second.kind, "rejected");
  const declarationCallsAfterSecond = fixture.declarationCalls();
  const repeatedSecond = fixture.host.providers.resolveVirtualModule(fixture.rootSpecifier("second"));
  assert.equal(repeatedSecond, second);
  assert.equal(fixture.declarationCalls(), declarationCallsAfterSecond);
  assert.equal(declarationCallsAfterSecond, rejectedChainModuleCount * 2);

  assert.equal(second, first);
  assert.equal(rejectedDiagnostic(second), rejectedDiagnostic(first));
  assert.equal(fixture.host.diagnostics.all().length, 1);
  assertBudgetDiagnostic(rejectedDiagnostic(first));
  assert.deepEqual(fixture.host.providers.getVirtualDeclarationDocuments(), []);
});

test("provider budget rejection is resolution-order independent and transactionally unpublished", () => {
  const direct = rejectedChainFixture(["ordered"]);
  const directRoot = direct.host.providers.resolveVirtualModule(direct.rootSpecifier("ordered"));
  assert.equal(directRoot.kind, "rejected");
  assert.deepEqual(direct.host.providers.getVirtualDeclarationDocuments(), []);

  const dependencyFirst = rejectedChainFixture(["ordered"]);
  const leaf = dependencyFirst.host.providers.resolveVirtualModule(dependencyFirst.leafSpecifier("ordered"));
  assert.equal(leaf.kind, "resolved");
  const documentsBeforeRoot = dependencyFirst.host.providers.getVirtualDeclarationDocuments();
  assert.equal(documentsBeforeRoot.length, 1);
  const dependencyFirstRoot = dependencyFirst.host.providers.resolveVirtualModule(
    dependencyFirst.rootSpecifier("ordered"),
  );
  assert.equal(dependencyFirstRoot.kind, "rejected");
  assert.deepEqual(rejectedDiagnostic(dependencyFirstRoot), rejectedDiagnostic(directRoot));
  assert.deepEqual(dependencyFirst.host.providers.getVirtualDeclarationDocuments(), documentsBeforeRoot);
  assert.equal(
    dependencyFirst.host.providers.resolveVirtualModule(dependencyFirst.rootSpecifier("ordered")),
    dependencyFirstRoot,
  );
});

function rejectedChainFixture(prefixes: readonly string[]): {
  readonly host: ExtensionHost;
  readonly declarationCalls: () => number;
  readonly rootSpecifier: (prefix: string) => string;
  readonly leafSpecifier: (prefix: string) => string;
} {
  const prefixSet = new Set(prefixes);
  const modulePattern = /^@test\/resource\/([^/]+)\/(\d+)\.js$/;
  let declarationCalls = 0;
  const parseSpecifier = (specifier: string): { readonly prefix: string; readonly index: number } | undefined => {
    const match = modulePattern.exec(specifier);
    if (match === null || !prefixSet.has(match[1]!)) {
      return undefined;
    }
    return { prefix: match[1]!, index: Number.parseInt(match[2]!, 10) };
  };
  const provider: SourceDeclarationProvider = {
    identity: testProviderIdentity("test.provider-closure-resources"),
    declarationMaterialization: "complete",
    ownsModule(specifier) {
      return parseSpecifier(specifier) === undefined
        ? { kind: "unowned" }
        : { kind: "owned" };
    },
    resolveModule(specifier): ProviderModuleResolution {
      const parsed = parseSpecifier(specifier);
      if (parsed === undefined) {
        throw new Error(`Unexpected provider module '${specifier}'.`);
      }
      return {
        kind: "virtual",
        moduleSpecifier: specifier,
        providerModuleId: `Test.Resource.${parsed.prefix}.${parsed.index}`,
        virtualFileName: `/provider/resource/${parsed.prefix}/${parsed.index}.d.ts`,
      };
    },
    getDeclarationModel(resolution): ProviderDeclarationModel {
      declarationCalls += 1;
      const parsed = parseSpecifier(resolution.moduleSpecifier);
      if (parsed === undefined) {
        throw new Error(`Unexpected provider module '${resolution.moduleSpecifier}'.`);
      }
      const nextSpecifier = parsed.index + 1 < rejectedChainModuleCount
        ? moduleSpecifier(parsed.prefix, parsed.index + 1)
        : undefined;
      return {
        moduleSpecifier: resolution.moduleSpecifier,
        providerModuleId: resolution.providerModuleId,
        ...(nextSpecifier === undefined ? {} : {
          imports: [{
            moduleSpecifier: nextSpecifier,
            namedImports: [{ exportedName: "Node", kind: "type" }],
            typeOnly: true,
          }],
        }),
        exports: [{
          id: `Node${parsed.index}`,
          name: "Node",
          kind: "interface",
          ...(nextSpecifier === undefined ? {} : {
            members: [{
              id: `Node${parsed.index}.next`,
              name: "next",
              kind: "property",
              type: {
                kind: "provider-ref",
                moduleSpecifier: nextSpecifier,
                exportName: "Node",
              },
            }],
          }),
        }],
      };
    },
  };
  return {
    host: new ExtensionHost({}, {
      extensions: [sourceProviderCompilerExtension(provider)],
    }),
    declarationCalls: () => declarationCalls,
    rootSpecifier: (prefix) => moduleSpecifier(prefix, 0),
    leafSpecifier: (prefix) => moduleSpecifier(prefix, rejectedChainModuleCount - 1),
  };
}

function moduleSpecifier(prefix: string, index: number): string {
  return `@test/resource/${prefix}/${index}.js`;
}

function rejectedDiagnostic(
  result: ReturnType<ExtensionHost["providers"]["resolveVirtualModule"]>,
): ExtensionDiagnostic {
  assert.equal(result.kind, "rejected");
  return result.diagnostic;
}

function assertBudgetDiagnostic(diagnostic: ExtensionDiagnostic): void {
  assert.equal(diagnostic.extensionCode, "INVALID_PROVIDER_DECLARATION_MODEL");
  const budgetDetails = diagnostic.evidence?.find(
    (entry) => entry.message === "Provider declaration closure budget",
  )?.details as Readonly<Record<string, unknown>> | undefined;
  assert.equal(Object.getPrototypeOf(budgetDetails), null);
  assert.deepEqual(
    { ...budgetDetails },
    {
      dimension: "candidate modules",
      limit: providerDeclarationClosureLimits.maxCandidates,
    },
  );
}
