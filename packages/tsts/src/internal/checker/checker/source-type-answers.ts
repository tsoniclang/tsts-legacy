import type { Node } from "../../ast/spine.js";
import type { Diagnostic } from "../../ast/diagnostic.js";
import type { Symbol } from "../../ast/symbol.js";
import { CheckModeNormal, type Checker, type CheckMode } from "./state.js";
import type { IndexedTypeReadSource, Signature, Type, TypeNodeLinks } from "../types.js";
import { SignatureFlagsCallChainFlags } from "../types.js";
import { Node_Expression, Node_Symbol, Node_Type } from "../../ast/ast.js";
import { AsTypeOperatorNode } from "../../ast/generated/casts.js";
import { NodeFlagsOptionalChain, SymbolFlagsOptional, SymbolFlagsProperty, SymbolFlagsTransient } from "../../ast/generated/flags.js";
import { KindIdentifier, KindNonNullExpression, KindParenthesizedExpression, KindParenthesizedType, KindReadonlyKeyword, KindTypeOperator } from "../../ast/generated/kinds.js";
import { IsExpressionNode, IsPartOfTypeNode } from "../../ast/utilities.js";
import { IsConstructorDeclaration, IsPropertySignatureDeclaration } from "../../ast/generated/predicates.js";
import { LinkStore_Get, LinkStore_TryGet } from "../../core/linkstore.js";
import { isSourceModuleBinding, retainedAliasFailure } from "./symbols.js";
import { admitNativeChecker } from "../resource-admission.js";

export interface ResolvedSourceTypeInfo {
  readonly type: Type;
  readonly causes: readonly Diagnostic[];
  readonly typeSource?: Node;
  readonly indexedRead?: IndexedTypeReadSource;
  readonly projectedReturn?: SelectedSignatureReturnProjection;
}

export interface SelectedSignatureReturnProjection {
  readonly declaration: Node;
  readonly annotation: Node;
  readonly original: Type;
  readonly selected: Type;
}

type BorrowedTypeSource = Node | readonly [Node, Node];

export interface SourceTypeAnswer extends ResolvedSourceTypeInfo {
  readonly borrowedFrom?: BorrowedTypeSource;
}

export interface SourceTypeAnswerOutput {
  value: SourceTypeAnswer | undefined;
}

export type CheckerDiagnosticMembership = (diagnostic: Diagnostic) => boolean;

function admittedCause(cause: Diagnostic | undefined, admits: CheckerDiagnosticMembership | undefined): Diagnostic | undefined {
  return cause !== undefined && admits?.(cause) !== false ? cause : undefined;
}

function withCause(type: Type, cause?: Diagnostic): SourceTypeAnswer {
  return { type, causes: cause === undefined ? [] : [cause] };
}

export function sourceTypeAnswer(checker: Checker | undefined, node: Node | undefined,
  type: Type | undefined, admits?: CheckerDiagnosticMembership): SourceTypeAnswer | undefined {
  if (checker === undefined || node === undefined || type === undefined) return undefined;
  return readSourceTypeAnswer(checker, node, type, admits, false);
}

export function borrowedSourceTypeAnswer(checker: Checker, anchor: Node, type: Type,
  admits: CheckerDiagnosticMembership | undefined): SourceTypeAnswer {
  admitNativeChecker(checker, "work");
  if (isSourceModuleBinding(anchor)) {
    const symbol = Node_Symbol(anchor);
    return withCause(type, symbol === undefined ? undefined : admittedCause(retainedAliasFailure(checker, anchor, symbol, true), admits));
  }
  const errorExpression = type === checker.errorType && IsExpressionNode(anchor) && !IsPartOfTypeNode(anchor);
  return readSourceTypeAnswer(checker, anchor, type, admits, !errorExpression);
}

function errorOperandSource(checker: Checker, operand: Node | undefined): Node | undefined {
  const answer = sourceTypeAnswer(checker, operand, checker.errorType);
  if (answer === undefined) return undefined;
  const source = answer.borrowedFrom;
  if (source !== undefined) return "Kind" in source ? source : operand;
  return answer.causes.length === 0 ? undefined : operand;
}

export function retainErrorOperandSource(checker: Checker, result: Node | undefined, mode: CheckMode,
  left: Node | undefined, right?: Node): void {
  if (result === undefined || mode !== CheckModeNormal || checker.flowLoopStack.length !== 0 || left === undefined && right === undefined) return;
  const first = errorOperandSource(checker, left);
  const second = errorOperandSource(checker, right);
  const source = first === undefined || second === undefined || first === second
    ? first ?? second : [first, second] as const;
  if (source === undefined) return;
  const type = checker.errorType;
  const links = LinkStore_Get(checker.typeNodeLinks, result)!;
  if (links.resolvedType === type && links.resolutionFailure !== undefined) return;
  links.resolvedType = type;
  links.resolvedTypeSource = source;
}

function completedTypeSource(retained: TypeNodeLinks): BorrowedTypeSource | IndexedTypeReadSource | undefined {
  const source = retained.resolvedTypeSource;
  if (source === undefined || "Kind" in source || "length" in source || "kind" in source) return source;
  if (source.declaredType !== undefined && source.declaredType === retained.resolvedType) return source.declaredSource;
  return undefined;
}

function isCompletedSourceType(checker: Checker, node: Node | undefined, type: Type | undefined): boolean {
  if (node === undefined || type === undefined || type === checker.errorType) return false;
  const links = LinkStore_TryGet(checker.typeNodeLinks, node);
  return links?.resolvedType === type && links.resolutionFailure === undefined
    && links.grammarFailure === undefined && links.declarationFailure === undefined;
}

