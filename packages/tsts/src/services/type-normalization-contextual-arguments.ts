import { CheckModeNormal } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_getResolvedSignature } from "../internal/checker/checker/signatures.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import type { Type } from "../internal/checker/types.js";

export function reacquireContextualArgument(producer: Checker, type: Type): Type | undefined {
  const recipe = type.derivation;
  if (recipe?.kind !== "inferred-at") return undefined;
  const source = type.checker;
  if (source === undefined || source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A contextual argument retains its actual producer in the same Program");
  const original = LinkStore_TryGet(source.signatureLinks, recipe.at);
  const evidence = original?.resolvedCallSelectionEvidence;
  if (!Number.isSafeInteger(recipe.index) || recipe.index < 0 || Object.is(recipe.index, -0)
    || evidence?.kind !== "applicable" || evidence.selection.application.invocation !== recipe.at
    || evidence.selection.application.instantiatedSignature !== original?.resolvedSignature
    || evidence.selection.application.signatureTypeArguments[recipe.index]?.checkedArgument !== type)
    return undefined;
  const signature = Checker_getResolvedSignature(producer, recipe.at, undefined, CheckModeNormal);
  const selected = LinkStore_TryGet(producer.signatureLinks, recipe.at)?.resolvedCallSelectionEvidence;
  if (signature === undefined || selected?.kind !== "applicable" || selected.selection.application.instantiatedSignature !== signature)
    throw new Error("The target retains the actual completed selected application");
  const result = selected.selection.application.signatureTypeArguments[recipe.index]?.checkedArgument;
  if (result === undefined || result.checker !== producer || result.derivation?.kind !== "inferred-at"
    || result.derivation.at !== recipe.at || result.derivation.index !== recipe.index)
    throw new Error("The native selected application retains its actual contextual argument");
  return result;
}
