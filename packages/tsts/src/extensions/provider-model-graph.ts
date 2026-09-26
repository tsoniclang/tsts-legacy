import type {
  ExtensionEvidence,
  ProviderDeclarationModel,
  ProviderExportDeclaration,
  ProviderHeritageDeclaration,
  ProviderImportDeclaration,
  ProviderMemberDeclaration,
  ProviderParameterDeclaration,
  ProviderPropertyName,
  ProviderRequestedExport,
  ProviderSignatureDeclaration,
  ProviderTypeFamilyDeclaration,
  ProviderTypeExpression,
  ProviderTypeParameterDeclaration,
} from "./host.js";
import { isArgumentPassingMode } from "./argument-passing.js";
import {
  snapshotProviderEvidenceArray,
} from "./provider-boundary-data.js";
import { providerDeclarationModelLimits } from "./provider-resource-limits.js";

const providerModelReadFailure = Symbol("provider-model-read-failure");

type ProviderModelGraphNodeKind =
  | "model"
  | "import"
  | "requested-export"
  | "export"
  | "heritage"
  | "member"
  | "signature"
  | "parameter"
  | "type-parameter"
  | "type";

interface ProviderModelGraphFrame {
  readonly kind: ProviderModelGraphNodeKind;
  readonly value: unknown;
  readonly depth: number;
  readonly path: string;
  readonly exit?: true;
  readonly arrayExit?: true;
  readonly complexityArray?: true;
}

export interface ProviderDeclarationModelGraphMetrics {
  readonly physicalNodeAndArrayEntryCount: number;
  readonly physicalScalarCodeUnitCount: number;
  readonly expandedSemanticNodeAndArrayEntryCount: number;
  readonly expandedSemanticScalarCodeUnitCount: number;
}

export type ProviderDeclarationModelGraphValidation =
  | {
    readonly kind: "valid";
    readonly model: ProviderDeclarationModel;
    readonly metrics: ProviderDeclarationModelGraphMetrics;
  }
  | {
    readonly kind: "invalid";
    readonly reason: "shape" | "cycle" | "depth" | "complexity";
    readonly path: string;
    readonly firstPath?: string;
    readonly depth: number;
    readonly limit?: number;
  };

type InvalidProviderDeclarationModelGraphValidation = Extract<
  ProviderDeclarationModelGraphValidation,
  { readonly kind: "invalid" }
>;

type ProviderModelContractRecord =
  | ProviderDeclarationModel
  | ProviderImportDeclaration
  | ProviderRequestedExport
  | ProviderExportDeclaration
  | ProviderHeritageDeclaration
  | ProviderMemberDeclaration
  | ProviderSignatureDeclaration
  | ProviderParameterDeclaration
  | ProviderTypeParameterDeclaration
  | ProviderTypeFamilyDeclaration
  | Exclude<ProviderPropertyName, string>
  | ProviderTypeExpression;

type KeysOfProviderModelContract<T> = T extends unknown ? keyof T : never;
type ProviderModelFieldName = Extract<KeysOfProviderModelContract<ProviderModelContractRecord>, string>;

const providerModelFieldNameRecord = {
  moduleSpecifier: true,
  providerModuleId: true,
  imports: true,
  exports: true,
  evidence: true,
  defaultImport: true,
  namespaceImport: true,
  typeOnly: true,
  namedImports: true,
  exportedName: true,
  localName: true,
  kind: true,
  id: true,
  intrinsicId: true,
  name: true,
  exportName: true,
  exportKind: true,
  sourceTypeFamily: true,
  documentation: true,
  type: true,
  typeParameters: true,
  heritage: true,
  members: true,
  signatures: true,
  typeArgumentCount: true,
  static: true,
  readonly: true,
  optional: true,
  parameters: true,
  returnType: true,
  passingMode: true,
  rest: true,
  defaultType: true,
  variance: true,
  constraints: true,
  value: true,
  typeArguments: true,
  elementType: true,
  elementTypes: true,
  types: true,
  text: true,
} as const satisfies Record<ProviderModelFieldName, true>;

const providerModelFieldNames = new Set<ProviderModelFieldName>(
  Object.keys(providerModelFieldNameRecord) as ProviderModelFieldName[],
);

function providerModelFields(...fields: readonly ProviderModelFieldName[]): ReadonlySet<ProviderModelFieldName> {
  return new Set(fields);
}

const providerModelShapeFields = {
  model: providerModelFields("moduleSpecifier", "providerModuleId", "imports", "exports", "evidence"),
  import: providerModelFields("moduleSpecifier", "defaultImport", "namespaceImport", "typeOnly", "namedImports"),
  requestedExport: providerModelFields("exportedName", "localName", "kind"),
  export: providerModelFields(
    "id", "intrinsicId", "name", "kind", "exportName", "exportKind", "sourceTypeFamily",
    "documentation", "type", "typeParameters", "heritage", "members", "signatures",
  ),
  heritage: providerModelFields("kind", "type"),
  member: providerModelFields("id", "kind", "name", "static", "readonly", "optional", "documentation", "type", "signatures"),
  signature: providerModelFields("id", "name", "documentation", "parameters", "returnType", "typeParameters"),
  parameter: providerModelFields("name", "passingMode", "optional", "rest", "type", "defaultType"),
  typeParameter: providerModelFields("name", "variance", "constraints", "defaultType"),
  typeFamily: providerModelFields("exportName", "typeArgumentCount"),
  propertyIdentifier: providerModelFields("kind", "text"),
  propertyNumber: providerModelFields("kind", "value"),
  propertySymbol: providerModelFields("kind", "name"),
  anyProperty: providerModelFields("kind", "text", "value", "name"),
  scalarType: providerModelFields("kind"),
  literalType: providerModelFields("kind", "value"),
  namedType: providerModelFields("kind", "name"),
  sourceGlobalType: providerModelFields("kind", "name", "typeArguments"),
  arrayType: providerModelFields("kind", "elementType"),
  tupleType: providerModelFields("kind", "elementTypes"),
  compositeType: providerModelFields("kind", "types"),
  functionType: providerModelFields("kind", "id", "parameters", "returnType", "typeParameters"),
  providerRefType: providerModelFields("kind", "moduleSpecifier", "exportName", "localName", "namespaceImport", "typeArguments"),
  anyType: providerModelFields(
    "kind", "value", "name", "typeArguments", "id",
    "elementType", "elementTypes", "types", "parameters", "returnType", "typeParameters",
    "moduleSpecifier", "exportName", "localName", "namespaceImport",
  ),
} as const;

interface ProviderModelReadContext {
  readonly fields: WeakMap<object, Map<ProviderModelFieldName, unknown>>;
  readonly fieldNames: WeakMap<object, readonly ProviderModelFieldName[]>;
  readonly chargedScalarFields: WeakMap<object, Set<ProviderModelFieldName>>;
  readonly arrays: WeakMap<object, readonly unknown[]>;
  readonly arrayTraversal: WeakMap<object, Map<ProviderModelGraphNodeKind, ProviderModelArrayTraversalState>>;
  readonly physicalNodes: WeakSet<object>;
  readonly semanticScalarUsage: WeakMap<object, Map<ProviderModelGraphNodeKind, ProviderModelSemanticScalarUsage>>;
  evidenceCaptured: boolean;
  evidenceSnapshot: readonly ExtensionEvidence[] | undefined;
  physicalNodeAndArrayEntryCount: number;
  totalScalarCodeUnitCount: number;
  traversalMode: "physical" | "complexity";
  currentSemanticNode: object | undefined;
  currentSemanticNodeKind: ProviderModelGraphNodeKind | undefined;
  currentPath: string;
  currentDepth: number;
  failure: InvalidProviderDeclarationModelGraphValidation | undefined;
}

interface ProviderModelSemanticScalarUsage {
  readonly fieldsByRecord: WeakMap<object, Set<ProviderModelFieldName>>;
  totalCodeUnits: number;
}

interface ProviderModelArrayTraversalState {
  activePath: string | undefined;
  complete: boolean;
}

interface ProviderModelSnapshotContext {
  readonly reads: ProviderModelReadContext;
  readonly nodes: WeakMap<object, Map<ProviderModelGraphNodeKind, unknown>>;
  readonly arrays: WeakMap<object, Map<ProviderModelGraphNodeKind, readonly unknown[]>>;
  readonly propertyNames: WeakMap<object, ProviderPropertyName>;
  readonly typeFamilies: WeakMap<object, ProviderTypeFamilyDeclaration>;
}

interface ProviderCanonicalizationContext {
  readonly types: WeakMap<object, ProviderTypeExpression>;
  readonly moduleSpecifier: string | undefined;
  readonly sourceFamilyExportNameByLocalReferenceKey: ReadonlyMap<string, string>;
}

