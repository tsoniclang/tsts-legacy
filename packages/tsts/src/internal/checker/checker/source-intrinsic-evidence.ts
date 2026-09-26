import type { GoPtr } from "../../../go/compat.js";
import type { Node } from "../../ast/ast.js";
import type { Symbol } from "../../ast/symbol.js";
import { SymbolFlagsAlias } from "../../ast/generated/flags.js";
import { GetSourceFileOfNode, OEKParentheses, SkipOuterExpressions } from "../../ast/utilities.js";
import { getExtensionHost } from "../../../extensions/host.js";
import { providerIntrinsicDeclarationFactKey, type ProviderVirtualDeclarationFact } from "../../../extensions/facts.js";
import type { Checker } from "./state.js";
import { Checker_GetAliasedSymbol, Checker_GetSymbolAtLocation } from "./symbols.js";

export interface SourceIntrinsicDeclarationInfo {
  readonly expression: Node;
  readonly symbol: Symbol;
  readonly declaration: ProviderVirtualDeclarationFact;
}

export function resolveSourceIntrinsicDeclaration(
  checker: GoPtr<Checker>,
  expression: GoPtr<Node>,
): SourceIntrinsicDeclarationInfo | undefined {
  if (checker === undefined || expression === undefined) return undefined;
  const sourceFile = GetSourceFileOfNode(expression);
  if (sourceFile === undefined || !checker.fileIndexMap.has(sourceFile)) {
    throw new Error("Intrinsic identity requires an expression from the owning compiler program.");
  }
  const host = getExtensionHost(checker.program);
  if (host === undefined) return undefined;
  const selected = SkipOuterExpressions(expression, OEKParentheses);
  const binding = Checker_GetSymbolAtLocation(checker, selected);
  const symbol = binding !== undefined && (binding.Flags & SymbolFlagsAlias) !== 0
    ? Checker_GetAliasedSymbol(checker, binding)
    : binding;
  const declaration = host.facts.get(symbol, providerIntrinsicDeclarationFactKey);
  return symbol === undefined || declaration === undefined
    ? undefined
    : Object.freeze({ expression, symbol, declaration });
}
