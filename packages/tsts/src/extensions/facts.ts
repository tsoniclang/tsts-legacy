import {
  defineExtensionFactKey,
  markHostSourceReadableFactKey,
} from "./fact-key.js";
import type {
  ExtensionFactSubject,
  ProviderWellKnownSymbolName,
} from "./host.js";
import type {
  Node,
} from "../internal/ast/ast.js";
import type { Symbol } from "../internal/ast/symbol.js";
import type { Type } from "../internal/checker/types.js";
import {
  isArgumentPassingMode,
  type ArgumentPassingMode,
} from "./argument-passing.js";

export type { ArgumentPassingMode } from "./argument-passing.js";

export type ExtensionCanonicalIdentityKind =
  | "module"
  | "package"
  | "export"
  | "local-alias"
  | "symbol"
  | "type"
  | "signature"
  | "instantiated-type";

export type ExtensionImportKind = "type" | "value" | "namespace" | "unknown";

export type SourcePrimitiveKind =
  | "bool"
  | "char"
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "int64"
  | "uint64"
  | "native-int"
  | "native-uint"
  | "float16"
  | "float32"
  | "float64"
  | "decimal"
  | "int128"
  | "uint128";

export interface ExtensionCanonicalIdentity {
  readonly kind: ExtensionCanonicalIdentityKind;
  readonly id: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly subpath?: string;
  readonly exportName?: string;
  readonly importKind?: ExtensionImportKind;
  readonly canonicalSymbolId?: string;
}

export type SourcePointerMutability = "readonly" | "readwrite" | "unspecified";

export interface SourcePrimitiveFact {
  readonly kind: SourcePrimitiveKind;
  readonly signed?: boolean;
  readonly width?: number;
  readonly runtimeBase: "boolean" | "number" | "bigint" | "string" | "object";
}

export interface ArgumentPassingFact {
  readonly mode: ArgumentPassingMode;
  readonly storageExpression?: Node;
}

export interface FunctionPointerFact {
  readonly parameters: readonly Node[];
  readonly result: Node;
  readonly abi: readonly string[];
}

export interface PointerFact {
  readonly pointee: Node;
  readonly mutability: SourcePointerMutability;
}

export type PointerOperationFact =
  | {
      readonly operation: "address-of";
      readonly call: Node;
      readonly pointeeType: Type;
      readonly resultType: Type;
      readonly storageExpression: Node;
      readonly storageType: Type;
      readonly storageSymbol?: Symbol;
      readonly storageDeclaration?: Node;
      readonly locationIdentity: Node;
    }
  | {
      readonly operation: "allocate";
      readonly call: Node;
      readonly pointeeType: Type;
      readonly resultType: Type;
      readonly initialExpression: Node;
      readonly initialType: Type;
      readonly locationIdentity: Node;
    }
  | {
      readonly operation: "load";
      readonly call: Node;
      readonly pointeeType: Type;
      readonly resultType: Type;
      readonly pointerExpression: Node;
      readonly pointerType: Type;
    }
  | {
      readonly operation: "store";
      readonly call: Node;
      readonly pointeeType: Type;
      readonly resultType: Type;
      readonly pointerExpression: Node;
      readonly pointerType: Type;
      readonly valueExpression: Node;
      readonly valueType: Type;
    };

export interface StructFact {
  readonly valueType: boolean;
  readonly fields?: readonly FieldFact[];
}

export interface FieldFact {
  readonly name: string;
  readonly type: Node;
  readonly readonly?: boolean;
}

export interface AttributeFact {
  readonly target: Node;
  readonly attributeName: string;
  readonly arguments?: readonly Node[];
}

export interface DefaultValueFact {
  readonly type: Node;
}

export interface FlowStateFact {
  readonly state: "moved" | "borrowed-shared" | "borrowed-mut";
}

export interface ProviderDeclarationIdentity {
  readonly providerId: string;
  readonly providerVersion?: string;
  readonly providerModuleId: string;
  readonly moduleSpecifier: string;
  readonly artifactFileName?: string;
  readonly exportName?: string;
  readonly exportId?: string;
  readonly memberName?: string;
  readonly memberKey?: ProviderMemberKey;
  readonly memberId?: string;
  readonly memberStatic?: boolean;
  readonly signatureId?: string;
}

