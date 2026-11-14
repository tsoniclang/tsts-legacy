import type { Checker } from "../internal/checker/checker/state.js";
import { CachedTypeKindRestrictiveTypeParameter, getTupleKey, getTypeAliasInstantiationKey, getTypeListKey } from "../internal/checker/checker/state.js";
import { Checker_getRestrictiveTypeParameter, Checker_getSignatureFromDeclaration } from "../internal/checker/checker/signatures.js";
import { Checker_getDeclaredTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_createTypeReference, Checker_getTupleTargetType } from "../internal/checker/checker/types.js";
import { Checker_getTypeAliasInstantiation } from "../internal/checker/checker/inference.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { ObjectFlagsClassOrInterface, ObjectFlagsReference, ObjectFlagsTuple, TypeFlagsObject, TypeFlagsTypeParameter,
  Type_AsInterfaceType, Type_AsObjectType, Type_AsTupleType, Type_AsTypeParameter, Type_AsTypeReference, Type_Target } from "../internal/checker/types.js";
import type { Signature, Type } from "../internal/checker/types.js";

export function reacquireDeclarationSignature(source: Checker, producer: Checker, signature: Signature): Signature | undefined {
  if (signature.checkerId !== source.id) throw new TypeError("A native signature construction requires its actual producer");
  const declaration = signature.declaration;
  if (declaration === undefined || LinkStore_TryGet(source.signatureLinks, declaration)?.resolvedSignature !== signature) return undefined;
  const result = Checker_getSignatureFromDeclaration(producer, declaration);
  if (result === undefined) throw new Error("The native declaration signature constructor did not return its value");
  return result;
}

export function reacquireDeclaredType(producer: Checker, type: Type): Type | undefined {
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native type construction requires its actual producer");
  const symbol = type.symbol;
  if (symbol === undefined) return undefined;
  const declared = LinkStore_TryGet(source.declaredTypeLinks, symbol)?.declaredType;
  if (declared === type) {
    const result = Checker_getDeclaredTypeOfSymbol(producer, symbol);
    if (result === undefined) throw new Error("The native declared type constructor did not return its value");
    return result;
  }
  if ((type.flags & TypeFlagsTypeParameter) === 0 || declared === undefined || (declared.objectFlags & ObjectFlagsClassOrInterface) === 0) return undefined;
  if (!Type_AsTypeParameter(type)?.isThisType || Type_AsTypeParameter(type)?.constraint !== declared || Type_AsInterfaceType(declared)?.thisType !== type) return undefined;
  const owner = Checker_getDeclaredTypeOfSymbol(producer, symbol);
  const result = Type_AsInterfaceType(owner)?.thisType;
  if (result === undefined) throw new Error("The native declared self constructor did not return its value");
  return result;
}

export function reacquireTypeReference(producer: Checker, type: Type, normalize: (type: Type) => Type): Type | undefined {
  if (type.alias !== undefined || (type.flags & TypeFlagsObject) === 0 || (type.objectFlags & ObjectFlagsReference) === 0) return undefined;
  const source = type.checker;
  const target = Type_Target(type);
  if (source === undefined || target?.checker !== source) throw new TypeError("A native reference requires its actual target producer");
  if (target === type) {
    if ((type.objectFlags & ObjectFlagsTuple) === 0) return undefined;
    const tuple = Type_AsTupleType(type);
    if (tuple === undefined || source.tupleTypes.get(getTupleKey(tuple.elementInfos, tuple.readonly)) !== type) return undefined;
    const result = Checker_getTupleTargetType(producer, tuple.elementInfos, tuple.readonly);
    if (result === undefined) throw new Error("The native tuple target constructor did not return its value");
    return result;
  }
  const arguments_ = Type_AsTypeReference(type)?.resolvedTypeArguments;
  if (arguments_ === undefined || Type_AsObjectType(target)?.instantiations.get(getTypeListKey(arguments_)) !== type) return undefined;
  const selectedTarget = normalize(target);
  if (selectedTarget.checker !== producer) throw new TypeError("A native reference requires its normalized input producer");
  const selectedArguments: Type[] = [];
  for (const value of arguments_) {
    if (value === undefined) throw new TypeError("A native reference requires its actual type arguments");
    const selected = normalize(value);
    if (selected.checker !== producer) throw new TypeError("A native reference requires its normalized input producer");
    selectedArguments.push(selected);
  }
  const result = Checker_createTypeReference(producer, selectedTarget, selectedArguments);
  if (result === undefined) throw new Error("The native reference constructor did not return its value");
  return result;
}

export function reacquireTypeAlias(producer: Checker, type: Type, normalize: (type: Type) => Type): Type | undefined {
  const alias = type.alias;
  if (alias?.symbol === undefined) return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native type alias requires its actual producer");
  const links = LinkStore_TryGet(source.typeAliasLinks, alias.symbol);
  let result: Type | undefined;
  if (links?.declaredType === type) {
    result = Checker_getDeclaredTypeOfSymbol(producer, alias.symbol);
  } else {
    if (links?.instantiations?.get(getTypeAliasInstantiationKey(alias.typeArguments, undefined)) !== type) return undefined;
    const arguments_: Type[] = [];
    for (const value of alias.typeArguments) {
      if (value === undefined) throw new TypeError("A native type alias requires its actual arguments");
      const selected = normalize(value);
      if (selected.checker !== producer) throw new TypeError("A native type alias requires its normalized input producer");
      arguments_.push(selected);
    }
    result = Checker_getTypeAliasInstantiation(producer, alias.symbol, arguments_, undefined);
  }
  if (result === undefined) throw new Error("The native type alias constructor did not return its value");
  return result;
}

export function reacquireDeclaredRestriction(producer: Checker, type: Type): Type | undefined {
  if ((type.flags & TypeFlagsTypeParameter) === 0 || type.symbol === undefined) return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native parameter restriction requires its actual producer");
  const declared = LinkStore_TryGet(source.declaredTypeLinks, type.symbol)?.declaredType;
  if (declared === undefined || (declared.flags & TypeFlagsTypeParameter) === 0 ||
    source.cachedTypes.get({ kind: CachedTypeKindRestrictiveTypeParameter, typeId: declared.id }) !== type) return undefined;
  const selected = Checker_getDeclaredTypeOfSymbol(producer, type.symbol);
  if (selected === undefined) throw new Error("The native restriction requires its actual declared parameter");
  const result = Checker_getRestrictiveTypeParameter(producer, selected);
  if (result === undefined) throw new Error("The native parameter restriction did not return its value");
  return result;
}
