import type { SourceFile } from "../internal/ast/ast.js";
import { AsSourceFile } from "../internal/ast/ast.js";
import type { Node } from "../internal/ast/spine.js";
import { NewNodeFactory } from "../internal/ast/spine.js";
import type { NodeFactory } from "../internal/ast/generated/factory.js";
import type { NodeVisitor } from "../internal/ast/visitor.js";
import {
  NewNodeVisitor,
  NodeVisitor_VisitEachChild,
  NodeVisitor_VisitNode,
} from "../internal/ast/visitor.js";
import { KindSourceFile } from "../internal/ast/generated/kinds.js";
import { NodeDefault_AsNode } from "../internal/ast/spine.js";

export type TargetAstRewrite = (
  original: Node,
  updated: Node,
  factory: NodeFactory,
) => Node | undefined;

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
        if (original.Kind === KindSourceFile) {
          throw new globalThis.Error("target AST child rewrite removed the source file");
        }
        return undefined;
      }
      const rewritten = rewrite(original, updated, factory);
      if (rewritten === undefined && original.Kind === KindSourceFile) {
        throw new globalThis.Error("target AST rewrite removed the source file");
      }
      return rewritten;
    },
    factory,
    {},
  );
  const result = NodeVisitor_VisitNode(visitor, NodeDefault_AsNode(sourceFile));
  if (result === undefined || result.Kind !== KindSourceFile) {
    throw new globalThis.Error(
      `target AST rewrite did not produce a source file (kind=${result === undefined ? "absent" : String(result.Kind)})`,
    );
  }
  const transformed = AsSourceFile(result);
  if (transformed === undefined) {
    throw new globalThis.Error("target AST rewrite lost its source-file receiver");
  }
  return transformed;
}

export {
  encodeTargetSourceFileForPrinting,
  TargetAstEncodingError,
} from "./target-ast-encoding.js";
export * from "../internal/ast/generated/casts.js";
export * from "../internal/ast/generated/factory.js";
export * from "../internal/ast/generated/kinds.js";
export * from "../internal/ast/generated/predicates.js";
export { AsSourceFile, NodeFactory_UpdateSourceFile } from "../internal/ast/ast.js";
export { NodeFactory_NewNodeList } from "../internal/ast/spine.js";
export type { Node, NodeFactory, SourceFile };