export type ProviderMemberKey =
  | { readonly kind: "property-key"; readonly name: string }
  | { readonly kind: "well-known-symbol"; readonly name: ProviderWellKnownSymbolName };

export interface ProviderVirtualDeclarationFact extends ProviderDeclarationIdentity {
  readonly providerVersion: string;
  readonly artifactFileName: string;
}

export interface ProviderTypeFamilyVariantFact {
  readonly sourceTypeArgumentCount: number;
  readonly declaration: ProviderVirtualDeclarationFact;
}

export interface ProviderTypeFamilyFact {
  readonly exportName: string;
  readonly variants: readonly ProviderTypeFamilyVariantFact[];
}

export interface AssociatedTypeFact {
  readonly owner: ExtensionFactSubject;
  readonly name: string;
  readonly value: ExtensionFactSubject;
}

export interface ConstGenericFact {
  readonly name: string;
  readonly value: string | number | bigint | boolean;
}

export const canonicalIdentityFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<ExtensionCanonicalIdentity>({
  extensionId: "tsts.source-semantics",
  name: "canonicalIdentity",
  snapshot: snapshotCanonicalIdentityFact,
  equals: canonicalIdentityEquals,
}));

export const sourcePrimitiveFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<SourcePrimitiveFact>({
  extensionId: "tsts.source-semantics",
  name: "sourcePrimitive",
  snapshot: snapshotSourcePrimitiveFact,
  equals: (left, right) =>
    left.kind === right.kind
    && left.width === right.width
    && left.signed === right.signed
    && left.runtimeBase === right.runtimeBase,
}));

export const argumentPassingFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<ArgumentPassingFact>({
  extensionId: "tsts.source-semantics",
  name: "argumentPassing",
  snapshot: snapshotArgumentPassingFact,
  equals: (left, right) =>
    left.mode === right.mode
    && left.storageExpression === right.storageExpression,
}));

export const functionPointerFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<FunctionPointerFact>({
  extensionId: "tsts.source-semantics",
  name: "functionPointer",
  snapshot: snapshotFunctionPointerFact,
  equals: (left, right) =>
    left.result === right.result
    && identityArrayEquals(left.parameters, right.parameters)
    && stringArrayEquals(left.abi, right.abi),
}));

export const pointerFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<PointerFact>({
  extensionId: "tsts.source-semantics",
  name: "pointer",
  snapshot: snapshotPointerFact,
  equals: (left, right) =>
    left.pointee === right.pointee
    && left.mutability === right.mutability,
}));

export const pointerOperationFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<PointerOperationFact>({
  extensionId: "tsts.source-semantics",
  name: "pointerOperation",
  snapshot: snapshotPointerOperationFact,
  equals: pointerOperationFactEquals,
}));

export const structFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<StructFact>({
  extensionId: "tsts.source-semantics",
  name: "struct",
  snapshot: snapshotStructFact,
  equals: (left, right) =>
    left.valueType === right.valueType
    && optionalFieldArrayEquals(left.fields, right.fields),
}));

export const fieldFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<FieldFact>({
  extensionId: "tsts.source-semantics",
  name: "field",
  snapshot: snapshotFieldFact,
  equals: fieldFactEquals,
}));

export const attributeFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<AttributeFact>({
  extensionId: "tsts.source-semantics",
  name: "attribute",
  snapshot: snapshotAttributeFact,
  equals: (left, right) =>
    left.target === right.target
    && left.attributeName === right.attributeName
    && optionalIdentityArrayEquals(left.arguments, right.arguments),
}));

export const defaultValueFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<DefaultValueFact>({
  extensionId: "tsts.source-semantics",
  name: "defaultValue",
  snapshot: snapshotDefaultValueFact,
  equals: (left, right) => left.type === right.type,
}));

export const flowStateFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<FlowStateFact>({
  extensionId: "tsts.source-semantics",
  name: "flowState",
  snapshot: snapshotFlowStateFact,
  equals: (left, right) => left.state === right.state,
}));

export const providerVirtualDeclarationFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<ProviderVirtualDeclarationFact>({
  extensionId: "tsts.provider",
  name: "virtualDeclaration",
  snapshot: snapshotProviderVirtualDeclarationFact,
  equals: providerDeclarationIdentityEquals,
}));