export function validateProviderDeclarationModelGraph(value: unknown): ProviderDeclarationModelGraphValidation {
  const reads: ProviderModelReadContext = {
    fields: new WeakMap(),
    fieldNames: new WeakMap(),
    chargedScalarFields: new WeakMap(),
    arrays: new WeakMap(),
    arrayTraversal: new WeakMap(),
    physicalNodes: new WeakSet(),
    semanticScalarUsage: new WeakMap(),
    evidenceCaptured: false,
    evidenceSnapshot: undefined,
    physicalNodeAndArrayEntryCount: 0,
    totalScalarCodeUnitCount: 0,
    traversalMode: "physical",
    currentSemanticNode: undefined,
    currentSemanticNodeKind: undefined,
    currentPath: "$",
    currentDepth: 1,
    failure: undefined,
  };
  const active = new WeakMap<object, string>();
  const complete = new WeakMap<object, Set<ProviderModelGraphNodeKind>>();
  const stack: ProviderModelGraphFrame[] = [{ kind: "model", value, depth: 1, path: "$" }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.arrayExit === true) {
      completeProviderModelArrayTraversal(reads, frame);
      continue;
    }
    if (!isProviderModelRecord(frame.value)) {
      return { kind: "invalid", reason: "shape", path: frame.path, depth: frame.depth };
    }
    if (frame.exit === true) {
      active.delete(frame.value);
      const completedKinds = complete.get(frame.value) ?? new Set();
      completedKinds.add(frame.kind);
      complete.set(frame.value, completedKinds);
      continue;
    }
    const firstPath = active.get(frame.value);
    if (firstPath !== undefined) {
      return { kind: "invalid", reason: "cycle", path: frame.path, firstPath, depth: frame.depth };
    }
    if (frame.depth > providerDeclarationModelLimits.maxNestingDepth) {
      return {
        kind: "invalid",
        reason: "depth",
        path: frame.path,
        depth: frame.depth,
        limit: providerDeclarationModelLimits.maxNestingDepth,
      };
    }
    if (complete.get(frame.value)?.has(frame.kind) === true) {
      continue;
    }
    if (!reserveProviderModelPhysicalNode(reads, frame.value, frame.path, frame.depth)) {
      return reads.failure!;
    }
    active.set(frame.value, frame.path);
    stack.push({ ...frame, exit: true });
    reads.currentPath = frame.path;
    reads.currentDepth = frame.depth;
    reads.currentSemanticNode = frame.value;
    reads.currentSemanticNodeKind = frame.kind;
    const pushed = pushProviderModelGraphChildren(reads, stack, frame);
    reads.currentSemanticNode = undefined;
    reads.currentSemanticNodeKind = undefined;
    if (!pushed) {
      return reads.failure ?? { kind: "invalid", reason: "shape", path: frame.path, depth: frame.depth };
    }
  }

  const root: ProviderModelGraphFrame = { kind: "model", value, depth: 1, path: "$" };
  const complexityValidation = validateProviderModelGraphComplexity(reads, root);
  if (complexityValidation.kind === "invalid") {
    return complexityValidation;
  }

  const snapshotContext: ProviderModelSnapshotContext = {
    reads,
    nodes: new WeakMap(),
    arrays: new WeakMap(),
    propertyNames: new WeakMap(),
    typeFamilies: new WeakMap(),
  };
  const model = snapshotProviderDeclarationModel(snapshotContext, value as ProviderDeclarationModel);
  const metrics: ProviderDeclarationModelGraphMetrics = Object.freeze({
    physicalNodeAndArrayEntryCount: reads.physicalNodeAndArrayEntryCount,
    physicalScalarCodeUnitCount: reads.totalScalarCodeUnitCount,
    expandedSemanticNodeAndArrayEntryCount: complexityValidation.expandedSemanticNodeAndArrayEntryCount,
    expandedSemanticScalarCodeUnitCount: complexityValidation.expandedSemanticScalarCodeUnitCount,
  });
  return {
    kind: "valid",
    model,
    metrics,
  };
}

export function canonicalizeProviderAbiModel(model: ProviderDeclarationModel): ProviderDeclarationModel {
  const context = createProviderCanonicalizationContext(model);
  return {
    moduleSpecifier: model.moduleSpecifier,
    providerModuleId: model.providerModuleId,
    exports: model.exports
      .map((declaration) => canonicalizeProviderAbiExportDeclarationWithContext(context, declaration))
      .sort(compareCanonicalProviderExports),
  };
}

function createProviderCanonicalizationContext(model?: ProviderDeclarationModel): ProviderCanonicalizationContext {
  const sourceFamilyExportNameByLocalReferenceKey = new Map<string, string>();
  const conflictingLocalReferenceKeys = new Set<string>();
  if (model !== undefined) {
    for (const declaration of model.exports) {
      const family = declaration.sourceTypeFamily;
      if (family === undefined) {
        continue;
      }
      const localNames = new Set([declaration.name, declaration.exportName].filter((name): name is string => name !== undefined));
      for (const localName of localNames) {
        const key = getProviderCanonicalFamilyReferenceKey(localName, family.typeArgumentCount);
        if (conflictingLocalReferenceKeys.has(key)) {
          continue;
        }
        const existing = sourceFamilyExportNameByLocalReferenceKey.get(key);
        if (existing === undefined || existing === family.exportName) {
          sourceFamilyExportNameByLocalReferenceKey.set(key, family.exportName);
        } else {
          sourceFamilyExportNameByLocalReferenceKey.delete(key);
          conflictingLocalReferenceKeys.add(key);
        }
      }
    }
  }
  return {
    types: new WeakMap(),
    moduleSpecifier: model?.moduleSpecifier,
    sourceFamilyExportNameByLocalReferenceKey,
  };
}

function getProviderCanonicalFamilyReferenceKey(exportName: string, typeArgumentCount: number): string {
  return `${exportName}\0${typeArgumentCount}`;
}

