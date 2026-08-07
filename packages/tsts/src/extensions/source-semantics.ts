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
  Node_Parameters,
  Node_PropertyName,
  Node_Properties,
  Node_Statements,
  Node_Symbol,
  Node_Text,
  Node_TypeArguments,
  Node_TypeParameters,
} from "../internal/ast/ast.js";
import { Node_ForEachChild, Node_Name } from "../internal/ast/spine.js";
import { AsExportDeclaration, AsExportSpecifier, AsImportClause, AsNamespaceImport, AsPropertyAccessExpression, AsQualifiedName, AsTypeReferenceNode } from "../internal/ast/generated/casts.js";
import {
  KindArrayBindingPattern,
  KindCallExpression,
  KindExportDeclaration,
  KindIdentifier,
  KindImportDeclaration,
  KindNamedImports,
  KindNamedExports,
  KindNamespaceImport,
  KindNumericLiteral,
  KindObjectLiteralExpression,
  KindObjectBindingPattern,
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
import { GetSymbolId, IsFunctionLike, IsLeftHandSideExpression } from "../internal/ast/utilities.js";
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
  providerVirtualDeclarationFactKey,
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
  SourcePrimitiveFact,
  SourcePrimitiveKind,
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

export type SourceCallMarkerKind =
  | "write-only-reference"
  | "read-write-reference"
  | "read-only-reference"
  | "shared-borrow"
  | "mutable-borrow"
  | "move"
  | "struct"
  | "field"
  | "attribute"
  | "default-value"
  | "address-of"
  | "allocate"
  | "load"
  | "store";

type ArgumentPassingMarkerKind = Extract<
  SourceCallMarkerKind,
  "write-only-reference" | "read-write-reference" | "read-only-reference"
>;

export interface SourceCallMarkerDeclaration {
  readonly kind: "call-marker";
  readonly exportName: string;
  readonly marker: SourceCallMarkerKind;
}

export type SourceTypeMarkerKind = "pointer" | "function-pointer";

export interface SourceTypeMarkerDeclaration {
  readonly kind: "type-marker";
  readonly exportName: string;
  readonly marker: SourceTypeMarkerKind;
}

interface SourceSemanticsMarkerImportIndex {
  readonly primitivesByLocalName: ReadonlyMap<string, SourcePrimitiveImportBinding>;
  readonly typeMarkersByLocalName: ReadonlyMap<string, SourceMarkerImportBinding<SourceTypeMarkerDeclaration>>;
  readonly namespacesByLocalName: ReadonlyMap<string, SourceNamespaceImportBinding>;
}

interface SourcePrimitiveImportBinding {
  readonly moduleIdentity: SourceSemanticsModuleRuntime;
  readonly localName: string;
  readonly exportName: string;
  readonly primitiveFact: SourcePrimitiveDeclaration;
}

interface SourceMarkerImportBinding<TMarker> {
  readonly localName: string;
  readonly marker: TMarker;
}

interface SourceNamespaceImportBinding {
  readonly localName: string;
  readonly moduleIdentity: SourceSemanticsModuleRuntime;
}

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
      for (const sourceFile of context.source.getSourceFiles()) {
        if (sourceFile === undefined) {
          continue;
        }
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

function recordSourceSemanticsFacts(
  sourceFile: GoPtr<SourceFile>,
  checker: TypeCheckerQueries,
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  if (sourceFile === undefined) {
    return;
  }

  for (const statement of Node_Statements(sourceFile) ?? []) {
    if (statement?.Kind === KindImportDeclaration) {
      const moduleIdentity = getSourceSemanticsModuleIdentity(statement, modules);
      if (moduleIdentity !== undefined) {
        recordSourceSemanticsImportClause(facts, statement, moduleIdentity);
      }
      continue;
    }
    if (statement?.Kind === KindExportDeclaration) {
      const moduleIdentity = getSourceSemanticsModuleIdentity(statement, modules);
      if (moduleIdentity !== undefined) {
        recordSourceSemanticsExportClause(facts, statement, moduleIdentity);
      }
    }
  }
  const markerImportIndex = createSourceSemanticsMarkerImportIndex(sourceFile, modules);
  recordSourceSemanticsCallMarkers(facts, diagnostics, extensionId, sourceFile, checker, modules);
  recordSourceSemanticsTypeReferences(facts, sourceFile, modules, markerImportIndex);
}

function recordSourceSemanticsImportClause(
  facts: SourceSemanticsFactAccess,
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
      recordSourcePrimitiveImport(facts, importSpecifier, moduleIdentity, exportName, primitiveFact, typedImport);
      continue;
    }
    if (moduleIdentity.callMarkersByExportName.has(exportName)) {
      recordSourceSemanticsSymbolImport(facts, importSpecifier, moduleIdentity, exportName, typedImport ? "type" : "value");
      continue;
    }
    if (moduleIdentity.typeMarkersByExportName.has(exportName)) {
      recordSourceSemanticsSymbolImport(facts, importSpecifier, moduleIdentity, exportName, typedImport ? "type" : "value");
    }
  }
}

