import type { GoPtr } from "../../../go/compat.js";
import type { Node } from "../../ast/spine.js";
import type { Symbol } from "../../ast/symbol.js";
import type { Type } from "../types.js";
import { Type_Target, TypeFlagsNever } from "../types.js";
import type { IterationTypes } from "./state.js";

export const sourceIterationEvidenceLimits = Object.freeze({
  maxUnionAlternatives: 4_096,
  maxUnionDepth: 64,
});

export interface ExtensionSelectedIterationTypes {
  readonly yieldType: GoPtr<Type>;
  readonly returnType: GoPtr<Type>;
  readonly nextType: GoPtr<Type>;
}

interface ExtensionSelectedIterationProtocolBase {
  readonly sourceIterableType: Type;
  readonly iterationTypes: ExtensionSelectedIterationTypes;
}

export type ExtensionSelectedIterationProtocol =
  | ExtensionSelectedIterationProtocolBase & {
      readonly resolutionKind: "known-iterable-instantiation";
      readonly iterableTargetType: Type;
      readonly iterableSymbol: GoPtr<Symbol>;
      readonly iterableValueDeclaration: GoPtr<Node>;
      readonly iterableDeclarations: readonly GoPtr<Node>[];
      readonly iteratorMethodSymbol?: never;
      readonly iteratorMethodValueDeclaration?: never;
      readonly iteratorMethodDeclarations?: never;
      readonly iteratorMethodType?: never;
      readonly iteratorType?: never;
    }
  | ExtensionSelectedIterationProtocolBase & {
      readonly resolutionKind: "selected-iterator-member";
      readonly iteratorMethodSymbol: Symbol;
      readonly iteratorMethodValueDeclaration: GoPtr<Node>;
      readonly iteratorMethodDeclarations: readonly GoPtr<Node>[];
      readonly iteratorMethodType: Type;
      readonly iteratorType: Type;
      readonly iterableTargetType?: never;
      readonly iterableSymbol?: never;
      readonly iterableValueDeclaration?: never;
      readonly iterableDeclarations?: never;
    };

export type ExtensionForOfAtomicIterationMechanism =
  | {
      readonly kind: "synchronous-iterator-protocol";
      readonly sourceIterableType: Type;
      readonly protocol: ExtensionSelectedIterationProtocol;
    }
  | {
      readonly kind: "array-like-index";
      readonly sourceIterableType: Type;
      readonly selectedIndexType: Type;
    }
  | {
      readonly kind: "string-code-unit-index";
      readonly sourceIterableType: Type;
    }
  | {
      readonly kind: "untyped-dynamic-iteration";
      readonly sourceIterableType: Type;
    };

export type ExtensionForAwaitOfAtomicIterationMechanism =
  | {
      readonly kind: "asynchronous-iterator-protocol";
      readonly sourceIterableType: Type;
      readonly protocol: ExtensionSelectedIterationProtocol;
    }
  | {
      readonly kind: "synchronous-iterator-adapted-to-async";
      readonly sourceIterableType: Type;
      readonly protocol: ExtensionSelectedIterationProtocol;
    }
  | {
      readonly kind: "array-like-index-adapted-to-async";
      readonly sourceIterableType: Type;
      readonly selectedIndexType: Type;
    }
  | {
      readonly kind: "string-code-unit-index-adapted-to-async";
      readonly sourceIterableType: Type;
    }
  | {
      readonly kind: "untyped-dynamic-iteration";
      readonly sourceIterableType: Type;
    };

export type ExtensionForOfIterationMechanism =
  | ExtensionForOfAtomicIterationMechanism
  | {
      readonly kind: "union";
      readonly alternatives: readonly [ExtensionForOfAtomicIterationMechanism, ...ExtensionForOfAtomicIterationMechanism[]];
    };

export type ExtensionForAwaitOfIterationMechanism =
  | ExtensionForAwaitOfAtomicIterationMechanism
  | {
      readonly kind: "union";
      readonly alternatives: readonly [ExtensionForAwaitOfAtomicIterationMechanism, ...ExtensionForAwaitOfAtomicIterationMechanism[]];
    };