function compareCanonicalProviderExports(left: ProviderExportDeclaration, right: ProviderExportDeclaration): number {
  const leftSourceName = left.sourceTypeFamily?.exportName
    ?? (left.exportKind === "default" ? "default" : left.exportName ?? left.name);
  const rightSourceName = right.sourceTypeFamily?.exportName
    ?? (right.exportKind === "default" ? "default" : right.exportName ?? right.name);
  if (leftSourceName !== rightSourceName) {
    return leftSourceName < rightSourceName ? -1 : 1;
  }
  const leftArity = left.sourceTypeFamily?.typeArgumentCount ?? -1;
  const rightArity = right.sourceTypeFamily?.typeArgumentCount ?? -1;
  if (leftArity !== rightArity) {
    return leftArity - rightArity;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function pushProviderModelGraphChildren(
  reads: ProviderModelReadContext,
  stack: ProviderModelGraphFrame[],
  frame: ProviderModelGraphFrame,
): boolean {
  const nextDepth = frame.depth + 1;
  switch (frame.kind) {
    case "model": {
      const model = frame.value as ProviderDeclarationModel;
      if (!captureExactProviderModelRecord(reads, model, providerModelShapeFields.model, frame.path, frame.depth)) {
        return false;
      }
      const moduleSpecifier = readProviderModelField(reads, model, "moduleSpecifier");
      const providerModuleId = readProviderModelField(reads, model, "providerModuleId");
      const imports = readProviderModelField(reads, model, "imports");
      const exports = readProviderModelField(reads, model, "exports");
      const evidence = readProviderModelField(reads, model, "evidence");
      return typeof moduleSpecifier === "string"
        && typeof providerModuleId === "string"
        && pushProviderModelArray(reads, stack, imports, "import", nextDepth, true, frame.path + ".imports")
        && pushProviderModelArray(reads, stack, exports, "export", nextDepth, false, frame.path + ".exports")
        && snapshotProviderModelEvidence(reads, evidence, frame.path + ".evidence", nextDepth);
    }
    case "import": {
      const declaration = frame.value as ProviderImportDeclaration;
      if (!captureExactProviderModelRecord(reads, declaration, providerModelShapeFields.import, frame.path, frame.depth)) {
        return false;
      }
      const moduleSpecifier = readProviderModelField(reads, declaration, "moduleSpecifier");
      const defaultImport = readProviderModelField(reads, declaration, "defaultImport");
      const namespaceImport = readProviderModelField(reads, declaration, "namespaceImport");
      const typeOnly = readProviderModelField(reads, declaration, "typeOnly");
      const namedImports = readProviderModelField(reads, declaration, "namedImports");
      return typeof moduleSpecifier === "string"
        && isOptionalString(defaultImport)
        && isOptionalString(namespaceImport)
        && isOptionalBoolean(typeOnly)
        && pushProviderModelArray(reads, stack, namedImports, "requested-export", nextDepth, true, frame.path + ".namedImports");
    }
    case "requested-export": {
      const request = frame.value as ProviderRequestedExport;
      if (!captureExactProviderModelRecord(reads, request, providerModelShapeFields.requestedExport, frame.path, frame.depth)) {
        return false;
      }
      const exportedName = readProviderModelField(reads, request, "exportedName");
      const localName = readProviderModelField(reads, request, "localName");
      const requestKind = readProviderModelField(reads, request, "kind");
      return typeof exportedName === "string"
        && isOptionalString(localName)
        && (requestKind === undefined || requestKind === "type" || requestKind === "value" || requestKind === "unknown");
    }
    case "export": {
      const declaration = frame.value as ProviderExportDeclaration;
      if (!captureExactProviderModelRecord(reads, declaration, providerModelShapeFields.export, frame.path, frame.depth)) {
        return false;
      }
      const id = readProviderModelField(reads, declaration, "id");
      const intrinsicId = readProviderModelField(reads, declaration, "intrinsicId");
      const name = readProviderModelField(reads, declaration, "name");
      const declarationKind = readProviderModelField(reads, declaration, "kind");
      const exportName = readProviderModelField(reads, declaration, "exportName");
      const exportKind = readProviderModelField(reads, declaration, "exportKind");
      const sourceTypeFamily = readProviderModelField(reads, declaration, "sourceTypeFamily");
      const documentation = readProviderModelField(reads, declaration, "documentation");
      const type = readProviderModelField(reads, declaration, "type");
      const typeParameters = readProviderModelField(reads, declaration, "typeParameters");
      const heritage = readProviderModelField(reads, declaration, "heritage");
      const members = readProviderModelField(reads, declaration, "members");
      const signatures = readProviderModelField(reads, declaration, "signatures");
      return typeof id === "string"
        && isOptionalString(intrinsicId)
        && typeof name === "string"
        && isProviderDeclarationKind(declarationKind)
        && isOptionalString(exportName)
        && (exportKind === undefined || exportKind === "named" || exportKind === "default")
        && isValidProviderTypeFamilyShape(
          reads,
          sourceTypeFamily,
          frame.path + ".sourceTypeFamily",
          nextDepth,
        )
        && isOptionalString(documentation)
        && pushOptionalProviderModelNode(stack, type, "type", nextDepth, true, frame.path + ".type")
        && pushProviderModelArray(reads, stack, typeParameters, "type-parameter", nextDepth, true, frame.path + ".typeParameters")
        && pushProviderModelArray(reads, stack, heritage, "heritage", nextDepth, true, frame.path + ".heritage")
        && pushProviderModelArray(reads, stack, members, "member", nextDepth, true, frame.path + ".members")
        && pushProviderModelArray(reads, stack, signatures, "signature", nextDepth, true, frame.path + ".signatures");
    }
    case "heritage": {
      const heritage = frame.value as ProviderHeritageDeclaration;
      if (!captureExactProviderModelRecord(reads, heritage, providerModelShapeFields.heritage, frame.path, frame.depth)) {
        return false;
      }
      const heritageKind = readProviderModelField(reads, heritage, "kind");
      const type = readProviderModelField(reads, heritage, "type");
      return (heritageKind === "extends" || heritageKind === "implements")
        && pushOptionalProviderModelNode(stack, type, "type", nextDepth, false, frame.path + ".type");
    }
    case "member": {
      const member = frame.value as ProviderMemberDeclaration;
      if (!captureExactProviderModelRecord(reads, member, providerModelShapeFields.member, frame.path, frame.depth)) {
        return false;
      }
      const id = readProviderModelField(reads, member, "id");
      const memberKind = readProviderModelField(reads, member, "kind");
      const name = readProviderModelField(reads, member, "name");
      const staticMember = readProviderModelField(reads, member, "static");
      const readonlyMember = readProviderModelField(reads, member, "readonly");
      const optionalMember = readProviderModelField(reads, member, "optional");
      const documentation = readProviderModelField(reads, member, "documentation");
      const type = readProviderModelField(reads, member, "type");
      const signatures = readProviderModelField(reads, member, "signatures");
      return typeof id === "string"
        && isProviderMemberKind(memberKind)
        && isValidProviderPropertyNameShape(reads, name, frame.path + ".name", nextDepth)
        && isOptionalBoolean(staticMember)
        && isOptionalBoolean(readonlyMember)
        && isOptionalBoolean(optionalMember)
        && isOptionalString(documentation)
        && pushOptionalProviderModelNode(stack, type, "type", nextDepth, true, frame.path + ".type")
        && pushProviderModelArray(reads, stack, signatures, "signature", nextDepth, true, frame.path + ".signatures");
    }
    case "signature": {
      const signature = frame.value as ProviderSignatureDeclaration;
      if (!captureExactProviderModelRecord(reads, signature, providerModelShapeFields.signature, frame.path, frame.depth)) {
        return false;
      }
      const id = readProviderModelField(reads, signature, "id");
      const name = readProviderModelField(reads, signature, "name");
      const documentation = readProviderModelField(reads, signature, "documentation");
      const parameters = readProviderModelField(reads, signature, "parameters");
      const returnType = readProviderModelField(reads, signature, "returnType");
      const typeParameters = readProviderModelField(reads, signature, "typeParameters");
      return typeof id === "string"
        && isOptionalString(name)
        && isOptionalString(documentation)
        && pushProviderModelArray(reads, stack, parameters, "parameter", nextDepth, false, frame.path + ".parameters")
        && pushOptionalProviderModelNode(stack, returnType, "type", nextDepth, true, frame.path + ".returnType")
        && pushProviderModelArray(reads, stack, typeParameters, "type-parameter", nextDepth, true, frame.path + ".typeParameters");
    }
    case "parameter": {
      const parameter = frame.value as ProviderParameterDeclaration;
      if (!captureExactProviderModelRecord(reads, parameter, providerModelShapeFields.parameter, frame.path, frame.depth)) {
        return false;
      }
      const name = readProviderModelField(reads, parameter, "name");
      const passingMode = readProviderModelField(reads, parameter, "passingMode");
      const optionalParameter = readProviderModelField(reads, parameter, "optional");
      const rest = readProviderModelField(reads, parameter, "rest");
      const type = readProviderModelField(reads, parameter, "type");
      const defaultType = readProviderModelField(reads, parameter, "defaultType");
      return typeof name === "string"
        && (passingMode === undefined || isArgumentPassingMode(passingMode))
        && isOptionalBoolean(optionalParameter)
        && isOptionalBoolean(rest)
        && pushOptionalProviderModelNode(stack, type, "type", nextDepth, false, frame.path + ".type")
        && pushOptionalProviderModelNode(stack, defaultType, "type", nextDepth, true, frame.path + ".defaultType");
    }
    case "type-parameter": {
      const parameter = frame.value as ProviderTypeParameterDeclaration;
      if (!captureExactProviderModelRecord(reads, parameter, providerModelShapeFields.typeParameter, frame.path, frame.depth)) {
        return false;
      }
      const name = readProviderModelField(reads, parameter, "name");
      const variance = readProviderModelField(reads, parameter, "variance");
      const constraints = readProviderModelField(reads, parameter, "constraints");
      const defaultType = readProviderModelField(reads, parameter, "defaultType");
      return typeof name === "string"
        && (variance === undefined
          || variance === "in"
          || variance === "out"
          || variance === "invariant")
        && pushProviderModelArray(reads, stack, constraints, "type", nextDepth, true, frame.path + ".constraints")
        && pushOptionalProviderModelNode(stack, defaultType, "type", nextDepth, true, frame.path + ".defaultType");
    }
    case "type":
      return pushProviderTypeExpressionChildren(reads, stack, frame.value as ProviderTypeExpression, nextDepth, frame.path);
  }
}

function pushProviderTypeExpressionChildren(
  reads: ProviderModelReadContext,
  stack: ProviderModelGraphFrame[],
  type: ProviderTypeExpression,
  depth: number,
  path: string,
): boolean {
  if (!captureExactProviderModelRecord(reads, type, providerModelShapeFields.anyType, path, depth)) {
    return false;
  }
  const typeKind = readProviderModelField(reads, type, "kind");
  if (typeof typeKind !== "string") {
    return false;
  }
  switch (typeKind) {
    case "any":
    case "unknown":
    case "void":
    case "never":
    case "undefined":
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "object":
      return captureExactProviderModelRecord(reads, type, providerModelShapeFields.scalarType, path, depth);
    case "literal": {
      const literal = type as Extract<ProviderTypeExpression, { readonly kind: "literal" }>;
      if (!captureExactProviderModelRecord(reads, literal, providerModelShapeFields.literalType, path, depth)) {
        return false;
      }
      const value = readProviderModelField(reads, literal, "value");
      return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number";
    }
    case "bigint-literal": {
      const literal = type as Extract<ProviderTypeExpression, { readonly kind: "bigint-literal" }>;
      if (!captureExactProviderModelRecord(reads, literal, providerModelShapeFields.literalType, path, depth)) {
        return false;
      }
      const value = readProviderModelField(reads, literal, "value");
      return typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(value);
    }
    case "source-primitive":
    case "type-parameter": {
      const named = type as Extract<ProviderTypeExpression, { readonly kind: "source-primitive" | "type-parameter" }>;
      if (!captureExactProviderModelRecord(reads, named, providerModelShapeFields.namedType, path, depth)) {
        return false;
      }
      return typeof readProviderModelField(reads, named, "name") === "string";
    }
    case "source-global": {
      const reference = type as Extract<ProviderTypeExpression, { readonly kind: "source-global" }>;
      if (!captureExactProviderModelRecord(reads, reference, providerModelShapeFields.sourceGlobalType, path, depth)) {
        return false;
      }
      const name = readProviderModelField(reads, reference, "name");
      const typeArguments = readProviderModelField(reads, reference, "typeArguments");
      return typeof name === "string"
        && pushProviderModelArray(reads, stack, typeArguments, "type", depth, true, path + ".typeArguments");
    }
    case "array": {
      const arrayType = type as Extract<ProviderTypeExpression, { readonly kind: "array" }>;
      if (!captureExactProviderModelRecord(reads, arrayType, providerModelShapeFields.arrayType, path, depth)) {
        return false;
      }
      return pushOptionalProviderModelNode(
        stack,
        readProviderModelField(reads, arrayType, "elementType"),
        "type",
        depth,
        false,
        path + ".elementType",
      );
    }
    case "tuple": {
      const tuple = type as Extract<ProviderTypeExpression, { readonly kind: "tuple" }>;
      if (!captureExactProviderModelRecord(reads, tuple, providerModelShapeFields.tupleType, path, depth)) {
        return false;
      }
      return pushProviderModelArray(
        reads,
        stack,
        readProviderModelField(reads, tuple, "elementTypes"),
        "type",
        depth,
        false,
        path + ".elementTypes",
      );
    }
    case "union":
    case "intersection": {
      const composite = type as Extract<ProviderTypeExpression, { readonly kind: "union" | "intersection" }>;
      if (!captureExactProviderModelRecord(reads, composite, providerModelShapeFields.compositeType, path, depth)) {
        return false;
      }
      return pushProviderModelArray(
        reads,
        stack,
        readProviderModelField(reads, composite, "types"),
        "type",
        depth,
        false,
        path + ".types",
      );
    }
    case "function": {
      const functionType = type as Extract<ProviderTypeExpression, { readonly kind: "function" }>;
      if (!captureExactProviderModelRecord(reads, functionType, providerModelShapeFields.functionType, path, depth)) {
        return false;
      }
      const id = readProviderModelField(reads, functionType, "id");
      const parameters = readProviderModelField(reads, functionType, "parameters");
      const returnType = readProviderModelField(reads, functionType, "returnType");
      const typeParameters = readProviderModelField(reads, functionType, "typeParameters");
      return typeof id === "string"
        && pushProviderModelArray(reads, stack, parameters, "parameter", depth, false, path + ".parameters")
        && pushOptionalProviderModelNode(stack, returnType, "type", depth, false, path + ".returnType")
        && pushProviderModelArray(reads, stack, typeParameters, "type-parameter", depth, true, path + ".typeParameters");
    }
    case "provider-ref": {
      const reference = type as Extract<ProviderTypeExpression, { readonly kind: "provider-ref" }>;
      if (!captureExactProviderModelRecord(reads, reference, providerModelShapeFields.providerRefType, path, depth)) {
        return false;
      }
      const moduleSpecifier = readProviderModelField(reads, reference, "moduleSpecifier");
      const exportName = readProviderModelField(reads, reference, "exportName");
      const localName = readProviderModelField(reads, reference, "localName");
      const namespaceImport = readProviderModelField(reads, reference, "namespaceImport");
      const typeArguments = readProviderModelField(reads, reference, "typeArguments");
      return typeof moduleSpecifier === "string"
        && typeof exportName === "string"
        && isOptionalString(localName)
        && isOptionalString(namespaceImport)
        && pushProviderModelArray(reads, stack, typeArguments, "type", depth, true, path + ".typeArguments");
    }
    default:
      return false;
  }
}

function pushProviderModelArray(
  reads: ProviderModelReadContext,
  stack: ProviderModelGraphFrame[],
  values: unknown,
  kind: ProviderModelGraphNodeKind,
  depth: number,
  optional: boolean,
  path: string,
): boolean {
  if (values === undefined) {
    return optional;
  }
  if (typeof values !== "object" || values === null) {
    return false;
  }
  const cached = reads.arrays.get(values);
  if (cached !== undefined) {
    return scheduleCapturedProviderModelArray(reads, stack, values, cached, kind, depth, path);
  }
  const classification = classifyProviderModelArray(values);
  if (classification !== "array") {
    if (classification === "invalid") {
      setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    }
    return false;
  }
  const captured = captureProviderModelArrayValues(reads, values as readonly unknown[], path, depth);
  if (captured === undefined) {
    return false;
  }
  return scheduleCapturedProviderModelArray(reads, stack, values, captured, kind, depth, path);
}

function scheduleCapturedProviderModelArray(
  reads: ProviderModelReadContext,
  stack: ProviderModelGraphFrame[],
  source: object,
  captured: readonly unknown[],
  kind: ProviderModelGraphNodeKind,
  depth: number,
  path: string,
): boolean {
  if (reads.traversalMode === "complexity") {
    stack.push({ kind, value: source, depth, path, complexityArray: true });
    return true;
  }
  let statesByKind = reads.arrayTraversal.get(source);
  if (statesByKind === undefined) {
    statesByKind = new Map();
    reads.arrayTraversal.set(source, statesByKind);
  }
  let state = statesByKind.get(kind);
  if (state === undefined) {
    state = { activePath: path, complete: false };
    statesByKind.set(kind, state);
  } else if (state.complete) {
    return true;
  } else if (state.activePath !== undefined) {
    setProviderModelReadFailure(reads, {
      kind: "invalid",
      reason: "cycle",
      path,
      firstPath: state.activePath,
      depth,
    });
    return false;
  } else {
    state.activePath = path;
  }
  stack.push({ kind, value: source, depth, path, arrayExit: true });
  for (let index = captured.length - 1; index >= 0; index--) {
    stack.push({ kind, value: captured[index], depth, path: path + "[" + index + "]" });
  }
  return true;
}

function completeProviderModelArrayTraversal(
  reads: ProviderModelReadContext,
  frame: ProviderModelGraphFrame,
): void {
  const state = reads.arrayTraversal.get(frame.value as object)?.get(frame.kind);
  if (state === undefined || state.activePath === undefined || state.complete) {
    throw new Error("Provider model array traversal invariant failed.");
  }
  state.activePath = undefined;
  state.complete = true;
}

function captureProviderModelArrayValues(
  reads: ProviderModelReadContext,
  values: readonly unknown[],
  path: string,
  depth: number,
): readonly unknown[] | undefined {
  const cached = reads.arrays.get(values);
  if (cached !== undefined) {
    return cached;
  }
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(values);
    lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length");
  } catch {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return undefined;
  }
  if (prototype !== Array.prototype
    || lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.writable !== true
    || lengthDescriptor.enumerable !== false
    || lengthDescriptor.configurable !== false) {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return undefined;
  }
  const length = lengthDescriptor.value;
  if (typeof length !== "number" || Number.isNaN(length) || length < 0 || !Number.isInteger(length)) {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return undefined;
  }
  if (!Number.isSafeInteger(length)
    || length > providerDeclarationModelLimits.maxPhysicalNodeAndArrayEntries
    || reads.physicalNodeAndArrayEntryCount
      > providerDeclarationModelLimits.maxPhysicalNodeAndArrayEntries - length) {
    setProviderModelReadFailure(reads, {
      kind: "invalid",
      reason: "complexity",
      path,
      depth,
      limit: providerDeclarationModelLimits.maxPhysicalNodeAndArrayEntries,
    });
    return undefined;
  }
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(values);
  } catch {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return undefined;
  }
  if (ownKeys.length !== length + 1
    || ownKeys.some((key) => typeof key !== "string"
      || key !== "length" && !isExactProviderModelArrayIndex(key, length))) {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return undefined;
  }
  reads.physicalNodeAndArrayEntryCount += length;
  const captured = new Array<unknown>(length);
  try {
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path: `${path}[${index}]`, depth });
        return undefined;
      }
      captured[index] = descriptor.value;
    }
  } catch {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return undefined;
  }
  reads.arrays.set(values, captured);
  return captured;
}

