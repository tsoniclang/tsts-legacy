import type { Checker } from "../internal/checker/checker/state.js";
import { CachedTypeKindRegularObjectLiteral, CachedTypeKindWidened } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionCached } from "../internal/checker/checker/syntax-checking.js";
import { Checker_getRegularTypeOfObjectLiteral, Checker_getWidenedType } from "../internal/checker/checker/types.js";
import { IsObjectLiteralExpression } from "../internal/ast/generated/predicates.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import type { Type } from "../internal/checker/types.js";

export function reacquireCachedObjectExpression(producer: Checker, type: Type): Type | undefined {
  if (type.alias !== undefined) return undefined;
  const source = type.checker;
  if (source === undefined) throw new TypeError("A native object expression requires its actual producer");
  const node = type.symbol?.ValueDeclaration;
  if (node === undefined || !IsObjectLiteralExpression(node)) return undefined;
  const original = LinkStore_TryGet(source.typeNodeLinks, node)?.resolvedType;
  if (original === undefined) return undefined;
  let construction: "expression" | "regular" | "widened";
  if (original === type) construction = "expression";
  else if (source.cachedTypes.get({ kind: CachedTypeKindRegularObjectLiteral, typeId: original.id }) === type) construction = "regular";
  else if (source.cachedTypes.get({ kind: CachedTypeKindWidened, typeId: original.id }) === type) construction = "widened";
  else return undefined;
  const selected = Checker_checkExpressionCached(producer, node);
  if (selected === undefined) throw new Error("The native cached expression did not return its value");
  const result = construction === "regular" ? Checker_getRegularTypeOfObjectLiteral(producer, selected)
    : construction === "widened" ? Checker_getWidenedType(producer, selected) : selected;
  if (result === undefined) throw new Error("The native object expression construction did not return its value");
  return result;
}