export type ExtensionCheckedIterationSelection =
  | {
      readonly iterationKind: "for-in";
      readonly sourceIterableType: Type;
      readonly sourceElementType: Type;
      readonly mechanism: {
        readonly kind: "property-key-enumeration";
      };
    }
  | {
      readonly iterationKind: "for-of";
      readonly sourceIterableType: Type;
      readonly sourceElementType: Type;
      readonly mechanism: ExtensionForOfIterationMechanism;
    }
  | {
      readonly iterationKind: "for-await-of";
      readonly sourceIterableType: Type;
      readonly sourceElementType: Type;
      readonly mechanism: ExtensionForAwaitOfIterationMechanism;
    };

export interface ExtensionCheckedIterationResult {
  readonly elementType: Type;
  readonly selection: ExtensionCheckedIterationSelection | undefined;
}

export interface ExtensionCheckedYieldStarResult {
  readonly sourceIterableType: Type;
  readonly iterationTypes: ExtensionSelectedIterationTypes;
  readonly mechanism:
    | ExtensionForOfIterationMechanism
    | ExtensionForAwaitOfIterationMechanism;
}

export function freezeExtensionCheckedIterationSelection(
  selection: ExtensionCheckedIterationSelection,
): ExtensionCheckedIterationSelection {
  switch (selection.iterationKind) {
    case "for-in":
      return Object.freeze({
        iterationKind: selection.iterationKind,
        sourceIterableType: selection.sourceIterableType,
        sourceElementType: selection.sourceElementType,
        mechanism: Object.freeze({ kind: "property-key-enumeration" }),
      });
    case "for-of":
      return Object.freeze({
        iterationKind: selection.iterationKind,
        sourceIterableType: selection.sourceIterableType,
        sourceElementType: selection.sourceElementType,
        mechanism: freezeForOfIterationMechanism(selection.mechanism),
      });
    case "for-await-of":
      return Object.freeze({
        iterationKind: selection.iterationKind,
        sourceIterableType: selection.sourceIterableType,
        sourceElementType: selection.sourceElementType,
        mechanism: freezeForAwaitOfIterationMechanism(selection.mechanism),
      });
  }
}

export function freezeExtensionCheckedYieldStarResult(
  result: ExtensionCheckedYieldStarResult,
  asynchronous: boolean,
): ExtensionCheckedYieldStarResult {
  return Object.freeze({
    sourceIterableType: result.sourceIterableType,
    iterationTypes: Object.freeze({ ...result.iterationTypes }),
    mechanism: asynchronous
      ? freezeForAwaitOfIterationMechanism(
          result.mechanism as ExtensionForAwaitOfIterationMechanism,
        )
      : freezeForOfIterationMechanism(
          result.mechanism as ExtensionForOfIterationMechanism,
        ),
  });
}

export interface ExtensionIterationSelectionBudget {
  remainingUnionAlternatives: number;
  exhausted: boolean;
}

export interface ExtensionIterationProtocolSelectionCapture {
  readonly budget: ExtensionIterationSelectionBudget;
  mechanism: ExtensionForOfIterationMechanism | ExtensionForAwaitOfIterationMechanism | undefined;
}

type ExtensionIterationAtomicMechanism =
  | ExtensionForOfAtomicIterationMechanism
  | ExtensionForAwaitOfAtomicIterationMechanism;

function hasIterationTypes(iterationTypes: IterationTypes): boolean {
  return iterationTypes.yieldType !== undefined
    || iterationTypes.returnType !== undefined
    || iterationTypes.nextType !== undefined;
}

function snapshotIterationTypes(iterationTypes: IterationTypes): ExtensionSelectedIterationTypes {
  return {
    yieldType: iterationTypes.yieldType,
    returnType: iterationTypes.returnType,
    nextType: iterationTypes.nextType,
  };
}

export function extensionIterationTypesMatch(left: IterationTypes, right: IterationTypes): boolean {
  return left.yieldType === right.yieldType
    && left.returnType === right.returnType
    && left.nextType === right.nextType;
}