function isExactProviderModelArrayIndex(value: string, length: number): boolean {
  if (value === "0") {
    return length > 0;
  }
  if (value.length === 0 || value.charCodeAt(0) === 48) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function pushOptionalProviderModelNode(
  stack: ProviderModelGraphFrame[],
  value: unknown,
  kind: ProviderModelGraphNodeKind,
  depth: number,
  optional: boolean,
  path: string,
): boolean {
  if (value === undefined) {
    return optional;
  }
  stack.push({ kind, value, depth, path });
  return true;
}

function classifyProviderModelArray(value: object): "array" | "not-array" | "invalid" {
  try {
    return Array.isArray(value) ? "array" : "not-array";
  } catch {
    return "invalid";
  }
}

function isProviderModelRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && classifyProviderModelArray(value) === "not-array";
}

function captureExactProviderModelRecord(
  reads: ProviderModelReadContext,
  value: unknown,
  allowedFields: ReadonlySet<ProviderModelFieldName>,
  path: string,
  depth: number,
): value is Record<string, unknown> {
  if (!isProviderModelRecord(value)) {
    setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
    return false;
  }
  let fields = reads.fields.get(value);
  let fieldNames = reads.fieldNames.get(value);
  if (fields === undefined || fieldNames === undefined) {
    let prototype: object | null;
    let ownKeys: readonly PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(value);
      ownKeys = Reflect.ownKeys(value);
    } catch {
      setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
      return false;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
      return false;
    }
    fields = new Map();
    const names: ProviderModelFieldName[] = [];
    try {
      for (const key of ownKeys) {
        if (typeof key !== "string" || !providerModelFieldNames.has(key as ProviderModelFieldName)) {
          setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
          return false;
        }
        const fieldName = key as ProviderModelFieldName;
        const descriptor = Object.getOwnPropertyDescriptor(value, fieldName);
        if (descriptor === undefined || descriptor.enumerable !== true) {
          setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path: `${path}.${fieldName}`, depth: depth + 1 });
          return false;
        }
        let fieldValue: unknown;
        if ("value" in descriptor) {
          fieldValue = descriptor.value;
        } else if (typeof descriptor.get === "function") {
          fieldValue = Reflect.apply(descriptor.get, value, []);
        } else {
          setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path: `${path}.${fieldName}`, depth: depth + 1 });
          return false;
        }
        names.push(fieldName);
        fields.set(fieldName, fieldValue);
      }
    } catch {
      setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path, depth });
      return false;
    }
    fieldNames = names;
    reads.fields.set(value, fields);
    reads.fieldNames.set(value, fieldNames);
  }
  for (const fieldName of fieldNames) {
    if (!allowedFields.has(fieldName)) {
      setProviderModelReadFailure(reads, { kind: "invalid", reason: "shape", path: `${path}.${fieldName}`, depth: depth + 1 });
      return false;
    }
  }
  return true;
}

function reserveProviderModelPhysicalNode(
  reads: ProviderModelReadContext,
  value: object,
  path: string,
  depth: number,
): boolean {
  if (reads.physicalNodes.has(value)) {
    return true;
  }
  if (!reserveProviderModelPhysicalEntries(reads, 1, path, depth)) {
    return false;
  }
  reads.physicalNodes.add(value);
  return true;
}

function reserveProviderModelPhysicalEntries(
  reads: ProviderModelReadContext,
  count: number,
  path: string,
  depth: number,
): boolean {
  if (!Number.isSafeInteger(count)
    || count < 0
    || count > providerDeclarationModelLimits.maxPhysicalNodeAndArrayEntries - reads.physicalNodeAndArrayEntryCount) {
    setProviderModelReadFailure(reads, {
      kind: "invalid",
      reason: "complexity",
      path,
      depth,
      limit: providerDeclarationModelLimits.maxPhysicalNodeAndArrayEntries,
    });
    return false;
  }
  reads.physicalNodeAndArrayEntryCount += count;
  return true;
}

function reserveProviderModelScalarCodeUnits(
  reads: ProviderModelReadContext,
  count: number,
  path: string,
  depth: number,
  aggregateOnly = false,
): boolean {
  const limit = aggregateOnly || count <= providerDeclarationModelLimits.maxStringCodeUnits
    ? providerDeclarationModelLimits.maxPhysicalScalarCodeUnits
    : providerDeclarationModelLimits.maxStringCodeUnits;
  if (!Number.isSafeInteger(count)
    || count < 0
    || (!aggregateOnly && count > providerDeclarationModelLimits.maxStringCodeUnits)
    || count > providerDeclarationModelLimits.maxPhysicalScalarCodeUnits - reads.totalScalarCodeUnitCount) {
    setProviderModelReadFailure(reads, {
      kind: "invalid",
      reason: "complexity",
      path,
      depth,
      limit,
    });
    return false;
  }
  reads.totalScalarCodeUnitCount += count;
  return true;
}

function setProviderModelReadFailure(
  reads: ProviderModelReadContext,
  failure: InvalidProviderDeclarationModelGraphValidation,
): void {
  if (reads.failure === undefined) {
    reads.failure = failure;
  }
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isValidProviderPropertyNameShape(
  reads: ProviderModelReadContext,
  value: unknown,
  path: string,
  depth: number,
): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (!isProviderModelRecord(value) || !reserveProviderModelPhysicalNode(reads, value, path, depth)) {
    return false;
  }
  if (!captureExactProviderModelRecord(
    reads,
    value,
    providerModelShapeFields.anyProperty,
    path,
    depth,
  )) {
    return false;
  }
  const propertyKind = readProviderModelField(reads, value, "kind");
  switch (propertyKind) {
    case "identifier":
    case "string-literal":
      return captureExactProviderModelRecord(reads, value, providerModelShapeFields.propertyIdentifier, path, depth)
        && typeof readProviderModelField(reads, value, "text") === "string";
    case "number-literal":
      return captureExactProviderModelRecord(reads, value, providerModelShapeFields.propertyNumber, path, depth)
        && typeof readProviderModelField(reads, value, "value") === "number";
    case "well-known-symbol":
      return captureExactProviderModelRecord(reads, value, providerModelShapeFields.propertySymbol, path, depth)
        && typeof readProviderModelField(reads, value, "name") === "string";
    default:
      return false;
  }
}

function isProviderDeclarationKind(value: unknown): boolean {
  return value === "type"
    || value === "value"
    || value === "namespace"
    || value === "function"
    || value === "class"
    || value === "interface"
    || value === "enum"
    || value === "intrinsic";
}

function isProviderMemberKind(value: unknown): boolean {
  return value === "method"
    || value === "constructor"
    || value === "property"
    || value === "field"
    || value === "indexer";
}

function isValidProviderTypeFamilyShape(
  reads: ProviderModelReadContext,
  value: unknown,
  path: string,
  depth: number,
): boolean {
  if (value === undefined) {
    return true;
  }
  return isProviderModelRecord(value)
    && reserveProviderModelPhysicalNode(reads, value, path, depth)
    && captureExactProviderModelRecord(reads, value, providerModelShapeFields.typeFamily, path, depth)
    && typeof readProviderModelField(reads, value, "exportName") === "string"
    && typeof readProviderModelField(reads, value, "typeArgumentCount") === "number";
}

function readProviderModelField<T extends object, K extends keyof T & ProviderModelFieldName>(
  reads: ProviderModelReadContext,
  record: T,
  fieldName: K,
): T[K] {
  const fields = reads.fields.get(record);
  if (fields === undefined) {
    throw new Error("Provider model field was read before its exact record shape was captured.");
  }
  let value = fields.get(fieldName) as T[K] | typeof providerModelReadFailure;
  let chargedFields = reads.chargedScalarFields.get(record);
  if (chargedFields === undefined) {
    chargedFields = new Set();
    reads.chargedScalarFields.set(record, chargedFields);
  }
  if (!chargedFields.has(fieldName)) {
    chargedFields.add(fieldName);
    if (typeof value === "string" && !reserveProviderModelScalarCodeUnits(
      reads,
      value.length,
      `${reads.currentPath}.${String(fieldName)}`,
      reads.currentDepth + 1,
    )) {
      value = providerModelReadFailure;
      fields.set(fieldName, value);
    }
  }
  if (typeof value === "string") {
    recordProviderModelSemanticScalarField(reads, record, fieldName, value.length);
  }
  return value as T[K];
}