export const providerTypeFamilyFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<ProviderTypeFamilyFact>({
  extensionId: "tsts.provider",
  name: "typeFamily",
  snapshot: snapshotProviderTypeFamilyFact,
  equals: (left, right) =>
    left.exportName === right.exportName
    && providerTypeFamilyVariantArrayEquals(left.variants, right.variants),
}));

export const associatedTypeFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<AssociatedTypeFact>({
  extensionId: "tsts.source-semantics",
  name: "associatedType",
  snapshot: snapshotAssociatedTypeFact,
  equals: (left, right) =>
    left.owner === right.owner
    && left.name === right.name
    && left.value === right.value,
}));

export const constGenericFactKey = markHostSourceReadableFactKey(defineExtensionFactKey<ConstGenericFact>({
  extensionId: "tsts.source-semantics",
  name: "constGeneric",
  snapshot: snapshotConstGenericFact,
  equals: (left, right) =>
    left.name === right.name
    && left.value === right.value,
}));

function snapshotCanonicalIdentityFact(value: ExtensionCanonicalIdentity): ExtensionCanonicalIdentity {
  const record = exactRecord(value, "ExtensionCanonicalIdentity", [
    "kind",
    "id",
    "packageName",
    "packageVersion",
    "subpath",
    "exportName",
    "importKind",
    "canonicalSymbolId",
  ]);
  const kind = requiredString(record, "kind", "ExtensionCanonicalIdentity") as ExtensionCanonicalIdentityKind;
  if (!canonicalIdentityKinds.has(kind)) {
    throw new Error(`ExtensionCanonicalIdentity.kind '${kind}' is invalid.`);
  }
  const importKind = optionalString(record, "importKind", "ExtensionCanonicalIdentity") as ExtensionImportKind | undefined;
  if (importKind !== undefined && !importKinds.has(importKind)) {
    throw new Error(`ExtensionCanonicalIdentity.importKind '${importKind}' is invalid.`);
  }
  return Object.freeze({
    kind,
    id: requiredString(record, "id", "ExtensionCanonicalIdentity"),
    ...optionalStringFields(record, "ExtensionCanonicalIdentity", [
      "packageName",
      "packageVersion",
      "subpath",
      "exportName",
      "canonicalSymbolId",
    ]),
    ...(importKind === undefined ? {} : { importKind }),
  });
}

function snapshotSourcePrimitiveFact(value: SourcePrimitiveFact): SourcePrimitiveFact {
  const record = exactRecord(value, "SourcePrimitiveFact", ["kind", "signed", "width", "runtimeBase"]);
  const kind = requiredString(record, "kind", "SourcePrimitiveFact") as SourcePrimitiveKind;
  if (!sourcePrimitiveKinds.has(kind)) {
    throw new Error(`SourcePrimitiveFact.kind '${kind}' is invalid.`);
  }
  const runtimeBase = requiredString(record, "runtimeBase", "SourcePrimitiveFact") as SourcePrimitiveFact["runtimeBase"];
  if (!sourceRuntimeBases.has(runtimeBase)) {
    throw new Error(`SourcePrimitiveFact.runtimeBase '${runtimeBase}' is invalid.`);
  }
  const signed = optionalBoolean(record, "signed", "SourcePrimitiveFact");
  const width = optionalSafeInteger(record, "width", "SourcePrimitiveFact");
  if (width !== undefined && width <= 0) {
    throw new Error("SourcePrimitiveFact.width must be positive.");
  }
  return Object.freeze({
    kind,
    runtimeBase,
    ...(signed === undefined ? {} : { signed }),
    ...(width === undefined ? {} : { width }),
  });
}

function snapshotArgumentPassingFact(value: ArgumentPassingFact): ArgumentPassingFact {
  const record = exactRecord(value, "ArgumentPassingFact", ["mode", "storageExpression"]);
  const mode = requiredString(record, "mode", "ArgumentPassingFact");
  if (!isArgumentPassingMode(mode)) {
    throw new Error(`ArgumentPassingFact.mode '${mode}' is invalid.`);
  }
  const storageExpression = optionalNode(record, "storageExpression", "ArgumentPassingFact");
  return Object.freeze({
    mode,
    ...(storageExpression === undefined ? {} : { storageExpression }),
  });
}

