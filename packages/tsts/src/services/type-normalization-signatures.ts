import type { Checker } from "../internal/checker/checker/state.js";
import type { GoPtr } from "../go/compat.js";
import { goReceiverKey } from "../internal/ast/spine.js";
import { CheckModeNormal, SignatureKeyBase, SignatureKeyCanonical, SignatureKeyErased, SignatureKeyInner, SignatureKeyOuter, getTypeListKey } from "../internal/checker/checker/state.js";
import { Checker_getBaseSignature, Checker_getCanonicalSignature, Checker_getErasedSignature, Checker_getOptionalCallSignature, Checker_getOrCreateTypeFromSignature, Checker_getResolvedSignature, Checker_getSignatureInstantiationWithoutFillingInTypeArguments } from "../internal/checker/checker/signatures.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { TypeMapper_Kind, TypeMapperKindArray, TypeMapperKindSimple } from "../internal/checker/mapper.js";
import type { ArrayTypeMapper, SimpleTypeMapper } from "../internal/checker/mapper.js";
import { ObjectFlagsSingleSignatureType, SignatureFlagsIsInnerCallChain, SignatureFlagsIsOuterCallChain, TypeFlagsObject, Type_AsStructuredType } from "../internal/checker/types.js";
import type { Signature, Type } from "../internal/checker/types.js";

export type CachedSignatureConstruction = "erased" | "canonical" | "base" | "inner-call" | "outer-call";