function recordProviderModelSemanticScalarField(
  reads: ProviderModelReadContext,
  record: object,
  fieldName: ProviderModelFieldName,
  codeUnits: number,
): void {
  const semanticNode = reads.currentSemanticNode;
  const semanticNodeKind = reads.currentSemanticNodeKind;
  if (semanticNode === undefined || semanticNodeKind === undefined) {
    return;
  }
  let usageByKind = reads.semanticScalarUsage.get(semanticNode);
  if (usageByKind === undefined) {
    usageByKind = new Map();
    reads.semanticScalarUsage.set(semanticNode, usageByKind);
  }
  let usage = usageByKind.get(semanticNodeKind);
  if (usage === undefined) {
    usage = { fieldsByRecord: new WeakMap(), totalCodeUnits: 0 };
    usageByKind.set(semanticNodeKind, usage);
  }
  let fields = usage.fieldsByRecord.get(record);
  if (fields === undefined) {
    fields = new Set();
    usage.fieldsByRecord.set(record, fields);
  }
  if (!fields.has(fieldName)) {
    fields.add(fieldName);
    usage.totalCodeUnits += codeUnits;
  }
}

function getProviderModelDirectSemanticScalarCodeUnits(
  reads: ProviderModelReadContext,
  frame: ProviderModelGraphFrame,
): number {
  return reads.semanticScalarUsage.get(frame.value as object)?.get(frame.kind)?.totalCodeUnits ?? 0;
}

function snapshotProviderModelEvidence(
  reads: ProviderModelReadContext,
  value: unknown,
  path: string,
  depth: number,
): boolean {
  if (reads.evidenceCaptured) {
    return true;
  }
  const snapshot = snapshotProviderEvidenceArray(value, path);
  if (snapshot.kind === "invalid") {
    setProviderModelReadFailure(reads, {
      kind: "invalid",
      reason: snapshot.reason,
      path: snapshot.path,
      ...(snapshot.firstPath === undefined ? {} : { firstPath: snapshot.firstPath }),
      depth: snapshot.depth ?? depth,
      ...(snapshot.limit === undefined ? {} : { limit: snapshot.limit }),
    });
    return false;
  }
  if (!reserveProviderModelPhysicalEntries(reads, snapshot.physicalNodeAndCollectionEntryCount, path, depth)
    || !reserveProviderModelScalarCodeUnits(reads, snapshot.scalarCodeUnits, path, depth, true)) {
    return false;
  }
  reads.evidenceCaptured = true;
  reads.evidenceSnapshot = snapshot.value;
  return true;
}

function snapshotProviderDeclarationModel(
  context: ProviderModelSnapshotContext,
  model: ProviderDeclarationModel,
): ProviderDeclarationModel {
  const cached = getProviderModelNodeSnapshot<ProviderDeclarationModel>(context, model, "model");
  if (cached !== undefined) {
    return cached;
  }
  const moduleSpecifier = readProviderModelField(context.reads, model, "moduleSpecifier");
  const providerModuleId = readProviderModelField(context.reads, model, "providerModuleId");
  const imports = readProviderModelField(context.reads, model, "imports");
  const exports = readProviderModelField(context.reads, model, "exports");
  const evidence = context.reads.evidenceSnapshot;
  const snapshot: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId,
    ...(imports === undefined
      ? {}
      : {
        imports: snapshotProviderModelArray(
          context,
          imports,
          "import",
          (entry) => snapshotProviderImportDeclaration(context, entry),
        ),
      }),
    exports: snapshotProviderModelArray(
      context,
      exports,
      "export",
      (entry) => snapshotProviderExportDeclaration(context, entry),
    ),
    ...(evidence === undefined ? {} : { evidence }),
  };
  setProviderModelNodeSnapshot(context, model, "model", snapshot);
  return snapshot;
}

function snapshotProviderImportDeclaration(
  context: ProviderModelSnapshotContext,
  declaration: ProviderImportDeclaration,
): ProviderImportDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderImportDeclaration>(context, declaration, "import");
  if (cached !== undefined) {
    return cached;
  }
  const moduleSpecifier = readProviderModelField(context.reads, declaration, "moduleSpecifier");
  const defaultImport = readProviderModelField(context.reads, declaration, "defaultImport");
  const namedImports = readProviderModelField(context.reads, declaration, "namedImports");
  const namespaceImport = readProviderModelField(context.reads, declaration, "namespaceImport");
  const typeOnly = readProviderModelField(context.reads, declaration, "typeOnly");
  const snapshot: ProviderImportDeclaration = {
    moduleSpecifier,
    ...(defaultImport === undefined ? {} : { defaultImport }),
    ...(namedImports === undefined
      ? {}
      : {
        namedImports: snapshotProviderModelArray(
          context,
          namedImports,
          "requested-export",
          (request) => snapshotProviderRequestedExport(context, request),
        ),
      }),
    ...(namespaceImport === undefined ? {} : { namespaceImport }),
    ...(typeOnly === undefined ? {} : { typeOnly }),
  };
  setProviderModelNodeSnapshot(context, declaration, "import", snapshot);
  return snapshot;
}

function snapshotProviderRequestedExport(
  context: ProviderModelSnapshotContext,
  request: ProviderRequestedExport,
): ProviderRequestedExport {
  const cached = getProviderModelNodeSnapshot<ProviderRequestedExport>(context, request, "requested-export");
  if (cached !== undefined) {
    return cached;
  }
  const exportedName = readProviderModelField(context.reads, request, "exportedName");
  const localName = readProviderModelField(context.reads, request, "localName");
  const requestKind = readProviderModelField(context.reads, request, "kind");
  const snapshot: ProviderRequestedExport = {
    exportedName,
    ...(localName === undefined ? {} : { localName }),
    ...(requestKind === undefined ? {} : { kind: requestKind }),
  };
  setProviderModelNodeSnapshot(context, request, "requested-export", snapshot);
  return snapshot;
}

function snapshotProviderExportDeclaration(
  context: ProviderModelSnapshotContext,
  declaration: ProviderExportDeclaration,
): ProviderExportDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderExportDeclaration>(context, declaration, "export");
  if (cached !== undefined) {
    return cached;
  }
  const id = readProviderModelField(context.reads, declaration, "id");
  const intrinsicId = readProviderModelField(context.reads, declaration, "intrinsicId");
  const name = readProviderModelField(context.reads, declaration, "name");
  const exportName = readProviderModelField(context.reads, declaration, "exportName");
  const exportKind = readProviderModelField(context.reads, declaration, "exportKind");
  const sourceTypeFamily = readProviderModelField(context.reads, declaration, "sourceTypeFamily");
  const declarationKind = readProviderModelField(context.reads, declaration, "kind");
  const type = readProviderModelField(context.reads, declaration, "type");
  const typeParameters = readProviderModelField(context.reads, declaration, "typeParameters");
  const heritage = readProviderModelField(context.reads, declaration, "heritage");
  const members = readProviderModelField(context.reads, declaration, "members");
  const signatures = readProviderModelField(context.reads, declaration, "signatures");
  const documentation = readProviderModelField(context.reads, declaration, "documentation");
  const snapshot: ProviderExportDeclaration = {
    id,
    ...(intrinsicId === undefined ? {} : { intrinsicId }),
    name,
    ...(exportName === undefined ? {} : { exportName }),
    ...(exportKind === undefined ? {} : { exportKind }),
    ...(sourceTypeFamily === undefined
      ? {}
      : { sourceTypeFamily: snapshotProviderTypeFamily(context, sourceTypeFamily) }),
    kind: declarationKind,
    ...(type === undefined ? {} : { type: snapshotProviderTypeExpression(context, type) }),
    ...(typeParameters === undefined || isCapturedProviderModelArrayEmpty(context.reads, typeParameters)
      ? {}
      : {
        typeParameters: snapshotProviderModelArray(
          context,
          typeParameters,
          "type-parameter",
          (parameter) => snapshotProviderTypeParameterDeclaration(context, parameter),
        ),
      }),
    ...(heritage === undefined || isCapturedProviderModelArrayEmpty(context.reads, heritage)
      ? {}
      : {
        heritage: snapshotProviderModelArray(
          context,
          heritage,
          "heritage",
          (entry) => snapshotProviderHeritageDeclaration(context, entry),
        ),
      }),
    ...(members === undefined
      ? {}
      : {
        members: snapshotProviderModelArray(
          context,
          members,
          "member",
          (member) => snapshotProviderMemberDeclaration(context, member),
        ),
      }),
    ...(signatures === undefined
      ? {}
      : {
        signatures: snapshotProviderModelArray(
          context,
          signatures,
          "signature",
          (signature) => snapshotProviderSignatureDeclaration(context, signature),
        ),
      }),
    ...(documentation === undefined ? {} : { documentation }),
  };
  setProviderModelNodeSnapshot(context, declaration, "export", snapshot);
  return snapshot;
}

function snapshotProviderHeritageDeclaration(
  context: ProviderModelSnapshotContext,
  heritage: ProviderHeritageDeclaration,
): ProviderHeritageDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderHeritageDeclaration>(context, heritage, "heritage");
  if (cached !== undefined) {
    return cached;
  }
  const heritageKind = readProviderModelField(context.reads, heritage, "kind");
  const type = readProviderModelField(context.reads, heritage, "type");
  const snapshot: ProviderHeritageDeclaration = {
    kind: heritageKind,
    type: snapshotProviderTypeExpression(context, type),
  };
  setProviderModelNodeSnapshot(context, heritage, "heritage", snapshot);
  return snapshot;
}

