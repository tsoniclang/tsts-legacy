import type { GoPtr } from "../go/compat.js";
import type { Node } from "../internal/ast/spine.js";
import type { Symbol } from "../internal/ast/symbol.js";
import { SymbolFlagsEnum } from "../internal/ast/symbolflags.js";
import { LinkStore_Get } from "../internal/core/linkstore.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { CachedTypeKindWidened } from "../internal/checker/checker/state.js";
import { Checker_getDeclaredTypeOfSymbol, Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import {
  Checker_getDeclaredTypeOfTypeParameter,
  Checker_getOrCreateTypeFromSignature,
  Checker_getResolvedSignature,
  Checker_getRestrictiveTypeParameter,
  Checker_getReturnTypeOfSignature,
  Checker_getSignatureInstantiation,
  Checker_getSignaturesOfType,
  Checker_getTypeParameterFromMappedType,
} from "../internal/checker/checker/signatures.js";
import { Checker_checkExpressionCached } from "../internal/checker/checker/syntax-checking.js";
import {
  Checker_getIntersectionType,
  Checker_getRegularTypeOfObjectLiteral,
  Checker_getTypeArguments,
  Checker_getUnionTypeEx,
  Checker_getWidenedType,
  Checker_instantiateType,
} from "../internal/checker/checker/types.js";
import { newTypeMapper } from "../internal/checker/mapper.js";
import type { SignatureDerivation, TypeDerivation } from "../internal/checker/derivation.js";
import { reacquireBuiltinSignature, reacquireBuiltinType } from "./type-normalization-builtins.js";
import { reacquireLiteralType } from "./type-normalization-literals.js";
import { reacquireTypeOperator } from "./type-normalization-operators.js";
import { reacquireCachedObjectExpression } from "./type-normalization-expressions.js";
import { cachedSignatureArguments, cachedSignatureConstruction, reacquireCachedSignature, reacquireSignatureInstantiation, reacquireSignatureType } from "./type-normalization-signatures.js";
import { reacquireDeclarationSignature, reacquireDeclaredRestriction, reacquireDeclaredType, reacquireTypeAlias, reacquireTypeReference } from "./type-normalization-declarations.js";
import {
  ObjectFlagsAnonymous,
  ObjectFlagsClassOrInterface,
  ObjectFlagsInstantiated,
  ObjectFlagsInstantiationExpressionType,
  ObjectFlagsMapped,
  ObjectFlagsReference,
  ObjectFlagsReverseMapped,
  SignatureKindCall,
  SignatureKindConstruct,
  TypeFlagsConditional,
  TypeFlagsIntersection,
  TypeFlagsObject,
  TypeFlagsTypeParameter,
  TypeFlagsUnion,
  TypeFlagsUniqueESSymbol,
  Type_AsConditionalType,
  Type_AsInstantiationExpressionType,
  Type_AsTypeParameter,
  Type_AsUnionType,
  Type_Mapper,
  Type_Target,
  Type_Types,
  UnionReductionLiteral,
} from "../internal/checker/types.js";
import type { Signature, Type, TypeNodeLinks } from "../internal/checker/types.js";
import { TypeMapper_Map } from "../internal/checker/mapper.js";

// SDK-4 Unit 1 (W3-3.plan.md R5-15 to R5-18): P's Type for the value a Type of another producer of the same Program
// denotes. Two closed kinds of case: a construction (the Type's own native fields are its complete construction) or a
// recorded derivation (the producing site wrote one record leading to P's cached value through the same native
// operation). A derived Type without its record is an internal defect and throws. The caller guarantees that both
// checkers belong to one Program.
export interface TypeNormalization {
  readonly type: (type: Type) => Type;
}

export function createTypeNormalization(producer: Checker): TypeNormalization {
  const types = new Map<Type, Type>();
  const signatures = new Map<Signature, Signature>();

  const fail = (what: string, type: Type | undefined): never => {
    throw new Error(`Type normalization: ${what} (flags ${type?.flags}, object flags ${type?.objectFlags}).`);
  };

  const list = (values: readonly GoPtr<Type>[] | undefined): Type[] =>
    (values ?? []).map(value => value === undefined ? fail("an undefined type in a list", undefined) : normalize(value));

  const signatureKind = (kind: "call" | "construct") => kind === "call" ? SignatureKindCall : SignatureKindConstruct;

  const normalizeSignature = (source: Checker, signature: Signature): Signature => {
    if (signature.checkerId !== source.id) return fail("a signature without its actual producing context", undefined);
    if (source === producer) return signature;
    const known = signatures.get(signature);
    if (known !== undefined) return known;
    const result = normalizeSignatureWorker(source, signature);
    signatures.set(signature, result);
    return result;
  };

  const normalizeSignatureWorker = (source: Checker, signature: Signature): Signature => {
    const builtin = reacquireBuiltinSignature(source, producer, signature);
    if (builtin !== undefined) return builtin;
    const declared = reacquireDeclarationSignature(source, producer, signature);
    if (declared !== undefined) return declared;
    const construction = cachedSignatureConstruction(source, signature);
    if (construction !== undefined) {
      const target = signature.target ?? fail("a cached signature without its actual source", undefined);
      return reacquireCachedSignature(producer, construction, normalizeSignature(source, target));
    }
    const arguments_ = cachedSignatureArguments(source, signature);
    if (arguments_ !== undefined) {
      const target = signature.target ?? fail("a cached instantiation without its actual source", undefined);
      return reacquireSignatureInstantiation(producer, normalizeSignature(source, target), list(arguments_));
    }
    const record: SignatureDerivation | undefined = signature.derivation;
    if (record !== undefined) {
      switch (record.kind) {
        case "member": {
          const found = Checker_getSignaturesOfType(producer, normalize(record.owner), signatureKind(record.signatureKind))[record.index];
          return found ?? fail(`a member signature at index ${record.index} is missing`, record.owner);
        }
        case "union-member": {
          const constituents = (signature.composite?.signatures ?? []).map(member => member === undefined ? fail("an undefined constituent", undefined) : normalizeSignature(source, member));
          const candidates = Checker_getSignaturesOfType(producer, normalize(record.owner), signatureKind(record.signatureKind));
          const found = candidates.find(candidate => candidate?.derivation?.kind === "union-member" &&
            sameSet(candidate.composite?.signatures ?? [], constituents));
          return found ?? fail("no union signature with the same constituents", record.owner);
        }
        case "intersection-member": {
          const original = normalizeSignature(source, record.source);
          const candidates = Checker_getSignaturesOfType(producer, normalize(record.owner), signatureKind(record.signatureKind));
          const found = candidates.find(candidate => candidate?.derivation?.kind === "intersection-member" && candidate.derivation.source === original);
          return found ?? fail("no intersection signature cloned from the same source", record.owner);
        }
        case "instantiated-from":
          return Checker_getSignatureInstantiation(producer, normalizeSignature(source, record.signature), list(record.typeArguments), record.isJavaScript, list(record.inferredTypeParameters))
            ?? fail("an instantiation returned nothing", undefined);
        case "resolved-at":
          return Checker_getResolvedSignature(producer, record.node, undefined, 0)
            ?? fail("a call node has no resolved signature", undefined);
        case "return-of": {
          const returnType = Checker_getReturnTypeOfSignature(producer, normalizeSignature(source, record.signature));
          return Checker_getSignaturesOfType(producer, returnType, SignatureKindCall)[0] ?? fail("a return type has no call signature", returnType);
        }
      }
    }
    return fail("a derived signature without its record", undefined);
  };

  const normalize = (type: Type): Type => {
    if (type.checker === producer || type.checker === undefined) return type;
    const known = types.get(type);
    if (known !== undefined) return known;
    const result = normalizeWorker(type);
    types.set(type, result);
    return result;
  };

  const literalOwner = (node: Node, mode: "normal" | "contextual", type: Type): Type =>
    mode === "normal" ? Checker_checkExpressionCached(producer, node) ?? fail("a literal node has no type", type)
      : fail("a contextually checked literal is reached only through its call", type);

  const normalizeRecorded = (type: Type, record: TypeDerivation): Type => {
    const source = type.checker ?? fail("a derived type without its actual producer", type);
    switch (record.kind) {
      case "restrictive-of":
        return Checker_getRestrictiveTypeParameter(producer, normalize(record.typeParameter)) ?? fail("no restrictive parameter", type);
      case "signature-clone":
      case "inferred-unique":
        return normalizeSignature(source, record.signature).typeParameters[record.index] ?? fail("a cloned parameter index is missing", type);
      case "mapped-clone":
        return Checker_getTypeParameterFromMappedType(producer, normalize(record.mapped)) ?? fail("no mapped type parameter", type);
      case "from-signature":
        return Checker_getOrCreateTypeFromSignature(producer, normalizeSignature(source, record.signature)) ?? fail("no signature type", type);
      case "literal":
        return literalOwner(record.node, record.mode, type);
      case "regular-of":
        return Checker_getRegularTypeOfObjectLiteral(producer, normalize(record.fresh)) ?? fail("no regular literal type", type);
      case "widened-from":
        return Checker_getWidenedType(producer, normalize(record.source)) ?? fail("no widened type", type);
      case "widened-in":
        return contextWidened(type, record);
      case "spread-of":
        return Checker_checkExpressionCached(producer, record.node) ?? fail("a spread literal has no type", type);
      case "rest-of":
        return Checker_getTypeOfSymbol(producer, record.symbol) ?? fail("a rest binding has no type", type);
      case "inferred-at": {
        const resolved = Checker_getResolvedSignature(producer, record.node, undefined, 0)
          ?? fail("a call node has no resolved signature", type);
        return resolvedTypeArgument(resolved, record.index, type);
      }
    }
  };

  const resolvedTypeArgument = (resolved: Signature, index: number, type: Type): Type => {
    const instantiation = resolved.derivation;
    if (instantiation?.kind === "instantiated-from") {
      const argument = normalize(instantiation.typeArguments[index] ?? fail("an inferred argument index is missing", type));
      return argument;
    }
    const sources = resolved.target?.typeParameters ?? [];
    const parameter = sources[index] ?? fail("an inferred argument index is missing", type);
    return (resolved.mapper === undefined ? undefined : TypeMapper_Map(resolved.mapper, parameter)) ?? fail("an inferred argument has no image", type);
  };

  const contextWidened = (type: Type, record: Extract<TypeDerivation, { kind: "widened-in" }>): Type => {
    const literal = record.literal ?? fail("a context-widened type has no literal", type);
    const sourceChecker = type.checker ?? fail("a context-widened type has no producer", type);
    let widenedRoot: Type;
    if (literal.mode === "normal") {
      widenedRoot = Checker_getWidenedType(producer, normalize(record.root)) ?? fail("no widened root", type);
    } else {
      const handedOut = sourceChecker.cachedTypes.get({ kind: CachedTypeKindWidened, typeId: record.root.id });
      widenedRoot = normalize(handedOut ?? fail("the widened root of a contextual literal is not cached", type));
    }
    const key = contextWidenedKey(widenedRoot, record.root, record.path, literal);
    const found = producer.contextWidenedTypes?.get(contextWidenedLookup(key)) ?? findContextWidened(widenedRoot, record.path, literal);
    return found ?? fail("no context-widened type with the same path and literal", type);
  };

  const findContextWidened = (widenedRoot: Type, path: readonly string[], literal: { node: Node; mode: string }): Type | undefined => {
    const members = (widenedRoot.flags & TypeFlagsUnion) !== 0 ? Type_Types(widenedRoot) ?? [] : [widenedRoot];
    for (const member of members) {
      const record = member?.derivation;
      if (record?.kind === "widened-in" && record.literal?.node === literal.node && record.literal.mode === literal.mode &&
        record.path.length === path.length && record.path.every((name, index) => name === path[index])) return member;
    }
    return undefined;
  };

  const normalizeTypeParameter = (type: Type): Type => {
    const data = Type_AsTypeParameter(type) ?? fail("a type parameter without data", type);
    if (data.isThisType) {
      const constraint = data.constraint ?? fail("a this type without its class", type);
      const declared = normalize(constraint);
      return (declared.data as { thisType?: Type }).thisType ?? fail("a class without a this type", declared);
    }
    const declared = Checker_getDeclaredTypeOfTypeParameter(type.checker, type.symbol);
    if (declared !== type) fail("a type parameter that is not its declaration's own and has no record", type);
    return Checker_getDeclaredTypeOfTypeParameter(producer, type.symbol) ?? fail("no declared type parameter", type);
  };

  const outerArguments = (type: Type, declaration: Node | undefined): { parameters: Type[]; arguments: Type[] } => {
    const owner = type.checker ?? fail("an instantiation without a producer", type);
    if (declaration === undefined) return fail("an instantiation without a declaration", type);
    const links = LinkStore_Get(owner.typeNodeLinks, declaration) as GoPtr<TypeNodeLinks>;
    const parameters = links?.outerTypeParameters ?? fail("an instantiation whose outer parameters are not computed", type);
    const mapper = Type_Mapper(type) ?? fail("an instantiation without a mapper", type);
    const images = parameters.map(parameter => TypeMapper_Map(mapper, parameter));
    return { parameters: list(parameters), arguments: list(images) };
  };

  const normalizeWorker = (type: Type): Type => {
    const record = type.derivation;
    if (record !== undefined) return normalizeRecorded(type, record);
    const singleton = reacquireBuiltinType(producer, type);
    if (singleton !== undefined) return singleton;
    const declared = reacquireDeclaredType(producer, type);
    if (declared !== undefined) return declared;
    const restriction = reacquireDeclaredRestriction(producer, type);
    if (restriction !== undefined) return restriction;
    const signatureType = reacquireSignatureType(producer, type, signature => {
      const source = type.checker ?? fail("a signature type without its actual producer", type);
      return normalizeSignature(source, signature);
    });
    if (signatureType !== undefined) return signatureType;
    const alias = reacquireTypeAlias(producer, type, normalize);
    if (alias !== undefined) return alias;
    if (type.alias !== undefined) return fail("an alias without its complete cached native construction", type);
    const flags = type.flags;
    const literalType = reacquireLiteralType(producer, type);
    if (literalType !== undefined) return literalType;
    if ((flags & TypeFlagsUniqueESSymbol) !== 0) {
      return Checker_getTypeOfSymbol(producer, type.symbol) ?? fail("a unique symbol without its type", type);
    }
    if ((flags & TypeFlagsTypeParameter) !== 0) return normalizeTypeParameter(type);
    if ((flags & TypeFlagsUnion) !== 0) {
      const symbol: Symbol | undefined = type.symbol;
      if (symbol !== undefined && (symbol.Flags & SymbolFlagsEnum) !== 0 && Checker_getDeclaredTypeOfSymbol(type.checker, symbol) === type) {
        return Checker_getDeclaredTypeOfSymbol(producer, symbol) ?? fail("no declared enum type", type);
      }
      const origin = Type_AsUnionType(type)?.origin;
      return Checker_getUnionTypeEx(producer, list(Type_Types(type)), UnionReductionLiteral, undefined, origin === undefined ? undefined : normalize(origin))
        ?? fail("a union returned nothing", type);
    }
    if ((flags & TypeFlagsIntersection) !== 0) {
      return Checker_getIntersectionType(producer, list(Type_Types(type))) ?? fail("an intersection returned nothing", type);
    }
    const operation = reacquireTypeOperator(producer, type, normalize);
    if (operation !== undefined) return operation;
    const reference = reacquireTypeReference(producer, type, normalize);
    if (reference !== undefined) return reference;
    const expression = reacquireCachedObjectExpression(producer, type);
    if (expression !== undefined) return expression;
    if ((flags & TypeFlagsConditional) !== 0) {
      const data = Type_AsConditionalType(type) ?? fail("a conditional type without data", type);
      const root = data.root ?? fail("a conditional type without root", type);
      const owner = type.checker ?? fail("a conditional type without a producer", type);
      const declared = LinkStore_Get(owner.typeNodeLinks, root.node) as GoPtr<TypeNodeLinks>;
      const declaredType = declared?.resolvedType ?? fail("a conditional type node without its type", type);
      if (declaredType === type) {
        const links = LinkStore_Get(producer.typeNodeLinks, root.node) as GoPtr<TypeNodeLinks>;
        return links?.resolvedType ?? fail("the producer has not resolved the conditional type node", type);
      }
      const parameters = list(root.outerTypeParameters);
      const mapper = data.mapper ?? fail("a conditional instantiation without a mapper", type);
      const images = list((root.outerTypeParameters ?? []).map(parameter => TypeMapper_Map(mapper, parameter)));
      return Checker_instantiateType(producer, normalize(declaredType), newTypeMapper(parameters, images)) ?? fail("a conditional instantiation returned nothing", type);
    }
    if ((flags & TypeFlagsObject) !== 0) {
      const objectFlags = type.objectFlags;
      if ((objectFlags & ObjectFlagsReverseMapped) !== 0) {
        return fail("a reverse mapping without its complete native construction", type);
      }
      if ((objectFlags & ObjectFlagsReference) !== 0) {
        return fail("a reference without its complete cached native construction", type);
      }
      if ((objectFlags & ObjectFlagsClassOrInterface) !== 0) {
        return Checker_getDeclaredTypeOfSymbol(producer, type.symbol) ?? fail("no declared type", type);
      }
      if ((objectFlags & ObjectFlagsInstantiated) !== 0 && (objectFlags & (ObjectFlagsAnonymous | ObjectFlagsMapped)) !== 0) {
        const target = Type_Target(type) ?? fail("an instantiation without target", type);
        const declaration = (objectFlags & ObjectFlagsInstantiationExpressionType) !== 0
          ? Type_AsInstantiationExpressionType(type)?.node : type.symbol?.Declarations?.[0];
        const { parameters, arguments: images } = outerArguments(type, declaration);
        return Checker_instantiateType(producer, normalize(target), newTypeMapper(parameters, images)) ?? fail("an instantiation returned nothing", type);
      }
    }
    return fail("a derived type without its record", type);
  };

  return { type: normalize };
}

function sameSet(left: readonly GoPtr<Signature>[], right: readonly Signature[]): boolean {
  if (left.length !== right.length) return false;
  const members = new Set<GoPtr<Signature>>(left);
  return right.every(signature => members.has(signature));
}

function contextWidenedKey(widenedRoot: Type, root: Type, path: readonly string[], literal: { node: Node; mode: string }): string {
  return `${widenedRoot.id}/${path.join(".")}/${literal.mode}`;
}

function contextWidenedLookup(key: string): string {
  return key;
}