export function completedRequiredPropertySource(checker: Checker, property: Symbol, type: Type): Node | undefined {
  if (type === checker.errorType || (property.Flags & (SymbolFlagsProperty | SymbolFlagsOptional | SymbolFlagsTransient)) !== SymbolFlagsProperty)
    return undefined;
  const declaration = property.ValueDeclaration;
  if (declaration === undefined || !IsPropertySignatureDeclaration(declaration) || property.Declarations?.length !== 1
    || property.Declarations[0] !== declaration || Node_Symbol(declaration) !== property) return undefined;
  return completedAnnotationSource(checker, Node_Type(declaration), type);
}

export function completedAnnotationSource(checker: Checker, annotation: Node | undefined, type: Type): Node | undefined {
  const source = directTypeSource(checker, annotation, type);
  return isCompletedSourceType(checker, source, type) ? source : undefined;
}

export function originalSignatureDeclaration(checker: Checker, signature: Signature): Node | undefined {
  const declaration = signature.declaration;
  return declaration !== undefined && signature.target === undefined && signature.mapper === undefined
    && signature.composite === undefined && (signature.flags & SignatureFlagsCallChainFlags) === 0
    && LinkStore_TryGet(checker.signatureLinks, declaration)?.resolvedSignature === signature ? declaration : undefined;
}

export function signatureReturnAnswer(checker: Checker | undefined, signature: Signature | undefined, type: Type | undefined,
  admits?: CheckerDiagnosticMembership): SourceTypeAnswer | undefined {
  if (checker === undefined || signature === undefined || type === undefined) return undefined;
  const declaration = originalSignatureDeclaration(checker, signature);
  const annotation = declaration !== undefined && !IsConstructorDeclaration(declaration) ? Node_Type(declaration) : undefined;
  if (annotation === undefined) return withCause(type);
  const answer = readSourceTypeAnswer(checker, annotation, type, admits, false);
  const typeSource = completedAnnotationSource(checker, annotation, type);
  return typeSource !== undefined && answer.causes.length === 0 ? { ...answer, typeSource } : answer;
}

export function directTypeSource(checker: Checker, node: Node | undefined, type: Type): Node | undefined {
  while (node?.Kind === KindParenthesizedType) {
    admitNativeChecker(checker, "work");
    node = Node_Type(node);
  }
  if (node === undefined) return undefined;
  const retained = LinkStore_TryGet(checker.typeNodeLinks, node);
  const source = retained?.resolvedType === type && retained.resolutionFailure === undefined && retained.grammarFailure === undefined
    && retained.declarationFailure === undefined ? completedTypeSource(retained) : undefined;
  return source !== undefined && "Kind" in source ? source : node;
}

function hasTransparentErrorOperand(node: Node): boolean {
  return node.Kind === KindParenthesizedExpression
    || node.Kind === KindNonNullExpression && (node.Flags & NodeFlagsOptionalChain) === 0;
}

function readSourceTypeAnswer(checker: Checker, node: Node, type: Type,
  admits: CheckerDiagnosticMembership | undefined, borrowed: boolean): SourceTypeAnswer {
  let current: Node | undefined = node;
  let mayBorrow = true;
  while (current !== undefined) {
    admitNativeChecker(checker, "work");
    const retained = LinkStore_TryGet(checker.typeNodeLinks, current);
    if (retained?.declarationFailure !== undefined) {
      const cause = admittedCause(retained.declarationFailure, admits);
      if (cause !== undefined) return withCause(type, cause);
      mayBorrow = false;
    }
    const completed = borrowed || retained?.resolvedType === type;
    if (completed && retained !== undefined) {
      const cause = admittedCause(retained.resolutionFailure, admits) ?? admittedCause(retained.grammarFailure, admits);
      if (cause !== undefined) return withCause(type, cause);
      const source = mayBorrow && retained.resolvedType !== undefined ? completedTypeSource(retained) : undefined;
      const successful = type !== checker.errorType && retained.resolvedType !== checker.errorType && mayBorrow && retained.resolutionFailure === undefined
        && retained.grammarFailure === undefined && retained.declarationFailure === undefined;
      if (source !== undefined && "kind" in source)
        return successful && source.annotation === current ? { type, causes: [], indexedRead: source } : withCause(type);
      if (source !== undefined) return successful && "Kind" in source && isCompletedSourceType(checker, source, retained.resolvedType)
        ? { type, causes: [], borrowedFrom: source, typeSource: source }
        : { type, causes: [], borrowedFrom: source };
      if (successful && !borrowed && current !== node && node.Kind === KindParenthesizedType)
        return { type, causes: [], typeSource: current };
    }
    if (!borrowed && type === checker.errorType && hasTransparentErrorOperand(current)) {
      current = Node_Expression(current);
      continue;
    }
    if (current.Kind !== KindParenthesizedType &&
      !(completed && current.Kind === KindTypeOperator && AsTypeOperatorNode(current)?.Operator === KindReadonlyKeyword)) break;
    current = Node_Type(current);
  }
  if (!borrowed && type === checker.errorType && current?.Kind === KindIdentifier && current.Parent !== undefined
    && (node.Kind === KindIdentifier || hasTransparentErrorOperand(node))
    && !IsPartOfTypeNode(current) && IsExpressionNode(current)) {
    const name = LinkStore_TryGet(checker.symbolNodeLinks, current);
    if (name !== undefined && name.resolvedSymbol === checker.unknownSymbol)
      return withCause(type, admittedCause(name.resolutionFailure, admits));
    if (name?.resolvedSymbol !== undefined) {
      const alias = LinkStore_TryGet(checker.aliasSymbolLinks, name.resolvedSymbol);
      if (alias !== undefined && alias.aliasTarget === checker.unknownSymbol && alias.failedBindingSource !== undefined)
        return { type, causes: [], borrowedFrom: alias.failedBindingSource };
    }
  }
  return withCause(type);
}
