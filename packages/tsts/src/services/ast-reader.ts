import type { bool } from "../go/scalars.js";
import type { GoPtr } from "../go/compat.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import {
  Node_Arguments,
  Node_Body,
  Node_Elements,
  Node_ImportClause,
  Node_Members,
  Node_ModifierFlags,
  Node_ModifierNodes,
  Node_Parameters,
  Node_Properties,
  Node_QuestionToken,
  Node_Statements,
  Node_Text,
  Node_Type,
  Node_TypeArguments,
  Node_TypeParameters,
  SourceFile_FileName,
  SourceFile_Path,
  SourceFile_Text,
} from "../internal/ast/ast.js";
import { Node_End, Node_ForEachChild, Node_Name, Node_Pos } from "../internal/ast/spine.js";
import type { Kind } from "../internal/ast/generated/kinds.js";
import { KindString } from "../internal/ast/generated/kinds.js";
import * as casts from "../internal/ast/generated/casts.js";
import * as predicates from "../internal/ast/generated/predicates.js";
import { NodeFlagsBlockScoped, NodeFlagsNone } from "../internal/ast/generated/flags.js";
import {
  ModifierFlagsAbstract,
  ModifierFlagsAmbient,
  ModifierFlagsAsync,
  ModifierFlagsConst,
  ModifierFlagsDefault,
  ModifierFlagsExport,
  ModifierFlagsOverride,
  ModifierFlagsPrivate,
  ModifierFlagsProtected,
  ModifierFlagsPublic,
  ModifierFlagsReadonly,
  ModifierFlagsStatic,
} from "../internal/ast/modifierflags.js";
import { GetCombinedNodeFlags, GetHeritageElements, GetSourceFileOfNode, HasModifier, IsConstAssertion, IsTypeOnlyImportDeclaration, IsTypeOnlyImportOrExportDeclaration, IsVarAwaitUsing, IsVarConst, IsVarLet, IsVarUsing, NodeIsSynthesized } from "../internal/ast/utilities.js";
import { KindExtendsKeyword, KindImplementsKeyword } from "../internal/ast/generated/kinds.js";
import {
  ComputePositionMap,
  PositionMap_UTF8ToUTF16,
} from "../internal/ast/positionmap.js";
import { GetTokenPosOfNode } from "../internal/scanner/scanner.js";

export type AstModifierKind =
  | "public"
  | "private"
  | "protected"
  | "readonly"
  | "override"
  | "export"
  | "abstract"
  | "ambient"
  | "static"
  | "async"
  | "default"
  | "const";

export type AstVariableDeclarationKind = "var" | "let" | "const" | "using" | "await using";

export type AstAuthoredRange =
  | {
      readonly kind: "authored";
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "synthetic" };

export interface AstReader {
  readonly kind: (node: GoPtr<Node>) => Kind | undefined;
  readonly kindName: (node: GoPtr<Node>) => string;
  readonly text: (node: GoPtr<Node>) => string;
  readonly name: (node: GoPtr<Node>) => GoPtr<Node>;
  readonly body: (node: GoPtr<Node>) => GoPtr<Node>;
  readonly parent: (node: GoPtr<Node>) => GoPtr<Node>;
  readonly children: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly forEachChild: (node: GoPtr<Node>, callback: (child: GoPtr<Node>) => void) => void;
  readonly statements: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly members: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly parameters: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  /** Returns the exact authored type node owned by syntax whose TS-Go schema permits one. */
  readonly typeNode: (node: GoPtr<Node>) => GoPtr<Node>;
  readonly typeParameters: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly typeArguments: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly arguments: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly elements: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly properties: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  /** Returns the exact `?` token owned by nodes whose schema permits one. */
  readonly questionToken: (node: GoPtr<Node>) => GoPtr<Node>;
  /** Returns the exact operator kind name for binary, update, and type-operator syntax. */
  readonly operatorKindName: (node: GoPtr<Node>) => string | undefined;
  readonly modifiers: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly modifierFlags: (node: GoPtr<Node>) => number;
  readonly hasModifier: (node: GoPtr<Node>, flags: number) => boolean;
  /** Tests syntactic modifiers. `"const"` means the `const enum` modifier, not a variable declaration kind. */
  readonly hasModifierKind: (node: GoPtr<Node>, kind: AstModifierKind) => boolean;
  /** Classifies a variable statement, declaration list, or direct variable declaration. */
  readonly variableDeclarationKind: (node: GoPtr<Node>) => AstVariableDeclarationKind | undefined;
  /** Uses TS-Go's canonical grammar predicate for `as const` and `<const>` assertions. */
  readonly isConstAssertion: (node: GoPtr<Node>) => boolean;
  readonly heritageElements: (node: GoPtr<Node>, kind: "extends" | "implements") => readonly GoPtr<Node>[];
  readonly extendsHeritageElements: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly implementsHeritageElements: (node: GoPtr<Node>) => readonly GoPtr<Node>[];
  readonly isTypeOnlyImportDeclaration: (node: GoPtr<Node>) => boolean;
  readonly isTypeOnlyImportOrExportDeclaration: (node: GoPtr<Node>) => boolean;
  readonly pos: (node: GoPtr<Node>) => number;
  readonly end: (node: GoPtr<Node>) => number;
  /** Returns trivia-free UTF-16 offsets into the exact checked source text. */
  readonly authoredRange: (node: GoPtr<Node>) => AstAuthoredRange;
  readonly getSourceFile: (node: GoPtr<Node>) => GoPtr<SourceFile>;
  readonly getFileName: (sourceFile: GoPtr<SourceFile>) => string;
  readonly getPath: (sourceFile: GoPtr<SourceFile>) => string;
  readonly getSourceText: (sourceFile: GoPtr<SourceFile>) => string;
  readonly isDeclarationFile: (sourceFile: GoPtr<SourceFile>) => boolean;
  readonly is: typeof predicates;
  readonly as: typeof casts;
}

