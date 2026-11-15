import type { Checker } from "../internal/checker/checker/state.js";
import { CachedTypeKindRegularObjectLiteral, CachedTypeKindWidened } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionCached } from "../internal/checker/checker/syntax-checking.js";
import { Checker_getRegularTypeOfObjectLiteral, Checker_getWidenedType } from "../internal/checker/checker/types.js";
import { Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { hasDotDotDotToken } from "../internal/checker/utilities.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { IsBindingElement, IsObjectBindingPattern, IsObjectLiteralExpression } from "../internal/ast/generated/predicates.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { ObjectFlagsObjectRestType, TypeFlagsObject } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";

export function reacquireCachedRestType(producer: Checker, type: Type): Type | undefined {
  if (type.alias !== undefined || (type.flags & TypeFlagsObject) === 0 || (type.objectFlags & ObjectFlagsObjectRestType) === 0)
    return undefined;
  const source = type.checker;
  if (source === undefined || source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native rest binding retains its actual producer in the same Program");
  const symbol = type.symbol;
  const declaration = symbol?.ValueDeclaration;
  if (symbol === undefined || declaration === undefined || !IsBindingElement(declaration)
    || !IsObjectBindingPattern(declaration.Parent) || !hasDotDotDotToken(declaration)
    || Node_Symbol(declaration) !== symbol || LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType !== type)
    return undefined;
  const result = Checker_getTypeOfSymbol(producer, symbol);
  if (result === undefined || result.checker !== producer)
    throw new Error("The actual binding's native cached Type retains its producer");
  return result;
}

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
