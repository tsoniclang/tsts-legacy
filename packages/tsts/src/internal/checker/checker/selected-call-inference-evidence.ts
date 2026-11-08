import type { InferenceContext, InferenceInfo } from "./state.js";
import { TypeFlagsUnion, Type_Types } from "../types.js";
import type {
  ResolvedCallInferenceContribution,
  ResolvedCallInferenceEvidence,
  ResolvedCallInferenceOrigin,
  ResolvedCallInferencePathPart,
  Signature,
  Type,
} from "../types.js";

interface SelectedInferenceTrace {
  readonly context: InferenceContext;
  readonly origin: ResolvedCallInferenceOrigin;
  sourceType: Type;
  formalType: Type;
  sourcePath: readonly ResolvedCallInferencePathPart[];
  formalPath: readonly ResolvedCallInferencePathPart[];
  complete: boolean;
  typeArguments: SelectedInferenceTypeArgumentOwners | undefined;
  signatures: SelectedInferenceSignatures | undefined;
}

interface SelectedInferenceTypeArgumentOwners {
  readonly source: Type;
  readonly formal: Type;
  readonly sourceArray: boolean;
  readonly formalArray: boolean;
}

interface SelectedInferenceSignatures {
  readonly source: Signature;
  readonly formal: Signature;
  readonly checkedSource: Signature;
  readonly checkedFormal: Signature;
  readonly kind: "call" | "construct";
}

export interface SelectedCallInferenceSignatureObservation {
  readonly journal: SelectedCallInferenceJournal;
  readonly context: InferenceContext;
  readonly sourceType: Type;
  readonly formalType: Type;
  readonly signatures: SelectedInferenceSignatures;
}

interface SelectedInferenceCandidate {
  readonly context: InferenceContext;
  readonly parameter: Type;
  readonly candidate: Type;
  readonly priority: number;
  readonly contravariant: boolean;
  readonly contribution: ResolvedCallInferenceContribution | undefined;
}

export interface SelectedCallInferenceJournal {
  readonly contexts: readonly InferenceContext[];
  readonly records: SelectedInferenceCandidate[];
  readonly traces: SelectedInferenceTrace[];
  readonly complete: boolean;
  readonly reserve: () => boolean;
  readonly release: () => void;
}

const unavailable: ResolvedCallInferenceEvidence = Object.freeze({ kind: "unavailable" });

export function createSelectedCallInferenceJournal(
  contexts: readonly InferenceContext[],
  reserve: () => boolean,
  release: () => void,
): SelectedCallInferenceJournal {
  let complete = true;
  return {
    contexts,
    records: [],
    traces: [],
    get complete() { return complete; },
    reserve: () => {
      if (!complete) return false;
      complete = reserve();
      return complete;
    },
    release,
  };
}

export function withSelectedCallInferenceOrigin<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  context: InferenceContext,
  origin: ResolvedCallInferenceOrigin,
  sourceType: Type,
  formalType: Type,
  operation: () => Output,
): Output {
  if (journal === undefined || !journal.reserve()) return operation();
  const trace: SelectedInferenceTrace = {
    context,
    origin: Object.freeze(origin),
    sourceType,
    formalType,
    sourcePath: Object.freeze([]),
    formalPath: Object.freeze([]),
    complete: true,
    typeArguments: undefined,
    signatures: undefined,
  };
  journal.traces.push(trace);
  try {
    return operation();
  } finally {
    if (journal.traces.pop() !== trace) throw new Error("Selected inference origins must settle in stack order.");
    journal.release();
  }
}

export function withSelectedCallInferenceProjection<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  sourceType: Type,
  formalType: Type,
  sourcePart: ResolvedCallInferencePathPart | null | undefined,
  formalPart: ResolvedCallInferencePathPart | null | undefined,
  operation: () => Output,
): Output {
  return withSelectedCallInferencePaths(journal, inferences, sourceType, formalType,
    sourcePart === undefined ? undefined : sourcePart === null ? null : [sourcePart],
    formalPart === undefined ? undefined : formalPart === null ? null : [formalPart], operation);
}