export function captureKnownIterableInstantiation(
  capture: ExtensionIterationProtocolSelectionCapture,
  sourceIterableType: GoPtr<Type>,
  iterationTypes: IterationTypes,
): void {
  if (sourceIterableType === undefined || !hasIterationTypes(iterationTypes)) {
    return;
  }
  const iterableTargetType = Type_Target(sourceIterableType);
  if (iterableTargetType === undefined) {
    return;
  }
  const iterableSymbol = iterableTargetType.symbol;
  const protocol: ExtensionSelectedIterationProtocol = {
    resolutionKind: "known-iterable-instantiation",
    sourceIterableType,
    iterationTypes: snapshotIterationTypes(iterationTypes),
    iterableTargetType,
    iterableSymbol,
    iterableValueDeclaration: iterableSymbol?.ValueDeclaration,
    iterableDeclarations: iterableSymbol?.Declarations?.slice() ?? [],
  };
  capture.mechanism = {
    kind: "synchronous-iterator-protocol",
    sourceIterableType,
    protocol,
  };
}

export function captureSelectedIteratorMember(
  capture: ExtensionIterationProtocolSelectionCapture,
  sourceIterableType: GoPtr<Type>,
  iteratorMethodSymbol: GoPtr<Symbol>,
  iteratorMethodType: GoPtr<Type>,
  iteratorType: GoPtr<Type>,
  iterationTypes: IterationTypes,
): void {
  if (sourceIterableType === undefined
    || iteratorMethodSymbol === undefined
    || iteratorMethodType === undefined
    || iteratorType === undefined
    || !hasIterationTypes(iterationTypes)) {
    return;
  }
  const protocol: ExtensionSelectedIterationProtocol = {
    resolutionKind: "selected-iterator-member",
    sourceIterableType,
    iterationTypes: snapshotIterationTypes(iterationTypes),
    iteratorMethodSymbol,
    iteratorMethodValueDeclaration: iteratorMethodSymbol.ValueDeclaration,
    iteratorMethodDeclarations: iteratorMethodSymbol.Declarations?.slice() ?? [],
    iteratorMethodType,
    iteratorType,
  };
  capture.mechanism = {
    kind: "synchronous-iterator-protocol",
    sourceIterableType,
    protocol,
  };
}

function withFinalIterationTypes(
  protocol: ExtensionSelectedIterationProtocol,
  iterationTypes: IterationTypes,
): ExtensionSelectedIterationProtocol {
  if (protocol.resolutionKind === "known-iterable-instantiation") {
    return {
      resolutionKind: protocol.resolutionKind,
      sourceIterableType: protocol.sourceIterableType,
      iterationTypes: snapshotIterationTypes(iterationTypes),
      iterableTargetType: protocol.iterableTargetType,
      iterableSymbol: protocol.iterableSymbol,
      iterableValueDeclaration: protocol.iterableValueDeclaration,
      iterableDeclarations: protocol.iterableDeclarations,
    };
  }
  return {
    resolutionKind: protocol.resolutionKind,
    sourceIterableType: protocol.sourceIterableType,
    iterationTypes: snapshotIterationTypes(iterationTypes),
    iteratorMethodSymbol: protocol.iteratorMethodSymbol,
    iteratorMethodValueDeclaration: protocol.iteratorMethodValueDeclaration,
    iteratorMethodDeclarations: protocol.iteratorMethodDeclarations,
    iteratorMethodType: protocol.iteratorMethodType,
    iteratorType: protocol.iteratorType,
  };
}