export function createAstReader(): AstReader {
  const reader: AstReader = {
    kind: (node) => node?.Kind,
    kindName: (node) => node === undefined ? "Undefined" : KindString(node.Kind),
    text: (node) => node === undefined ? "" : Node_Text(node),
    name: (node) => node === undefined ? undefined : Node_Name(node),
    body: (node) => node === undefined ? undefined : Node_Body(node),
    parent: (node) => node?.Parent,
    children: collectChildren,
    forEachChild: (node, callback) => {
      if (node === undefined) {
        return;
      }
      Node_ForEachChild(node, (child) => {
        callback(child);
        return false as bool;
      });
    },
    statements: (node) => Node_Statements(node) ?? [],
    members: (node) => Node_Members(node) ?? [],
    parameters: (node) => Node_Parameters(node) ?? [],
    typeNode: (node) => node === undefined ? undefined : Node_Type(node),
    typeParameters: (node) => Node_TypeParameters(node) ?? [],
    typeArguments: (node) => Node_TypeArguments(node) ?? [],
    arguments: (node) => Node_Arguments(node) ?? [],
    elements: (node) => Node_Elements(node) ?? [],
    properties: (node) => Node_Properties(node) ?? [],
    questionToken: (node) => node === undefined ? undefined : Node_QuestionToken(node),
    operatorKindName,
    modifiers: (node) => Node_ModifierNodes(node) ?? [],
    modifierFlags: (node) => node === undefined ? 0 : Node_ModifierFlags(node),
    hasModifier: (node, flags) => node !== undefined && HasModifier(node, flags) === true,
    hasModifierKind: (node, kind) => node !== undefined && HasModifier(node, modifierFlagForKind(kind)) === true,
    variableDeclarationKind,
    isConstAssertion: (node) => node !== undefined && IsConstAssertion(node) === true,
    heritageElements: (node, kind) => GetHeritageElements(node, kind === "extends" ? KindExtendsKeyword : KindImplementsKeyword) ?? [],
    extendsHeritageElements: (node) => GetHeritageElements(node, KindExtendsKeyword) ?? [],
    implementsHeritageElements: (node) => GetHeritageElements(node, KindImplementsKeyword) ?? [],
    isTypeOnlyImportDeclaration: (node) => {
      if (node === undefined) {
        return false;
      }
      if (predicates.IsImportDeclaration(node)) {
        const importClause = Node_ImportClause(node);
        return importClause !== undefined
          && IsTypeOnlyImportDeclaration(importClause) === true;
      }
      return IsTypeOnlyImportDeclaration(node) === true;
    },
    isTypeOnlyImportOrExportDeclaration: (node) => {
      if (node === undefined) {
        return false;
      }
      if (predicates.IsImportDeclaration(node)) {
        const importClause = Node_ImportClause(node);
        return importClause !== undefined
          && IsTypeOnlyImportOrExportDeclaration(importClause) === true;
      }
      return IsTypeOnlyImportOrExportDeclaration(node) === true;
    },
    pos: (node) => node === undefined ? -1 : Node_Pos(node),
    end: (node) => node === undefined ? -1 : Node_End(node),
    authoredRange,
    getSourceFile: (node) => GetSourceFileOfNode(node),
    getFileName: (sourceFile) => sourceFile === undefined ? "" : SourceFile_FileName(sourceFile),
    getPath: (sourceFile) => sourceFile === undefined ? "" : SourceFile_Path(sourceFile),
    getSourceText: (sourceFile) => sourceFile === undefined ? "" : SourceFile_Text(sourceFile),
    isDeclarationFile: (sourceFile) => sourceFile?.IsDeclarationFile === true,
    is: predicates,
    as: casts,
  };
  return Object.freeze(reader);
}