function snapshotFunctionPointerFact(value: FunctionPointerFact): FunctionPointerFact {
  const record = exactRecord(value, "FunctionPointerFact", ["parameters", "result", "abi"]);
  return Object.freeze({
    parameters: nodeArray(record.parameters, "FunctionPointerFact.parameters"),
    result: requiredNode(record, "result", "FunctionPointerFact"),
    abi: stringArray(record.abi, "FunctionPointerFact.abi"),
  });
}

function snapshotPointerFact(value: PointerFact): PointerFact {
  const record = exactRecord(value, "PointerFact", ["pointee", "mutability"]);
  const mutability = requiredString(record, "mutability", "PointerFact") as SourcePointerMutability;
  if (!pointerMutabilities.has(mutability)) {
    throw new Error(`PointerFact.mutability '${mutability}' is invalid.`);
  }
  return Object.freeze({
    pointee: requiredNode(record, "pointee", "PointerFact"),
    mutability,
  });
}

function snapshotPointerOperationFact(value: PointerOperationFact): PointerOperationFact {
  const operation = requiredPointerOperation(value);
  const commonFields = ["operation", "call", "pointeeType", "resultType"];
  switch (operation) {
    case "address-of": {
      const record = exactRecord(value, "PointerOperationFact", [
        ...commonFields,
        "storageExpression",
        "storageType",
        "storageSymbol",
        "storageDeclaration",
        "locationIdentity",
      ]);
      const storageSymbol = optionalCompilerSymbol(record, "storageSymbol", "PointerOperationFact");
      const storageDeclaration = optionalNode(record, "storageDeclaration", "PointerOperationFact");
      return Object.freeze({
        operation,
        call: requiredNode(record, "call", "PointerOperationFact"),
        pointeeType: requiredCompilerType(record, "pointeeType", "PointerOperationFact"),
        resultType: requiredCompilerType(record, "resultType", "PointerOperationFact"),
        storageExpression: requiredNode(record, "storageExpression", "PointerOperationFact"),
        storageType: requiredCompilerType(record, "storageType", "PointerOperationFact"),
        ...(storageSymbol === undefined ? {} : { storageSymbol }),
        ...(storageDeclaration === undefined ? {} : { storageDeclaration }),
        locationIdentity: requiredNode(record, "locationIdentity", "PointerOperationFact"),
      });
    }
    case "allocate": {
      const record = exactRecord(value, "PointerOperationFact", [
        ...commonFields,
        "initialExpression",
        "initialType",
        "locationIdentity",
      ]);
      return Object.freeze({
        operation,
        call: requiredNode(record, "call", "PointerOperationFact"),
        pointeeType: requiredCompilerType(record, "pointeeType", "PointerOperationFact"),
        resultType: requiredCompilerType(record, "resultType", "PointerOperationFact"),
        initialExpression: requiredNode(record, "initialExpression", "PointerOperationFact"),
        initialType: requiredCompilerType(record, "initialType", "PointerOperationFact"),
        locationIdentity: requiredNode(record, "locationIdentity", "PointerOperationFact"),
      });
    }
    case "load": {
      const record = exactRecord(value, "PointerOperationFact", [
        ...commonFields,
        "pointerExpression",
        "pointerType",
      ]);
      return Object.freeze({
        operation,
        call: requiredNode(record, "call", "PointerOperationFact"),
        pointeeType: requiredCompilerType(record, "pointeeType", "PointerOperationFact"),
        resultType: requiredCompilerType(record, "resultType", "PointerOperationFact"),
        pointerExpression: requiredNode(record, "pointerExpression", "PointerOperationFact"),
        pointerType: requiredCompilerType(record, "pointerType", "PointerOperationFact"),
      });
    }
    case "store": {
      const record = exactRecord(value, "PointerOperationFact", [
        ...commonFields,
        "pointerExpression",
        "pointerType",
        "valueExpression",
        "valueType",
      ]);
      return Object.freeze({
        operation,
        call: requiredNode(record, "call", "PointerOperationFact"),
        pointeeType: requiredCompilerType(record, "pointeeType", "PointerOperationFact"),
        resultType: requiredCompilerType(record, "resultType", "PointerOperationFact"),
        pointerExpression: requiredNode(record, "pointerExpression", "PointerOperationFact"),
        pointerType: requiredCompilerType(record, "pointerType", "PointerOperationFact"),
        valueExpression: requiredNode(record, "valueExpression", "PointerOperationFact"),
        valueType: requiredCompilerType(record, "valueType", "PointerOperationFact"),
      });
    }
  }
}

