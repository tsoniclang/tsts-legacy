import type { Checker } from "../internal/checker/checker/state.js";
import { getIntersectionKey, getUnionKey, IntersectionFlagsNone, IntersectionFlagsNoConstraintReduction,
  UnionReductionNone } from "../internal/checker/checker/state.js";
import { Checker_getIntersectionTypeEx, Checker_getUnionTypeEx } from "../internal/checker/checker/types.js";
import { TypeFlagsIntersection, TypeFlagsUnion, Type_AsUnionType, Type_Types } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";

export function reacquireCompositeType(producer: Checker, type: Type, normalize: (type: Type) => Type): Type | undefined {
  if (type.alias !== undefined || (type.flags & (TypeFlagsUnion | TypeFlagsIntersection)) === 0) return undefined;
  const source = type.checker;
  if (source === undefined || source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("A native composite type retains its actual Program and producer");
  const members = Type_Types(type);
  const union = (type.flags & TypeFlagsUnion) !== 0;
  const origin = union ? Type_AsUnionType(type)?.origin : undefined;
  let intersectionFlags = IntersectionFlagsNone;
  if (union) {
    if (source.unionTypes.get(getUnionKey(members, origin, undefined)) !== type) return undefined;
  } else if (source.intersectionTypes.get(getIntersectionKey(members, intersectionFlags, undefined)) !== type) {
    intersectionFlags = IntersectionFlagsNoConstraintReduction;
    if (source.intersectionTypes.get(getIntersectionKey(members, intersectionFlags, undefined)) !== type) return undefined;
  }
  const selected: Type[] = [];
  for (const member of members) {
    if (member === undefined || member.checker !== source)
      throw new TypeError("A native composite type retains its actual member producers");
    const value = normalize(member);
    if (value.checker !== producer) throw new TypeError("A native composite type requires normalized member producers");
    selected.push(value);
  }
  const selectedOrigin = origin === undefined ? undefined : normalize(origin);
  if (selectedOrigin !== undefined && selectedOrigin.checker !== producer)
    throw new TypeError("A native union origin requires its normalized producer");
  const result = union ? Checker_getUnionTypeEx(producer, selected, UnionReductionNone, undefined, selectedOrigin)
    : Checker_getIntersectionTypeEx(producer, selected, intersectionFlags, undefined);
  if (result === undefined || result.checker !== producer)
    throw new Error("The native composite constructor retains its actual result producer");
  return result;
}
