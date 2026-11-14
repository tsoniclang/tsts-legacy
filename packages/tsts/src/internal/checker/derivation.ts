import type { Node } from "../ast/spine.js";
import type { Symbol } from "../ast/symbol.js";
import type { Signature, Type } from "./types.js";

// The record a producing site writes on a Type it creates when the native operation erased the context a second
// producer of the same Program needs to obtain the same value (SDK-4 Unit 1, W3-3.plan.md R5-15 to R5-18). Each record
// leads to that producer's own cached value through the same native operation. A Type carries at most one record.
export type TypeDerivation =
  // A restrictive copy of a type parameter (getRestrictiveTypeParameter).
  | { readonly kind: "restrictive-of"; readonly typeParameter: Type }
  // A type parameter cloned for an instantiated signature (instantiateSignatureEx), at its index.
  | { readonly kind: "signature-clone"; readonly signature: Signature; readonly index: number }
  // A type parameter cloned for an instantiated mapped type (instantiateAnonymousType).
  | { readonly kind: "mapped-clone"; readonly mapped: Type }
  // An inference-unique type parameter (getUniqueTypeParameters) of an inferred return signature, at its index.
  | { readonly kind: "inferred-unique"; readonly signature: Signature; readonly index: number }
  // The type of a signature (getOrCreateTypeFromSignature), including a single-signature type.
  | { readonly kind: "from-signature"; readonly signature: Signature }
  // An object literal type made by checkObjectLiteral, with the mode it was checked in. Only a normal-mode literal is
  // obtained again through its node's cached type.
  | { readonly kind: "literal"; readonly node: Node; readonly mode: "normal" | "contextual" }
  // The regular type of a fresh object literal type (getRegularTypeOfObjectLiteral).
  | { readonly kind: "regular-of"; readonly fresh: Type }
  // An object literal type widened without a context (getWidenedTypeWithContext, cached by the source's id).
  | { readonly kind: "widened-from"; readonly source: Type }
  // An object literal type widened inside a context: the root type whose widening created the context, the property
  // path from it, and the literal the source came from.
  | {
      readonly kind: "widened-in";
      readonly root: Type;
      readonly path: readonly string[];
      readonly literal: { readonly node: Node; readonly mode: "normal" | "contextual" } | undefined;
    }
  // An object spread result that is an object literal's checked type: the literal's node owns the cached value.
  | { readonly kind: "spread-of"; readonly node: Node }
  // An object rest result that is a binding's declared type: the binding symbol owns the cached value.
  | { readonly kind: "rest-of"; readonly symbol: Symbol }
  // A type argument inferred for the call at node, at index, whose derivation has no record readable without the call.
  | { readonly kind: "inferred-at"; readonly node: Node; readonly index: number };

// The record a producing site writes on a Signature it creates.
export type SignatureDerivation =
  // A resolved member signature of an instantiated class, interface or anonymous type, at its declaration-order index.
  | { readonly kind: "member"; readonly owner: Type; readonly signatureKind: "call" | "construct"; readonly index: number }
  // A union type's signature, made from the constituent signatures held natively in its composite.
  | { readonly kind: "union-member"; readonly owner: Type; readonly signatureKind: "call" | "construct" }
  // An intersection type's mixin construct signature, cloned from source.
  | { readonly kind: "intersection-member"; readonly owner: Type; readonly signatureKind: "call" | "construct"; readonly source: Signature }
  // A signature instantiated with type arguments (cached in the source signature's instantiations).
  | { readonly kind: "instantiated-from"; readonly signature: Signature; readonly typeArguments: readonly Type[];
      readonly isJavaScript: boolean; readonly inferredTypeParameters: readonly Type[] }
  // The signature a call node stores as its resolved signature, made uncached by inference.
  | { readonly kind: "resolved-at"; readonly node: Node }
  // The return signature of an inferred higher-order instantiation: the signature of the single-signature type
  // that is the return type of the resolved signature.
  | { readonly kind: "return-of"; readonly signature: Signature };