function snapshotStructFact(value: StructFact): StructFact {
  const record = exactRecord(value, "StructFact", ["valueType", "fields"]);
  const fields = optionalArray(record.fields, "StructFact.fields", snapshotFieldFact);
  return Object.freeze({
    valueType: requiredBoolean(record, "valueType", "StructFact"),
    ...(fields === undefined ? {} : { fields }),
  });
}

function snapshotFieldFact(value: FieldFact): FieldFact {
  const record = exactRecord(value, "FieldFact", ["name", "type", "readonly"]);
  const readonly = optionalBoolean(record, "readonly", "FieldFact");
  return Object.freeze({
    name: requiredString(record, "name", "FieldFact"),
    type: requiredNode(record, "type", "FieldFact"),
    ...(readonly === undefined ? {} : { readonly }),
  });
}

function snapshotAttributeFact(value: AttributeFact): AttributeFact {
  const record = exactRecord(value, "AttributeFact", ["target", "attributeName", "arguments"]);
  const args = optionalNodeArray(record.arguments, "AttributeFact.arguments");
  return Object.freeze({
    target: requiredNode(record, "target", "AttributeFact"),
    attributeName: requiredString(record, "attributeName", "AttributeFact"),
    ...(args === undefined ? {} : { arguments: args }),
  });
}

function snapshotDefaultValueFact(value: DefaultValueFact): DefaultValueFact {
  const record = exactRecord(value, "DefaultValueFact", ["type"]);
  return Object.freeze({
    type: requiredNode(record, "type", "DefaultValueFact"),
  });
}

function snapshotFlowStateFact(value: FlowStateFact): FlowStateFact {
  const record = exactRecord(value, "FlowStateFact", ["state"]);
  const state = requiredString(record, "state", "FlowStateFact") as FlowStateFact["state"];
  if (!flowStates.has(state)) {
    throw new Error(`FlowStateFact.state '${state}' is invalid.`);
  }
  return Object.freeze({ state });
}

function snapshotProviderVirtualDeclarationFact(value: ProviderVirtualDeclarationFact): ProviderVirtualDeclarationFact {
  const record = exactRecord(value, "ProviderVirtualDeclarationFact", [
    "providerId",
    "providerVersion",
    "providerModuleId",
    "moduleSpecifier",
    "artifactFileName",
    "exportName",
    "exportId",
    "memberName",
    "memberKey",
    "memberId",
    "memberStatic",
    "signatureId",
  ]);
  const memberKey = record.memberKey === undefined
    ? undefined
    : snapshotProviderMemberKey(record.memberKey);
  const memberStatic = optionalBoolean(record, "memberStatic", "ProviderVirtualDeclarationFact");
  return Object.freeze({
    providerId: requiredString(record, "providerId", "ProviderVirtualDeclarationFact"),
    providerVersion: requiredString(record, "providerVersion", "ProviderVirtualDeclarationFact"),
    providerModuleId: requiredString(record, "providerModuleId", "ProviderVirtualDeclarationFact"),
    moduleSpecifier: requiredString(record, "moduleSpecifier", "ProviderVirtualDeclarationFact"),
    artifactFileName: requiredString(record, "artifactFileName", "ProviderVirtualDeclarationFact"),
    ...optionalStringFields(record, "ProviderVirtualDeclarationFact", [
      "exportName",
      "exportId",
      "memberName",
      "memberId",
      "signatureId",
    ]),
    ...(memberKey === undefined ? {} : { memberKey }),
    ...(memberStatic === undefined ? {} : { memberStatic }),
  });
}

function snapshotProviderMemberKey(value: unknown): ProviderMemberKey {
  const record = exactRecord(value, "ProviderMemberKey", ["kind", "name"]);
  const kind = requiredString(record, "kind", "ProviderMemberKey");
  const name = requiredString(record, "name", "ProviderMemberKey");
  if (kind === "property-key") {
    return Object.freeze({ kind, name });
  }
  if (kind === "well-known-symbol" && providerWellKnownSymbolNames.has(name as ProviderWellKnownSymbolName)) {
    return Object.freeze({ kind, name: name as ProviderWellKnownSymbolName });
  }
  throw new Error(`ProviderMemberKey kind/name '${kind}:${name}' is invalid.`);
}