function recordSourceSemanticsExportClause(
  facts: SourceSemanticsFactAccess,
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
      recordSourcePrimitiveImport(facts, exportSpecifier, moduleIdentity, sourceName, primitiveFact, declarationIsTypeOnly || specifierIsTypeOnly);
      continue;
    }
    const specifierIsTypeOnly = AsExportSpecifier(exportSpecifier)!.IsTypeOnly;
    if (moduleIdentity.callMarkersByExportName.has(sourceName)) {
      recordSourceSemanticsSymbolImport(facts, exportSpecifier, moduleIdentity, sourceName, declarationIsTypeOnly || specifierIsTypeOnly ? "type" : "value");
      continue;
    }
    if (moduleIdentity.typeMarkersByExportName.has(sourceName)) {
      recordSourceSemanticsSymbolImport(facts, exportSpecifier, moduleIdentity, sourceName, declarationIsTypeOnly || specifierIsTypeOnly ? "type" : "value");
    }
  }
}

function recordSourceSemanticsCallMarkers(
  facts: SourceSemanticsFactAccess,
  diagnostics: ExtensionDiagnosticWriter,
  extensionId: string,
  sourceFile: GoPtr<SourceFile>,
  checker: TypeCheckerQueries,
  modules: readonly SourceSemanticsModuleRuntime[],
): void {
  visitSourceSemanticsNodePost(sourceFile, (node) => {
    if (node?.Kind !== KindCallExpression) {
      return;
    }
    const callInfo = checker.getResolvedCallInfo(node);
    const marker = resolveSelectedSourceSemanticsCallMarker(facts, callInfo, modules);
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
  const pointeeType = selectedTypeArguments.length === 1
    ? selectedTypeArguments[0]?.selectedType
    : undefined;
  if (pointeeType === undefined) {
    diagnostics.append({
      extensionId,
      extensionCode: "SOURCE_SEMANTICS_POINTER_TYPE_EVIDENCE_MISSING",
      numericCode: 9901103,
      publicCode: "TSTS_SOURCE_SEMANTICS_0003",
      category: "error",
      message: `${marker.exportName}(...) requires one exact selected pointee type.`,
      nodeOrSpan: callExpression,
      evidence,
      identity: `source-semantics-pointer-type:${marker.exportName}:${String(callExpression.id)}`,
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
          identity: `source-semantics-writable-storage:${marker.exportName}:${String(callExpression.id)}`,
        });
        return;
      }
      const fact = {
        operation: "address-of",
        call: callExpression,
        pointeeType,
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
        resultType: callInfo.sourceResultType,
        pointerExpression: pointer.expression,
        pointerType: pointer.type,
        valueExpression: value.expression,
        valueType: value.type,
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
    identity: `source-semantics-non-storage:${marker.exportName}:${String(target?.id ?? "unknown")}`,
  });
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
  const primitive = resolvePrimitiveTypeReference(context.facts, typeName, modules);
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
  modules: readonly SourceSemanticsModuleRuntime[],
  markerImportIndex: SourceSemanticsMarkerImportIndex,
): void {
  visitSourceSemanticsNode(sourceFile, (node) => {
    if (node?.Kind !== KindTypeReference) {
      return;
    }
    const typeName = AsTypeReferenceNode(node)!.TypeName;
    if (typeName === undefined) {
      return;
    }
    const marker = resolveSourceSemanticsTypeMarkerReference(facts, typeName, modules, markerImportIndex);
    if (marker !== undefined) {
      recordSourceSemanticsTypeMarker(facts, node, typeName, marker);
    }
    const primitive = resolvePrimitiveTypeReference(facts, typeName, modules, markerImportIndex);
    if (primitive === undefined) {
      return;
    }
    const evidence = createPrimitiveEvidence(primitive.moduleIdentity, primitive.exportName);
    facts.set(node, canonicalIdentityFactKey, primitive.identity, evidence);
    facts.set(node, sourcePrimitiveFactKey, stripExportName(primitive.primitiveFact), evidence);
    facts.set(typeName, canonicalIdentityFactKey, primitive.identity, evidence);
    facts.set(typeName, sourcePrimitiveFactKey, stripExportName(primitive.primitiveFact), evidence);
    if (typeName.Kind === KindQualifiedName) {
      const right = AsQualifiedName(typeName)!.Right;
      if (right === undefined) {
        return;
      }
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
  modules: readonly SourceSemanticsModuleRuntime[],
): SourceCallMarkerDeclaration | undefined {
  if (callInfo === undefined) {
    return undefined;
  }
  const callee = callInfo.sourceCallee;
  for (const subject of [
    callee.selectedDeclaration,
    callee.selectedSymbol,
    callee.declaration,
    callee.symbol,
  ]) {
    const marker = resolveCallMarkerFromSelectedSubject(facts, subject, modules);
    if (marker !== undefined) {
      return marker;
    }
  }
  const access = callInfo.sourceCalleeAccess;
  if (access === undefined) {
    return undefined;
  }
  const receiverIdentity = access.receiver.symbol === undefined
    ? undefined
    : facts.get(access.receiver.symbol, canonicalIdentityFactKey);
  if (receiverIdentity?.kind === "module" && access.selectedSymbol !== undefined) {
    return getModuleCallMarker(
      modules,
      receiverIdentity.id,
      access.selectedSymbol.Name,
    );
  }
  return undefined;
}

function resolveCallMarkerFromSelectedSubject(
  facts: SourceSemanticsFactAccess,
  subject: ExtensionFactSubject | undefined,
  modules: readonly SourceSemanticsModuleRuntime[],
): SourceCallMarkerDeclaration | undefined {
  if (subject === undefined) {
    return undefined;
  }
  const providerDeclaration = facts.get(subject, providerVirtualDeclarationFactKey);
  if (providerDeclaration?.exportName !== undefined) {
    return getModuleCallMarker(
      modules,
      providerDeclaration.moduleSpecifier,
      providerDeclaration.exportName,
    );
  }
  const identity = facts.get(subject, canonicalIdentityFactKey);
  if (identity?.kind === "export" && identity.exportName !== undefined) {
    const module = modules.find(
      (candidate) => identity.id === `${candidate.moduleSpecifier}::${identity.exportName}`,
    );
    return module?.callMarkersByExportName.get(identity.exportName);
  }
  if ("Parent" in subject && "Name" in subject) {
    const symbol = subject as Symbol;
    const parentIdentity = symbol.Parent === undefined
      ? undefined
      : facts.get(symbol.Parent, canonicalIdentityFactKey);
    if (parentIdentity?.kind === "module") {
      return getModuleCallMarker(modules, parentIdentity.id, symbol.Name);
    }
  }
  return undefined;
}

function getModuleCallMarker(
  modules: readonly SourceSemanticsModuleRuntime[],
  moduleSpecifier: string,
  exportName: string,
): SourceCallMarkerDeclaration | undefined {
  return modules.find((candidate) => candidate.moduleSpecifier === moduleSpecifier)
    ?.callMarkersByExportName.get(exportName);
}

function resolveSourceSemanticsTypeMarkerReference(
  facts: SourceSemanticsFactAccess,
  node: GoPtr<Node>,
  modules: readonly SourceSemanticsModuleRuntime[],
  markerImportIndex: SourceSemanticsMarkerImportIndex,
): SourceTypeMarkerDeclaration | undefined {
  return resolveSourceSemanticsMarkerFromImportIndex(node, markerImportIndex.typeMarkersByLocalName, markerImportIndex.namespacesByLocalName, "type-marker")
    ?? resolveSourceSemanticsMarkerReference(facts, node, modules, "type-marker");
}

function resolveSourceSemanticsMarkerFromImportIndex<TMarker extends { readonly exportName: string }>(
  node: GoPtr<Node>,
  markersByLocalName: ReadonlyMap<string, SourceMarkerImportBinding<TMarker>>,
  namespacesByLocalName: ReadonlyMap<string, SourceNamespaceImportBinding>,
  capability: SourceSemanticsModuleCapability,
): TMarker | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.Kind === KindPropertyAccessExpression) {
    const receiver = AsPropertyAccessExpression(node)?.Expression;
    const receiverName = getIdentifierText(receiver);
    if (receiverName === undefined) {
      return undefined;
    }
    const namespaceBinding = namespacesByLocalName.get(receiverName);
    if (namespaceBinding === undefined || isImportBindingShadowed(receiver, receiverName)) {
      return undefined;
    }
    const propertyName = getStaticSourceSemanticsNameText(Node_Name(node));
    if (propertyName === undefined) {
      return undefined;
    }
    const marker = getModuleMarker(namespaceBinding.moduleIdentity, capability, propertyName);
    return marker as TMarker | undefined;
  }
  if (node.Kind === KindQualifiedName) {
    const qualifiedName = AsQualifiedName(node);
    const leftName = getIdentifierText(qualifiedName?.Left);
    if (leftName === undefined) {
      return undefined;
    }
    const namespaceBinding = namespacesByLocalName.get(leftName);
    if (namespaceBinding === undefined || isImportBindingShadowed(qualifiedName?.Left, leftName)) {
      return undefined;
    }
    const exportName = getIdentifierText(qualifiedName?.Right);
    if (exportName === undefined) {
      return undefined;
    }
    const marker = getModuleMarker(namespaceBinding.moduleIdentity, capability, exportName);
    return marker as TMarker | undefined;
  }
  const localName = getIdentifierText(node);
  if (localName === undefined) {
    return undefined;
  }
  const binding = markersByLocalName.get(localName);
  return binding !== undefined && !isImportBindingShadowed(node, localName) ? binding.marker : undefined;
}

function resolveSourceSemanticsMarkerReference<TMarker extends { readonly exportName: string }>(
  facts: SourceSemanticsFactAccess,
  node: GoPtr<Node>,
  modules: readonly SourceSemanticsModuleRuntime[],
  capability: SourceSemanticsModuleCapability,
): TMarker | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.Kind === KindPropertyAccessExpression) {
    const propertyName = Node_Text(Node_Name(node));
    const receiverSymbol = Node_Symbol(AsPropertyAccessExpression(node)?.Expression);
    const receiverIdentity = receiverSymbol === undefined ? undefined : facts.get(receiverSymbol, canonicalIdentityFactKey);
    if (receiverIdentity?.kind !== "module") {
      return undefined;
    }
    const module = modules.find((candidate) => candidate.moduleSpecifier === receiverIdentity.id);
    return getModuleMarker(module, capability, propertyName) as TMarker | undefined;
  }
  if (node.Kind === KindQualifiedName) {
    const qualifiedName = AsQualifiedName(node);
    const exportName = Node_Text(qualifiedName?.Right);
    const leftSymbol = Node_Symbol(qualifiedName?.Left);
    const leftIdentity = leftSymbol === undefined ? undefined : facts.get(leftSymbol, canonicalIdentityFactKey);
    if (leftIdentity?.kind !== "module") {
      return undefined;
    }
    const module = modules.find((candidate) => candidate.moduleSpecifier === leftIdentity.id);
    return getModuleMarker(module, capability, exportName) as TMarker | undefined;
  }
  const symbol = Node_Symbol(node);
  const identity = symbol === undefined ? undefined : facts.get(symbol, canonicalIdentityFactKey);
  if (identity?.exportName === undefined) {
    return undefined;
  }
  const module = modules.find((candidate) => identity.id === `${candidate.moduleSpecifier}::${identity.exportName}`);
  return getModuleMarker(module, capability, identity.exportName) as TMarker | undefined;
}