function snapshotProviderMemberDeclaration(
  context: ProviderModelSnapshotContext,
  member: ProviderMemberDeclaration,
): ProviderMemberDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderMemberDeclaration>(context, member, "member");
  if (cached !== undefined) {
    return cached;
  }
  const id = readProviderModelField(context.reads, member, "id");
  const name = readProviderModelField(context.reads, member, "name");
  const memberKind = readProviderModelField(context.reads, member, "kind");
  const staticMember = readProviderModelField(context.reads, member, "static");
  const readonlyMember = readProviderModelField(context.reads, member, "readonly");
  const optionalMember = readProviderModelField(context.reads, member, "optional");
  const type = readProviderModelField(context.reads, member, "type");
  const signatures = readProviderModelField(context.reads, member, "signatures");
  const documentation = readProviderModelField(context.reads, member, "documentation");
  const snapshot: ProviderMemberDeclaration = {
    id,
    name: snapshotProviderPropertyName(context, name),
    kind: memberKind,
    ...(staticMember === undefined ? {} : { static: staticMember }),
    ...(readonlyMember === undefined ? {} : { readonly: readonlyMember }),
    ...(optionalMember === undefined ? {} : { optional: optionalMember }),
    ...(type === undefined ? {} : { type: snapshotProviderTypeExpression(context, type) }),
    ...(signatures === undefined
      ? {}
      : {
        signatures: snapshotProviderModelArray(
          context,
          signatures,
          "signature",
          (signature) => snapshotProviderSignatureDeclaration(context, signature),
        ),
      }),
    ...(documentation === undefined ? {} : { documentation }),
  };
  setProviderModelNodeSnapshot(context, member, "member", snapshot);
  return snapshot;
}

function snapshotProviderPropertyName(
  context: ProviderModelSnapshotContext,
  name: ProviderMemberDeclaration["name"],
): ProviderMemberDeclaration["name"] {
  if (typeof name === "string") {
    return name;
  }
  const cached = context.propertyNames.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const propertyKind = readProviderModelField(context.reads, name, "kind");
  let snapshot: ProviderPropertyName;
  switch (propertyKind) {
    case "identifier":
    case "string-literal": {
      const textualName = name as Extract<ProviderPropertyName, { readonly kind: "identifier" | "string-literal" }>;
      snapshot = {
        kind: propertyKind,
        text: readProviderModelField(context.reads, textualName, "text"),
      };
      break;
    }
    case "number-literal": {
      const numericName = name as Extract<ProviderPropertyName, { readonly kind: "number-literal" }>;
      snapshot = {
        kind: propertyKind,
        value: readProviderModelField(context.reads, numericName, "value"),
      };
      break;
    }
    case "well-known-symbol": {
      const symbolName = name as Extract<ProviderPropertyName, { readonly kind: "well-known-symbol" }>;
      snapshot = {
        kind: propertyKind,
        name: readProviderModelField(context.reads, symbolName, "name"),
      };
      break;
    }
  }
  const frozenSnapshot = Object.freeze(snapshot);
  context.propertyNames.set(name, frozenSnapshot);
  return frozenSnapshot;
}

function snapshotProviderSignatureDeclaration(
  context: ProviderModelSnapshotContext,
  signature: ProviderSignatureDeclaration,
): ProviderSignatureDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderSignatureDeclaration>(context, signature, "signature");
  if (cached !== undefined) {
    return cached;
  }
  const id = readProviderModelField(context.reads, signature, "id");
  const name = readProviderModelField(context.reads, signature, "name");
  const parameters = readProviderModelField(context.reads, signature, "parameters");
  const returnType = readProviderModelField(context.reads, signature, "returnType");
  const typeParameters = readProviderModelField(context.reads, signature, "typeParameters");
  const documentation = readProviderModelField(context.reads, signature, "documentation");
  const snapshot: ProviderSignatureDeclaration = {
    id,
    ...(name === undefined ? {} : { name }),
    parameters: snapshotProviderModelArray(
      context,
      parameters,
      "parameter",
      (parameter) => snapshotProviderParameterDeclaration(context, parameter),
    ),
    ...(returnType === undefined ? {} : { returnType: snapshotProviderTypeExpression(context, returnType) }),
    ...(typeParameters === undefined
      ? {}
      : {
        typeParameters: snapshotProviderModelArray(
          context,
          typeParameters,
          "type-parameter",
          (parameter) => snapshotProviderTypeParameterDeclaration(context, parameter),
        ),
      }),
    ...(documentation === undefined ? {} : { documentation }),
  };
  setProviderModelNodeSnapshot(context, signature, "signature", snapshot);
  return snapshot;
}

function snapshotProviderParameterDeclaration(
  context: ProviderModelSnapshotContext,
  parameter: ProviderParameterDeclaration,
): ProviderParameterDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderParameterDeclaration>(context, parameter, "parameter");
  if (cached !== undefined) {
    return cached;
  }
  const name = readProviderModelField(context.reads, parameter, "name");
  const type = readProviderModelField(context.reads, parameter, "type");
  const passingMode = readProviderModelField(context.reads, parameter, "passingMode");
  const optionalParameter = readProviderModelField(context.reads, parameter, "optional");
  const rest = readProviderModelField(context.reads, parameter, "rest");
  const defaultType = readProviderModelField(context.reads, parameter, "defaultType");
  const snapshot: ProviderParameterDeclaration = {
    name,
    type: snapshotProviderTypeExpression(context, type),
    ...(passingMode === undefined ? {} : { passingMode }),
    ...(optionalParameter === undefined ? {} : { optional: optionalParameter }),
    ...(rest === undefined ? {} : { rest }),
    ...(defaultType === undefined ? {} : { defaultType: snapshotProviderTypeExpression(context, defaultType) }),
  };
  setProviderModelNodeSnapshot(context, parameter, "parameter", snapshot);
  return snapshot;
}

function snapshotProviderTypeParameterDeclaration(
  context: ProviderModelSnapshotContext,
  parameter: ProviderTypeParameterDeclaration,
): ProviderTypeParameterDeclaration {
  const cached = getProviderModelNodeSnapshot<ProviderTypeParameterDeclaration>(context, parameter, "type-parameter");
  if (cached !== undefined) {
    return cached;
  }
  const name = readProviderModelField(context.reads, parameter, "name");
  const constraints = readProviderModelField(context.reads, parameter, "constraints");
  const defaultType = readProviderModelField(context.reads, parameter, "defaultType");
  const variance = readProviderModelField(context.reads, parameter, "variance");
  const snapshot: ProviderTypeParameterDeclaration = {
    name,
    ...(constraints === undefined
      ? {}
      : {
        constraints: snapshotProviderModelArray(
          context,
          constraints,
          "type",
          (constraint) => snapshotProviderTypeExpression(context, constraint),
        ),
      }),
    ...(defaultType === undefined ? {} : { defaultType: snapshotProviderTypeExpression(context, defaultType) }),
    ...(variance === undefined ? {} : { variance }),
  };
  setProviderModelNodeSnapshot(context, parameter, "type-parameter", snapshot);
  return snapshot;
}

function snapshotProviderTypeExpression(
  context: ProviderModelSnapshotContext,
  type: ProviderTypeExpression,
): ProviderTypeExpression {
  const cached = getProviderModelNodeSnapshot<ProviderTypeExpression>(context, type, "type");
  if (cached !== undefined) {
    return cached;
  }
  const typeKind = readProviderModelField(context.reads, type, "kind");
  let snapshot: ProviderTypeExpression;
  switch (typeKind) {
    case "any":
    case "unknown":
    case "void":
    case "never":
    case "undefined":
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "object":
      snapshot = { kind: typeKind };
      break;
    case "source-primitive": {
      const sourcePrimitive = type as Extract<ProviderTypeExpression, { readonly kind: "source-primitive" }>;
      snapshot = {
        kind: typeKind,
        name: readProviderModelField(context.reads, sourcePrimitive, "name"),
      };
      break;
    }
    case "source-global": {
      const reference = type as Extract<ProviderTypeExpression, { readonly kind: "source-global" }>;
      const typeArguments = readProviderModelField(context.reads, reference, "typeArguments");
      snapshot = {
        kind: typeKind,
        name: readProviderModelField(context.reads, reference, "name"),
        ...(typeArguments === undefined
          ? {}
          : {
            typeArguments: snapshotProviderModelArray(
              context,
              typeArguments,
              "type",
              (argument) => snapshotProviderTypeExpression(context, argument),
            ),
          }),
      };
      break;
    }
    case "type-parameter": {
      const typeParameter = type as Extract<ProviderTypeExpression, { readonly kind: "type-parameter" }>;
      snapshot = {
        kind: typeKind,
        name: readProviderModelField(context.reads, typeParameter, "name"),
      };
      break;
    }
    case "array": {
      const arrayType = type as Extract<ProviderTypeExpression, { readonly kind: "array" }>;
      snapshot = {
        kind: typeKind,
        elementType: snapshotProviderTypeExpression(
          context,
          readProviderModelField(context.reads, arrayType, "elementType"),
        ),
      };
      break;
    }
    case "tuple": {
      const tuple = type as Extract<ProviderTypeExpression, { readonly kind: "tuple" }>;
      snapshot = {
        kind: typeKind,
        elementTypes: snapshotProviderModelArray(
          context,
          readProviderModelField(context.reads, tuple, "elementTypes"),
          "type",
          (elementType) => snapshotProviderTypeExpression(context, elementType),
        ),
      };
      break;
    }
    case "union":
    case "intersection": {
      const composite = type as Extract<ProviderTypeExpression, { readonly kind: "union" | "intersection" }>;
      snapshot = {
        kind: typeKind,
        types: snapshotProviderModelArray(
          context,
          readProviderModelField(context.reads, composite, "types"),
          "type",
          (compositeType) => snapshotProviderTypeExpression(context, compositeType),
        ),
      };
      break;
    }
    case "function": {
      const functionType = type as Extract<ProviderTypeExpression, { readonly kind: "function" }>;
      const id = readProviderModelField(context.reads, functionType, "id");
      const parameters = readProviderModelField(context.reads, functionType, "parameters");
      const returnType = readProviderModelField(context.reads, functionType, "returnType");
      const typeParameters = readProviderModelField(context.reads, functionType, "typeParameters");
      snapshot = {
        kind: typeKind,
        id,
        parameters: snapshotProviderModelArray(
          context,
          parameters,
          "parameter",
          (parameter) => snapshotProviderParameterDeclaration(context, parameter),
        ),
        returnType: snapshotProviderTypeExpression(context, returnType),
        ...(typeParameters === undefined
          ? {}
          : {
            typeParameters: snapshotProviderModelArray(
              context,
              typeParameters,
              "type-parameter",
              (parameter) => snapshotProviderTypeParameterDeclaration(context, parameter),
            ),
          }),
      };
      break;
    }
    case "literal": {
      const literal = type as Extract<ProviderTypeExpression, { readonly kind: "literal" }>;
      snapshot = {
        kind: typeKind,
        value: readProviderModelField(context.reads, literal, "value"),
      };
      break;
    }
    case "bigint-literal": {
      const literal = type as Extract<ProviderTypeExpression, { readonly kind: "bigint-literal" }>;
      snapshot = {
        kind: typeKind,
        value: readProviderModelField(context.reads, literal, "value"),
      };
      break;
    }
    case "provider-ref": {
      const reference = type as Extract<ProviderTypeExpression, { readonly kind: "provider-ref" }>;
      const moduleSpecifier = readProviderModelField(context.reads, reference, "moduleSpecifier");
      const exportName = readProviderModelField(context.reads, reference, "exportName");
      const localName = readProviderModelField(context.reads, reference, "localName");
      const namespaceImport = readProviderModelField(context.reads, reference, "namespaceImport");
      const typeArguments = readProviderModelField(context.reads, reference, "typeArguments");
      snapshot = {
        kind: typeKind,
        moduleSpecifier,
        exportName,
        ...(localName === undefined ? {} : { localName }),
        ...(namespaceImport === undefined ? {} : { namespaceImport }),
        ...(typeArguments === undefined
          ? {}
          : {
            typeArguments: snapshotProviderModelArray(
              context,
              typeArguments,
              "type",
              (argument) => snapshotProviderTypeExpression(context, argument),
            ),
          }),
      };
      break;
    }
  }
  setProviderModelNodeSnapshot(context, type, "type", snapshot);
  return snapshot;
}

