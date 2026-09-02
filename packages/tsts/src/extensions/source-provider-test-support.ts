import type { GoPtr } from "../go/compat.js";
import type { Node } from "../internal/ast/ast.js";
import {
  TstsSourceProviderContractVersion,
  type CompilerExtension,
  type ExtensionDiagnostic,
  type ProviderDeclarationModel,
  type ProviderDeclarationRequest,
  type ProviderModuleContext,
  type ProviderModuleResolution,
  type SourceDeclarationProvider,
} from "./index.js";

export const testCoreDeclarations = [
  "interface Object {}",
  "interface Function {}",
  "interface CallableFunction extends Function {}",
  "interface NewableFunction extends Function {}",
  "interface IArguments {}",
  "interface String {}",
  "interface Number {}",
  "interface Boolean {}",
  "interface RegExp {}",
  "interface Array<T> { readonly length: number; [index: number]: T; }",
].join("\n");

export const testNoLibCompilerOptions = Object.freeze({
  noLib: true,
  module: "esnext",
  moduleResolution: "bundler",
});

export function sourceProviderExtension(
  models: ReadonlyMap<string, ProviderDeclarationModel>,
  options: {
    readonly extensionId?: string;
    readonly providerId?: string;
    readonly declarationMaterialization?: SourceDeclarationProvider["declarationMaterialization"];
    readonly packageName?: string;
    readonly packageVersion?: string;
    readonly onContext?: (specifier: string, context: ProviderModuleContext) => void;
    readonly getDeclarationModel?: (
      resolution: ProviderModuleResolution,
      model: ProviderDeclarationModel,
      request: ProviderDeclarationRequest,
    ) => ProviderDeclarationModel | ExtensionDiagnostic;
  } = {},
): CompilerExtension {
  const extensionId = options.extensionId ?? "test.source-provider.extension";
  const providerId = options.providerId ?? "test.source-provider";
  const provider: SourceDeclarationProvider = {
    identity: {
      id: providerId,
      version: "1.0.0",
      extensionContractVersion: TstsSourceProviderContractVersion,
      diagnosticRange: { start: 9_900_000, end: 9_900_099 },
    },
    declarationMaterialization: options.declarationMaterialization ?? "complete",
    ownsModule(specifier, context) {
      options.onContext?.(specifier, context);
      return models.has(specifier)
        ? { kind: "owned" }
        : { kind: "unowned" };
    },
    resolveModule(specifier) {
      const model = models.get(specifier);
      if (model === undefined) {
        return providerDiagnostic(providerId, "TEST_PROVIDER_MODULE_MISSING", `No model exists for '${specifier}'.`);
      }
      return {
        kind: "virtual",
        moduleSpecifier: specifier,
        virtualFileName: `/provider/${model.providerModuleId.replaceAll(".", "/")}.d.ts`,
        providerModuleId: model.providerModuleId,
        ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
        ...(options.packageVersion === undefined ? {} : { packageVersion: options.packageVersion }),
      };
    },
    getDeclarationModel(resolution, request) {
      const model = models.get(resolution.moduleSpecifier);
      if (model === undefined) {
        return providerDiagnostic(
          providerId,
          "TEST_PROVIDER_MODEL_MISSING",
          `No declaration model exists for '${resolution.moduleSpecifier}'.`,
        );
      }
      return options.getDeclarationModel?.(resolution, model, request) ?? model;
    },
  };
  return {
    identity: {
      id: extensionId,
      version: "1.0.0",
    },
    initialize(context): void {
      context.registerSourceDeclarationProvider(provider);
    },
  };
}

export function sourceProviderCompilerExtension(
  provider: SourceDeclarationProvider,
  extensionId = `${provider.identity.id}.extension`,
): CompilerExtension {
  return {
    identity: {
      id: extensionId,
      version: "1.0.0",
    },
    initialize(context): void {
      context.registerSourceDeclarationProvider(provider);
    },
  };
}

export function testProviderIdentity(id: string) {
  return {
    id,
    version: "1.0.0",
    extensionContractVersion: TstsSourceProviderContractVersion,
  } as const;
}

export function testProviderModel(
  moduleSpecifier: string,
  providerModuleId: string,
  exports: ProviderDeclarationModel["exports"] = [{
    id: "Value",
    name: "Value",
    kind: "value",
    type: { kind: "number" },
  }],
): ProviderDeclarationModel {
  return { moduleSpecifier, providerModuleId, exports };
}

export function findNodes(
  root: GoPtr<Node>,
  children: (node: GoPtr<Node>) => readonly GoPtr<Node>[],
  predicate: (node: GoPtr<Node>) => boolean,
): readonly GoPtr<Node>[] {
  const matches: GoPtr<Node>[] = [];
  const visit = (node: GoPtr<Node>): void => {
    if (node === undefined) {
      return;
    }
    if (predicate(node)) {
      matches.push(node);
    }
    for (const child of children(node)) {
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function providerDiagnostic(providerId: string, extensionCode: string, message: string): ExtensionDiagnostic {
  return {
    category: "error",
    numericCode: 9900001,
    extensionId: providerId,
    extensionCode,
    message,
  };
}