function createSourceSemanticsMarkerImportIndex(
  sourceFile: GoPtr<SourceFile>,
  modules: readonly SourceSemanticsModuleRuntime[],
): SourceSemanticsMarkerImportIndex {
  const primitivesByLocalName = new Map<string, SourcePrimitiveImportBinding>();
  const typeMarkersByLocalName = new Map<string, SourceMarkerImportBinding<SourceTypeMarkerDeclaration>>();
  const namespacesByLocalName = new Map<string, SourceNamespaceImportBinding>();
  for (const statement of Node_Statements(sourceFile) ?? []) {
    if (statement?.Kind !== KindImportDeclaration) {
      continue;
    }
    const moduleIdentity = getSourceSemanticsModuleIdentity(statement, modules);
    if (moduleIdentity === undefined) {
      continue;
    }
    const namedBindings = AsImportClause(Node_ImportClause(statement))?.NamedBindings;
    if (namedBindings === undefined) {
      continue;
    }
    if (namedBindings.Kind === KindNamespaceImport) {
      const namespaceNameNode = Node_Name(namedBindings);
      const namespaceName = Node_Text(namespaceNameNode);
      if (namespaceName !== "") {
        namespacesByLocalName.set(namespaceName, {
          localName: namespaceName,
          moduleIdentity,
        });
      }
      continue;
    }
    if (namedBindings.Kind !== KindNamedImports) {
      continue;
    }
    for (const importSpecifier of Node_Elements(namedBindings) ?? []) {
      const localNameNode = Node_Name(importSpecifier);
      const localName = Node_Text(localNameNode);
      const exportName = Node_Text(Node_PropertyName(importSpecifier) ?? localNameNode);
      const primitive = moduleIdentity.primitivesByExportName.get(exportName);
      if (primitive !== undefined) {
        primitivesByLocalName.set(localName, {
          moduleIdentity,
          localName,
          exportName,
          primitiveFact: primitive,
        });
      }
      const typeMarker = moduleIdentity.typeMarkersByExportName.get(exportName);
      if (typeMarker !== undefined) {
        typeMarkersByLocalName.set(localName, {
          localName,
          marker: typeMarker,
        });
      }
    }
  }
  return { primitivesByLocalName, typeMarkersByLocalName, namespacesByLocalName };
}

