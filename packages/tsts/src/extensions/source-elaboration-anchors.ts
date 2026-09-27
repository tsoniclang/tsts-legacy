import type { Node, SourceFile } from "../internal/ast/ast.js";
import { Node_End, Node_Pos } from "../internal/ast/spine.js";
import type { SourceProgramQueries } from "./source-program.js";
import { encodeIdentityTuple } from "./identity-tuple.js";
import type { SourceElaborationBudget } from "./source-elaboration-budget.js";

export interface SourceElaborationAnchor {
  readonly fileName: string;
  readonly path: readonly number[];
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
  readonly id: string;
}

export class SourceElaborationAnchors {
  readonly #source: SourceProgramQueries;
  readonly #maximumDepth: number;
  readonly #budget: SourceElaborationBudget;
  readonly #known = new Map<string, SourceElaborationAnchor>();
  readonly #children = new WeakMap<Node, readonly Node[]>();
  readonly #childIndexes = new WeakMap<Node, ReadonlyMap<Node, number>>();
  readonly #anchors = new WeakMap<Node, SourceElaborationAnchor>();

  constructor(source: SourceProgramQueries, maximumDepth: number, budget: SourceElaborationBudget,
    anchors: Iterable<SourceElaborationAnchor>) {
    this.#source = source;
    this.#maximumDepth = maximumDepth;
    this.#budget = budget;
    for (const anchor of anchors) this.#retain(anchor);
  }

  reference(node: Node): SourceElaborationAnchor {
    const cached = this.#anchors.get(node);
    if (cached !== undefined) return cached;
    const file = this.#source.ast.getSourceFile(node);
    if (file === undefined || this.#source.getSourceFile(this.#source.ast.getFileName(file)) !== file) {
      throw new Error("Source elaboration requires syntax from its current compiler epoch.");
    }
    const path: number[] = [];
    const visited = new Set<Node>();
    let child = node;
    while (child !== file) {
      if (visited.has(child) || path.length >= this.#maximumDepth) {
        throw new Error("Source elaboration anchor is cyclic or exceeds its depth budget.");
      }
      visited.add(child);
      const parent = child.Parent;
      if (parent === undefined) throw new Error("Source elaboration anchor has no owning syntax path.");
      this.#readChildren(parent);
      const index = this.#childIndexes.get(parent)!.get(child);
      if (index === undefined) throw new Error("Source elaboration anchor is outside its parent's schema children.");
      path.push(index);
      child = parent;
    }
    path.reverse();
    const fileName = this.#source.ast.getFileName(file);
    const anchor = this.#retain(Object.freeze({
      fileName,
      path: Object.freeze(path),
      kind: node.Kind,
      pos: Node_Pos(node),
      end: Node_End(node),
      id: encodeIdentityTuple([fileName, ...path]),
    }));
    this.#anchors.set(node, anchor);
    return anchor;
  }

  resolve(anchor: SourceElaborationAnchor): Node {
    const file = this.#source.getSourceFile(anchor.fileName);
    if (file === undefined) throw new Error(`Source elaboration file '${anchor.fileName}' is no longer present.`);
    if (anchor.path.length > this.#maximumDepth) throw new Error("Source elaboration anchor exceeds its depth budget.");
    let node: Node = file;
    for (const index of anchor.path) {
      const child = this.#readChildren(node)[index];
      if (child === undefined) throw new Error("Source elaboration anchor no longer resolves to its exact syntax.");
      node = child;
    }
    if (node.Kind !== anchor.kind || Node_Pos(node) !== anchor.pos || Node_End(node) !== anchor.end) {
      throw new Error("Source elaboration anchor no longer matches its exact syntax.");
    }
    this.#anchors.set(node, anchor);
    return node;
  }

  sourceInputs(): ReadonlyMap<string, string> {
    return new Map(this.#source.getSourceFiles().filter((file): file is SourceFile => file !== undefined)
      .map(file => [this.#source.ast.getFileName(file), file.Text()]));
  }

  #retain(anchor: SourceElaborationAnchor): SourceElaborationAnchor {
    const existing = this.#known.get(anchor.id);
    if (existing !== undefined) {
      if (existing.kind !== anchor.kind || existing.pos !== anchor.pos || existing.end !== anchor.end) {
        throw new Error("Source elaboration anchor changed within its input revision.");
      }
      return existing;
    }
    this.#budget.reserve(1 + anchor.path.length, anchor.id.length + anchor.fileName.length);
    this.#known.set(anchor.id, anchor);
    return anchor;
  }

  #readChildren(node: Node): readonly Node[] {
    const cached = this.#children.get(node);
    if (cached !== undefined) return cached;
    const children = Object.freeze(this.#source.ast.children(node).filter((child): child is Node => child !== undefined));
    const indexes = new Map<Node, number>();
    for (const [index, child] of children.entries()) {
      if (indexes.has(child)) throw new Error("Source elaboration syntax contains a repeated child identity.");
      indexes.set(child, index);
    }
    this.#children.set(node, children);
    this.#childIndexes.set(node, indexes);
    return children;
  }
}