export function setExtensionProtocolMechanismKind(
  capture: ExtensionIterationProtocolSelectionCapture,
  kind: "synchronous-iterator-protocol" | "asynchronous-iterator-protocol" | "synchronous-iterator-adapted-to-async",
  iterationTypes: IterationTypes,
): void {
  const mechanism = capture.mechanism;
  if (mechanism === undefined || mechanism.kind === "union") {
    return;
  }
  if (mechanism.kind !== "synchronous-iterator-protocol") {
    capture.mechanism = undefined;
    return;
  }
  const protocol = withFinalIterationTypes(mechanism.protocol, iterationTypes);
  if (kind === "asynchronous-iterator-protocol") {
    capture.mechanism = { kind, sourceIterableType: mechanism.sourceIterableType, protocol };
    return;
  }
  if (kind === "synchronous-iterator-adapted-to-async") {
    capture.mechanism = { kind, sourceIterableType: mechanism.sourceIterableType, protocol };
    return;
  }
  capture.mechanism = { kind, sourceIterableType: mechanism.sourceIterableType, protocol };
}

function isForOfAtomicIterationMechanism(
  mechanism: ExtensionIterationAtomicMechanism,
): mechanism is ExtensionForOfAtomicIterationMechanism {
  return mechanism.kind === "synchronous-iterator-protocol"
    || mechanism.kind === "array-like-index"
    || mechanism.kind === "string-code-unit-index"
    || mechanism.kind === "untyped-dynamic-iteration";
}

function isForAwaitOfAtomicIterationMechanism(
  mechanism: ExtensionIterationAtomicMechanism,
): mechanism is ExtensionForAwaitOfAtomicIterationMechanism {
  return mechanism.kind === "asynchronous-iterator-protocol"
    || mechanism.kind === "synchronous-iterator-adapted-to-async"
    || mechanism.kind === "array-like-index-adapted-to-async"
    || mechanism.kind === "string-code-unit-index-adapted-to-async"
    || mechanism.kind === "untyped-dynamic-iteration";
}

export function isForOfIterationMechanism(
  mechanism: ExtensionForOfIterationMechanism | ExtensionForAwaitOfIterationMechanism,
): mechanism is ExtensionForOfIterationMechanism {
  return mechanism.kind === "union"
    ? mechanism.alternatives.every(isForOfAtomicIterationMechanism)
    : isForOfAtomicIterationMechanism(mechanism);
}

export function isForAwaitOfIterationMechanism(
  mechanism: ExtensionForOfIterationMechanism | ExtensionForAwaitOfIterationMechanism,
): mechanism is ExtensionForAwaitOfIterationMechanism {
  return mechanism.kind === "union"
    ? mechanism.alternatives.every(isForAwaitOfAtomicIterationMechanism)
    : isForAwaitOfAtomicIterationMechanism(mechanism);
}

function appendForOfAlternatives(
  destination: ExtensionForOfAtomicIterationMechanism[],
  mechanism: ExtensionForOfIterationMechanism | ExtensionForAwaitOfIterationMechanism,
): boolean {
  const alternatives = mechanism.kind === "union" ? mechanism.alternatives : [mechanism];
  for (const alternative of alternatives) {
    if (!isForOfAtomicIterationMechanism(alternative)) {
      return false;
    }
    destination.push(alternative);
  }
  return true;
}

function appendForAwaitOfAlternatives(
  destination: ExtensionForAwaitOfAtomicIterationMechanism[],
  mechanism: ExtensionForOfIterationMechanism | ExtensionForAwaitOfIterationMechanism,
): boolean {
  const alternatives = mechanism.kind === "union" ? mechanism.alternatives : [mechanism];
  for (const alternative of alternatives) {
    if (!isForAwaitOfAtomicIterationMechanism(alternative)) {
      return false;
    }
    destination.push(alternative);
  }
  return true;
}

export function combineExtensionProtocolMechanisms(
  capture: ExtensionIterationProtocolSelectionCapture,
  children: readonly ExtensionIterationProtocolSelectionCapture[],
  forAwaitOf: boolean,
): void {
  if (capture.budget.exhausted || children.some((child) => child.mechanism === undefined)) {
    capture.mechanism = undefined;
    return;
  }
  if (forAwaitOf) {
    const alternatives: ExtensionForAwaitOfAtomicIterationMechanism[] = [];
    for (const child of children) {
      if (!appendForAwaitOfAlternatives(alternatives, child.mechanism!)) {
        capture.mechanism = undefined;
        return;
      }
    }
    capture.mechanism = alternatives.length === 1
      ? alternatives[0]
      : alternatives.length === 0
        ? undefined
        : { kind: "union", alternatives: [alternatives[0]!, ...alternatives.slice(1)] };
    return;
  }
  const alternatives: ExtensionForOfAtomicIterationMechanism[] = [];
  for (const child of children) {
    if (!appendForOfAlternatives(alternatives, child.mechanism!)) {
      capture.mechanism = undefined;
      return;
    }
  }
  capture.mechanism = alternatives.length === 1
    ? alternatives[0]
    : alternatives.length === 0
      ? undefined
      : { kind: "union", alternatives: [alternatives[0]!, ...alternatives.slice(1)] };
}

