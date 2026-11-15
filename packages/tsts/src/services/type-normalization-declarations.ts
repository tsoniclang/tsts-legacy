import type { Checker } from "../internal/checker/checker/state.js";
import { CachedTypeKindRestrictiveTypeParameter, getTupleKey, getTypeAliasInstantiationKey, getTypeInstantiationKey } from "../internal/checker/checker/state.js";
import { cachedReferenceInputs } from "../internal/checker/checker.js";
import { Checker_getRestrictiveTypeParameter, Checker_getSignatureFromDeclaration, Checker_getTypeParameterFromMappedType } from "../internal/checker/checker/signatures.js";
import { Checker_getDeclaredTypeOfSymbol, Checker_getSymbolOfDeclaration, Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { SymbolFlagsFunction, SymbolFlagsMethod } from "../internal/ast/generated/flags.js";
import { CheckFlagsLate } from "../internal/ast/checkflags.js";
import { Node_Symbol, SourceFile_FileName } from "../internal/ast/ast.js";
import type { Symbol as NativeSymbol } from "../internal/ast/symbol.js";
import { Checker_createTypeReference, Checker_getTupleTargetType, Checker_getTypeFromTypeNode } from "../internal/checker/checker/types.js";
import { Checker_getObjectTypeInstantiation, Checker_getTypeAliasInstantiation } from "../internal/checker/checker/inference.js";
import { newTypeMapper, TypeMapper_Map } from "../internal/checker/mapper.js";
import { GetSourceFileOfNode, IsTypeNode } from "../internal/ast/utilities.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { ObjectFlagsClassOrInterface, ObjectFlagsInstantiated, ObjectFlagsMapped, ObjectFlagsReference, ObjectFlagsSingleSignatureType, ObjectFlagsTuple, TypeFlagsConditional, TypeFlagsObject, TypeFlagsTypeParameter,
  Type_AsConditionalType, Type_AsInterfaceType, Type_AsMappedType, Type_AsObjectType, Type_AsTupleType, Type_AsTypeParameter, Type_Target } from "../internal/checker/types.js";
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