function resolvePrimitiveTypeReference(
  facts: SourceSemanticsFactReader,
  typeName: GoPtr<Node>,
  modules: readonly SourceSemanticsModuleRuntime[],
  importIndex?: SourceSemanticsMarkerImportIndex,
): { readonly moduleIdentity: SourceSemanticsModuleRuntime; readonly exportName: string; readonly primitiveFact: SourcePrimitiveDeclaration; readonly identity: ExtensionCanonicalIdentity } | undefined {
  if (typeName === undefined) {
    return undefined;
  }
  if (typeName.Kind === KindQualifiedName) {
    return resolveQualifiedPrimitiveFromImportIndex(typeName, importIndex)
      ?? resolveQualifiedPrimitiveReference(facts, typeName, modules);
  }

  const indexedPrimitive = resolvePrimitiveFromImportIndex(typeName, importIndex);
  if (indexedPrimitive !== undefined) {
    return indexedPrimitive;
  }

  const typeNameSymbol = Node_Symbol(typeName);
  if (typeNameSymbol === undefined) {
    return undefined;
  }
  const primitiveFact = facts.get(typeNameSymbol, sourcePrimitiveFactKey);
  const identity = facts.get(typeNameSymbol, canonicalIdentityFactKey);
  if (primitiveFact === undefined || identity === undefined || identity.exportName === undefined) {
    return undefined;
  }
  const moduleIdentity = modules.find((candidate) => identity.id === `${candidate.moduleSpecifier}::${identity.exportName}`);
  if (moduleIdentity === undefined) {
    return undefined;
  }
  const declaration = moduleIdentity.primitivesByExportName.get(identity.exportName);
  if (declaration === undefined) {
    return undefined;
  }
  return { moduleIdentity, exportName: identity.exportName, primitiveFact: declaration, identity };
}

