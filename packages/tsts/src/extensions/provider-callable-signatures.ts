import type {
  ProviderDeclarationModel,
  ProviderExportDeclaration,
  ProviderMemberDeclaration,
  ProviderParameterDeclaration,
  ProviderSignatureDeclaration,
  ProviderTypeExpression,
  ProviderTypeParameterDeclaration,
} from "./host.js";

export type ProviderFunctionTypeExpression = Extract<ProviderTypeExpression, { readonly kind: "function" }>;

export interface ProviderRenderedFunctionSignature {
  readonly marker: number;
  readonly exportId: string;
  readonly memberId?: string;
  readonly signatureId: string;
  readonly parameters: readonly ProviderParameterDeclaration[];
}

const providerFunctionMarkerPrefix = "/*@tsts-provider-function:";
const providerFunctionMarkerSuffix = "*/";
export const providerFunctionSignatureMarkerMaximumLength = providerFunctionMarkerPrefix.length + 16 + providerFunctionMarkerSuffix.length;

export function createProviderRenderedFunctionSignature(
  declaration: ProviderExportDeclaration,
  member: ProviderMemberDeclaration | undefined,
  signature: ProviderFunctionTypeExpression,
  marker: number,
): ProviderRenderedFunctionSignature {
  return Object.freeze({
    marker,
    exportId: declaration.id,
    ...(member === undefined ? {} : { memberId: member.id }),
    signatureId: signature.id,
    parameters: signature.parameters,
  });
}

export function renderProviderFunctionSignatureMarker(marker: number): string {
  if (!Number.isSafeInteger(marker) || marker < 0) {
    throw new Error("Provider function signature marker must be a non-negative safe integer.");
  }
  return `${providerFunctionMarkerPrefix}${marker}${providerFunctionMarkerSuffix}`;
}

export function parseProviderFunctionSignatureMarker(sourceText: string): number | undefined {
  if (!sourceText.startsWith(providerFunctionMarkerPrefix)) {
    return undefined;
  }
  const end = sourceText.indexOf(providerFunctionMarkerSuffix, providerFunctionMarkerPrefix.length);
  if (end < 0) {
    return undefined;
  }
  const digits = sourceText.slice(providerFunctionMarkerPrefix.length, end);
  if (digits.length === 0 || digits.length > 16) {
    return undefined;
  }
  for (let index = 0; index < digits.length; index++) {
    const code = digits.charCodeAt(index);
    if (code < 48 || code > 57) {
      return undefined;
    }
  }
  if (digits.length > 1 && digits.charCodeAt(0) === 48) {
    return undefined;
  }
  const marker = Number(digits);
  return Number.isSafeInteger(marker) ? marker : undefined;
}

export function hasUniqueProviderCallableIdentities(model: ProviderDeclarationModel): boolean {
  const exportIds = new Set<string>();
  for (const declaration of model.exports) {
    if (!addUniqueIdentity(exportIds, declaration.id)) {
      return false;
    }
    const exportSignatureIds = new Set<string>();
    if (!collectProviderExportCallableIdentities(declaration, exportSignatureIds)) {
      return false;
    }
    const memberIds = new Set<string>();
    const memberSurfaces = new Set<string>();
    for (const member of declaration.members ?? []) {
      if (!addUniqueIdentity(memberIds, member.id)
        || !addUniqueIdentity(memberSurfaces, providerMemberSurfaceKey(member))
        || !collectProviderMemberCallableIdentities(member, new Set())) {
        return false;
      }
    }
  }
  return true;
}

function providerMemberSurfaceKey(member: ProviderMemberDeclaration): string {
  const staticMember = member.static === true;
  switch (member.kind) {
    case "constructor":
      return "constructor";
    case "indexer":
      return "indexer";
    case "method":
    case "property":
    case "field":
      return JSON.stringify([
        staticMember,
        providerPropertySourceKey(member.name),
      ]);
  }
}

function providerPropertySourceKey(name: ProviderMemberDeclaration["name"]): readonly [string, string] {
  if (typeof name !== "string" && name.kind === "well-known-symbol") {
    return ["well-known-symbol", name.name];
  }
  const text = typeof name === "string"
    ? name
    : name.kind === "number-literal"
      ? String(name.value)
      : name.text;
  return ["property-key", text];
}

function collectProviderExportCallableIdentities(
  declaration: ProviderExportDeclaration,
  identities: Set<string>,
): boolean {
  return collectProviderTypeParameterCallableIdentities(declaration.typeParameters ?? [], identities)
    && (declaration.type === undefined || collectProviderTypeCallableIdentities(declaration.type, identities))
    && (declaration.heritage ?? []).every((heritage) => collectProviderTypeCallableIdentities(heritage.type, identities))
    && (declaration.signatures ?? []).every((signature) =>
      collectProviderSignatureCallableIdentities(signature, identities));
}

function collectProviderMemberCallableIdentities(
  member: ProviderMemberDeclaration,
  identities: Set<string>,
): boolean {
  return (member.type === undefined || collectProviderTypeCallableIdentities(member.type, identities))
    && (member.signatures ?? []).every((signature) =>
      collectProviderSignatureCallableIdentities(signature, identities));
}

function collectProviderSignatureCallableIdentities(
  signature: ProviderSignatureDeclaration,
  identities: Set<string>,
): boolean {
  return addUniqueIdentity(identities, signature.id)
    && collectProviderTypeParameterCallableIdentities(signature.typeParameters ?? [], identities)
    && collectProviderParameterCallableIdentities(signature.parameters, identities)
    && (signature.returnType === undefined || collectProviderTypeCallableIdentities(signature.returnType, identities));
}

function collectProviderTypeParameterCallableIdentities(
  parameters: readonly ProviderTypeParameterDeclaration[],
  identities: Set<string>,
): boolean {
  return parameters.every((parameter) =>
    (parameter.constraints ?? []).every((constraint) => collectProviderTypeCallableIdentities(constraint, identities))
    && (parameter.defaultType === undefined || collectProviderTypeCallableIdentities(parameter.defaultType, identities)));
}

function collectProviderParameterCallableIdentities(
  parameters: readonly ProviderParameterDeclaration[],
  identities: Set<string>,
): boolean {
  return parameters.every((parameter) =>
    collectProviderTypeCallableIdentities(parameter.type, identities)
    && (parameter.defaultType === undefined || collectProviderTypeCallableIdentities(parameter.defaultType, identities)));
}

function collectProviderTypeCallableIdentities(
  type: ProviderTypeExpression,
  identities: Set<string>,
): boolean {
  switch (type.kind) {
    case "function":
      return addUniqueIdentity(identities, type.id)
        && collectProviderTypeParameterCallableIdentities(type.typeParameters ?? [], identities)
        && collectProviderParameterCallableIdentities(type.parameters, identities)
        && collectProviderTypeCallableIdentities(type.returnType, identities);
    case "source-global":
    case "provider-ref":
      return (type.typeArguments ?? []).every((argument) => collectProviderTypeCallableIdentities(argument, identities));
    case "array":
      return collectProviderTypeCallableIdentities(type.elementType, identities);
    case "tuple":
      return type.elementTypes.every((element) => collectProviderTypeCallableIdentities(element, identities));
    case "union":
    case "intersection":
      return type.types.every((nested) => collectProviderTypeCallableIdentities(nested, identities));
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
    case "source-primitive":
    case "type-parameter":
    case "literal":
    case "bigint-literal":
      return true;
  }
}

function addUniqueIdentity(identities: Set<string>, identity: string): boolean {
  if (identity.length === 0 || identities.has(identity)) {
    return false;
  }
  identities.add(identity);
  return true;
}
