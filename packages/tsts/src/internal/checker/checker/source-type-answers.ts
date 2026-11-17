import type { Node } from "../../ast/spine.js";
import type { Diagnostic } from "../../ast/diagnostic.js";
import type { Checker } from "./state.js";
import type { Type } from "../types.js";
import { LinkStore_TryGet } from "../../core/linkstore.js";

export interface ResolvedSourceTypeInfo {
  readonly type: Type;
  readonly cause: Diagnostic | undefined;
}

export interface SourceTypeAnswerOutput {
  value: ResolvedSourceTypeInfo | undefined;
}

export function sourceTypeAnswer(checker: Checker | undefined, node: Node | undefined,
  type: Type | undefined): ResolvedSourceTypeInfo | undefined {
  if (checker === undefined || node === undefined || type === undefined) return undefined;
  const retained = LinkStore_TryGet(checker.typeNodeLinks, node);
  return { type, cause: retained?.resolvedType === type ? retained.resolutionFailure : undefined };
}