export function withSelectedCallInferencePaths<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  sourceType: Type,
  formalType: Type,
  sourceParts: readonly ResolvedCallInferencePathPart[] | null | undefined,
  formalParts: readonly ResolvedCallInferencePathPart[] | null | undefined,
  operation: () => Output,
): Output {
  const trace = currentTrace(journal, inferences);
  if (trace === undefined || journal === undefined || !journal.reserve()) return operation();
  const previous = {
    sourceType: trace.sourceType,
    formalType: trace.formalType,
    sourcePath: trace.sourcePath,
    formalPath: trace.formalPath,
    complete: trace.complete,
  };
  const sourceMatches = sourceParts === undefined ? trace.sourceType === sourceType
    : sourceParts !== null && sourceParts[0]?.owner === trace.sourceType;
  const formalMatches = formalParts === undefined ? trace.formalType === formalType
    : formalParts !== null && formalParts[0]?.owner === trace.formalType;
  trace.sourceType = sourceType;
  trace.formalType = formalType;
  if (sourceParts !== undefined && sourceParts !== null) trace.sourcePath = Object.freeze([...trace.sourcePath, ...sourceParts.map(part => Object.freeze(part))]);
  if (formalParts !== undefined && formalParts !== null) trace.formalPath = Object.freeze([...trace.formalPath, ...formalParts.map(part => Object.freeze(part))]);
  trace.complete = trace.complete && sourceMatches && formalMatches;
  try {
    return operation();
  } finally {
    Object.assign(trace, previous);
    journal.release();
  }
}

export function withSelectedCallInferenceFrame<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  operation: () => Output,
): Output {
  const trace = currentTrace(journal, inferences);
  return trace === undefined ? operation() : withSelectedCallInferenceProjection(journal, inferences,
    trace.sourceType, trace.formalType, undefined, undefined, operation);
}

export function selectCallInferenceProjection(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  sourceType: Type,
  formalType: Type,
  sourcePart: ResolvedCallInferencePathPart | null | undefined,
  formalPart: ResolvedCallInferencePathPart | null | undefined,
): void {
  const trace = currentTrace(journal, inferences);
  if (trace === undefined) return;
  const sourceMatches = sourcePart === undefined ? trace.sourceType === sourceType
    : sourcePart !== null && sourcePart.owner === trace.sourceType;
  const formalMatches = formalPart === undefined ? trace.formalType === formalType
    : formalPart !== null && formalPart.owner === trace.formalType;
  trace.sourceType = sourceType;
  trace.formalType = formalType;
  if (sourcePart !== undefined && sourcePart !== null) trace.sourcePath = Object.freeze([...trace.sourcePath, Object.freeze(sourcePart)]);
  if (formalPart !== undefined && formalPart !== null) trace.formalPath = Object.freeze([...trace.formalPath, Object.freeze(formalPart)]);
  trace.complete = trace.complete && sourceMatches && formalMatches;
}

export function selectedCallInferencePosition(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
): { readonly sourceType: Type; readonly formalType: Type } | undefined {
  const trace = currentTrace(journal, inferences);
  return trace === undefined ? undefined : { sourceType: trace.sourceType, formalType: trace.formalType };
}

export function withSelectedCallInferenceUnionMembers<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  source: Type | undefined,
  formal: Type | undefined,
  operation: () => Output,
): Output {
  const position = selectedCallInferencePosition(journal, inferences);
  if (position === undefined || source === undefined || formal === undefined) return operation();
  const member = (owner: Type, selected: Type): ResolvedCallInferencePathPart | null | undefined => {
    if (owner === selected) return undefined;
    if ((owner.flags & TypeFlagsUnion) === 0) return null;
    const index = Type_Types(owner).indexOf(selected);
    return index < 0 ? null : { kind: "union-member", owner, member: selected, index };
  };
  return withSelectedCallInferenceProjection(journal, inferences, source, formal,
    member(position.sourceType, source), member(position.formalType, formal), operation);
}

export function withSelectedCallInferenceTypeArguments<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  owners: SelectedInferenceTypeArgumentOwners,
  operation: () => Output,
): Output {
  const trace = currentTrace(journal, inferences);
  if (trace === undefined) return operation();
  const previous = trace.typeArguments;
  trace.typeArguments = owners;
  try {
    return operation();
  } finally {
    trace.typeArguments = previous;
  }
}