function resolvePrimitiveFromImportIndex(
  typeName: GoPtr<Node>,
  importIndex: SourceSemanticsMarkerImportIndex | undefined,
): { readonly moduleIdentity: SourceSemanticsModuleRuntime; readonly exportName: string; readonly primitiveFact: SourcePrimitiveDeclaration; readonly identity: ExtensionCanonicalIdentity } | undefined {
  if (typeName === undefined || importIndex === undefined) {
    return undefined;
  }
  const binding = importIndex.primitivesByLocalName.get(Node_Text(typeName));
  if (binding === undefined || isImportBindingShadowed(typeName, binding.localName)) {
    return undefined;
  }
  const symbol = Node_Symbol(typeName);
  return {
    ...binding,
    identity: createExportIdentity(binding.moduleIdentity, binding.exportName, "type", symbol === undefined ? `${binding.moduleIdentity.moduleSpecifier}::${binding.exportName}` : getSymbolFactId(symbol)),
  };
}

function resolveQualifiedPrimitiveFromImportIndex(
  typeName: GoPtr<Node>,
  importIndex: SourceSemanticsMarkerImportIndex | undefined,
): { readonly moduleIdentity: SourceSemanticsModuleRuntime; readonly exportName: string; readonly primitiveFact: SourcePrimitiveDeclaration; readonly identity: ExtensionCanonicalIdentity } | undefined {
  if (typeName === undefined || importIndex === undefined) {
    return undefined;
  }
  const qualifiedName = AsQualifiedName(typeName);
  const leftName = Node_Text(qualifiedName?.Left);
  const namespaceBinding = importIndex.namespacesByLocalName.get(leftName);
  if (namespaceBinding === undefined || isImportBindingShadowed(qualifiedName?.Left, leftName)) {
    return undefined;
  }
  const right = qualifiedName!.Right;
  const exportName = Node_Text(right);
  const primitiveFact = namespaceBinding.moduleIdentity.primitivesByExportName.get(exportName);
  if (primitiveFact === undefined) {
    return undefined;
  }
  const symbol = Node_Symbol(right);
  return {
    moduleIdentity: namespaceBinding.moduleIdentity,
    exportName,
    primitiveFact,
    identity: createExportIdentity(namespaceBinding.moduleIdentity, exportName, "type", symbol === undefined ? `${namespaceBinding.moduleIdentity.moduleSpecifier}::${exportName}` : getSymbolFactId(symbol)),
  };
}