export function reacquireHigherOrderSignature(source: Checker, producer: Checker, signature: Signature,
  normalize: (signature: Signature) => Signature): Signature | undefined {
  if (signature.checkerId !== source.id) throw new TypeError("A native signature construction requires its actual producer");
  const derivation = signature.derivation;
  if (derivation === undefined) return undefined;
  if (source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native higher-order signature requires the same actual Program");
  if (derivation.kind === "higher-order") {
    const original = LinkStore_TryGet(source.signatureLinks, derivation.at);
    let result: Signature | undefined;
    if (original?.resolvedSignature === signature) {
      result = Checker_getResolvedSignature(producer, derivation.at, undefined, CheckModeNormal);
    } else {
      const evidence = original?.resolvedCallSelectionEvidence;
      if (evidence?.kind !== "conditional-candidates") return undefined;
      const candidates = evidence.candidates.filter(candidate => candidate.application.instantiatedSignature === signature);
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (candidate === undefined) return undefined;
      const selected = normalize(candidate.application.signature);
      if (selected.checkerId !== producer.id)
        throw new TypeError("A native conditional candidate requires its normalized original signature producer");
      Checker_getResolvedSignature(producer, derivation.at, undefined, CheckModeNormal);
      const completed = LinkStore_TryGet(producer.signatureLinks, derivation.at)?.resolvedCallSelectionEvidence;
      if (completed?.kind !== "conditional-candidates")
        throw new Error("The native invocation retains its actual conditional candidate answer");
      const matching = completed.candidates.filter(value => value.application.signature === selected
        && value.application.kind === candidate.application.kind);
      if (matching.length !== 1)
        throw new Error("Native conditional candidate normalization is unfinished for this producing relation");
      result = matching[0]?.application.instantiatedSignature;
    }
    if (result === undefined || result.checkerId !== producer.id || result.derivation?.kind !== "higher-order")
      throw new Error("The native invocation retains its actual higher-order result");
    return result;
  }
  const owner = derivation.signature;
  if (owner.checkerId !== source.id || owner.derivation?.kind !== "higher-order"
    || owner.derivation.returned !== signature) return undefined;
  const selected = normalize(owner);
  if (selected.checkerId !== producer.id || selected.derivation?.kind !== "higher-order")
    throw new TypeError("A native higher-order return requires its normalized signature producer");
  return selected.derivation.returned;
}

export function cachedSignatureArguments(source: Checker, signature: Signature): readonly GoPtr<Type>[] | undefined {
  if (signature.checkerId !== source.id) throw new TypeError("A native signature construction requires its actual producer");
  const target = signature.target;
  const mapper = signature.mapper;
  if (target === undefined || mapper === undefined) return undefined;
  let arguments_: GoPtr<Type>[];
  switch (TypeMapper_Kind(mapper)) {
    case TypeMapperKindSimple: {
      const data = mapper.data[goReceiverKey] as SimpleTypeMapper | undefined;
      if (data === undefined) throw new TypeError("A native simple mapper requires its actual construction data");
      arguments_ = [data.target];
      break;
    }
    case TypeMapperKindArray: {
      const data = mapper.data[goReceiverKey] as ArrayTypeMapper | undefined;
      if (data === undefined) throw new TypeError("A native array mapper requires its actual construction data");
      arguments_ = data.targets;
      break;
    }
    default: return undefined;
  }
  if (arguments_.some(type => type === undefined)) throw new TypeError("A native cached instantiation requires its actual arguments");
  return source.cachedSignatures.get({ sig: target, key: getTypeListKey(arguments_) }) === signature ? arguments_ : undefined;
}

export function reacquireSignatureInstantiation(producer: Checker, signature: Signature, arguments_: Type[]): Signature {
  if (signature.checkerId !== producer.id || arguments_.some(type => type.checker !== producer)) {
    throw new TypeError("A native signature instantiation requires its normalized input producer");
  }
  const result = Checker_getSignatureInstantiationWithoutFillingInTypeArguments(producer, signature, arguments_);
  if (result === undefined) throw new Error("The native signature instantiation did not return its value");
  return result;
}

export function reacquireSignatureType(producer: Checker, type: Type, normalize: (signature: Signature) => Signature): Type | undefined {
  if ((type.flags & TypeFlagsObject) === 0 || (type.objectFlags & ObjectFlagsSingleSignatureType) === 0) return undefined;
  const data = Type_AsStructuredType(type);
  const signature = data?.signatures?.[0];
  if (data?.signatures?.length !== 1 || signature?.isolatedSignatureType !== type) return undefined;
  if (type.checker === undefined || signature.checkerId !== type.checker.id) throw new TypeError("A native signature type requires its actual producer");
  const normalized = normalize(signature);
  if (normalized.checkerId !== producer.id) throw new TypeError("A native signature type requires its normalized signature producer");
  const result = Checker_getOrCreateTypeFromSignature(producer, normalized);
  if (result === undefined) throw new Error("The native isolated signature constructor did not return its value");
  return result;
}

export function cachedSignatureConstruction(source: Checker, signature: Signature): CachedSignatureConstruction | undefined {
  if (signature.checkerId !== source.id) throw new TypeError("A native signature construction requires its actual producer");
  const target = signature.target;
  if (target === undefined) return undefined;
  if (source.cachedSignatures.get({ sig: target, key: SignatureKeyErased }) === signature) return "erased";
  if (source.cachedSignatures.get({ sig: target, key: SignatureKeyCanonical }) === signature) return "canonical";
  if (source.cachedSignatures.get({ sig: target, key: SignatureKeyBase }) === signature) return "base";
  if (source.cachedSignatures.get({ sig: target, key: SignatureKeyInner }) === signature) return "inner-call";
  if (source.cachedSignatures.get({ sig: target, key: SignatureKeyOuter }) === signature) return "outer-call";
  return undefined;
}

export function reacquireCachedSignature(producer: Checker, construction: CachedSignatureConstruction, signature: Signature): Signature {
  if (signature.checkerId !== producer.id) throw new TypeError("A native signature constructor requires its normalized input producer");
  let result: Signature | undefined;
  switch (construction) {
    case "erased": result = Checker_getErasedSignature(producer, signature); break;
    case "canonical": result = Checker_getCanonicalSignature(producer, signature); break;
    case "base": result = Checker_getBaseSignature(producer, signature); break;
    case "inner-call": result = Checker_getOptionalCallSignature(producer, signature, SignatureFlagsIsInnerCallChain); break;
    case "outer-call": result = Checker_getOptionalCallSignature(producer, signature, SignatureFlagsIsOuterCallChain); break;
  }
  if (result === undefined) throw new Error("The native cached signature constructor did not return its value");
  return result;
}