export function reacquireCachedLateBoundSymbol(source: Checker, producer: Checker, symbol: NativeSymbol): NativeSymbol | undefined {
  if (symbol.checkerId !== source.id) throw new TypeError("A native late-bound symbol requires its actual producing checker");
  const declaration = symbol.ValueDeclaration;
  const early = declaration === undefined ? undefined : Node_Symbol(declaration);
  if ((symbol.CheckFlags & CheckFlagsLate) === 0 || declaration === undefined || early === undefined
    || early.checkerId !== undefined) return undefined;
  const file = GetSourceFileOfNode(declaration);
  if (file === undefined || source.program.GetSourceFile(SourceFile_FileName(file)) !== file
    || LinkStore_TryGet(source.symbolNodeLinks, declaration)?.resolvedSymbol !== symbol
    || LinkStore_TryGet(source.lateBoundLinks, early)?.lateSymbol !== symbol) return undefined;
  if (source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native late-bound symbol requires the same actual Program");
  const result = Checker_getSymbolOfDeclaration(producer, declaration);
  if (result === undefined || result.checkerId !== producer.id
    || LinkStore_TryGet(producer.symbolNodeLinks, declaration)?.resolvedSymbol !== result
    || LinkStore_TryGet(producer.lateBoundLinks, early)?.lateSymbol !== result)
    throw new TypeError("The actual declaration retains both target-owned late-bound symbol cache relations");
  return result;
}

export function reacquireCachedFunctionType(producer: Checker, type: Type): Type | undefined {
  if (type.alias !== undefined || (type.flags & TypeFlagsObject) === 0) return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native function value requires its actual producing checker");
  const symbol = type.symbol;
  if (symbol === undefined || (symbol.Flags & (SymbolFlagsFunction | SymbolFlagsMethod)) === 0
    || LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType !== type) return undefined;
  const selected = symbol.checkerId === undefined ? symbol : reacquireCachedLateBoundSymbol(source, producer, symbol);
  if (selected === undefined) return undefined;
  if (symbol.checkerId === undefined && source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native function value requires the same actual Program");
  const result = Checker_getTypeOfSymbol(producer, selected);
  if (result === undefined || result.checker !== producer || result.symbol !== selected
    || LinkStore_TryGet(producer.valueSymbolLinks, selected)?.resolvedType !== result)
    throw new TypeError("The actual function symbol retains its target producer's cached value");
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
  const arguments_ = cachedReferenceInputs(source, type);
  if (arguments_ === undefined) return undefined;
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

export function reacquireRestrictiveParameter(producer: Checker, type: Type, normalize: (type: Type) => Type): Type | undefined {
  if ((type.flags & TypeFlagsTypeParameter) === 0 || type.derivation?.kind !== "restrictive") return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native parameter restriction requires its actual producer");
  if (source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native parameter restriction requires the same actual Program");
  const original = type.derivation.source;
  if (original.checker !== source ||
    source.cachedTypes.get({ kind: CachedTypeKindRestrictiveTypeParameter, typeId: original.id }) !== type) return undefined;
  const selected = normalize(original);
  if (selected.checker !== producer || (selected.flags & TypeFlagsTypeParameter) === 0)
    throw new TypeError("A native parameter restriction requires its normalized input producer");
  const result = Checker_getRestrictiveTypeParameter(producer, selected);
  if (result === undefined) throw new Error("The native parameter restriction did not return its value");
  return result;
}

export function reacquireMappedParameter(producer: Checker, type: Type, normalize: (type: Type) => Type): Type | undefined {
  if ((type.flags & TypeFlagsTypeParameter) === 0 || type.derivation?.kind !== "mapped-parameter") return undefined;
  const source = type.checker;
  if (source === undefined || source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A mapped native parameter requires its actual producer in the same Program");
  const mapped = type.derivation.mapped;
  if (mapped.checker !== source || (mapped.flags & TypeFlagsObject) === 0 || (mapped.objectFlags & ObjectFlagsMapped) === 0
    || Type_AsMappedType(mapped)?.typeParameter !== type) return undefined;
  const selected = normalize(mapped);
  if (selected.checker !== producer || (selected.flags & TypeFlagsObject) === 0 || (selected.objectFlags & ObjectFlagsMapped) === 0)
    throw new TypeError("A mapped native parameter requires its normalized actual mapped owner");
  const result = Checker_getTypeParameterFromMappedType(producer, selected);
  if (result === undefined || result.checker !== producer)
    throw new Error("The native mapped instantiation retains its actual parameter");
  return result;
}

export function reacquireCachedTypeNode(producer: Checker, type: Type): Type | undefined {
  if (type.alias !== undefined) return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native cached type node requires its actual source owner");
  if (source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native cached type node requires the same actual Program");
  const node = (type.flags & TypeFlagsConditional) !== 0 ? Type_AsConditionalType(type)?.root?.node
    : type.symbol?.Declarations?.find(declaration => declaration !== undefined && IsTypeNode(declaration)
      && LinkStore_TryGet(source.typeNodeLinks, declaration)?.resolvedType === type);
  if (node === undefined) return undefined;
  if (LinkStore_TryGet(source.typeNodeLinks, node)?.resolvedType !== type) return undefined;
  const result = Checker_getTypeFromTypeNode(producer, node);
  if (result === undefined) throw new Error("The native cached type node did not return its value");
  return result;
}

export function reacquireAnonymousInstantiation(producer: Checker, type: Type, normalize: (type: Type) => Type): Type | undefined {
  if (type.alias !== undefined || (type.flags & TypeFlagsObject) === 0 || (type.objectFlags & ObjectFlagsInstantiated) === 0
    || (type.objectFlags & (ObjectFlagsReference | ObjectFlagsSingleSignatureType)) !== 0) return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native anonymous instantiation requires its actual source owner");
  if (source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native anonymous instantiation requires the same actual Program");
  const data = Type_AsObjectType(type);
  if (data === undefined) return undefined;
  const target = data.target;
  if (target === undefined || target === type || target.checker !== source) return undefined;
  const declaration = target.symbol?.Declarations?.[0];
  const parameters = declaration === undefined ? undefined : LinkStore_TryGet(source.typeNodeLinks, declaration)?.outerTypeParameters;
  if (parameters === undefined || parameters.length === 0) return undefined;
  const arguments_: Type[] = [];
  for (const parameter of parameters) {
    if (parameter === undefined) throw new TypeError("A native anonymous instantiation retains its actual outer parameters");
    const argument = TypeMapper_Map(data.mapper, parameter);
    if (argument === undefined) throw new TypeError("A native anonymous instantiation retains its actual outer arguments");
    arguments_.push(argument);
  }
  if (Type_AsObjectType(target)?.instantiations?.get(getTypeInstantiationKey(arguments_, undefined, false)) !== type) return undefined;
  const selected = normalize(target);
  const selectedParameters: Type[] = [];
  const selectedArguments: Type[] = [];
  for (const parameter of parameters) {
    if (parameter === undefined) throw new TypeError("A native anonymous instantiation retains its actual outer parameters");
    selectedParameters.push(normalize(parameter));
  }
  for (const argument of arguments_) selectedArguments.push(normalize(argument));
  if (selected.checker !== producer || selectedParameters.some(parameter => parameter.checker !== producer)
    || selectedArguments.some(argument => argument.checker !== producer))
    throw new TypeError("A native anonymous instantiation requires its normalized input producer");
  const result = Checker_getObjectTypeInstantiation(producer, selected, newTypeMapper(selectedParameters, selectedArguments), undefined);
  if (result === undefined) throw new Error("The native cached anonymous instantiation did not return its value");
  return result;
}