function snapshotProviderTypeFamilyFact(value: ProviderTypeFamilyFact): ProviderTypeFamilyFact {
  const record = exactRecord(value, "ProviderTypeFamilyFact", ["exportName", "variants"]);
  return Object.freeze({
    exportName: requiredString(record, "exportName", "ProviderTypeFamilyFact"),
    variants: requiredArray(record.variants, "ProviderTypeFamilyFact.variants", snapshotProviderTypeFamilyVariantFact),
  });
}

function snapshotProviderTypeFamilyVariantFact(value: ProviderTypeFamilyVariantFact): ProviderTypeFamilyVariantFact {
  const record = exactRecord(value, "ProviderTypeFamilyVariantFact", ["sourceTypeArgumentCount", "declaration"]);
  const sourceTypeArgumentCount = requiredSafeInteger(record, "sourceTypeArgumentCount", "ProviderTypeFamilyVariantFact");
  if (sourceTypeArgumentCount < 0) {
    throw new Error("ProviderTypeFamilyVariantFact.sourceTypeArgumentCount cannot be negative.");
  }
  return Object.freeze({
    sourceTypeArgumentCount,
    declaration: snapshotProviderVirtualDeclarationFact(record.declaration as ProviderVirtualDeclarationFact),
  });
}

function snapshotAssociatedTypeFact(value: AssociatedTypeFact): AssociatedTypeFact {
  const record = exactRecord(value, "AssociatedTypeFact", ["owner", "name", "value"]);
  return Object.freeze({
    owner: requiredSubject(record, "owner", "AssociatedTypeFact"),
    name: requiredString(record, "name", "AssociatedTypeFact"),
    value: requiredSubject(record, "value", "AssociatedTypeFact"),
  });
}

function snapshotConstGenericFact(value: ConstGenericFact): ConstGenericFact {
  const record = exactRecord(value, "ConstGenericFact", ["name", "value"]);
  const scalar = record.value;
  if (typeof scalar !== "string"
    && typeof scalar !== "number"
    && typeof scalar !== "bigint"
    && typeof scalar !== "boolean") {
    throw new Error("ConstGenericFact.value must be a string, number, bigint, or boolean.");
  }
  if (typeof scalar === "number" && !Number.isFinite(scalar)) {
    throw new Error("ConstGenericFact.value must be finite when numeric.");
  }
  return Object.freeze({
    name: requiredString(record, "name", "ConstGenericFact"),
    value: scalar,
  });
}

function canonicalIdentityEquals(left: ExtensionCanonicalIdentity, right: ExtensionCanonicalIdentity): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && left.packageName === right.packageName
    && left.packageVersion === right.packageVersion
    && left.subpath === right.subpath
    && left.exportName === right.exportName
    && left.importKind === right.importKind
    && left.canonicalSymbolId === right.canonicalSymbolId;
}

function providerDeclarationIdentityEquals(
  left: ProviderDeclarationIdentity,
  right: ProviderDeclarationIdentity,
): boolean {
  return left.providerId === right.providerId
    && left.providerVersion === right.providerVersion
    && left.providerModuleId === right.providerModuleId
    && left.moduleSpecifier === right.moduleSpecifier
    && left.artifactFileName === right.artifactFileName
    && left.exportName === right.exportName
    && left.exportId === right.exportId
    && left.memberName === right.memberName
    && providerMemberKeyEquals(left.memberKey, right.memberKey)
    && left.memberId === right.memberId
    && left.memberStatic === right.memberStatic
    && left.signatureId === right.signatureId;
}

function providerMemberKeyEquals(
  left: ProviderMemberKey | undefined,
  right: ProviderMemberKey | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.kind === right.kind
      && left.name === right.name;
}

function providerTypeFamilyVariantArrayEquals(
  left: readonly ProviderTypeFamilyVariantFact[],
  right: readonly ProviderTypeFamilyVariantFact[],
): boolean {
  return left.length === right.length
    && left.every((variant, index) => {
      const candidate = right[index]!;
      return variant.sourceTypeArgumentCount === candidate.sourceTypeArgumentCount
        && providerDeclarationIdentityEquals(variant.declaration, candidate.declaration);
    });
}