export function createChildExtensionIterationCapture(
  capture: ExtensionIterationProtocolSelectionCapture,
): ExtensionIterationProtocolSelectionCapture {
  return { budget: capture.budget, mechanism: undefined };
}

function setFallbackMechanism(
  capture: ExtensionIterationProtocolSelectionCapture,
  alternatives: readonly ExtensionIterationAtomicMechanism[],
  forAwaitOf: boolean,
): void {
  if (capture.budget.exhausted || alternatives.length === 0) {
    capture.mechanism = undefined;
    return;
  }
  if (forAwaitOf) {
    const typed: ExtensionForAwaitOfAtomicIterationMechanism[] = [];
    for (const alternative of alternatives) {
      if (!isForAwaitOfAtomicIterationMechanism(alternative)) {
        capture.mechanism = undefined;
        return;
      }
      typed.push(alternative);
    }
    capture.mechanism = typed.length === 1
      ? typed[0]
      : { kind: "union", alternatives: [typed[0]!, ...typed.slice(1)] };
    return;
  }
  const typed: ExtensionForOfAtomicIterationMechanism[] = [];
  for (const alternative of alternatives) {
    if (!isForOfAtomicIterationMechanism(alternative)) {
      capture.mechanism = undefined;
      return;
    }
    typed.push(alternative);
  }
  capture.mechanism = typed.length === 1
    ? typed[0]
    : { kind: "union", alternatives: [typed[0]!, ...typed.slice(1)] };
}

export function captureExtensionArrayOrStringIteration(
  capture: ExtensionIterationProtocolSelectionCapture,
  forAwaitOf: boolean,
  arrayType: GoPtr<Type>,
  selectedIndexType: GoPtr<Type>,
  stringType: GoPtr<Type>,
): void {
  const alternatives: ExtensionIterationAtomicMechanism[] = [];
  if (stringType !== undefined) {
    alternatives.push(forAwaitOf
      ? { kind: "string-code-unit-index-adapted-to-async", sourceIterableType: stringType }
      : { kind: "string-code-unit-index", sourceIterableType: stringType });
  }
  if (arrayType !== undefined && selectedIndexType !== undefined && (arrayType.flags & TypeFlagsNever) === 0) {
    alternatives.push(forAwaitOf
      ? { kind: "array-like-index-adapted-to-async", sourceIterableType: arrayType, selectedIndexType }
      : { kind: "array-like-index", sourceIterableType: arrayType, selectedIndexType });
  }
  setFallbackMechanism(capture, alternatives, forAwaitOf);
}

export function createExtensionIterationProtocolSelectionCapture(): ExtensionIterationProtocolSelectionCapture {
  return {
    budget: {
      remainingUnionAlternatives: sourceIterationEvidenceLimits.maxUnionAlternatives,
      exhausted: false,
    },
    mechanism: undefined,
  };
}

export function createExtensionForInIterationSelection(
  sourceIterableType: Type,
  sourceElementType: Type,
): ExtensionCheckedIterationSelection {
  return Object.freeze({
    iterationKind: "for-in",
    sourceIterableType,
    sourceElementType,
    mechanism: Object.freeze({ kind: "property-key-enumeration" }),
  });
}

