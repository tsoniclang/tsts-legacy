import type { Node } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_GetIndexInfosOfType } from "../internal/checker/exports.js";
import { Type_Types, TypeFlagsUnion, type IndexInfo, type Type } from "../internal/checker/types.js";
import type { GoPtr } from "../go/compat.js";

export function typeIndexComponents(
  checker: GoPtr<Checker>,
  sourceType: GoPtr<Type>,
  index: GoPtr<IndexInfo>,
): readonly GoPtr<Node>[] {
  const keyType = index?.keyType;
  if (checker === undefined || sourceType === undefined || keyType === undefined) return Object.freeze([]);
  if ((sourceType.flags & TypeFlagsUnion) === 0) return Object.freeze([...(index?.components ?? [])]);
  const visited = new Set<Type>();
  const active = new Set<Type>();
  const declarations = new Set<Node>();
  const pending: { readonly type: Type; readonly complete: boolean }[] = [{ type: sourceType, complete: false }];
  while (pending.length !== 0) {
    const { type, complete } = pending.pop()!;
    if (complete) {
      active.delete(type);
      visited.add(type);
      continue;
    }
    if (active.has(type)) return Object.freeze([]);
    if (visited.has(type)) continue;
    active.add(type);
    pending.push({ type, complete: true });
    if ((type.flags & TypeFlagsUnion) !== 0) {
      const members = Type_Types(type);
      if (members === undefined || members.length === 0 || members.some(member => member === undefined)) return Object.freeze([]);
      for (const member of members) pending.push({ type: member!, complete: false });
      continue;
    }
    const matches = Checker_GetIndexInfosOfType(checker, type).filter(info => info?.keyType === keyType);
    const info = matches.length === 1 ? matches[0] : undefined;
    const components = info?.declaration === undefined ? info?.components : [info.declaration];
    if (components === undefined || components.length === 0 || components.some(node => node === undefined)) return Object.freeze([]);
    for (const declaration of components) declarations.add(declaration!);
  }
  return Object.freeze([...declarations]);
}
