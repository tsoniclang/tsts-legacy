import type { GoPtr } from "../go/compat.js";
import { goReceiverKey } from "../internal/ast/spine.js";
import { TypeMapper_Kind, TypeMapperKindArray, TypeMapperKindSimple } from "../internal/checker/mapper.js";
import type { ArrayTypeMapper, SimpleTypeMapper, TypeMapper } from "../internal/checker/mapper.js";
import type { Type } from "../internal/checker/types.js";

export function flatTypeMapperInputs(mapper: TypeMapper): {
  readonly sources: GoPtr<Type>[];
  readonly targets: GoPtr<Type>[];
} | undefined {
  switch (TypeMapper_Kind(mapper)) {
    case TypeMapperKindSimple: {
      const data = mapper.data[goReceiverKey] as SimpleTypeMapper | undefined;
      if (data === undefined) throw new TypeError("A native simple mapper requires its actual construction data");
      return { sources: [data.source], targets: [data.target] };
    }
    case TypeMapperKindArray: {
      const data = mapper.data[goReceiverKey] as ArrayTypeMapper | undefined;
      if (data === undefined) throw new TypeError("A native array mapper requires its actual construction data");
      return data;
    }
    default: return undefined;
  }
}
