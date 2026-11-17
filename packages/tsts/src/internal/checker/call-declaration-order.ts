import { Node_Members } from "../ast/ast.js";
import type { Node } from "../ast/spine.js";
import type { Symbol } from "../ast/symbol.js";
import { IsInterfaceDeclaration, IsTypeLiteralNode } from "../ast/generated/predicates.js";
import { KindCallSignature, KindConstructSignature } from "../ast/generated/kinds.js";
import { IsClassLike } from "../ast/utilities.js";
import type { ResolvedCallSelectionEvidence, Signature } from "./types.js";

export function callDeclarationOrder(
  signatures: readonly (Signature | undefined)[],
  originals: ReadonlyMap<Signature, Signature>,
  declarationSymbol: (declaration: Node) => Symbol | undefined,
): ResolvedCallSelectionEvidence["declarationOrder"] {
  const unavailable = (): ResolvedCallSelectionEvidence["declarationOrder"] => Object.freeze({ kind: "unavailable" });
  const ordered: { readonly signature: Signature; readonly declaration: Node | undefined }[] = [];
  for (const signature of signatures) {
    if (signature === undefined || signature.composite !== undefined || !originals.has(signature)) return unavailable();
    ordered.push({ signature, declaration: signature.declaration });
  }
  if (ordered.length === 0 || new Set(ordered.map(entry => entry.signature)).size !== ordered.length) return unavailable();
  const first = ordered[0]!;
  if (ordered.length === 1) {
    return first.declaration === undefined && first.signature.constructorClass === undefined ? unavailable()
      : Object.freeze({ kind: "available", signatures: Object.freeze([originals.get(first.signature)!]) });
  }
  if (first.declaration === undefined || ordered.some(entry => entry.declaration === undefined
    || entry.signature.constructorClass !== first.signature.constructorClass)) return unavailable();
  const symbol = declarationSymbol(first.declaration);
  if (ordered.some(entry => declarationSymbol(entry.declaration!) !== symbol)) return unavailable();
  const bound = symbol?.Declarations;
  const parent = first.declaration.Parent;
  const members = parent !== undefined && (IsClassLike(parent) || IsInterfaceDeclaration(parent) || IsTypeLiteralNode(parent))
    ? Node_Members(parent) : undefined;
  const anonymousSignatureGroup = symbol === undefined
    && (first.declaration.Kind === KindCallSignature || first.declaration.Kind === KindConstructSignature);
  const memberGroup = members !== undefined && (symbol !== undefined || anonymousSignatureGroup) && ordered.every(entry =>
    entry.declaration!.Parent === parent && entry.declaration!.Kind === first.declaration!.Kind && members.includes(entry.declaration));
  const declarations = symbol !== undefined && bound !== undefined && ordered.every(entry => bound.includes(entry.declaration))
    ? bound : memberGroup ? members : undefined;
  if (declarations === undefined) return unavailable();
  const ordinals = ordered.map(entry => declarations.indexOf(entry.declaration));
  if (ordinals.some(index => index < 0) || new Set(ordinals).size !== ordered.length) return unavailable();
  ordered.sort((left, right) => declarations.indexOf(left.declaration) - declarations.indexOf(right.declaration));
  return Object.freeze({ kind: "available", signatures: Object.freeze(ordered.map(entry => originals.get(entry.signature)!)) });
}
