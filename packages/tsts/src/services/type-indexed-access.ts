import type { GoPtr } from "../go/compat.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Type } from "../internal/checker/types.js";
import {
  AccessFlagsNone, AccessFlagsWriting, TypeFlagsIndexedAccess, TypeFlagsUnion,
  Type_AsIndexedAccessType, Type_Types,
} from "../internal/checker/types.js";
import {
  Checker_getIndexedAccessTypeOrUndefined, Checker_getPropertyOfType,
} from "../internal/checker/checker/symbols.js";
import { Checker_getReducedApparentType } from "../internal/checker/checker/types.js";
import { Checker_getApplicableIndexInfo } from "../internal/checker/checker/signatures.js";
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from "../internal/checker/utilities.js";
import { getExtensionHost } from "../extensions/host.js";
import type { TypeIndexInfo, TypePropertyInfo } from "./type-shape.js";
import { readTypeIndexInfo, readTypePropertyInfo } from "./type-members.js";

export interface TypeIndexedAccessComponents {
  readonly objectType: Type;
  readonly indexType: Type;
}

export type TypeIndexedAccessMember = {
  readonly indexType: Type;
  readonly readType: Type;
  readonly writeType: Type;
} & (
  | { readonly kind: "property"; readonly property: TypePropertyInfo }
  | { readonly kind: "index"; readonly index: TypeIndexInfo }
);

export type TypeIndexedAccessSelection = TypeIndexedAccessComponents & {
  readonly readType: Type;
  readonly writeType: Type;
} & (
  | { readonly kind: "deferred" }
  | { readonly kind: "resolved"; readonly members: readonly TypeIndexedAccessMember[] }
);

export function readTypeIndexedAccessComponents(query: GoPtr<Checker>, type: GoPtr<Type>): TypeIndexedAccessComponents | undefined {
  if (query === undefined || type?.checker === undefined || !ownsChecker(query, type.checker) ||
    (type.flags & TypeFlagsIndexedAccess) === 0) return undefined;
  const indexed = Type_AsIndexedAccessType(type);
  const objectType = indexed?.objectType;
  const indexType = indexed?.indexType;
  return objectType === undefined || indexType === undefined ? undefined : Object.freeze({objectType, indexType});
}

export function selectTypeIndexedAccess(
  query: GoPtr<Checker>, objectType: GoPtr<Type>, indexType: GoPtr<Type>,
): TypeIndexedAccessSelection | undefined {
  const checker = objectType?.checker;
  if (query === undefined || checker === undefined || objectType === undefined || indexType === undefined ||
    !ownsChecker(query, checker) || indexType.checker !== checker ||
    objectType === checker.errorType || indexType === checker.errorType) return undefined;
  const readType = Checker_getIndexedAccessTypeOrUndefined(checker, objectType, indexType, AccessFlagsNone, undefined, undefined);
  const writeType = Checker_getIndexedAccessTypeOrUndefined(checker, objectType, indexType, AccessFlagsWriting, undefined, undefined);
  if (readType === undefined || writeType === undefined || readType === checker.errorType || writeType === checker.errorType) return undefined;
  if ((readType.flags & TypeFlagsIndexedAccess) !== 0 || (writeType.flags & TypeFlagsIndexedAccess) !== 0) {
    return Object.freeze({ kind: "deferred", objectType, indexType, readType, writeType });
  }
  const keys = (indexType.flags & TypeFlagsUnion) === 0 ? [indexType] : Type_Types(indexType);
  const apparent = Checker_getReducedApparentType(checker, objectType);
  if (apparent === undefined || keys.length === 0) return undefined;
  const members: TypeIndexedAccessMember[] = [];
  for (const key of keys) {
    if (key === undefined || key.checker !== checker) return undefined;
    const read = Checker_getIndexedAccessTypeOrUndefined(checker, objectType, key, AccessFlagsNone, undefined, undefined);
    const write = Checker_getIndexedAccessTypeOrUndefined(checker, objectType, key, AccessFlagsWriting, undefined, undefined);
    if (read === undefined || write === undefined || read === checker.errorType || write === checker.errorType) return undefined;
    const symbol = isTypeUsableAsPropertyName(key)
      ? Checker_getPropertyOfType(checker, apparent, getPropertyNameFromType(key)) : undefined;
    if (symbol !== undefined) {
      members.push(Object.freeze({kind: "property", indexType: key, readType: read, writeType: write,
        property: Object.freeze(readTypePropertyInfo(checker, apparent, symbol))}));
      continue;
    }
    const index = Checker_getApplicableIndexInfo(checker, apparent, key);
    if (index === undefined) return undefined;
    members.push(Object.freeze({kind: "index", indexType: key, readType: read, writeType: write,
      index: Object.freeze(readTypeIndexInfo(checker, apparent, index))}));
  }
  return Object.freeze({ kind: "resolved", objectType, indexType, readType, writeType, members: Object.freeze(members) });
}

function ownsChecker(query: Checker, checker: Checker): boolean {
  if (query === checker || query.program === checker.program) return true;
  const owner = getExtensionHost(query.program);
  return owner !== undefined && owner === getExtensionHost(checker.program);
}
