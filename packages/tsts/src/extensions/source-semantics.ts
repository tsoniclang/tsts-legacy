import type { bool } from "../go/scalars.js";
import type { GoPtr } from "../go/compat.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import type { Symbol } from "../internal/ast/symbol.js";
import {
  Node_Arguments,
  Node_Expression,
  Node_Elements,
  Node_ImportClause,
  Node_Initializer,
  Node_ModuleSpecifier,
  Node_PropertyName,
  Node_Properties,
  SourceFile_Path,
  Node_Statements,
  Node_Symbol,
  Node_Text,
  Node_TypeArguments,
} from "../internal/ast/ast.js";
import { Node_End, Node_ForEachChild, Node_Name, Node_Pos } from "../internal/ast/spine.js";
import { AsExportDeclaration, AsExportSpecifier, AsImportClause, AsNamespaceImport, AsPropertyAccessExpression, AsQualifiedName, AsTypeReferenceNode } from "../internal/ast/generated/casts.js";
import {
  KindCallExpression,
  KindExportDeclaration,
  KindExportSpecifier,
  KindIdentifier,
  KindImportDeclaration,
  KindImportSpecifier,
  KindNamedImports,
  KindNamedExports,
  KindNamespaceImport,
  KindNumericLiteral,
  KindObjectLiteralExpression,
  KindPropertyAccessExpression,
  KindPropertyAssignment,
  KindPropertyDeclaration,
  KindQualifiedName,
  KindStringLiteral,
  KindTypeKeyword,
  KindTypeReference,
  KindTupleType,
  KindVariableDeclaration,
} from "../internal/ast/generated/kinds.js";
import {
  GetSourceFileOfNode,
  GetSymbolId,
  IsDeclarationName,
  IsLeftHandSideExpression,
  IsRightSideOfQualifiedNameOrPropertyAccess,
} from "../internal/ast/utilities.js";
import {
  argumentPassingFactKey,
  attributeFactKey,
  canonicalIdentityFactKey,
  defaultValueFactKey,
  fieldFactKey,
  flowStateFactKey,
  functionPointerFactKey,
  pointerFactKey,
  pointerOperationFactKey,
  rawPointerFactKey,
  rawPointerOperationFactKey,
  providerVirtualDeclarationFactKey,
  sourceMarkerFactKey,
  sourcePrimitiveFactKey,
  structFactKey,
} from "./facts.js";
import type {
  ArgumentPassingFact,
  AttributeFact,
  DefaultValueFact,
  ExtensionCanonicalIdentity,
  ExtensionImportKind,
  FieldFact,
  FlowStateFact,
  FunctionPointerFact,
  PointerFact,
  PointerOperationFact,
  RawPointerFact,
  RawPointerOperationFact,
  SourceCallMarkerKind,
  SourceMarkerFact,
  SourcePrimitiveFact,
  SourcePrimitiveKind,
  SourceTypeMarkerKind,
  StructFact,
} from "./facts.js";
import type { ResolvedSourceCallInfo, TypeCheckerQueries } from "../services/type-checker.js";
import type {
  CompilerExtension,
  ExtensionDiagnosticWriter,
  ExtensionEvidence,
  ExtensionFactKey,
  ExtensionFactReader,
  ExtensionFactResolverContext,
  ExtensionFactSubject,
  SourceAnalysisFactAccess,
} from "./host.js";
import { defineExtensionFactKey } from "./fact-key.js";
import { encodeIdentityTuple } from "./identity-tuple.js";

type SourceSemanticsFactReader = Pick<ExtensionFactReader, "get">;
type SourceSemanticsFactAccess = Pick<SourceAnalysisFactAccess, "get" | "set">;

export interface SourceSemanticsExtensionOptions {
  readonly modules: readonly SourceSemanticsModule[];
}

export const sourceSemanticsExtensionId = "tsts.source-semantics";

export type SourceSemanticsModuleCapability = "primitive" | "call-marker" | "type-marker";

export interface SourceSemanticsModuleIdentity {
  readonly moduleSpecifier: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly subpath?: string;
  readonly capabilities?: readonly SourceSemanticsModuleCapability[];
}

export interface SourceSemanticsModule extends SourceSemanticsModuleIdentity {
  readonly exports: readonly SourceSemanticsExportDeclaration[];
}

export type SourceSemanticsExportDeclaration =
  | SourcePrimitiveDeclaration
  | SourceCallMarkerDeclaration
  | SourceTypeMarkerDeclaration;

export interface SourcePrimitiveDeclaration extends Omit<SourcePrimitiveFact, "kind"> {
  readonly kind: "source-primitive";
  readonly exportName: string;
  readonly primitive: SourcePrimitiveKind;
}

export type { SourceCallMarkerKind, SourceTypeMarkerKind } from "./facts.js";

type ArgumentPassingMarkerKind = Extract<
  SourceCallMarkerKind,
  "write-only-reference" | "read-write-reference" | "read-only-reference"
>;

export interface SourceCallMarkerDeclaration {
  readonly kind: "call-marker";
  readonly exportName: string;
  readonly marker: SourceCallMarkerKind;
}

export interface SourceTypeMarkerDeclaration {
  readonly kind: "type-marker";
  readonly exportName: string;
  readonly marker: SourceTypeMarkerKind;
}

type SourceMarkerDeclaration = SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration;

interface SelectedSourcePrimitiveDeclaration {
  readonly moduleSpecifier: string;
  readonly exportName: string;
}

interface ResolvedSourcePrimitive {
  readonly moduleIdentity: SourceSemanticsModuleRuntime;
  readonly exportName: string;
  readonly primitiveFact: SourcePrimitiveDeclaration;
  readonly identity: ExtensionCanonicalIdentity;
}

const selectedSourcePrimitiveDeclarationFactKey = defineExtensionFactKey<SelectedSourcePrimitiveDeclaration>({
  extensionId: sourceSemanticsExtensionId,
  name: "selectedSourcePrimitiveDeclaration",
  snapshot: (value) => Object.freeze({ ...value }),
  equals: (left, right) =>
    left.moduleSpecifier === right.moduleSpecifier
    && left.exportName === right.exportName,
});

const selectedSourceMarkerDeclarationFactKey = defineExtensionFactKey<SourceMarkerDeclaration>({
  extensionId: sourceSemanticsExtensionId,
  name: "selectedSourceMarkerDeclaration",
  snapshot: (value) => Object.freeze({ ...value }),
  equals: (left, right) =>
    left.kind === right.kind
    && left.exportName === right.exportName
    && left.marker === right.marker,
});

interface SourceSemanticsModuleRuntime extends SourceSemanticsModuleIdentity {
  readonly primitivesByExportName: ReadonlyMap<string, SourcePrimitiveDeclaration>;
  readonly callMarkersByExportName: ReadonlyMap<string, SourceCallMarkerDeclaration>;
  readonly typeMarkersByExportName: ReadonlyMap<string, SourceTypeMarkerDeclaration>;
}

function createSourceSemanticsModules(modules: readonly SourceSemanticsModule[]): readonly SourceSemanticsModuleRuntime[] {
  return modules.map((module) => {
    const primitivesByExportName = new Map<string, SourcePrimitiveDeclaration>();
    const callMarkersByExportName = new Map<string, SourceCallMarkerDeclaration>();
    const typeMarkersByExportName = new Map<string, SourceTypeMarkerDeclaration>();
    for (const exportDeclaration of module.exports) {
      switch (exportDeclaration.kind) {
        case "source-primitive":
          primitivesByExportName.set(exportDeclaration.exportName, exportDeclaration);
          break;
        case "call-marker":
          callMarkersByExportName.set(exportDeclaration.exportName, exportDeclaration);
          break;
        case "type-marker":
          typeMarkersByExportName.set(exportDeclaration.exportName, exportDeclaration);
          break;
      }
    }
    return {
      moduleSpecifier: module.moduleSpecifier,
      ...(module.packageName !== undefined ? { packageName: module.packageName } : {}),
      ...(module.packageVersion !== undefined ? { packageVersion: module.packageVersion } : {}),
      ...(module.subpath !== undefined ? { subpath: module.subpath } : {}),
      ...(module.capabilities !== undefined ? { capabilities: module.capabilities } : {}),
      primitivesByExportName,
      callMarkersByExportName,
      typeMarkersByExportName,
    };
  });
}