function isImportBindingShadowed(node: GoPtr<Node>, localName: string): boolean {
  if (node === undefined || localName === "") {
    return false;
  }
  let current = node.Parent;
  while (current !== undefined) {
    if (IsFunctionLike(current)) {
      if (declarationListContainsName(Node_Parameters(current), localName) || declarationListContainsName(Node_TypeParameters(current) ?? [], localName)) {
        return true;
      }
    }
    current = current.Parent;
  }
  return false;
}

function declarationListContainsName(declarations: readonly GoPtr<Node>[], localName: string): boolean {
  return declarations.some((declaration) =>
    bindingNameContainsName(Node_Name(declaration), localName));
}

function bindingNameContainsName(name: GoPtr<Node>, localName: string): boolean {
  if (name === undefined) {
    return false;
  }
  if (name.Kind === KindIdentifier) {
    return Node_Text(name) === localName;
  }
  if (name.Kind !== KindArrayBindingPattern && name.Kind !== KindObjectBindingPattern) {
    return false;
  }
  return (Node_Elements(name) ?? []).some((element) =>
    bindingNameContainsName(Node_Name(element), localName));
}

function getIdentifierText(node: GoPtr<Node>): string | undefined {
  return node?.Kind === KindIdentifier ? Node_Text(node) : undefined;
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

function resolveQualifiedPrimitiveReference(
  facts: SourceSemanticsFactReader,
  typeName: GoPtr<Node>,
  modules: readonly SourceSemanticsModuleRuntime[],
): { readonly moduleIdentity: SourceSemanticsModuleRuntime; readonly exportName: string; readonly primitiveFact: SourcePrimitiveDeclaration; readonly identity: ExtensionCanonicalIdentity } | undefined {
  const qualifiedName = AsQualifiedName(typeName);
  const leftSymbol = Node_Symbol(qualifiedName?.Left);
  if (leftSymbol === undefined) {
    return undefined;
  }
  const moduleIdentityFact = facts.get(leftSymbol, canonicalIdentityFactKey);
  if (moduleIdentityFact?.kind !== "module") {
    return undefined;
  }
  const moduleIdentity = modules.find((candidate) => candidate.moduleSpecifier === moduleIdentityFact.id);
  if (moduleIdentity === undefined) {
    return undefined;
  }
  const right = qualifiedName!.Right;
  const exportName = Node_Text(right);
  const primitiveFact = moduleIdentity.primitivesByExportName.get(exportName);
  if (primitiveFact === undefined) {
    return undefined;
  }
  const rightSymbol = Node_Symbol(right);
  const identity = createExportIdentity(moduleIdentity, exportName, "type", rightSymbol === undefined ? `${moduleIdentity.moduleSpecifier}::${exportName}` : getSymbolFactId(rightSymbol));
  return { moduleIdentity, exportName, primitiveFact, identity };
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
  const evidence = createPrimitiveEvidence(moduleIdentity, exportName);
  facts.set(importSpecifier, canonicalIdentityFactKey, identity, evidence);
  facts.set(importSpecifier, sourcePrimitiveFactKey, stripExportName(primitiveFact), evidence);
  facts.set(localSymbol, canonicalIdentityFactKey, identity, evidence);
  facts.set(localSymbol, sourcePrimitiveFactKey, stripExportName(primitiveFact), evidence);
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