function authoredRange(node: GoPtr<Node>): AstAuthoredRange {
  if (node === undefined || NodeIsSynthesized(node)) {
    return Object.freeze({ kind: "synthetic" });
  }
  const sourceFile = GetSourceFileOfNode(node);
  if (sourceFile === undefined) {
    return Object.freeze({ kind: "synthetic" });
  }
  const positionMap = authoredPositionMap(sourceFile);
  const start = PositionMap_UTF8ToUTF16(
    positionMap,
    GetTokenPosOfNode(node, sourceFile, false as bool),
  );
  const end = PositionMap_UTF8ToUTF16(positionMap, Node_End(node));
  if (start < 0 || end < start) {
    return Object.freeze({ kind: "synthetic" });
  }
  return Object.freeze({ kind: "authored", start, end });
}

const authoredPositionMaps = new WeakMap<SourceFile, NonNullable<ReturnType<typeof ComputePositionMap>>>();

function authoredPositionMap(
  sourceFile: SourceFile,
): NonNullable<ReturnType<typeof ComputePositionMap>> {
  const existing = authoredPositionMaps.get(sourceFile);
  if (existing !== undefined) {
    return existing;
  }
  const created = ComputePositionMap(SourceFile_Text(sourceFile));
  if (created === undefined) {
    throw new Error("TS-Go position map construction returned no result.");
  }
  authoredPositionMaps.set(sourceFile, created);
  return created;
}

function operatorKindName(node: GoPtr<Node>): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (predicates.IsBinaryExpression(node)) {
    const operator = casts.AsBinaryExpression(node)?.OperatorToken;
    return operator === undefined ? undefined : KindString(operator.Kind);
  }
  if (predicates.IsPrefixUnaryExpression(node)) {
    const operator = casts.AsPrefixUnaryExpression(node)?.Operator;
    return operator === undefined ? undefined : KindString(operator);
  }
  if (predicates.IsPostfixUnaryExpression(node)) {
    const operator = casts.AsPostfixUnaryExpression(node)?.Operator;
    return operator === undefined ? undefined : KindString(operator);
  }
  if (predicates.IsTypeOperatorNode(node)) {
    const operator = casts.AsTypeOperatorNode(node)?.Operator;
    return operator === undefined ? undefined : KindString(operator);
  }
  return undefined;
}

function variableDeclarationKind(node: GoPtr<Node>): AstVariableDeclarationKind | undefined {
  const declarationList = variableDeclarationList(node);
  if (declarationList === undefined) {
    return undefined;
  }
  if (IsVarAwaitUsing(declarationList)) {
    return "await using";
  }
  if (IsVarUsing(declarationList)) {
    return "using";
  }
  if (IsVarConst(declarationList)) {
    return "const";
  }
  if (IsVarLet(declarationList)) {
    return "let";
  }
  return (GetCombinedNodeFlags(declarationList) & NodeFlagsBlockScoped) === NodeFlagsNone ? "var" : undefined;
}

function variableDeclarationList(node: GoPtr<Node>): GoPtr<Node> {
  if (node === undefined) {
    return undefined;
  }
  if (predicates.IsVariableStatement(node)) {
    return casts.AsVariableStatement(node)?.DeclarationList;
  }
  if (predicates.IsVariableDeclarationList(node)) {
    return node;
  }
  if (predicates.IsVariableDeclaration(node) && predicates.IsVariableDeclarationList(node.Parent)) {
    return node.Parent;
  }
  return undefined;
}

function modifierFlagForKind(kind: AstModifierKind): number {
  switch (kind) {
    case "public":
      return ModifierFlagsPublic;
    case "private":
      return ModifierFlagsPrivate;
    case "protected":
      return ModifierFlagsProtected;
    case "readonly":
      return ModifierFlagsReadonly;
    case "override":
      return ModifierFlagsOverride;
    case "export":
      return ModifierFlagsExport;
    case "abstract":
      return ModifierFlagsAbstract;
    case "ambient":
      return ModifierFlagsAmbient;
    case "static":
      return ModifierFlagsStatic;
    case "async":
      return ModifierFlagsAsync;
    case "default":
      return ModifierFlagsDefault;
    case "const":
      return ModifierFlagsConst;
  }
}

function collectChildren(node: GoPtr<Node>): readonly GoPtr<Node>[] {
  if (node === undefined) {
    return [];
  }
  const children: GoPtr<Node>[] = [];
  Node_ForEachChild(node, (child) => {
    children.push(child);
    return false as bool;
  });
  return children;
}