export function createSourceSemanticsExtension(options: SourceSemanticsExtensionOptions): CompilerExtension {
  const modules = createSourceSemanticsModules(options.modules);
  return {
    identity: {
      id: sourceSemanticsExtensionId,
      version: "1.0.0",
    },
    initialize(context): void {
      context.registerFactResolver(sourcePrimitiveFactKey, (subject, resolverContext) =>
        resolveSourcePrimitiveFact(subject, resolverContext, modules));
    },
    analyzeSource(context): void {
      const sourceFiles = context.source.getSourceFiles().filter(
        (sourceFile): sourceFile is SourceFile => sourceFile !== undefined,
      );
      for (const sourceFile of sourceFiles) {
        recordConfiguredSourceSemanticsDeclarations(
          sourceFile,
          context.source.getSourceFileQueries(sourceFile).checker,
          context.facts,
          modules,
        );
      }
      for (const sourceFile of sourceFiles) {
        recordSourceSemanticsDeclarationAliases(
          context.facts,
          sourceFile,
          context.source.getSourceFileQueries(sourceFile).checker,
          modules,
        );
      }
      for (const sourceFile of sourceFiles) {
        recordSourceSemanticsFacts(
          sourceFile,
          context.source.getSourceFileQueries(sourceFile).checker,
          context.facts,
          context.diagnostics,
          sourceSemanticsExtensionId,
          modules,
        );
      }
    },
  };
}

function recordConfiguredSourceSemanticsDeclarations(
  sourceFile: SourceFile,
  checker: TypeCheckerQueries,
  facts: SourceSemanticsFactAccess,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  for (const statement of Node_Statements(sourceFile) ?? []) {
    if (statement?.Kind === KindImportDeclaration) {
      const moduleIdentity = getSourceSemanticsModuleIdentity(statement, modules);
      if (moduleIdentity !== undefined) {
        recordSourceSemanticsImportClause(
          facts,
          checker,
          statement,
          moduleIdentity,
        );
      }
      continue;
    }
    if (statement?.Kind === KindExportDeclaration) {
      const moduleIdentity = getSourceSemanticsModuleIdentity(statement, modules);
      if (moduleIdentity !== undefined) {
        recordSourceSemanticsExportClause(
          facts,
          checker,
          statement,
          moduleIdentity,
        );
      }
    }
  }
}

function recordSourceSemanticsDeclarationAliases(
  facts: SourceSemanticsFactAccess,
  sourceFile: SourceFile,
  checker: TypeCheckerQueries,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  if (facts.get(sourceFile, providerVirtualDeclarationFactKey) !== undefined) {
    return;
  }
  visitSourceSemanticsNodePost(sourceFile, (node) => {
    if (
      node === undefined ||
      (node.Kind !== KindImportSpecifier && node.Kind !== KindExportSpecifier)
    ) {
      return;
    }
    const localSymbol = Node_Symbol(node);
    if (localSymbol === undefined) {
      return;
    }
    const selectedSymbol = checker.getAliasedSymbol(localSymbol);
    if (selectedSymbol === undefined) {
      return;
    }
    const primitive = facts.get(
      selectedSymbol,
      selectedSourcePrimitiveDeclarationFactKey,
    );
    if (primitive !== undefined) {
      const moduleIdentity = modules.find(
        (candidate) => candidate.moduleSpecifier === primitive.moduleSpecifier,
      );
      const declaration = moduleIdentity?.primitivesByExportName.get(
        primitive.exportName,
      );
      if (moduleIdentity === undefined || declaration === undefined) {
        throw new Error(
          `Selected source primitive '${primitive.moduleSpecifier}::${primitive.exportName}' has no configured declaration.`,
        );
      }
      const identity = createExportIdentity(
        moduleIdentity,
        primitive.exportName,
        "type",
        getSymbolFactId(localSymbol),
      );
      const evidence = createPrimitiveEvidence(
        moduleIdentity,
        primitive.exportName,
      );
      facts.set(node, selectedSourcePrimitiveDeclarationFactKey, primitive, evidence);
      facts.set(node, canonicalIdentityFactKey, identity, evidence);
      facts.set(node, sourcePrimitiveFactKey, stripExportName(declaration), evidence);
      facts.set(localSymbol, selectedSourcePrimitiveDeclarationFactKey, primitive, evidence);
      facts.set(localSymbol, canonicalIdentityFactKey, identity, evidence);
      facts.set(localSymbol, sourcePrimitiveFactKey, stripExportName(declaration), evidence);
    }
    const marker = facts.get(
      selectedSymbol,
      selectedSourceMarkerDeclarationFactKey,
    );
    if (marker === undefined) {
      return;
    }
    const markerFact: SourceMarkerFact = marker.kind === "call-marker"
      ? { kind: marker.kind, marker: marker.marker }
      : { kind: marker.kind, marker: marker.marker };
    const evidence = createMarkerEvidence(marker.exportName);
    facts.set(node, selectedSourceMarkerDeclarationFactKey, marker, evidence);
    facts.set(node, sourceMarkerFactKey, markerFact, evidence);
    facts.set(localSymbol, selectedSourceMarkerDeclarationFactKey, marker, evidence);
    facts.set(localSymbol, sourceMarkerFactKey, markerFact, evidence);
  });
}

function recordSourceSemanticsFacts(
  sourceFile: SourceFile,
  checker: TypeCheckerQueries,
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  recordSourceSemanticsMarkerReferences(
    facts,
    sourceFile,
    checker,
    modules,
  );
  recordSourceSemanticsCallMarkers(
    facts,
    diagnostics,
    extensionId,
    sourceFile,
    checker,
  );
  recordSourceSemanticsTypeReferences(
    facts,
    sourceFile,
    checker,
    modules,
  );
}

function recordSourceSemanticsImportClause(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  importDeclaration: GoPtr<Node>,
  moduleIdentity: SourceSemanticsModuleRuntime,
): void {
  const importClause = Node_ImportClause(importDeclaration);
  if (importClause === undefined) {
    return;
  }
  const typedImport = AsImportClause(importClause)!.PhaseModifier === KindTypeKeyword;
  const namedBindings = AsImportClause(importClause)!.NamedBindings;
  if (namedBindings === undefined) {
    return;
  }
  if (namedBindings.Kind === KindNamespaceImport) {
    recordNamespaceImportIdentity(facts, namedBindings, moduleIdentity, typedImport);
    return;
  }
  if (namedBindings.Kind !== KindNamedImports) {
    return;
  }
  for (const importSpecifier of Node_Elements(namedBindings) ?? []) {
    if (importSpecifier === undefined) {
      continue;
    }
    const localName = Node_Name(importSpecifier);
    if (localName === undefined) {
      continue;
    }
    const exportName = Node_Text(Node_PropertyName(importSpecifier) ?? localName);
    const primitiveFact = moduleIdentity.primitivesByExportName.get(exportName);
    if (primitiveFact !== undefined) {
      recordSourcePrimitiveImport(facts, checker, importSpecifier, moduleIdentity, exportName, primitiveFact, typedImport);
      continue;
    }
    const callMarker = moduleIdentity.callMarkersByExportName.get(exportName);
    if (callMarker !== undefined) {
      recordSourceSemanticsMarkerImport(facts, checker, importSpecifier, moduleIdentity, exportName, typedImport ? "type" : "value", callMarker);
      continue;
    }
    const typeMarker = moduleIdentity.typeMarkersByExportName.get(exportName);
    if (typeMarker !== undefined) {
      recordSourceSemanticsMarkerImport(facts, checker, importSpecifier, moduleIdentity, exportName, typedImport ? "type" : "value", typeMarker);
    }
  }
}

