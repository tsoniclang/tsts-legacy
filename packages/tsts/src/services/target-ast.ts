import type { SourceFile } from "../internal/ast/ast.js";
import { AsSourceFile } from "../internal/ast/ast.js";
import type { Node } from "../internal/ast/spine.js";
import { NewNodeFactory } from "../internal/ast/spine.js";
import type { NodeFactory } from "../internal/ast/generated/factory.js";
import type { NodeVisitor } from "../internal/ast/visitor.js";
import {
  NewNodeVisitor,
  NodeVisitor_VisitEachChild,
  NodeVisitor_VisitSourceFile,
} from "../internal/ast/visitor.js";

export type TargetAstRewrite = (
  original: Node,
  updated: Node,
  factory: NodeFactory,
) => Node;

export function transformTargetSourceFile(
  sourceFile: SourceFile,
  rewrite: TargetAstRewrite,
): SourceFile {
  const factory = NewNodeFactory({});
  let visitor: NodeVisitor | undefined;
  visitor = NewNodeVisitor(
    (original) => {
      if (original === undefined || visitor === undefined || factory === undefined) {
        throw new globalThis.Error("target AST visitor state is absent");
      }
      const updated = NodeVisitor_VisitEachChild(visitor, original);
      if (updated === undefined) {
        throw new globalThis.Error("target AST rewrite removed a required node");
      }
      return rewrite(original, updated, factory);
    },
    factory,
    {},
  );
  const result = NodeVisitor_VisitSourceFile(visitor, sourceFile);
  if (result === undefined || AsSourceFile(result.data.AsNode()) === undefined) {
    throw new globalThis.Error("target AST rewrite did not produce a source file");
  }
  return result;
}

export {
  encodeTargetSourceFileForPrinting,
  TargetAstEncodingError,
} from "./target-ast-encoding.js";
export * from "../internal/ast/generated/casts.js";
export * from "../internal/ast/generated/factory.js";
export * from "../internal/ast/generated/kinds.js";
export * from "../internal/ast/generated/predicates.js";
export { NodeFactory_UpdateSourceFile } from "../internal/ast/ast.js";
export { NodeFactory_NewNodeList } from "../internal/ast/spine.js";
export type { Node, NodeFactory, SourceFile };
