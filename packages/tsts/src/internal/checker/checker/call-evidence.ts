import type { GoPtr } from "../../../go/compat.js";
import { Node_Expression, Node_Type } from "../../ast/ast.js";
import { AsElementAccessExpression } from "../../ast/generated/casts.js";
import { IsParenthesizedExpression } from "../../ast/generated/predicates.js";
import type { Node } from "../../ast/spine.js";
import type { Symbol } from "../../ast/symbol.js";
import { IsAliasSymbolDeclaration, IsCallOrNewExpression } from "../../ast/utilities.js";
import { LinkStore_Get } from "../../core/linkstore.js";
import type {
  CheckedCallSelectionSeed,
  CheckedCallSourceSelectionProvenance,
  EffectiveCallArgumentOrigin,
  SignatureLinks,
  Type,
} from "../types.js";
import type { Checker } from "./state.js";
import { journalSelectedCallEvidence } from "./selected-call-evidence-transaction.js";

export interface PropertyCallCalleeEvidence {
  readonly sourceSymbol: GoPtr<Symbol>;
  readonly sourceDeclaration?: GoPtr<Node>;
  readonly selectedSymbol: GoPtr<Symbol>;
  readonly selectedDeclaration?: GoPtr<Node>;
  readonly resultType: GoPtr<Type>;
  readonly receiverType: GoPtr<Type>;
  readonly receiverSymbol?: GoPtr<Symbol>;
  readonly receiverDeclaration?: GoPtr<Node>;
}

export interface ElementCallCalleeEvidence {
  readonly sourceSymbol: GoPtr<Symbol>;
  readonly sourceDeclaration?: GoPtr<Node>;
  readonly selectedSymbol: GoPtr<Symbol>;
  readonly selectedDeclaration?: GoPtr<Node>;
  readonly resultType: GoPtr<Type>;
  readonly selectedElementIndex?: number;
  readonly receiverType: GoPtr<Type>;
  readonly argumentType: GoPtr<Type>;
}

export function callEvidenceWantedForCallee(callee: GoPtr<Node>): boolean {
  return checkedCallForCallee(callee) !== undefined;
}

export function retainIdentifierCallCalleeEvidence(
  checker: GoPtr<Checker>,
  identifier: GoPtr<Node>,
  sourceSymbol: GoPtr<Symbol>,
  selectedSymbol: GoPtr<Symbol>,
): void {
  if (checker === undefined || identifier === undefined) {
    return;
  }
  const callExpression = checkedCallForCallee(identifier);
  if (callExpression === undefined) {
    return;
  }
  const canonicalSourceSymbol = knownSymbol(checker, sourceSymbol);
  const canonicalSelectedSymbol = knownSymbol(checker, selectedSymbol);
  const sourceDeclaration = aliasDeclaration(canonicalSourceSymbol)
    ?? canonicalSourceSymbol?.ValueDeclaration;
  const selectedDeclaration = canonicalSelectedSymbol?.ValueDeclaration;
  const declaration = selectedDeclaration ?? sourceDeclaration;
  const authoredTypeNode = declaration === undefined
    ? undefined
    : Node_Type(declaration);
  retainCallSelectionSeed(checker, callExpression, {
    calleeProvenance: Object.freeze({
      ...(canonicalSourceSymbol === undefined ? {} : { symbol: canonicalSourceSymbol }),
      ...(sourceDeclaration === undefined ? {} : { declaration: sourceDeclaration }),
      ...(canonicalSelectedSymbol === undefined ? {} : { selectedSymbol: canonicalSelectedSymbol }),
      ...(selectedDeclaration === undefined ? {} : { selectedDeclaration }),
      ...(authoredTypeNode === undefined ? {} : { authoredTypeNode }),
    }),
  });
}

export function retainPropertyCallCalleeEvidence(
  checker: GoPtr<Checker>,
  propertyAccessExpression: GoPtr<Node>,
  evidence: PropertyCallCalleeEvidence,
): void {
  if (checker === undefined || propertyAccessExpression === undefined) {
    return;
  }
  const receiver = Node_Expression(propertyAccessExpression);
  const callExpression = checkedCallForCallee(propertyAccessExpression);
  if (receiver === undefined || callExpression === undefined) {
    return;
  }
  if (evidence.resultType === undefined || evidence.receiverType === undefined) {
    throw new Error("Property call-callee evidence requires exact receiver and result types.");
  }
  const sourceSymbol = knownSymbol(checker, evidence.sourceSymbol);
  const selectedSymbol = knownSymbol(checker, evidence.selectedSymbol);
  const sourceDeclaration = evidence.sourceDeclaration ?? sourceSymbol?.ValueDeclaration;
  const selectedDeclaration = evidence.selectedDeclaration ?? selectedSymbol?.ValueDeclaration;
  const receiverEvidence = Object.freeze({
    expression: receiver,
    type: evidence.receiverType,
    ...(evidence.receiverSymbol === undefined ? {} : { symbol: evidence.receiverSymbol }),
    ...(evidence.receiverDeclaration === undefined ? {} : { declaration: evidence.receiverDeclaration }),
  });
  retainCallSelectionSeed(checker, callExpression, {
    calleeProvenance: selectionProvenance(
      sourceSymbol,
      sourceDeclaration,
      selectedSymbol,
      selectedDeclaration,
    ),
    receiver: receiverEvidence,
    calleeAccess: Object.freeze({
      kind: "property",
      expression: propertyAccessExpression,
      receiver: receiverEvidence,
      resultType: evidence.resultType,
      ...(evidence.sourceSymbol === undefined ? {} : { symbol: evidence.sourceSymbol }),
      ...(evidence.sourceDeclaration === undefined ? {} : { declaration: evidence.sourceDeclaration }),
      ...(evidence.selectedSymbol === undefined ? {} : { selectedSymbol: evidence.selectedSymbol }),
      ...(evidence.selectedDeclaration === undefined ? {} : { selectedDeclaration: evidence.selectedDeclaration }),
    }),
  });
}

