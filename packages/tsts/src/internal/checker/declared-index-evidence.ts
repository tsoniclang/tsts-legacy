import type { Node } from "../ast/spine.js";
import type { Type } from "./types.js";

export class DeclaredIndexReadSource {
  readonly kind: "declared-index-read" = "declared-index-read";
  readonly #declaration: Node;

  private constructor(
    readonly annotation: Node,
    readonly receiver: Type,
    readonly index: Type,
    declaration: Node,
    readonly result: Type,
  ) {
    this.#declaration = declaration;
    Object.freeze(this);
  }

  get declaration(): Node {
    return this.#declaration;
  }

  static retain(annotation: Node, receiver: Type, index: Type, declaration: Node, result: Type): DeclaredIndexReadSource {
    return new DeclaredIndexReadSource(annotation, receiver, index, declaration, result);
  }

  static owns(value: object): value is DeclaredIndexReadSource {
    return #declaration in value;
  }
}

export function hasDeclaredIndexReadEvidence(value: unknown): value is DeclaredIndexReadSource {
  return typeof value === "object" && value !== null && DeclaredIndexReadSource.owns(value);
}
