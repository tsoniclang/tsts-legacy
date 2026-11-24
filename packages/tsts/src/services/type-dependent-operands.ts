import type { GoPtr } from "../go/compat.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { IndexFlags, Type, TypeFlags } from "../internal/checker/types.js";
import { Type_AsIndexType, Type_AsSubstitutionType, Type_AsTemplateLiteralType, TypeFlagsIndex, TypeFlagsSubstitution,
  TypeFlagsTemplateLiteral } from "../internal/checker/types.js";

export interface TypeKeyOfComponents {
  readonly target: Type;
  readonly indexFlags: IndexFlags;
}

export interface TypeSubstitutionComponents {
  readonly base: Type;
  readonly constraint: Type;
}

export interface TypeTemplateLiteralComponents {
  readonly texts: readonly string[];
  readonly types: readonly GoPtr<Type>[];
}

function owns(checker: GoPtr<Checker>, type: GoPtr<Type>, family: TypeFlags): type is Type {
  return checker !== undefined && type?.checker === checker && (type.flags & family) !== 0 && type.data.AsType() === type;
}

export function readTypeKeyOfComponents(checker: GoPtr<Checker>, type: GoPtr<Type>): TypeKeyOfComponents | undefined {
  if (!owns(checker, type, TypeFlagsIndex)) return undefined;
  const index = Type_AsIndexType(type);
  const target = index?.target;
  if (index === undefined || target === undefined || target.checker !== checker) return undefined;
  return Object.freeze({ target, indexFlags: index.indexFlags });
}

export function readTypeSubstitutionComponents(checker: GoPtr<Checker>, type: GoPtr<Type>): TypeSubstitutionComponents | undefined {
  if (!owns(checker, type, TypeFlagsSubstitution)) return undefined;
  const substitution = Type_AsSubstitutionType(type);
  const base = substitution?.baseType;
  const constraint = substitution?.constraint;
  if (base === undefined || constraint === undefined || base.checker !== checker || constraint.checker !== checker) return undefined;
  return Object.freeze({ base, constraint });
}

export function readTypeTemplateLiteralComponents(checker: GoPtr<Checker>, type: GoPtr<Type>): TypeTemplateLiteralComponents | undefined {
  if (!owns(checker, type, TypeFlagsTemplateLiteral)) return undefined;
  const template = Type_AsTemplateLiteralType(type);
  if (template === undefined || template.texts.length !== template.types.length + 1) return undefined;
  return Object.freeze({ texts: template.texts, types: template.types });
}