function freezeForOfIterationMechanism(
  mechanism: ExtensionForOfIterationMechanism,
): ExtensionForOfIterationMechanism {
  if (mechanism.kind === "union") {
    const alternatives: [ExtensionForOfAtomicIterationMechanism, ...ExtensionForOfAtomicIterationMechanism[]] = [
      freezeForOfAtomicIterationMechanism(mechanism.alternatives[0]),
      ...mechanism.alternatives.slice(1).map(freezeForOfAtomicIterationMechanism),
    ];
    return Object.freeze({
      kind: "union",
      alternatives: Object.freeze(alternatives),
    });
  }
  return freezeForOfAtomicIterationMechanism(mechanism);
}

function freezeForAwaitOfIterationMechanism(
  mechanism: ExtensionForAwaitOfIterationMechanism,
): ExtensionForAwaitOfIterationMechanism {
  if (mechanism.kind === "union") {
    const alternatives: [ExtensionForAwaitOfAtomicIterationMechanism, ...ExtensionForAwaitOfAtomicIterationMechanism[]] = [
      freezeForAwaitOfAtomicIterationMechanism(mechanism.alternatives[0]),
      ...mechanism.alternatives.slice(1).map(freezeForAwaitOfAtomicIterationMechanism),
    ];
    return Object.freeze({
      kind: "union",
      alternatives: Object.freeze(alternatives),
    });
  }
  return freezeForAwaitOfAtomicIterationMechanism(mechanism);
}

function freezeForOfAtomicIterationMechanism(
  mechanism: ExtensionForOfAtomicIterationMechanism,
): ExtensionForOfAtomicIterationMechanism {
  switch (mechanism.kind) {
    case "synchronous-iterator-protocol":
      return Object.freeze({
        kind: mechanism.kind,
        sourceIterableType: mechanism.sourceIterableType,
        protocol: freezeSelectedIterationProtocol(mechanism.protocol),
      });
    case "array-like-index":
      return Object.freeze({ ...mechanism });
    case "string-code-unit-index":
      return Object.freeze({ ...mechanism });
    case "untyped-dynamic-iteration":
      return Object.freeze({ ...mechanism });
  }
}

function freezeForAwaitOfAtomicIterationMechanism(
  mechanism: ExtensionForAwaitOfAtomicIterationMechanism,
): ExtensionForAwaitOfAtomicIterationMechanism {
  switch (mechanism.kind) {
    case "asynchronous-iterator-protocol":
    case "synchronous-iterator-adapted-to-async":
      return Object.freeze({
        kind: mechanism.kind,
        sourceIterableType: mechanism.sourceIterableType,
        protocol: freezeSelectedIterationProtocol(mechanism.protocol),
      });
    case "array-like-index-adapted-to-async":
      return Object.freeze({ ...mechanism });
    case "string-code-unit-index-adapted-to-async":
      return Object.freeze({ ...mechanism });
    case "untyped-dynamic-iteration":
      return Object.freeze({ ...mechanism });
  }
}

function freezeSelectedIterationProtocol(
  protocol: ExtensionSelectedIterationProtocol,
): ExtensionSelectedIterationProtocol {
  const iterationTypes = Object.freeze({ ...protocol.iterationTypes });
  if (protocol.resolutionKind === "known-iterable-instantiation") {
    return Object.freeze({
      resolutionKind: protocol.resolutionKind,
      sourceIterableType: protocol.sourceIterableType,
      iterationTypes,
      iterableTargetType: protocol.iterableTargetType,
      iterableSymbol: protocol.iterableSymbol,
      iterableValueDeclaration: protocol.iterableValueDeclaration,
      iterableDeclarations: Object.freeze([...protocol.iterableDeclarations]),
    });
  }
  return Object.freeze({
    resolutionKind: protocol.resolutionKind,
    sourceIterableType: protocol.sourceIterableType,
    iterationTypes,
    iteratorMethodSymbol: protocol.iteratorMethodSymbol,
    iteratorMethodValueDeclaration: protocol.iteratorMethodValueDeclaration,
    iteratorMethodDeclarations: Object.freeze([...protocol.iteratorMethodDeclarations]),
    iteratorMethodType: protocol.iteratorMethodType,
    iteratorType: protocol.iteratorType,
  });
}