function snapshotProviderTypeFamily(
  context: ProviderModelSnapshotContext,
  family: ProviderTypeFamilyDeclaration,
): ProviderTypeFamilyDeclaration {
  const cached = context.typeFamilies.get(family);
  if (cached !== undefined) {
    return cached;
  }
  const snapshot: ProviderTypeFamilyDeclaration = {
    exportName: readProviderModelField(context.reads, family, "exportName"),
    typeArgumentCount: readProviderModelField(context.reads, family, "typeArgumentCount"),
  };
  const frozenSnapshot = Object.freeze(snapshot);
  context.typeFamilies.set(family, frozenSnapshot);
  return frozenSnapshot;
}

function snapshotProviderModelArray<TSource, TSnapshot>(
  context: ProviderModelSnapshotContext,
  source: readonly TSource[],
  nodeKind: ProviderModelGraphNodeKind,
  snapshotEntry: (entry: TSource) => TSnapshot,
): readonly TSnapshot[] {
  const cached = context.arrays.get(source)?.get(nodeKind);
  if (cached !== undefined) {
    return cached as readonly TSnapshot[];
  }
  const captured = getCapturedProviderModelArrayValues(context.reads, source);
  const snapshot = Object.freeze(captured.map((entry) => snapshotEntry(entry as TSource)));
  let snapshotsByKind = context.arrays.get(source);
  if (snapshotsByKind === undefined) {
    snapshotsByKind = new Map();
    context.arrays.set(source, snapshotsByKind);
  }
  snapshotsByKind.set(nodeKind, snapshot as readonly unknown[]);
  return snapshot;
}

function isCapturedProviderModelArrayEmpty(
  reads: ProviderModelReadContext,
  source: readonly unknown[],
): boolean {
  return getCapturedProviderModelArrayValues(reads, source).length === 0;
}

function getCapturedProviderModelArrayValues(
  reads: ProviderModelReadContext,
  source: readonly unknown[],
): readonly unknown[] {
  const captured = reads.arrays.get(source);
  if (captured === undefined) {
    throw new Error("Validated provider model array capture invariant failed.");
  }
  return captured;
}

function getProviderModelNodeSnapshot<T>(
  context: ProviderModelSnapshotContext,
  source: object,
  nodeKind: ProviderModelGraphNodeKind,
): T | undefined {
  return context.nodes.get(source)?.get(nodeKind) as T | undefined;
}

function setProviderModelNodeSnapshot(
  context: ProviderModelSnapshotContext,
  source: object,
  nodeKind: ProviderModelGraphNodeKind,
  snapshot: unknown,
): void {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error("Provider model node snapshot invariant failed.");
  }
  const frozenSnapshot = Object.freeze(snapshot);
  let snapshotsByKind = context.nodes.get(source);
  if (snapshotsByKind === undefined) {
    snapshotsByKind = new Map();
    context.nodes.set(source, snapshotsByKind);
  }
  snapshotsByKind.set(nodeKind, frozenSnapshot);
}

interface ProviderModelGraphComplexity {
  readonly expandedNodeCount: number;
  readonly expandedScalarCodeUnitCount: number;
  readonly maximumRelativeDepth: number;
}

interface ProviderModelGraphComplexityContext {
  readonly reads: ProviderModelReadContext;
  readonly nodeComplexity: WeakMap<object, Map<ProviderModelGraphNodeKind, ProviderModelGraphComplexity>>;
  readonly arrayComplexity: WeakMap<object, Map<ProviderModelGraphNodeKind, ProviderModelGraphComplexity>>;
}

interface ProviderModelGraphComplexityTraversalFrame {
  readonly graph: ProviderModelGraphFrame;
  children: readonly ProviderModelGraphFrame[] | undefined;
  nextChildIndex: number;
  expandedNodeCount: number;
  expandedScalarCodeUnitCount: number;
  maximumRelativeDepth: number;
}

type ProviderModelGraphComplexityValidation =
  | InvalidProviderDeclarationModelGraphValidation
  | {
    readonly kind: "valid";
    readonly expandedSemanticNodeAndArrayEntryCount: number;
    readonly expandedSemanticScalarCodeUnitCount: number;
  };

function validateProviderModelGraphComplexity(
  reads: ProviderModelReadContext,
  root: ProviderModelGraphFrame,
): ProviderModelGraphComplexityValidation {
  const context: ProviderModelGraphComplexityContext = {
    reads,
    nodeComplexity: new WeakMap(),
    arrayComplexity: new WeakMap(),
  };
  const stack: ProviderModelGraphComplexityTraversalFrame[] = [{
    graph: root,
    children: undefined,
    nextChildIndex: 0,
    expandedNodeCount: 1,
    expandedScalarCodeUnitCount: getProviderModelDirectSemanticScalarCodeUnits(reads, root),
    maximumRelativeDepth: 0,
  }];
  while (stack.length > 0) {
    const traversal = stack[stack.length - 1]!;
    const cachedTraversalComplexity = getProviderModelGraphComplexity(context, traversal.graph);
    if (cachedTraversalComplexity !== undefined) {
      stack.pop();
      continue;
    }
    if (traversal.children === undefined) {
      traversal.children = getProviderModelGraphChildren(reads, traversal.graph);
      if (traversal.children === undefined) {
        return reads.failure ?? {
          kind: "invalid",
          reason: "shape",
          path: traversal.graph.path,
          depth: traversal.graph.depth,
        };
      }
    }
    if (traversal.nextChildIndex < traversal.children.length) {
      const child = traversal.children[traversal.nextChildIndex]!;
      const childComplexity = getProviderModelGraphComplexity(context, child);
      if (childComplexity === undefined) {
        stack.push({
          graph: child,
          children: undefined,
          nextChildIndex: 0,
          expandedNodeCount: child.complexityArray === true ? 0 : 1,
          expandedScalarCodeUnitCount: child.complexityArray === true
            ? 0
            : getProviderModelDirectSemanticScalarCodeUnits(reads, child),
          maximumRelativeDepth: 0,
        });
        continue;
      }
      traversal.nextChildIndex++;
      if (childComplexity.expandedNodeCount
        > providerDeclarationModelLimits.maxExpandedSemanticNodeAndArrayEntries - traversal.expandedNodeCount) {
        return {
          kind: "invalid",
          reason: "complexity",
          path: child.path,
          depth: child.depth,
          limit: providerDeclarationModelLimits.maxExpandedSemanticNodeAndArrayEntries,
        };
      }
      traversal.expandedNodeCount += childComplexity.expandedNodeCount;
      if (childComplexity.expandedScalarCodeUnitCount
        > providerDeclarationModelLimits.maxExpandedSemanticScalarCodeUnits
          - traversal.expandedScalarCodeUnitCount) {
        return {
          kind: "invalid",
          reason: "complexity",
          path: child.path,
          depth: child.depth,
          limit: providerDeclarationModelLimits.maxExpandedSemanticScalarCodeUnits,
        };
      }
      traversal.expandedScalarCodeUnitCount += childComplexity.expandedScalarCodeUnitCount;
      const childDepthIncrement = traversal.graph.complexityArray === true ? 0 : 1;
      traversal.maximumRelativeDepth = Math.max(
        traversal.maximumRelativeDepth,
        childComplexity.maximumRelativeDepth + childDepthIncrement,
      );
      const childMaximumDepth = child.depth + childComplexity.maximumRelativeDepth;
      if (childMaximumDepth > providerDeclarationModelLimits.maxNestingDepth) {
        return {
          kind: "invalid",
          reason: "depth",
          path: child.path,
          depth: childMaximumDepth,
          limit: providerDeclarationModelLimits.maxNestingDepth,
        };
      }
      continue;
    }
    setProviderModelGraphComplexity(context, traversal.graph, {
      expandedNodeCount: traversal.expandedNodeCount,
      expandedScalarCodeUnitCount: traversal.expandedScalarCodeUnitCount,
      maximumRelativeDepth: traversal.maximumRelativeDepth,
    });
    stack.pop();
  }

  const complexity = requireProviderModelGraphComplexity(context, root);
  return {
    kind: "valid",
    expandedSemanticNodeAndArrayEntryCount: complexity.expandedNodeCount,
    expandedSemanticScalarCodeUnitCount: complexity.expandedScalarCodeUnitCount,
  };
}

function getProviderModelGraphComplexity(
  context: ProviderModelGraphComplexityContext,
  frame: ProviderModelGraphFrame,
): ProviderModelGraphComplexity | undefined {
  const cache = frame.complexityArray === true ? context.arrayComplexity : context.nodeComplexity;
  return cache.get(frame.value as object)?.get(frame.kind);
}

function requireProviderModelGraphComplexity(
  context: ProviderModelGraphComplexityContext,
  frame: ProviderModelGraphFrame,
): ProviderModelGraphComplexity {
  const complexity = getProviderModelGraphComplexity(context, frame);
  if (complexity === undefined) {
    throw new Error("Provider model graph complexity analysis invariant failed.");
  }
  return complexity;
}

function setProviderModelGraphComplexity(
  context: ProviderModelGraphComplexityContext,
  frame: ProviderModelGraphFrame,
  complexity: ProviderModelGraphComplexity,
): void {
  const source = frame.value as object;
  const cache = frame.complexityArray === true ? context.arrayComplexity : context.nodeComplexity;
  let complexityByKind = cache.get(source);
  if (complexityByKind === undefined) {
    complexityByKind = new Map();
    cache.set(source, complexityByKind);
  }
  complexityByKind.set(frame.kind, complexity);
}