function recordSourceSemanticsExportClause(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  exportDeclaration: GoPtr<Node>,
  moduleIdentity: SourceSemanticsModuleRuntime,
): void {
  const exportClause = AsExportDeclaration(exportDeclaration)!.ExportClause;
  if (exportClause === undefined || exportClause.Kind !== KindNamedExports) {
    return;
  }
  const declarationIsTypeOnly = AsExportDeclaration(exportDeclaration)!.IsTypeOnly;
  for (const exportSpecifier of Node_Elements(exportClause) ?? []) {
    if (exportSpecifier === undefined) {
      continue;
    }
    const exportedName = Node_Name(exportSpecifier);
    if (exportedName === undefined) {
      continue;
    }
    const sourceName = Node_Text(Node_PropertyName(exportSpecifier) ?? exportedName);
    const primitiveFact = moduleIdentity.primitivesByExportName.get(sourceName);
    if (primitiveFact !== undefined) {
      const specifierIsTypeOnly = AsExportSpecifier(exportSpecifier)!.IsTypeOnly;
      recordSourcePrimitiveImport(facts, checker, exportSpecifier, moduleIdentity, sourceName, primitiveFact, declarationIsTypeOnly || specifierIsTypeOnly);
      continue;
    }
    const specifierIsTypeOnly = AsExportSpecifier(exportSpecifier)!.IsTypeOnly;
    const callMarker = moduleIdentity.callMarkersByExportName.get(sourceName);
    if (callMarker !== undefined) {
      recordSourceSemanticsMarkerImport(
        facts,
        checker,
        exportSpecifier,
        moduleIdentity,
        sourceName,
        declarationIsTypeOnly || specifierIsTypeOnly ? "type" : "value",
        callMarker,
      );
      continue;
    }
    const typeMarker = moduleIdentity.typeMarkersByExportName.get(sourceName);
    if (typeMarker !== undefined) {
      recordSourceSemanticsMarkerImport(
        facts,
        checker,
        exportSpecifier,
        moduleIdentity,
        sourceName,
        declarationIsTypeOnly || specifierIsTypeOnly ? "type" : "value",
        typeMarker,
      );
    }
  }
}

function recordSourceSemanticsMarkerReferences(
  facts: SourceSemanticsFactAccess,
  sourceFile: SourceFile,
  checker: TypeCheckerQueries,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  visitSourceSemanticsNodePost(sourceFile, (node) => {
    if (
      node === undefined ||
      (node.Kind !== KindIdentifier &&
        node.Kind !== KindPropertyAccessExpression &&
        node.Kind !== KindQualifiedName) ||
      IsDeclarationName(node) ||
      IsRightSideOfQualifiedNameOrPropertyAccess(node)
    ) {
      return;
    }
    const callMarker = resolveMarkerFromCheckedReference(
      facts,
      checker,
      node,
      modules,
      "call-marker",
    );
    const marker = callMarker ?? resolveMarkerFromCheckedReference(
      facts,
      checker,
      node,
      modules,
      "type-marker",
    );
    if (marker === undefined) {
      return;
    }
    const fact: SourceMarkerFact = marker.kind === "call-marker"
      ? { kind: marker.kind, marker: marker.marker }
      : { kind: marker.kind, marker: marker.marker };
    facts.set(
      node,
      selectedSourceMarkerDeclarationFactKey,
      marker,
      createMarkerEvidence(marker.exportName),
    );
    facts.set(
      node,
      sourceMarkerFactKey,
      fact,
      createMarkerEvidence(marker.exportName),
    );
  });
}

function recordSourceSemanticsCallMarkers(
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  sourceFile: GoPtr<SourceFile>,
  checker: TypeCheckerQueries,
): void {
  visitSourceSemanticsNodePost(sourceFile, (node) => {
    if (node?.Kind !== KindCallExpression) {
      return;
    }
    const callInfo = checker.getResolvedCallInfo(node);
    const marker = resolveSelectedSourceSemanticsCallMarker(facts, callInfo);
    if (marker === undefined || callInfo === undefined) {
      return;
    }
    recordSourceSemanticsCallMarker(facts, diagnostics, extensionId, checker, node, callInfo, marker);
  });
}

function recordSourceSemanticsCallMarker(
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  checker: TypeCheckerQueries,
  callExpression: Node,
  callInfo: ResolvedSourceCallInfo,
  marker: SourceCallMarkerDeclaration,
): void {
  const evidence = createMarkerEvidence(marker.exportName);
  switch (marker.marker) {
    case "write-only-reference":
    case "read-write-reference":
    case "read-only-reference": {
      if (!hasMarkerArgumentCount(callExpression, 1)) {
        return;
      }
      const argument = (Node_Arguments(callExpression) ?? [])[0];
      if (argument === undefined) {
        return;
      }
      recordArgumentPassingMarker(facts, diagnostics, extensionId, callExpression, argument, marker, evidence);
      return;
    }
    case "shared-borrow": {
      if (!hasMarkerArgumentCount(callExpression, 1)) {
        return;
      }
      const argument = (Node_Arguments(callExpression) ?? [])[0];
      if (argument === undefined) {
        return;
      }
      recordFlowMarker(facts, callExpression, argument, { state: "borrowed-shared" }, evidence);
      return;
    }
    case "mutable-borrow": {
      if (!hasMarkerArgumentCount(callExpression, 1)) {
        return;
      }
      const argument = (Node_Arguments(callExpression) ?? [])[0];
      if (argument === undefined) {
        return;
      }
      recordFlowMarker(facts, callExpression, argument, { state: "borrowed-mut" }, evidence);
      return;
    }
    case "move": {
      if (!hasMarkerArgumentCount(callExpression, 1)) {
        return;
      }
      const argument = (Node_Arguments(callExpression) ?? [])[0];
      if (argument === undefined) {
        return;
      }
      recordFlowMarker(facts, callExpression, argument, { state: "moved" }, evidence);
      return;
    }
    case "field":
      if (!hasMarkerArgumentCount(callExpression, 0) || !hasMarkerTypeArgumentCount(callExpression, 1)) {
        return;
      }
      recordFieldMarker(facts, callExpression, evidence);
      return;
    case "struct":
      if (!hasMarkerArgumentCount(callExpression, 1)) {
        return;
      }
      recordStructMarker(facts, callExpression, evidence);
      return;
    case "attribute":
      if (!hasMarkerTypeArgumentCount(callExpression, 1)) {
        return;
      }
      recordAttributeMarker(facts, callExpression, evidence);
      return;
    case "default-value":
      if (!hasMarkerArgumentCount(callExpression, 0) || !hasMarkerTypeArgumentCount(callExpression, 1)) {
        return;
      }
      recordDefaultValueMarker(facts, callExpression, evidence);
      return;
    case "address-of":
    case "allocate":
    case "load":
    case "store":
    case "equal-pointer":
    case "hash-pointer":
    case "bind-pointer":
    case "project-pointer":
      recordPointerOperation(
        facts,
        diagnostics,
        extensionId,
        checker,
        callExpression,
        callInfo,
        marker,
        evidence,
      );
      return;
    case "bind-raw-pointer":
    case "equal-raw-pointer":
    case "hash-raw-pointer":
      recordRawPointerOperation(facts, callExpression, callInfo, marker, evidence);
      return;
  }
}

function hasMarkerArgumentCount(callExpression: Node, count: number): boolean {
  return (Node_Arguments(callExpression) ?? []).length === count;
}

function hasMarkerTypeArgumentCount(callExpression: Node, count: number): boolean {
  return (Node_TypeArguments(callExpression) ?? []).length === count;
}