export function selectedCallInferenceTypeArguments(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
): SelectedInferenceTypeArgumentOwners | undefined {
  return currentTrace(journal, inferences)?.typeArguments;
}

export function withSelectedCallInferenceSignatures<Output>(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  signatures: SelectedInferenceSignatures,
  operation: () => Output,
): Output {
  const trace = currentTrace(journal, inferences);
  if (trace === undefined) return operation();
  const previous = trace.signatures;
  trace.signatures = signatures;
  try {
    return operation();
  } finally {
    trace.signatures = previous;
  }
}

export function selectedCallInferenceSignatures(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
): SelectedInferenceSignatures | undefined {
  return currentTrace(journal, inferences)?.signatures;
}

export function retainSelectedCallInferenceCandidate(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
  inference: InferenceInfo,
  sourceType: Type,
  formalType: Type,
  candidate: Type,
  priority: number,
  contravariant: boolean,
): void {
  if (journal === undefined || !journal.complete || inference.typeParameter === undefined) return;
  const trace = currentTrace(journal, inferences);
  const context = trace?.context ?? journal.contexts.find(candidateContext => candidateContext.inferences === inferences);
  if (context === undefined) return;
  const contribution = trace !== undefined && trace.complete && trace.sourceType === sourceType && trace.formalType === formalType
    ? Object.freeze({ typeParameter: inference.typeParameter, origin: trace.origin,
      sourcePath: trace.sourcePath, formalPath: trace.formalPath }) : undefined;
  if (!journal.reserve()) return;
  journal.records.push({ context, parameter: inference.typeParameter, candidate, priority, contravariant, contribution });
}

export function copySelectedCallInferenceContext(
  journal: SelectedCallInferenceJournal,
  source: InferenceContext,
  destination: InferenceContext,
): void {
  for (const record of journal.records.slice()) {
    if (record.context !== source) continue;
    if (!journal.reserve()) return;
    journal.records.push({ ...record, context: destination });
  }
}

export function selectedCallInferenceEvidence(
  journal: SelectedCallInferenceJournal | undefined,
  context: InferenceContext | undefined,
): ResolvedCallInferenceEvidence {
  if (journal?.complete === false) return unavailable;
  if (context === undefined) return Object.freeze({ kind: "available", contributions: Object.freeze([]) });
  const expected = new Map<Type, {
    readonly inference: InferenceInfo;
    readonly positive: Set<Type>;
    readonly negative: Set<Type>;
    readonly observedPositive: Set<Type>;
    readonly observedNegative: Set<Type>;
  }>();
  for (const inference of context.inferences) {
    if (inference?.typeParameter === undefined) continue;
    expected.set(inference.typeParameter, {
      inference,
      positive: new Set(inference.candidates.filter((candidate): candidate is Type => candidate !== undefined)),
      negative: new Set(inference.contraCandidates.filter((candidate): candidate is Type => candidate !== undefined)),
      observedPositive: new Set(),
      observedNegative: new Set(),
    });
  }
  const contributions: ResolvedCallInferenceContribution[] = [];
  for (const record of journal?.records ?? []) {
    if (record.context !== context) continue;
    const actual = expected.get(record.parameter);
    const candidates = record.contravariant ? actual?.negative : actual?.positive;
    if (actual === undefined || actual.inference.priority !== record.priority || !candidates?.has(record.candidate)) continue;
    if (record.contribution === undefined) return unavailable;
    (record.contravariant ? actual.observedNegative : actual.observedPositive).add(record.candidate);
    contributions.push(record.contribution);
  }
  for (const actual of expected.values()) {
    if (actual.positive.size !== actual.observedPositive.size || actual.negative.size !== actual.observedNegative.size) return unavailable;
  }
  return Object.freeze({ kind: "available", contributions: Object.freeze(contributions) });
}

function currentTrace(
  journal: SelectedCallInferenceJournal | undefined,
  inferences: InferenceContext["inferences"],
): SelectedInferenceTrace | undefined {
  return journal?.complete ? journal.traces.findLast(trace => trace.context.inferences === inferences) : undefined;
}