function fieldFactEquals(left: FieldFact, right: FieldFact): boolean {
  return left.name === right.name
    && left.type === right.type
    && left.readonly === right.readonly;
}

function pointerOperationFactEquals(
  left: PointerOperationFact,
  right: PointerOperationFact,
): boolean {
  if (
    left.operation !== right.operation
    || left.call !== right.call
    || left.pointeeType !== right.pointeeType
    || left.resultType !== right.resultType
  ) {
    return false;
  }
  switch (left.operation) {
    case "address-of":
      return right.operation === "address-of"
        && left.storageExpression === right.storageExpression
        && left.storageType === right.storageType
        && left.storageSymbol === right.storageSymbol
        && left.storageDeclaration === right.storageDeclaration
        && left.locationIdentity === right.locationIdentity;
    case "allocate":
      return right.operation === "allocate"
        && left.initialExpression === right.initialExpression
        && left.initialType === right.initialType
        && left.locationIdentity === right.locationIdentity;
    case "load":
      return right.operation === "load"
        && left.pointerExpression === right.pointerExpression
        && left.pointerType === right.pointerType;
    case "store":
      return right.operation === "store"
        && left.pointerExpression === right.pointerExpression
        && left.pointerType === right.pointerType
        && left.valueExpression === right.valueExpression
        && left.valueType === right.valueType;
  }
}

function optionalFieldArrayEquals(
  left: readonly FieldFact[] | undefined,
  right: readonly FieldFact[] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.length === right.length
      && left.every((field, index) => fieldFactEquals(field, right[index]!));
}

function optionalIdentityArrayEquals(
  left: readonly ExtensionFactSubject[] | undefined,
  right: readonly ExtensionFactSubject[] | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && identityArrayEquals(left, right);
}

function identityArrayEquals(
  left: readonly ExtensionFactSubject[],
  right: readonly ExtensionFactSubject[],
): boolean {
  return left.length === right.length
    && left.every((subject, index) => subject === right[index]);
}

function stringArrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactRecord(
  value: unknown,
  name: string,
  allowedFields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const allowed = new Set(allowedFields);
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`${name} contains unsupported field '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${name}.${key} must be an own data property.`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function requiredString(record: Readonly<Record<string, unknown>>, field: string, name: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name}.${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(record: Readonly<Record<string, unknown>>, field: string, name: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name}.${field} must be a string when present.`);
  }
  return value;
}

function optionalStringFields(
  record: Readonly<Record<string, unknown>>,
  name: string,
  fields: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = optionalString(record, field, name);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function requiredBoolean(record: Readonly<Record<string, unknown>>, field: string, name: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`${name}.${field} must be a boolean.`);
  }
  return value;
}

function optionalBoolean(record: Readonly<Record<string, unknown>>, field: string, name: string): boolean | undefined {
  const value = record[field];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name}.${field} must be a boolean when present.`);
  }
  return value as boolean | undefined;
}

function requiredSafeInteger(record: Readonly<Record<string, unknown>>, field: string, name: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name}.${field} must be a safe integer.`);
  }
  return value as number;
}

function optionalSafeInteger(record: Readonly<Record<string, unknown>>, field: string, name: string): number | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name}.${field} must be a safe integer when present.`);
  }
  return value as number;
}

function requiredSubject(
  record: Readonly<Record<string, unknown>>,
  field: string,
  name: string,
): ExtensionFactSubject {
  const value = record[field];
  if (typeof value !== "object" || value === null) {
    throw new Error(`${name}.${field} must be an identity-bearing object.`);
  }
  return value;
}

function requiredCompilerType(
  record: Readonly<Record<string, unknown>>,
  field: string,
  name: string,
): Type {
  const value = requiredSubject(record, field, name);
  if (!("flags" in value) || typeof value.flags !== "number") {
    throw new Error(`${name}.${field} must be a compiler semantic type.`);
  }
  return value as Type;
}