function recordPointerOperation(
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  checker: TypeCheckerQueries,
  callExpression: Node,
  callInfo: ResolvedSourceCallInfo,
  marker: SourceCallMarkerDeclaration,
  evidence: readonly ExtensionEvidence[],
): void {
  if (callInfo.sourceSelectedSignatureKind !== "resolved") {
    return;
  }
  const selectedTypeArguments = callInfo.sourceSelectedMethodTypeArguments ?? [];
  const expectedTypeArgumentCount = marker.marker === "project-pointer" ? 2 : 1;
  const pointeeIndex = marker.marker === "project-pointer" ? 1 : 0;
  const pointeeType = selectedTypeArguments.length === expectedTypeArgumentCount
    ? selectedTypeArguments[pointeeIndex]?.selectedType
    : undefined;
  const explicitPointeeTypeNode = selectedTypeArguments.length === expectedTypeArgumentCount
    ? selectedTypeArguments[pointeeIndex]?.explicitTypeNode
    : undefined;
  if (pointeeType === undefined) {
    diagnostics.append({
      extensionId,
      extensionCode: "SOURCE_SEMANTICS_POINTER_TYPE_EVIDENCE_MISSING",
      numericCode: 9901103,
      publicCode: "TSTS_SOURCE_SEMANTICS_0003",
      category: "error",
      message: `${marker.exportName}(...) requires ${expectedTypeArgumentCount} exact selected pointer type argument${expectedTypeArgumentCount === 1 ? "" : "s"}.`,
      nodeOrSpan: callExpression,
      evidence,
      identity: sourceSemanticsDiagnosticIdentity(
        "pointer-type",
        marker.exportName,
        callExpression,
      ),
    });
    return;
  }
  switch (marker.marker) {
    case "address-of": {
      const storageArgument = exactSourceCallArgument(callInfo, 0, 1);
      if (storageArgument === undefined) {
        return;
      }
      const storage = checker.getResolvedStorageInfo(storageArgument.expression);
      if (storage === undefined || !storage.writable) {
        diagnostics.append({
          extensionId,
          extensionCode: "SOURCE_SEMANTICS_WRITABLE_STORAGE_REQUIRED",
          numericCode: 9901102,
          publicCode: "TSTS_SOURCE_SEMANTICS_0002",
          category: "error",
          message: `${marker.exportName}(...) requires writable storage.`,
          nodeOrSpan: storageArgument.expression,
          evidence,
          identity: sourceSemanticsDiagnosticIdentity(
            "writable-storage",
            marker.exportName,
            callExpression,
          ),
        });
        return;
      }
      const fact = {
        operation: "address-of",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        storageExpression: storage.storageExpression,
        storageType: storage.type,
        ...(storage.symbol === undefined ? {} : { storageSymbol: storage.symbol }),
        ...(storage.declaration === undefined
          ? {}
          : { storageDeclaration: storage.declaration }),
        locationIdentity: storage.storageExpression,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "allocate": {
      const initial = exactSourceCallArgument(callInfo, 0, 1);
      if (initial === undefined) {
        return;
      }
      const fact = {
        operation: "allocate",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        initialExpression: initial.expression,
        initialType: initial.type,
        locationIdentity: callExpression,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "load": {
      const pointer = exactSourceCallArgument(callInfo, 0, 1);
      if (pointer === undefined) {
        return;
      }
      const fact = {
        operation: "load",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        pointerExpression: pointer.expression,
        pointerType: pointer.type,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "store": {
      const pointer = exactSourceCallArgument(callInfo, 0, 2);
      const value = exactSourceCallArgument(callInfo, 1, 2);
      if (pointer === undefined || value === undefined) {
        return;
      }
      const fact = {
        operation: "store",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        pointerExpression: pointer.expression,
        pointerType: pointer.type,
        valueExpression: value.expression,
        valueType: value.type,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "equal-pointer": {
      const left = exactSourceCallArgument(callInfo, 0, 2);
      const right = exactSourceCallArgument(callInfo, 1, 2);
      if (left === undefined || right === undefined) {
        return;
      }
      const fact = {
        operation: "equal-pointer",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        leftExpression: left.expression,
        leftType: left.type,
        rightExpression: right.expression,
        rightType: right.type,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "hash-pointer": {
      const pointer = exactSourceCallArgument(callInfo, 0, 1);
      if (pointer === undefined) {
        return;
      }
      const fact = {
        operation: "hash-pointer",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        pointerExpression: pointer.expression,
        pointerType: pointer.type,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "bind-pointer": {
      const identity = exactSourceCallArgument(callInfo, 0, 3);
      const read = exactSourceCallArgument(callInfo, 1, 3);
      const write = exactSourceCallArgument(callInfo, 2, 3);
      if (identity === undefined || read === undefined || write === undefined) {
        return;
      }
      const fact = {
        operation: "bind-pointer",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        identityExpression: identity.expression,
        identityType: identity.type,
        readExpression: read.expression,
        readType: read.type,
        writeExpression: write.expression,
        writeType: write.type,
        locationIdentity: identity.expression,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    case "project-pointer": {
      const pointer = exactSourceCallArgument(callInfo, 0, 3);
      const fromSource = exactSourceCallArgument(callInfo, 1, 3);
      const toSource = exactSourceCallArgument(callInfo, 2, 3);
      const sourceTypeArgument = selectedTypeArguments[0];
      if (
        pointer === undefined ||
        fromSource === undefined ||
        toSource === undefined ||
        sourceTypeArgument?.selectedType === undefined
      ) {
        return;
      }
      const fact = {
        operation: "project-pointer",
        call: callExpression,
        pointeeType,
        ...(explicitPointeeTypeNode === undefined ? {} : { explicitPointeeTypeNode }),
        resultType: callInfo.sourceResultType,
        sourcePointeeType: sourceTypeArgument.selectedType,
        ...(sourceTypeArgument.explicitTypeNode === undefined
          ? {}
          : { explicitSourcePointeeTypeNode: sourceTypeArgument.explicitTypeNode }),
        pointerExpression: pointer.expression,
        pointerType: pointer.type,
        fromSourceExpression: fromSource.expression,
        fromSourceType: fromSource.type,
        toSourceExpression: toSource.expression,
        toSourceType: toSource.type,
      } satisfies PointerOperationFact;
      facts.set(callExpression, pointerOperationFactKey, fact, evidence);
      return;
    }
    default:
      return;
  }
}

function exactSourceCallArgument(
  callInfo: ResolvedSourceCallInfo,
  index: number,
  expectedCount: number,
): ResolvedSourceCallInfo["sourceArguments"][number] | undefined {
  return callInfo.sourceArguments.length === expectedCount
    ? callInfo.sourceArguments[index]
    : undefined;
}

function recordRawPointerOperation(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  callInfo: ResolvedSourceCallInfo,
  marker: SourceCallMarkerDeclaration,
  evidence: readonly ExtensionEvidence[],
): void {
  if (callInfo.sourceSelectedSignatureKind !== "resolved") {
    return;
  }
  switch (marker.marker) {
    case "bind-raw-pointer": {
      const identity = exactSourceCallArgument(callInfo, 0, 1);
      if (identity === undefined) {
        return;
      }
      facts.set(callExpression, rawPointerOperationFactKey, {
        operation: marker.marker,
        call: callExpression,
        resultType: callInfo.sourceResultType,
        identityExpression: identity.expression,
        identityType: identity.type,
      } satisfies RawPointerOperationFact, evidence);
      return;
    }
    case "equal-raw-pointer": {
      const left = exactSourceCallArgument(callInfo, 0, 2);
      const right = exactSourceCallArgument(callInfo, 1, 2);
      if (left === undefined || right === undefined) {
        return;
      }
      facts.set(callExpression, rawPointerOperationFactKey, {
        operation: marker.marker,
        call: callExpression,
        resultType: callInfo.sourceResultType,
        leftExpression: left.expression,
        leftType: left.type,
        rightExpression: right.expression,
        rightType: right.type,
      } satisfies RawPointerOperationFact, evidence);
      return;
    }
    case "hash-raw-pointer": {
      const pointer = exactSourceCallArgument(callInfo, 0, 1);
      if (pointer === undefined) {
        return;
      }
      facts.set(callExpression, rawPointerOperationFactKey, {
        operation: marker.marker,
        call: callExpression,
        resultType: callInfo.sourceResultType,
        pointerExpression: pointer.expression,
        pointerType: pointer.type,
      } satisfies RawPointerOperationFact, evidence);
      return;
    }
    default:
      return;
  }
}

function recordArgumentPassingMarker(
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  callExpression: Node,
  target: Node,
  marker: SourceCallMarkerDeclaration,
  evidence: readonly ExtensionEvidence[],
): void {
  const fact = {
    mode: getArgumentPassingMode(marker.marker as ArgumentPassingMarkerKind),
    storageExpression: target,
  } satisfies ArgumentPassingFact;
  facts.set(callExpression, argumentPassingFactKey, fact, evidence);
  if (IsLeftHandSideExpression(target)) {
    facts.set(target, argumentPassingFactKey, fact, evidence);
    return;
  }
  diagnostics.append({
    extensionId,
    extensionCode: "SOURCE_SEMANTICS_NON_STORAGE_ARGUMENT",
    numericCode: 9901101,
    publicCode: "TSTS_SOURCE_SEMANTICS_0001",
    category: "error",
    message: `${marker.exportName}(...) requires a storage expression.`,
    nodeOrSpan: target,
    evidence,
    identity: sourceSemanticsDiagnosticIdentity(
      "non-storage",
      marker.exportName,
      target,
    ),
  });
}

function sourceSemanticsDiagnosticIdentity(
  diagnostic: string,
  exportName: string,
  node: Node,
): string {
  const sourceFile = GetSourceFileOfNode(node);
  return encodeIdentityTuple([
    "source-semantics",
    diagnostic,
    exportName,
    sourceFile === undefined ? undefined : SourceFile_Path(sourceFile),
    Node_Pos(node),
    Node_End(node),
  ]);
}

function getArgumentPassingMode(kind: ArgumentPassingMarkerKind): ArgumentPassingFact["mode"] {
  switch (kind) {
    case "write-only-reference":
      return "byref-writeonly-must-init";
    case "read-write-reference":
      return "byref-readwrite";
    case "read-only-reference":
      return "byref-readonly";
  }
}

function recordFieldMarker(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  evidence: readonly ExtensionEvidence[],
): void {
  const fieldType = (Node_TypeArguments(callExpression) ?? [])[0];
  if (fieldType === undefined) {
    return;
  }
  const fieldOwner = callExpression?.Parent;
  if (
    fieldOwner === undefined ||
    (fieldOwner.Kind !== KindPropertyAssignment &&
      fieldOwner.Kind !== KindPropertyDeclaration) ||
    Node_Initializer(fieldOwner) !== callExpression
  ) {
    return;
  }
  const nameNode = Node_Name(fieldOwner) ?? Node_PropertyName(fieldOwner);
  const name = getStaticSourceSemanticsNameText(nameNode);
  if (name === undefined) {
    return;
  }
  const fact = {
    name,
    type: fieldType,
  } satisfies FieldFact;
  facts.set(callExpression, fieldFactKey, fact, evidence);
  facts.set(fieldOwner, fieldFactKey, fact, evidence);
  if (nameNode !== undefined) {
    facts.set(nameNode, fieldFactKey, fact, evidence);
  }
}

function recordStructMarker(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  evidence: readonly ExtensionEvidence[],
): void {
  const shape = (Node_Arguments(callExpression) ?? [])[0];
  const fields: FieldFact[] = [];
  if (shape?.Kind === KindObjectLiteralExpression) {
    for (const property of Node_Properties(shape) ?? []) {
      if (property?.Kind !== KindPropertyAssignment) {
        continue;
      }
      const initializer = Node_Initializer(property);
      const field = facts.get(property, fieldFactKey) ?? (initializer === undefined ? undefined : facts.get(initializer, fieldFactKey));
      if (field !== undefined) {
        fields.push(field);
      }
    }
  }
  const fact = {
    valueType: true,
    fields,
  } satisfies StructFact;
  facts.set(callExpression, structFactKey, fact, evidence);
  recordInitializerOwnerFact(facts, callExpression, structFactKey, fact, evidence);
}

function recordAttributeMarker(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  evidence: readonly ExtensionEvidence[],
): void {
  const target = (Node_TypeArguments(callExpression) ?? [])[0];
  if (target === undefined) {
    return;
  }
  const fact = {
    target,
    attributeName: getTypeReferenceNameText(target),
    arguments: definedNodes(Node_Arguments(callExpression) ?? []),
  } satisfies AttributeFact;
  facts.set(callExpression, attributeFactKey, fact, evidence);
  recordInitializerOwnerFact(facts, callExpression, attributeFactKey, fact, evidence);
}

function recordDefaultValueMarker(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  evidence: readonly ExtensionEvidence[],
): void {
  const type = (Node_TypeArguments(callExpression) ?? [])[0];
  if (type === undefined) {
    return;
  }
  const fact = { type } satisfies DefaultValueFact;
  facts.set(callExpression, defaultValueFactKey, fact, evidence);
  recordInitializerOwnerFact(facts, callExpression, defaultValueFactKey, fact, evidence);
}

function recordInitializerOwnerFact<TFact>(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  key: ExtensionFactKey<TFact>,
  fact: TFact,
  evidence: readonly ExtensionEvidence[],
): void {
  const parent = callExpression?.Parent;
  if (parent === undefined || !isInitializerOwner(parent) || Node_Initializer(parent) !== callExpression) {
    return;
  }
  facts.set(parent, key, fact, evidence);
  const symbol = Node_Symbol(parent);
  if (symbol !== undefined) {
    facts.set(symbol, key, fact, evidence);
  }
}

function isInitializerOwner(node: GoPtr<Node>): boolean {
  return node?.Kind === KindVariableDeclaration || node?.Kind === KindPropertyDeclaration || node?.Kind === KindPropertyAssignment;
}

function recordFlowMarker(
  facts: SourceSemanticsFactAccess,
  callExpression: Node,
  target: Node,
  fact: FlowStateFact,
  evidence: readonly ExtensionEvidence[],
): void {
  facts.set(callExpression, flowStateFactKey, fact, evidence);
  facts.set(target, flowStateFactKey, fact, evidence);
  const symbol = Node_Symbol(target);
  if (symbol !== undefined) {
    facts.set(symbol, flowStateFactKey, fact, evidence);
  }
}

function resolveSourcePrimitiveFact(
  subject: ExtensionFactSubject,
  context: ExtensionFactResolverContext,
  modules: readonly SourceSemanticsModuleRuntime[],
): { readonly value: SourcePrimitiveFact; readonly evidence?: readonly ExtensionEvidence[] } | undefined {
  if (subject === null || subject === undefined || typeof subject !== "object") {
    return undefined;
  }
  const node = subject as GoPtr<Node>;
  if (node?.Kind !== KindTypeReference) {
    return undefined;
  }
  const typeName = AsTypeReferenceNode(node)?.TypeName;
  const primitive = resolveRecordedPrimitiveTypeReference(
    context.facts,
    node,
    typeName,
    modules,
  );
  if (primitive === undefined) {
    return undefined;
  }
  return {
    value: stripExportName(primitive.primitiveFact),
    evidence: createPrimitiveEvidence(primitive.moduleIdentity, primitive.exportName),
  };
}

function recordSourceSemanticsTypeReferences(
  facts: SourceSemanticsFactAccess,
  sourceFile: GoPtr<SourceFile>,
  checker: TypeCheckerQueries,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  visitSourceSemanticsNode(sourceFile, (node) => {
    if (node?.Kind !== KindTypeReference) {
      return;
    }
    const typeName = AsTypeReferenceNode(node)!.TypeName;
    if (typeName === undefined) {
      return;
    }
    const marker = resolveSourceSemanticsTypeMarkerReference(facts, typeName);
    if (marker !== undefined) {
      recordSourceSemanticsTypeMarker(facts, node, typeName, marker);
    }
    const primitive = resolvePrimitiveFromCheckedReference(
      facts,
      checker,
      typeName,
      modules,
    );
    if (primitive === undefined) {
      return;
    }
    const evidence = createPrimitiveEvidence(primitive.moduleIdentity, primitive.exportName);
    const selection = createSourcePrimitiveSelection(
      primitive.moduleIdentity,
      primitive.exportName,
    );
    facts.set(node, selectedSourcePrimitiveDeclarationFactKey, selection, evidence);
    facts.set(node, canonicalIdentityFactKey, primitive.identity, evidence);
    facts.set(node, sourcePrimitiveFactKey, stripExportName(primitive.primitiveFact), evidence);
    facts.set(typeName, selectedSourcePrimitiveDeclarationFactKey, selection, evidence);
    facts.set(typeName, canonicalIdentityFactKey, primitive.identity, evidence);
    facts.set(typeName, sourcePrimitiveFactKey, stripExportName(primitive.primitiveFact), evidence);
    if (typeName.Kind === KindQualifiedName) {
      const right = AsQualifiedName(typeName)!.Right;
      if (right === undefined) {
        return;
      }
      facts.set(right, selectedSourcePrimitiveDeclarationFactKey, selection, evidence);
      facts.set(right, canonicalIdentityFactKey, primitive.identity, evidence);
      facts.set(right, sourcePrimitiveFactKey, stripExportName(primitive.primitiveFact), evidence);
    }
  });
}

function recordSourceSemanticsTypeMarker(
  facts: SourceSemanticsFactAccess,
  typeReference: Node,
  typeName: Node,
  marker: SourceTypeMarkerDeclaration,
): void {
  const typeArguments = Node_TypeArguments(typeReference) ?? [];
  const evidence = createMarkerEvidence(marker.exportName);
  if (marker.marker === "raw-pointer") {
    if (typeArguments.length !== 0) {
      return;
    }
    const fact = { representation: "opaque-identity" } satisfies RawPointerFact;
    facts.set(typeReference, rawPointerFactKey, fact, evidence);
    facts.set(typeName, rawPointerFactKey, fact, evidence);
    return;
  }
  if (marker.marker === "pointer") {
    if (typeArguments.length !== 1) {
      return;
    }
    const pointee = typeArguments[0];
    if (pointee === undefined) {
      return;
    }
    const fact = {
      pointee,
      mutability: "readwrite",
    } satisfies PointerFact;
    facts.set(typeReference, pointerFactKey, fact, evidence);
    facts.set(typeName, pointerFactKey, fact, evidence);
    return;
  }
  if (marker.marker === "fixed-array") {
    const fact = {
      kind: "type-marker",
      marker: marker.marker,
    } satisfies SourceMarkerFact;
    facts.set(typeReference, sourceMarkerFactKey, fact, evidence);
    facts.set(typeName, sourceMarkerFactKey, fact, evidence);
    return;
  }
  if (typeArguments.length !== 2) {
    return;
  }
  const result = typeArguments[1];
  if (result === undefined) {
    return;
  }
  const parameters = getFunctionPointerParameters(typeArguments[0]);
  const fact = {
    parameters,
    result,
    abi: ["target-default"],
  } satisfies FunctionPointerFact;
  facts.set(typeReference, functionPointerFactKey, fact, evidence);
  facts.set(typeName, functionPointerFactKey, fact, evidence);
}

function getFunctionPointerParameters(parameterList: GoPtr<Node>): readonly Node[] {
  if (parameterList === undefined) {
    return [];
  }
  if (parameterList.Kind === KindTupleType) {
    return definedNodes(Node_Elements(parameterList) ?? []);
  }
  return [parameterList];
}

function resolveSelectedSourceSemanticsCallMarker(
  facts: SourceSemanticsFactAccess,
  callInfo: GoPtr<ResolvedSourceCallInfo>,
): SourceCallMarkerDeclaration | undefined {
  if (callInfo === undefined) {
    return undefined;
  }
  const callee = callInfo.sourceCallee;
  for (const subject of [
    callee.expression,
    callee.selectedDeclaration,
    callee.declaration,
    callee.selectedSymbol,
    callee.symbol,
  ]) {
    const marker = facts.get(subject, selectedSourceMarkerDeclarationFactKey);
    if (marker?.kind === "call-marker") {
      return marker;
    }
  }
  return undefined;
}

function resolveMarkerFromCheckedReference(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  node: Node,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker",
): SourceCallMarkerDeclaration | undefined;
function resolveMarkerFromCheckedReference(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  node: Node,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "type-marker",
): SourceTypeMarkerDeclaration | undefined;
function resolveMarkerFromCheckedReference(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  node: Node,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker" | "type-marker",
): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined;
function resolveMarkerFromCheckedReference(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  node: Node,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker" | "type-marker",
): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined {
  const receiver = node.Kind === KindPropertyAccessExpression
    ? AsPropertyAccessExpression(node)?.Expression
    : node.Kind === KindQualifiedName
    ? AsQualifiedName(node)?.Left
    : undefined;
  if (receiver !== undefined) {
    const receiverSymbol = checker.getLexicallyResolvedSymbol(receiver);
    const receiverIdentity = receiverSymbol === undefined
      ? undefined
      : facts.get(receiverSymbol, canonicalIdentityFactKey);
    if (receiverIdentity?.kind !== "module") {
      return undefined;
    }
    const selectedMember = node.Kind === KindPropertyAccessExpression
      ? Node_Name(node)
      : AsQualifiedName(node)?.Right;
    const selectedSymbol = checker.getResolvedSymbolOrNil(node)
      ?? checker.getResolvedSymbolOrNil(selectedMember)
      ?? checker.getSymbolAtLocation(selectedMember);
    if (selectedSymbol === undefined) {
      return undefined;
    }
    const module = modules.find(
      (candidate) => candidate.moduleSpecifier === receiverIdentity.id,
    );
    return getModuleMarker(
      module,
      capability,
      checker.getSymbolName(selectedSymbol),
    );
  }

  const localSymbol = checker.getSymbolAtLocation(node);
  const direct = resolveMarkerFromSelectedSubject(
    facts,
    localSymbol,
    modules,
    capability,
  );
  if (direct !== undefined) {
    return direct;
  }

  return resolveMarkerFromSelectedSymbol(
    facts,
    checker.getResolvedSymbolOrNil(node),
    modules,
    capability,
  );
}

function resolveMarkerFromSelectedSubject(
  facts: SourceSemanticsFactAccess,
  subject: ExtensionFactSubject | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker",
): SourceCallMarkerDeclaration | undefined;
function resolveMarkerFromSelectedSubject(
  facts: SourceSemanticsFactAccess,
  subject: ExtensionFactSubject | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "type-marker",
): SourceTypeMarkerDeclaration | undefined;
function resolveMarkerFromSelectedSubject(
  facts: SourceSemanticsFactAccess,
  subject: ExtensionFactSubject | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker" | "type-marker",
): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined;
function resolveMarkerFromSelectedSubject(
  facts: SourceSemanticsFactAccess,
  subject: ExtensionFactSubject | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker" | "type-marker",
): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined {
  if (subject === undefined) {
    return undefined;
  }
  const selectedMarker = facts.get(subject, selectedSourceMarkerDeclarationFactKey);
  if (selectedMarker?.kind === capability) {
    return selectedMarker;
  }
  const providerDeclaration = facts.get(subject, providerVirtualDeclarationFactKey);
  if (providerDeclaration?.exportName !== undefined) {
    const module = modules.find(
      (candidate) =>
        candidate.moduleSpecifier === providerDeclaration.moduleSpecifier,
    );
    return getModuleMarker(module, capability, providerDeclaration.exportName);
  }
  const identity = facts.get(subject, canonicalIdentityFactKey);
  if (identity?.kind === "export" && identity.exportName !== undefined) {
    const module = modules.find(
      (candidate) => identity.id === `${candidate.moduleSpecifier}::${identity.exportName}`,
    );
    return getModuleMarker(module, capability, identity.exportName);
  }
  return undefined;
}

function resolveMarkerFromSelectedSymbol(
  facts: SourceSemanticsFactAccess,
  symbol: Symbol | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker",
): SourceCallMarkerDeclaration | undefined;
function resolveMarkerFromSelectedSymbol(
  facts: SourceSemanticsFactAccess,
  symbol: Symbol | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "type-marker",
): SourceTypeMarkerDeclaration | undefined;
function resolveMarkerFromSelectedSymbol(
  facts: SourceSemanticsFactAccess,
  symbol: Symbol | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker" | "type-marker",
): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined;
function resolveMarkerFromSelectedSymbol(
  facts: SourceSemanticsFactAccess,
  symbol: Symbol | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: "call-marker" | "type-marker",
): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined {
  const direct = resolveMarkerFromSelectedSubject(
    facts,
    symbol,
    modules,
    capability,
  );
  if (direct !== undefined) {
    return direct;
  }
  const parentIdentity = symbol?.Parent === undefined
    ? undefined
    : facts.get(symbol.Parent, canonicalIdentityFactKey);
  if (parentIdentity?.kind !== "module" || symbol === undefined) {
    return undefined;
  }
  const module = modules.find(
    (candidate) => candidate.moduleSpecifier === parentIdentity.id,
  );
  return getModuleMarker(module, capability, symbol.Name);
}

function resolveSourceSemanticsTypeMarkerReference(
  facts: SourceSemanticsFactAccess,
  node: GoPtr<Node>,
): SourceTypeMarkerDeclaration | undefined {
  if (node === undefined) {
    return undefined;
  }
  const selected = facts.get(node, selectedSourceMarkerDeclarationFactKey)
    ?? facts.get(Node_Symbol(node), selectedSourceMarkerDeclarationFactKey);
  return selected?.kind === "type-marker" ? selected : undefined;
}

function resolvePrimitiveFromCheckedReference(
  facts: SourceSemanticsFactReader,
  checker: TypeCheckerQueries,
  typeName: GoPtr<Node>,
  modules: readonly SourceSemanticsModuleRuntime[],
): ResolvedSourcePrimitive | undefined {
  if (typeName === undefined) {
    return undefined;
  }
  const receiver = typeName.Kind === KindQualifiedName
    ? AsQualifiedName(typeName)?.Left
    : undefined;
  if (receiver !== undefined) {
    const receiverSymbol = checker.getLexicallyResolvedSymbol(receiver);
    const receiverIdentity = receiverSymbol === undefined
      ? undefined
      : facts.get(receiverSymbol, canonicalIdentityFactKey);
    if (receiverIdentity?.kind !== "module") {
      return undefined;
    }
    const selectedMember = AsQualifiedName(typeName)?.Right;
    const selectedSymbol = checker.getResolvedSymbolOrNil(typeName)
      ?? checker.getResolvedSymbolOrNil(selectedMember)
      ?? checker.getSymbolAtLocation(selectedMember);
    if (selectedSymbol === undefined) {
      return undefined;
    }
    const moduleIdentity = modules.find(
      (candidate) => candidate.moduleSpecifier === receiverIdentity.id,
    );
    return resolveConfiguredPrimitive(
      moduleIdentity,
      checker.getSymbolName(selectedSymbol),
      selectedSymbol,
    );
  }

  const localSymbol = checker.getSymbolAtLocation(typeName);
  const direct = resolvePrimitiveFromSelectedSymbol(facts, localSymbol, modules);
  if (direct !== undefined) {
    return direct;
  }

  return resolvePrimitiveFromSelectedSymbol(
    facts,
    checker.getResolvedSymbolOrNil(typeName),
    modules,
  );
}

function resolvePrimitiveFromSelectedSymbol(
  facts: SourceSemanticsFactReader,
  symbol: Symbol | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
): ResolvedSourcePrimitive | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  const selection = facts.get(
    symbol,
    selectedSourcePrimitiveDeclarationFactKey,
  );
  if (selection !== undefined) {
    return resolvePrimitiveSelection(selection, modules, symbol);
  }
  const providerDeclaration = facts.get(symbol, providerVirtualDeclarationFactKey);
  if (providerDeclaration?.exportName !== undefined) {
    const moduleIdentity = modules.find(
      (candidate) =>
        candidate.moduleSpecifier === providerDeclaration.moduleSpecifier,
    );
    return resolveConfiguredPrimitive(
      moduleIdentity,
      providerDeclaration.exportName,
      symbol,
    );
  }
  const identity = facts.get(symbol, canonicalIdentityFactKey);
  if (identity?.kind !== "export" || identity.exportName === undefined) {
    return undefined;
  }
  const moduleIdentity = modules.find(
    (candidate) =>
      identity.id === `${candidate.moduleSpecifier}::${identity.exportName}`,
  );
  return resolveConfiguredPrimitive(
    moduleIdentity,
    identity.exportName,
    symbol,
  );
}

function resolveRecordedPrimitiveTypeReference(
  facts: SourceSemanticsFactReader,
  typeReference: Node,
  typeName: GoPtr<Node>,
  modules: readonly SourceSemanticsModuleRuntime[],
): ResolvedSourcePrimitive | undefined {
  if (typeName === undefined) {
    return undefined;
  }
  const subjects = typeName.Kind === KindQualifiedName
    ? [typeReference, typeName, AsQualifiedName(typeName)?.Right]
    : [typeReference, typeName];
  for (const subject of subjects) {
    if (subject === undefined) {
      continue;
    }
    const selection = facts.get(
      subject,
      selectedSourcePrimitiveDeclarationFactKey,
    );
    if (selection === undefined) {
      continue;
    }
    const identity = facts.get(subject, canonicalIdentityFactKey);
    if (identity === undefined) {
      throw new Error(
        `Selected source primitive '${selection.moduleSpecifier}::${selection.exportName}' has no canonical identity.`,
      );
    }
    return resolvePrimitiveSelection(selection, modules, undefined, identity);
  }
  return undefined;
}

function resolvePrimitiveSelection(
  selection: SelectedSourcePrimitiveDeclaration,
  modules: readonly SourceSemanticsModuleRuntime[],
  symbol?: Symbol,
  identity?: ExtensionCanonicalIdentity,
): ResolvedSourcePrimitive {
  const moduleIdentity = modules.find(
    (candidate) => candidate.moduleSpecifier === selection.moduleSpecifier,
  );
  const primitive = moduleIdentity?.primitivesByExportName.get(selection.exportName);
  if (moduleIdentity === undefined || primitive === undefined) {
    throw new Error(
      `Selected source primitive '${selection.moduleSpecifier}::${selection.exportName}' has no configured declaration.`,
    );
  }
  return {
    moduleIdentity,
    exportName: selection.exportName,
    primitiveFact: primitive,
    identity: identity ?? createExportIdentity(
      moduleIdentity,
      selection.exportName,
      "type",
      symbol === undefined
        ? `${selection.moduleSpecifier}::${selection.exportName}`
        : getSymbolFactId(symbol),
    ),
  };
}

function resolveConfiguredPrimitive(
  moduleIdentity: SourceSemanticsModuleRuntime | undefined,
  exportName: string,
  symbol: Symbol,
): ResolvedSourcePrimitive | undefined {
  const primitiveFact = moduleIdentity?.primitivesByExportName.get(exportName);
  if (moduleIdentity === undefined || primitiveFact === undefined) {
    return undefined;
  }
  return {
    moduleIdentity,
    exportName,
    primitiveFact,
    identity: createExportIdentity(
      moduleIdentity,
      exportName,
      "type",
      getSymbolFactId(symbol),
    ),
  };
}

function createSourcePrimitiveSelection(
  moduleIdentity: SourceSemanticsModuleIdentity,
  exportName: string,
): SelectedSourcePrimitiveDeclaration {
  return {
    moduleSpecifier: moduleIdentity.moduleSpecifier,
    exportName,
  };
}

function getStaticSourceSemanticsNameText(node: GoPtr<Node>): string | undefined {
  switch (node?.Kind) {
    case KindIdentifier:
    case KindStringLiteral:
    case KindNumericLiteral:
      return Node_Text(node);
    default:
      return undefined;
  }
}

function visitSourceSemanticsNode(node: GoPtr<Node>, visit: (node: GoPtr<Node>) => void): void {
  if (node === undefined) {
    return;
  }
  visit(node);
  Node_ForEachChild(node, (child: GoPtr<Node>) => {
    visitSourceSemanticsNode(child, visit);
    return false as bool;
  });
}

function visitSourceSemanticsNodePost(node: GoPtr<Node>, visit: (node: GoPtr<Node>) => void): void {
  if (node === undefined) {
    return;
  }
  Node_ForEachChild(node, (child: GoPtr<Node>) => {
    visitSourceSemanticsNodePost(child, visit);
    return false as bool;
  });
  visit(node);
}

function definedNodes(subjects: readonly GoPtr<Node>[]): readonly Node[] {
  return subjects.filter((subject): subject is Node => subject !== undefined);
}

function recordNamespaceImportIdentity(
  facts: SourceSemanticsFactAccess,
  namespaceImport: Node,
  moduleIdentity: SourceSemanticsModuleIdentity,
  typedImport: boolean,
): void {
  const namespaceSymbol = Node_Symbol(namespaceImport);
  if (namespaceSymbol === undefined) {
    return;
  }
  facts.set(namespaceImport, canonicalIdentityFactKey, createModuleIdentity(moduleIdentity, "namespace", getSymbolFactId(namespaceSymbol)), createModuleEvidence(moduleIdentity));
  facts.set(namespaceSymbol, canonicalIdentityFactKey, createModuleIdentity(moduleIdentity, typedImport ? "type" : "namespace", getSymbolFactId(namespaceSymbol)), createModuleEvidence(moduleIdentity));
}

function getSourceSemanticsModuleIdentity(node: GoPtr<Node>, modules: readonly SourceSemanticsModuleRuntime[]): SourceSemanticsModuleRuntime | undefined {
  const moduleSpecifier = Node_ModuleSpecifier(node);
  return moduleSpecifier === undefined
    ? undefined
    : modules.find((candidate) => candidate.moduleSpecifier === Node_Text(moduleSpecifier));
}

function recordSourcePrimitiveImport(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  importSpecifier: Node,
  moduleIdentity: SourceSemanticsModuleIdentity,
  exportName: string,
  primitiveFact: SourcePrimitiveDeclaration,
  typedImport: boolean,
): void {
  const localSymbol = Node_Symbol(importSpecifier);
  if (localSymbol === undefined) {
    return;
  }
  const identity = createExportIdentity(moduleIdentity, exportName, typedImport ? "type" : "value", getSymbolFactId(localSymbol));
  const selection = createSourcePrimitiveSelection(moduleIdentity, exportName);
  const evidence = createPrimitiveEvidence(moduleIdentity, exportName);
  facts.set(importSpecifier, selectedSourcePrimitiveDeclarationFactKey, selection, evidence);
  facts.set(importSpecifier, canonicalIdentityFactKey, identity, evidence);
  facts.set(importSpecifier, sourcePrimitiveFactKey, stripExportName(primitiveFact), evidence);
  facts.set(localSymbol, selectedSourcePrimitiveDeclarationFactKey, selection, evidence);
  facts.set(localSymbol, canonicalIdentityFactKey, identity, evidence);
  facts.set(localSymbol, sourcePrimitiveFactKey, stripExportName(primitiveFact), evidence);
  const selectedSymbol = checker.getAliasedSymbol(localSymbol);
  if (selectedSymbol !== undefined && selectedSymbol !== localSymbol) {
    facts.set(selectedSymbol, selectedSourcePrimitiveDeclarationFactKey, selection, evidence);
  }
}

function recordSourceSemanticsSymbolImport(
  facts: SourceSemanticsFactAccess,
  importSpecifier: Node,
  moduleIdentity: SourceSemanticsModuleIdentity,
  exportName: string,
  importKind: ExtensionImportKind,
): void {
  const localSymbol = Node_Symbol(importSpecifier);
  if (localSymbol === undefined) {
    return;
  }
  const identity = createExportIdentity(moduleIdentity, exportName, importKind, getSymbolFactId(localSymbol));
  facts.set(importSpecifier, canonicalIdentityFactKey, identity, createModuleEvidence(moduleIdentity));
  facts.set(localSymbol, canonicalIdentityFactKey, identity, createModuleEvidence(moduleIdentity));
}

function recordSourceSemanticsMarkerImport(
  facts: SourceSemanticsFactAccess,
  checker: TypeCheckerQueries,
  importSpecifier: Node,
  moduleIdentity: SourceSemanticsModuleIdentity,
  exportName: string,
  importKind: ExtensionImportKind,
  marker: SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration,
): void {
  recordSourceSemanticsSymbolImport(
    facts,
    importSpecifier,
    moduleIdentity,
    exportName,
    importKind,
  );
  const localSymbol = Node_Symbol(importSpecifier);
  if (localSymbol === undefined) {
    return;
  }
  const fact: SourceMarkerFact = marker.kind === "call-marker"
    ? { kind: marker.kind, marker: marker.marker }
    : { kind: marker.kind, marker: marker.marker };
  const evidence = createMarkerEvidence(exportName);
  facts.set(importSpecifier, selectedSourceMarkerDeclarationFactKey, marker, evidence);
  facts.set(importSpecifier, sourceMarkerFactKey, fact, evidence);
  facts.set(localSymbol, selectedSourceMarkerDeclarationFactKey, marker, evidence);
  facts.set(localSymbol, sourceMarkerFactKey, fact, evidence);
  const selectedSymbol = checker.getAliasedSymbol(localSymbol);
  if (selectedSymbol !== undefined && selectedSymbol !== localSymbol) {
    facts.set(selectedSymbol, selectedSourceMarkerDeclarationFactKey, marker, evidence);
    facts.set(selectedSymbol, sourceMarkerFactKey, fact, evidence);
  }
}

function createModuleIdentity(moduleIdentity: SourceSemanticsModuleIdentity, importKind: ExtensionImportKind, canonicalSymbolId: string): ExtensionCanonicalIdentity {
  return {
    kind: "module",
    id: moduleIdentity.moduleSpecifier,
    ...(moduleIdentity.packageName !== undefined ? { packageName: moduleIdentity.packageName } : {}),
    ...(moduleIdentity.packageVersion !== undefined ? { packageVersion: moduleIdentity.packageVersion } : {}),
    subpath: moduleIdentity.subpath ?? moduleIdentity.moduleSpecifier,
    importKind,
    canonicalSymbolId,
  };
}

function createExportIdentity(moduleIdentity: SourceSemanticsModuleIdentity, exportName: string, importKind: ExtensionImportKind, canonicalSymbolId: string): ExtensionCanonicalIdentity {
  return {
    kind: "export",
    id: `${moduleIdentity.moduleSpecifier}::${exportName}`,
    ...(moduleIdentity.packageName !== undefined ? { packageName: moduleIdentity.packageName } : {}),
    ...(moduleIdentity.packageVersion !== undefined ? { packageVersion: moduleIdentity.packageVersion } : {}),
    subpath: moduleIdentity.subpath ?? moduleIdentity.moduleSpecifier,
    exportName,
    importKind,
    canonicalSymbolId,
  };
}

function createPrimitiveEvidence(moduleIdentity: SourceSemanticsModuleIdentity, exportName: string): readonly ExtensionEvidence[] {
  return [{
    message: "source primitive import",
    details: {
      moduleSpecifier: moduleIdentity.moduleSpecifier,
      exportName,
    },
  }];
}

function createModuleEvidence(moduleIdentity: SourceSemanticsModuleIdentity): readonly ExtensionEvidence[] {
  return [{
    message: "source semantics module import",
    details: {
      moduleSpecifier: moduleIdentity.moduleSpecifier,
    },
  }];
}

function createMarkerEvidence(exportName: string): readonly ExtensionEvidence[] {
  return [{
    message: "source semantics marker",
    details: { exportName },
  }];
}

function getTypeReferenceNameText(node: GoPtr<Node>): string {
  if (node?.Kind === KindTypeReference) {
    return getTypeReferenceNameText(AsTypeReferenceNode(node)?.TypeName);
  }
  if (node?.Kind === KindQualifiedName) {
    const qualifiedName = AsQualifiedName(node);
    const left = getTypeReferenceNameText(qualifiedName?.Left);
    const right = getTypeReferenceNameText(qualifiedName?.Right);
    return left === "" ? right : `${left}.${right}`;
  }
  return Node_Text(node);
}

function getModuleMarker(moduleIdentity: SourceSemanticsModuleRuntime | undefined, capability: SourceSemanticsModuleCapability, exportName: string): SourceCallMarkerDeclaration | SourceTypeMarkerDeclaration | undefined {
  if (moduleIdentity === undefined) {
    return undefined;
  }
  switch (capability) {
    case "call-marker":
      return moduleIdentity.callMarkersByExportName.get(exportName);
    case "type-marker":
      return moduleIdentity.typeMarkersByExportName.get(exportName);
    case "primitive":
      return undefined;
  }
}

function stripExportName(declaration: SourcePrimitiveDeclaration): SourcePrimitiveFact {
  return {
    kind: declaration.primitive,
    runtimeBase: declaration.runtimeBase,
    ...(declaration.signed !== undefined ? { signed: declaration.signed } : {}),
    ...(declaration.width !== undefined ? { width: declaration.width } : {}),
  };
}

export function sourcePrimitive(
  exportName: string,
  primitiveKind: SourcePrimitiveKind,
  runtimeBase: SourcePrimitiveFact["runtimeBase"],
  signed?: boolean,
  width?: number,
): SourcePrimitiveDeclaration {
  return {
    kind: "source-primitive",
    exportName,
    primitive: primitiveKind,
    runtimeBase,
    ...(signed !== undefined ? { signed } : {}),
    ...(width !== undefined ? { width } : {}),
  };
}

function getSymbolFactId(symbol: Symbol): string {
  return `${symbol.Name}:${String(GetSymbolId(symbol))}`;
}