function getProviderModelGraphChildren(
  reads: ProviderModelReadContext,
  frame: ProviderModelGraphFrame,
): readonly ProviderModelGraphFrame[] | undefined {
  if (frame.complexityArray === true) {
    const captured = reads.arrays.get(frame.value as object);
    if (captured === undefined) {
      throw new Error("Provider model graph array complexity capture invariant failed.");
    }
    const children = new Array<ProviderModelGraphFrame>(captured.length);
    for (let index = 0; index < captured.length; index++) {
      children[index] = {
        kind: frame.kind,
        value: captured[index],
        depth: frame.depth,
        path: `${frame.path}[${index}]`,
      };
    }
    return children;
  }
  const stack: ProviderModelGraphFrame[] = [];
  const previousMode = reads.traversalMode;
  reads.traversalMode = "complexity";
  try {
    if (!pushProviderModelGraphChildren(reads, stack, frame)) {
      return undefined;
    }
  } finally {
    reads.traversalMode = previousMode;
  }
  const children: ProviderModelGraphFrame[] = [];
  while (stack.length > 0) {
    children.push(stack.pop()!);
  }
  return children;
}

function canonicalizeProviderAbiExportDeclarationWithContext(
  context: ProviderCanonicalizationContext,
  declaration: ProviderExportDeclaration,
): ProviderExportDeclaration {
  const targetExportName = declaration.sourceTypeFamily?.exportName
    ?? (declaration.exportKind === "default" ? "default" : declaration.exportName ?? declaration.name);
  const sourceExportName = targetExportName;
  const canonicalName = declaration.sourceTypeFamily === undefined
    ? sourceExportName === "default" ? "__TstsProviderDefaultExport" : sourceExportName
    : "__TstsProvider_" + declaration.sourceTypeFamily.exportName + "_" + declaration.sourceTypeFamily.typeArgumentCount;
  return {
    id: declaration.id,
    ...(declaration.intrinsicId === undefined ? {} : { intrinsicId: declaration.intrinsicId }),
    name: canonicalName,
    ...(targetExportName === "default"
      ? { exportKind: "default" as const }
      : targetExportName === canonicalName
        ? {}
        : { exportName: targetExportName }),
    ...(declaration.sourceTypeFamily === undefined
      ? {}
      : {
        sourceTypeFamily: {
          exportName: declaration.sourceTypeFamily.exportName,
          typeArgumentCount: Object.is(declaration.sourceTypeFamily.typeArgumentCount, -0)
            ? 0
            : declaration.sourceTypeFamily.typeArgumentCount,
        },
      }),
    kind: declaration.kind,
    ...(declaration.type === undefined
      ? {}
      : { type: canonicalizeProviderExportOwnerType(context, declaration.type) }),
    ...(declaration.typeParameters === undefined || declaration.typeParameters.length === 0
      ? {}
      : {
        typeParameters: declaration.typeParameters.map(
          (parameter) => canonicalizeProviderAbiTypeParameterWithContext(context, parameter),
        ),
      }),
    ...(declaration.heritage === undefined || declaration.heritage.length === 0
      ? {}
      : {
        heritage: declaration.heritage.map((heritage) => ({
          kind: heritage.kind,
          type: canonicalizeProviderExportOwnerType(context, heritage.type),
        })),
      }),
    ...(declaration.members === undefined || declaration.members.length === 0
      ? {}
      : {
        members: declaration.members.map(
          (member) => canonicalizeProviderExportOwnerMember(context, member),
        ),
      }),
    ...(declaration.signatures === undefined || declaration.signatures.length === 0
      ? {}
      : {
        signatures: declaration.signatures.map(
          (signature) => canonicalizeProviderExportOwnerSignature(context, signature),
        ),
      }),
  };
}

function canonicalizeProviderExportOwnerMember(
  context: ProviderCanonicalizationContext,
  member: ProviderMemberDeclaration,
): ProviderMemberDeclaration {
  return {
    id: member.id,
    name: canonicalizeProviderPropertyName(member.name),
    kind: member.kind,
    ...(member.static === undefined ? {} : { static: member.static }),
    ...(member.readonly === true ? { readonly: true } : {}),
    ...(member.optional === true ? { optional: true } : {}),
    ...(member.type === undefined
      ? {}
      : { type: canonicalizeProviderExportOwnerType(context, member.type) }),
    ...(member.signatures === undefined || member.signatures.length === 0
      ? {}
      : {
        signatures: member.signatures.map(
          (signature) => canonicalizeProviderExportOwnerSignature(context, signature),
        ),
      }),
  };
}

function canonicalizeProviderPropertyName(name: ProviderMemberDeclaration["name"]): ProviderMemberDeclaration["name"] {
  if (typeof name !== "string" && name.kind === "well-known-symbol") {
    return { kind: "well-known-symbol", name: name.name };
  }
  const text = typeof name === "string"
    ? name
    : name.kind === "number-literal"
      ? String(name.value)
      : name.text;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)
    ? text
    : { kind: "string-literal", text };
}

function canonicalizeProviderExportOwnerSignature(
  context: ProviderCanonicalizationContext,
  signature: ProviderSignatureDeclaration,
): ProviderSignatureDeclaration {
  return {
    id: signature.id,
    ...(signature.name === undefined ? {} : { name: signature.name }),
    parameters: signature.parameters.map(
      (parameter) => canonicalizeProviderExportOwnerParameter(context, parameter),
    ),
    ...(signature.returnType === undefined
      ? {}
      : { returnType: canonicalizeProviderExportOwnerType(context, signature.returnType) }),
    ...(signature.typeParameters === undefined || signature.typeParameters.length === 0
      ? {}
      : {
        typeParameters: signature.typeParameters.map(
          (parameter) => canonicalizeProviderAbiTypeParameterWithContext(context, parameter),
        ),
      }),
  };
}

function canonicalizeProviderExportOwnerParameter(
  context: ProviderCanonicalizationContext,
  parameter: ProviderParameterDeclaration,
): ProviderParameterDeclaration {
  return {
    name: parameter.name,
    type: canonicalizeProviderExportOwnerType(context, parameter.type),
    ...(parameter.passingMode === undefined || parameter.passingMode === "by-value"
      ? {}
      : { passingMode: parameter.passingMode }),
    ...(parameter.optional === true ? { optional: true } : {}),
    ...(parameter.rest === true ? { rest: true } : {}),
    ...(parameter.defaultType === undefined
      ? {}
      : { defaultType: canonicalizeProviderExportOwnerType(context, parameter.defaultType) }),
  };
}

export function canonicalizeProviderAbiTypeParameter(
  parameter: ProviderTypeParameterDeclaration,
): ProviderTypeParameterDeclaration {
  return canonicalizeProviderAbiTypeParameterWithContext(
    createProviderCanonicalizationContext(),
    parameter,
  );
}

function canonicalizeProviderAbiTypeParameterWithContext(
  context: ProviderCanonicalizationContext,
  parameter: ProviderTypeParameterDeclaration,
): ProviderTypeParameterDeclaration {
  return {
    name: parameter.name,
    ...(parameter.constraints === undefined || parameter.constraints.length === 0
      ? {}
      : {
        constraints: parameter.constraints.map(
          (constraint) => canonicalizeProviderExportOwnerType(context, constraint),
        ),
      }),
    ...(parameter.defaultType === undefined
      ? {}
      : { defaultType: canonicalizeProviderExportOwnerType(context, parameter.defaultType) }),
    ...(parameter.variance === undefined ? {} : { variance: parameter.variance }),
  };
}

function canonicalizeProviderExportOwnerType(
  context: ProviderCanonicalizationContext,
  type: ProviderTypeExpression,
): ProviderTypeExpression {
  const cached = context.types.get(type);
  if (cached !== undefined) {
    return cached;
  }
  let canonical: ProviderTypeExpression;
  switch (type.kind) {
    case "any":
    case "unknown":
    case "void":
    case "never":
    case "undefined":
    case "boolean":
    case "string":
    case "number":
    case "bigint":
    case "object":
      canonical = { kind: type.kind };
      break;
    case "source-primitive":
      canonical = { kind: type.kind, name: type.name };
      break;
    case "source-global":
      canonical = {
        kind: type.kind,
        name: type.name,
        ...(type.typeArguments === undefined || type.typeArguments.length === 0
          ? {}
          : {
            typeArguments: type.typeArguments.map(
              (argument) => canonicalizeProviderExportOwnerType(context, argument),
            ),
          }),
      };
      break;
    case "type-parameter":
      canonical = { kind: type.kind, name: type.name };
      break;
    case "array":
      canonical = {
        kind: type.kind,
        elementType: canonicalizeProviderExportOwnerType(context, type.elementType),
      };
      break;
    case "tuple":
      canonical = {
        kind: type.kind,
        elementTypes: type.elementTypes.map(
          (elementType) => canonicalizeProviderExportOwnerType(context, elementType),
        ),
      };
      break;
    case "union":
    case "intersection":
      canonical = {
        kind: type.kind,
        types: type.types.map(
          (compositeType) => canonicalizeProviderExportOwnerType(context, compositeType),
        ),
      };
      break;
    case "function":
      canonical = {
        kind: type.kind,
        id: type.id,
        parameters: type.parameters.map(
          (parameter) => canonicalizeProviderExportOwnerParameter(context, parameter),
        ),
        returnType: canonicalizeProviderExportOwnerType(context, type.returnType),
        ...(type.typeParameters === undefined || type.typeParameters.length === 0
          ? {}
          : {
            typeParameters: type.typeParameters.map(
              (parameter) => canonicalizeProviderAbiTypeParameterWithContext(context, parameter),
            ),
          }),
      };
      break;
    case "literal":
      canonical = {
        kind: type.kind,
        value: typeof type.value === "number" && Object.is(type.value, -0) ? 0 : type.value,
      };
      break;
    case "bigint-literal":
      canonical = { kind: type.kind, value: type.value };
      break;
    case "provider-ref":
      {
        const typeArgumentCount = type.typeArguments?.length ?? 0;
        const sourceFamilyExportName = type.moduleSpecifier === context.moduleSpecifier
          ? context.sourceFamilyExportNameByLocalReferenceKey.get(
            getProviderCanonicalFamilyReferenceKey(type.exportName, typeArgumentCount),
          )
          : undefined;
      canonical = {
        kind: type.kind,
        moduleSpecifier: type.moduleSpecifier,
        exportName: sourceFamilyExportName ?? type.exportName,
        ...(type.typeArguments === undefined || type.typeArguments.length === 0
          ? {}
          : {
            typeArguments: type.typeArguments.map(
              (argument) => canonicalizeProviderExportOwnerType(context, argument),
            ),
          }),
      };
      break;
      }
  }
  context.types.set(type, canonical);
  return canonical;
}