function optionalCompilerSymbol(
  record: Readonly<Record<string, unknown>>,
  field: string,
  name: string,
): Symbol | undefined {
  const value = optionalSubject(record, field, name);
  if (value === undefined) {
    return undefined;
  }
  if (!("Flags" in value) || typeof value.Flags !== "number") {
    throw new Error(`${name}.${field} must be a compiler symbol when present.`);
  }
  return value as Symbol;
}

function requiredPointerOperation(value: unknown): PointerOperationFact["operation"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PointerOperationFact must be an object.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "operation");
  const operation = descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
  if (
    operation !== "address-of"
    && operation !== "allocate"
    && operation !== "load"
    && operation !== "store"
  ) {
    throw new Error(`PointerOperationFact.operation '${String(operation)}' is invalid.`);
  }
  return operation;
}

function optionalSubject(
  record: Readonly<Record<string, unknown>>,
  field: string,
  name: string,
): ExtensionFactSubject | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`${name}.${field} must be an identity-bearing object when present.`);
  }
  return value;
}

function requiredNode(
  record: Readonly<Record<string, unknown>>,
  field: string,
  name: string,
): Node {
  const value = requiredSubject(record, field, name);
  if (!("Kind" in value) || typeof value.Kind !== "number") {
    throw new Error(`${name}.${field} must be a compiler source node.`);
  }
  return value as Node;
}

function optionalNode(
  record: Readonly<Record<string, unknown>>,
  field: string,
  name: string,
): Node | undefined {
  return record[field] === undefined ? undefined : requiredNode(record, field, name);
}

function requiredArray<T>(
  value: unknown,
  name: string,
  snapshot: (element: T) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return Object.freeze(value.map((element) => snapshot(element as T)));
}

function optionalArray<T>(
  value: unknown,
  name: string,
  snapshot: (element: T) => T,
): readonly T[] | undefined {
  return value === undefined ? undefined : requiredArray(value, name, snapshot);
}

function subjectArray(value: unknown, name: string): readonly ExtensionFactSubject[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return Object.freeze(value.map((subject, index) => {
    if (typeof subject !== "object" || subject === null) {
      throw new Error(`${name}[${index}] must be an identity-bearing object.`);
    }
    return subject;
  }));
}

function nodeArray(value: unknown, name: string): readonly Node[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return Object.freeze(value.map((node, index) => {
    if (
      typeof node !== "object" ||
      node === null ||
      !("Kind" in node) ||
      typeof node.Kind !== "number"
    ) {
      throw new Error(`${name}[${index}] must be a compiler source node.`);
    }
    return node as Node;
  }));
}

function optionalSubjectArray(value: unknown, name: string): readonly ExtensionFactSubject[] | undefined {
  return value === undefined ? undefined : subjectArray(value, name);
}

function optionalNodeArray(value: unknown, name: string): readonly Node[] | undefined {
  return value === undefined ? undefined : nodeArray(value, name);
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return Object.freeze(value.map((element, index) => {
    if (typeof element !== "string") {
      throw new Error(`${name}[${index}] must be a string.`);
    }
    return element;
  }));
}

const canonicalIdentityKinds = new Set<ExtensionCanonicalIdentityKind>([
  "module",
  "package",
  "export",
  "local-alias",
  "symbol",
  "type",
  "signature",
  "instantiated-type",
]);
const importKinds = new Set<ExtensionImportKind>(["type", "value", "namespace", "unknown"]);
const sourcePrimitiveKinds = new Set<SourcePrimitiveKind>([
  "bool",
  "char",
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  "native-int",
  "native-uint",
  "float16",
  "float32",
  "float64",
  "decimal",
  "int128",
  "uint128",
]);
const sourceRuntimeBases = new Set<SourcePrimitiveFact["runtimeBase"]>([
  "boolean",
  "number",
  "bigint",
  "string",
  "object",
]);
const pointerMutabilities = new Set<SourcePointerMutability>(["readonly", "readwrite", "unspecified"]);
const flowStates = new Set<FlowStateFact["state"]>(["moved", "borrowed-shared", "borrowed-mut"]);
const providerWellKnownSymbolNames = new Set<ProviderWellKnownSymbolName>([
  "asyncIterator",
  "hasInstance",
  "isConcatSpreadable",
  "iterator",
  "match",
  "matchAll",
  "replace",
  "search",
  "species",
  "split",
  "toPrimitive",
  "toStringTag",
  "unscopables",
]);