export function retainElementCallCalleeEvidence(
  checker: GoPtr<Checker>,
  elementAccessExpression: GoPtr<Node>,
  evidence: ElementCallCalleeEvidence,
): void {
  if (checker === undefined || elementAccessExpression === undefined) {
    return;
  }
  const receiver = Node_Expression(elementAccessExpression);
  const argument = AsElementAccessExpression(elementAccessExpression)?.ArgumentExpression;
  const callExpression = checkedCallForCallee(elementAccessExpression);
  if (receiver === undefined || argument === undefined || callExpression === undefined) {
    return;
  }
  if (evidence.resultType === undefined
    || evidence.receiverType === undefined
    || evidence.argumentType === undefined) {
    throw new Error("Element call-callee evidence requires exact receiver, argument, and result types.");
  }
  const sourceSymbol = knownSymbol(checker, evidence.sourceSymbol);
  const selectedSymbol = knownSymbol(checker, evidence.selectedSymbol);
  const sourceDeclaration = evidence.sourceDeclaration ?? sourceSymbol?.ValueDeclaration;
  const selectedDeclaration = evidence.selectedDeclaration ?? selectedSymbol?.ValueDeclaration;
  const receiverEvidence = Object.freeze({
    expression: receiver,
    type: evidence.receiverType,
  });
  retainCallSelectionSeed(checker, callExpression, {
    calleeProvenance: selectionProvenance(
      sourceSymbol,
      sourceDeclaration,
      selectedSymbol,
      selectedDeclaration,
    ),
    receiver: receiverEvidence,
    calleeAccess: Object.freeze({
      kind: "element",
      expression: elementAccessExpression,
      receiver: receiverEvidence,
      argument: Object.freeze({
        expression: argument,
        type: evidence.argumentType,
      }),
      resultType: evidence.resultType,
      ...(evidence.selectedElementIndex === undefined
        ? {}
        : { selectedElementIndex: evidence.selectedElementIndex }),
      ...(evidence.sourceSymbol === undefined ? {} : { symbol: evidence.sourceSymbol }),
      ...(evidence.sourceDeclaration === undefined ? {} : { declaration: evidence.sourceDeclaration }),
      ...(evidence.selectedSymbol === undefined ? {} : { selectedSymbol: evidence.selectedSymbol }),
      ...(evidence.selectedDeclaration === undefined ? {} : { selectedDeclaration: evidence.selectedDeclaration }),
    }),
  });
}

export function retainCallArgumentOrigins(
  checker: Checker,
  callExpression: Node,
  origins: readonly EffectiveCallArgumentOrigin[],
): void {
  const links = LinkStore_Get(checker.signatureLinks, callExpression) as SignatureLinks;
  retainCallSelectionSeed(checker, callExpression, {
    ...links.checkedCallSelectionSeed,
    argumentOrigins: origins,
  });
}

function retainCallSelectionSeed(
  checker: Checker,
  callExpression: Node,
  incoming: CheckedCallSelectionSeed,
): CheckedCallSelectionSeed {
  const links = LinkStore_Get(checker.signatureLinks, callExpression) as SignatureLinks;
  journalSelectedCallEvidence(checker, links);
  const origins = incoming.argumentOrigins ?? links.checkedCallSelectionSeed?.argumentOrigins;
  const seed = Object.freeze({ ...incoming, ...(origins === undefined ? {} : { argumentOrigins: origins }) });
  links.checkedCallSelectionSeed = seed;
  return seed;
}

function selectionProvenance(
  sourceSymbol: GoPtr<Symbol>,
  sourceDeclaration: GoPtr<Node>,
  selectedSymbol: GoPtr<Symbol>,
  selectedDeclaration: GoPtr<Node>,
): CheckedCallSourceSelectionProvenance {
  const declaration = selectedDeclaration ?? sourceDeclaration;
  const authoredTypeNode = declaration === undefined
    ? undefined
    : Node_Type(declaration);
  return Object.freeze({
    ...(sourceSymbol === undefined ? {} : { symbol: sourceSymbol }),
    ...(sourceDeclaration === undefined ? {} : { declaration: sourceDeclaration }),
    ...(selectedSymbol === undefined ? {} : { selectedSymbol }),
    ...(selectedDeclaration === undefined ? {} : { selectedDeclaration }),
    ...(authoredTypeNode === undefined ? {} : { authoredTypeNode }),
  });
}

function checkedCallForCallee(callee: GoPtr<Node>): GoPtr<Node> {
  let current = callee;
  while (current !== undefined && IsParenthesizedExpression(current.Parent)) {
    current = current.Parent;
  }
  const parent = current?.Parent;
  return IsCallOrNewExpression(parent) && Node_Expression(parent) === current
    ? parent
    : undefined;
}

function knownSymbol(checker: Checker, symbol: GoPtr<Symbol>): GoPtr<Symbol> {
  return symbol === undefined || symbol === checker.unknownSymbol ? undefined : symbol;
}

function aliasDeclaration(symbol: GoPtr<Symbol>): GoPtr<Node> {
  const declarations = symbol?.Declarations ?? [];
  for (let index = declarations.length - 1; index >= 0; index--) {
    const declaration = declarations[index];
    if (declaration !== undefined && IsAliasSymbolDeclaration(declaration)) {
      return declaration;
    }
  }
  return undefined;
}
