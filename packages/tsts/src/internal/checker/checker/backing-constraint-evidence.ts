import type { Diagnostic } from "../../ast/diagnostic.js";
import type { Node } from "../../ast/spine.js";
import { Node_Arguments, Node_Initializer, Node_Type } from "../../ast/ast.js";
import { IsReturnStatement, IsTypeParameterDeclaration } from "../../ast/generated/predicates.js";
import { AsTypeParameterDeclaration } from "../../ast/generated/casts.js";
import { GetContainingFunction, HasInitializer, IsCallOrNewExpression } from "../../ast/utilities.js";
import type {
  ResolvedCallApplicationEvidence,
  ResolvedCheckedComponentEvidence,
  ResolvedCheckerBackingConstraint,
  ResolvedCheckerDiagnosticCoverage,
  Signature,
  Type,
} from "../types.js";
import type { Checker } from "./state.js";

type ConstraintBody = ResolvedCheckerBackingConstraint extends infer Constraint
  ? Constraint extends ResolvedCheckerBackingConstraint
    ? Omit<Constraint, "diagnostic">
    : never
  : never;

interface ConstraintFrame {
  readonly body: ConstraintBody;
  readonly diagnostics: Diagnostic[];
}

interface ConstraintRecord {
  readonly body: ConstraintBody;
  readonly diagnostic: Diagnostic;
  root: Diagnostic;
  readonly candidate: Signature | undefined;
  readonly tree: ReadonlyMap<Diagnostic, DiagnosticEdges>;
}

interface DiagnosticEdges {
  readonly messages: readonly (Diagnostic | undefined)[];
  readonly related: readonly (Diagnostic | undefined)[];
}

interface InvocationObservation {
  readonly invocation: Node;
  readonly diagnostics: Set<Diagnostic>;
}

export interface BackingConstraintEvidenceState {
  readonly frames: ConstraintFrame[];
  readonly records: ConstraintRecord[];
  readonly candidates: ResolvedCallApplicationEvidence[];
  readonly roots: Map<Diagnostic, ConstraintRecord[]>;
  readonly invocations: Map<Node, Map<ResolvedCallApplicationEvidence, ConstraintRecord[]>>;
  readonly diagnosticCaptures: Diagnostic[][];
  readonly origins: Map<Diagnostic, ConstraintRecord[]>;
  readonly envelopes: Map<Diagnostic, DiagnosticEdges>;
  readonly notes: Map<Diagnostic, Diagnostic[]>;
  readonly noteTrees: Map<Diagnostic, ReadonlyMap<Diagnostic, DiagnosticEdges>>;
  readonly applicability: Set<ConstraintRecord>;
  readonly applicabilityRoots: Map<Diagnostic, Node>;
  readonly invocationFrames: InvocationObservation[];
  readonly invocationDiagnostics: Map<Node, Set<Diagnostic>>;
  revision: number;
  cachedRevision: number;
  cached: readonly ResolvedCheckerBackingConstraint[];
}

function stateFor(checker: Checker): BackingConstraintEvidenceState {
  return checker.backingConstraintEvidenceState ??= { frames: [], records: [], candidates: [],
    roots: new Map(), invocations: new Map(), diagnosticCaptures: [],
    origins: new Map(), envelopes: new Map(), notes: new Map(), noteTrees: new Map(),
    applicability: new Set(), applicabilityRoots: new Map(), invocationFrames: [], invocationDiagnostics: new Map(),
    revision: 0, cachedRevision: -1, cached: Object.freeze([]) };
}

export function checkedComponent(
  node: Node,
  type: Type,
  kind: "value" | "annotation" | "declaration" = "value",
): ResolvedCheckedComponentEvidence {
  return Object.freeze({ root: Object.freeze({ kind, node, type }),
    path: Object.freeze([]), type, application: undefined });
}

export function withBackingConstraint<Output>(
  checker: Checker,
  body: ConstraintBody,
  operation: () => Output,
): Output {
  const state = stateFor(checker);
  const frame: ConstraintFrame = { body, diagnostics: [] };
  state.frames.push(frame);
  try {
    return operation();
  } finally {
    if (state.frames.pop() !== frame) throw new Error("Backing constraints must settle in exact stack order.");
  }
}

export function withBackingCandidate<Output>(
  checker: Checker,
  application: ResolvedCallApplicationEvidence,
  operation: () => Output,
): Output {
  const candidates = stateFor(checker).candidates;
  candidates.push(application);
  try {
    return operation();
  } finally {
    if (candidates.pop() !== application) throw new Error("Backing candidate observations must settle in exact stack order.");
  }
}

export function withBackingApplicabilityConstraint<Output>(
  checker: Checker,
  body: ConstraintBody,
  diagnostics: readonly (Diagnostic | undefined)[] | undefined,
  operation: () => Output,
): Output {
  const state = stateFor(checker);
  const firstRecord = state.records.length;
  const firstDiagnostic = diagnostics?.length ?? 0;
  const result = withBackingConstraint(checker, body, operation);
  if (body.application !== undefined) {
    for (const diagnostic of diagnostics?.slice(firstDiagnostic) ?? []) {
      if (diagnostic === undefined) continue;
      const tree = diagnosticTree(diagnostic);
      for (const record of state.records.slice(firstRecord)) {
        if (record.body === body && tree.has(record.diagnostic)) state.applicability.add(record);
      }
    }
    state.revision++;
  }
  return result;
}

export function beginBackingInvocation(checker: Checker, invocation: Node): InvocationObservation {
  const state = stateFor(checker);
  let diagnostics = state.invocationDiagnostics.get(invocation);
  if (diagnostics === undefined) state.invocationDiagnostics.set(invocation, diagnostics = new Set());
  const observation = { invocation, diagnostics };
  state.invocationFrames.push(observation);
  return observation;
}

export function endBackingInvocation(checker: Checker, observation: InvocationObservation | undefined): void {
  if (observation === undefined) return;
  if (stateFor(checker).invocationFrames.pop() !== observation) {
    throw new Error("Call diagnostic observations must settle in exact stack order.");
  }
}

export function retainCallApplicabilityDiagnostics(checker: Checker, invocation: Node,
  diagnostics: readonly Diagnostic[]): void {
  const state = stateFor(checker);
  for (const diagnostic of diagnostics) state.applicabilityRoots.set(diagnostic, invocation);
  state.revision++;
}

export function activeBackingCandidate(checker: Checker): ResolvedCallApplicationEvidence | undefined {
  return checker.backingConstraintEvidenceState?.candidates.at(-1);
}

export function capturePublishedDiagnostics(checker: Checker, operation: () => void): readonly Diagnostic[] {
  const captures = stateFor(checker).diagnosticCaptures;
  const diagnostics: Diagnostic[] = [];
  captures.push(diagnostics);
  try {
    operation();
    return Object.freeze(diagnostics);
  } finally {
    if (captures.pop() !== diagnostics) throw new Error("Diagnostic publication must settle in exact stack order.");
  }
}

export function observePublishedDiagnostic(checker: Checker, diagnostic: Diagnostic | undefined): void {
  if (diagnostic === undefined) return;
  for (const capture of checker.backingConstraintEvidenceState?.diagnosticCaptures ?? []) {
    if (!capture.includes(diagnostic)) capture.push(diagnostic);
  }
  const state = checker.backingConstraintEvidenceState;
  if (state !== undefined) {
    for (const frame of state.invocationFrames) frame.diagnostics.add(diagnostic);
    for (let current = checker.currentNode; current?.Parent !== undefined; current = current.Parent) {
      const parent = current.Parent;
      if (!IsCallOrNewExpression(parent) || !(Node_Arguments(parent) ?? []).includes(current)) continue;
      let diagnostics = state.invocationDiagnostics.get(parent);
      if (diagnostics === undefined) state.invocationDiagnostics.set(parent, diagnostics = new Set());
      diagnostics.add(diagnostic);
    }
    state.revision++;
  }
}

function diagnosticEdges(diagnostic: Diagnostic): DiagnosticEdges {
  return { messages: Object.freeze(diagnostic.messageChain.slice()),
    related: Object.freeze(diagnostic.relatedInformation.slice()) };
}

function diagnosticTree(diagnostic: Diagnostic): ReadonlyMap<Diagnostic, DiagnosticEdges> {
  const tree = new Map<Diagnostic, DiagnosticEdges>();
  const pending = [diagnostic];
  while (pending.length !== 0) {
    const current = pending.pop()!;
    if (tree.has(current)) continue;
    const edges = diagnosticEdges(current);
    tree.set(current, edges);
    for (const child of [...edges.messages, ...edges.related]) if (child !== undefined) pending.push(child);
  }
  return tree;
}

export function retainBackingDiagnosticEnvelope(checker: Checker, diagnostic: Diagnostic): void {
  const state = stateFor(checker);
  state.envelopes.set(diagnostic, diagnosticEdges(diagnostic));
  state.revision++;
}

export function retainBackingDiagnosticNotes(checker: Checker, diagnostic: Diagnostic,
  notes: readonly (Diagnostic | undefined)[]): void {
  const state = stateFor(checker);
  const existing = state.notes.get(diagnostic) ?? [];
  for (const note of notes) {
    if (note === undefined) continue;
    if (!existing.includes(note)) existing.push(note);
    state.noteTrees.set(note, diagnosticTree(note));
  }
  state.notes.set(diagnostic, existing);
  state.revision++;
}

export function checkerDiagnosticCoverage(checker: Checker, root: Diagnostic): ResolvedCheckerDiagnosticCoverage {
  const state = checker.backingConstraintEvidenceState;
  const unavailable = (): ResolvedCheckerDiagnosticCoverage => Object.freeze({ kind: "unavailable", root });
  if (state === undefined) return unavailable();
  const obligations = new Set<ConstraintRecord>();
  const visited = new Set<Diagnostic>();
  const authorized = new Set<Diagnostic>();
  const notes = new Set<Diagnostic>();
  const same = (actual: readonly (Diagnostic | undefined)[], expected: readonly (Diagnostic | undefined)[]): boolean =>
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
  const matches = (diagnostic: Diagnostic, edges: DiagnosticEdges): boolean => {
    const notes = state.notes.get(diagnostic) ?? [];
    return same(diagnostic.messageChain, edges.messages) && same(diagnostic.relatedInformation,
      [...edges.related, ...notes.filter(note => !edges.related.includes(note))]);
  };
  const inspectNotes = (diagnostic: Diagnostic): boolean => {
    for (const note of state.notes.get(diagnostic) ?? []) {
      const tree = state.noteTrees.get(note);
      if (tree === undefined) return false;
      for (const [node, edges] of tree) if (!matches(node, edges)) return false;
      notes.add(note);
    }
    return true;
  };
  const inspect = (diagnostic: Diagnostic): boolean => {
    if (visited.has(diagnostic)) return false;
    visited.add(diagnostic);
    const records = state.origins.get(diagnostic);
    if (records !== undefined) {
      for (const record of records) {
        for (const [node, edges] of record.tree) {
          if (!matches(node, edges) || !inspectNotes(node)) return false;
          authorized.add(node);
        }
        obligations.add(record);
      }
      return true;
    }
    const envelope = state.envelopes.get(diagnostic);
    return envelope !== undefined && matches(diagnostic, envelope) && inspectNotes(diagnostic) && envelope.messages.length !== 0
      && envelope.messages.every(child => child !== undefined && inspect(child))
      && envelope.related.every(child => child !== undefined
        && (authorized.has(child) || state.notes.get(diagnostic)?.includes(child)));
  };
  if (!inspect(root)) return unavailable();
  const invocation = state.applicabilityRoots.get(root);
  const alternative = invocation !== undefined && obligations.size !== 0 && [...obligations].every(record =>
    state.applicability.has(record) && record.body.application?.invocation === invocation);
  if (alternative) {
    for (const diagnostic of state.invocationDiagnostics.get(invocation) ?? []) {
      if (state.applicabilityRoots.get(diagnostic) !== invocation) return unavailable();
      if (diagnostic !== root && !inspect(diagnostic)) return unavailable();
    }
    if (![...obligations].every(record => state.applicability.has(record) && record.body.application?.invocation === invocation)) return unavailable();
  }
  return Object.freeze({ kind: "complete", root, obligations: Object.freeze([...obligations].map(record =>
    Object.freeze({ diagnostic: record.diagnostic, application: record.body.application,
      kind: state.applicability.has(record) ? "applicability" as const : "backing" as const }))),
    purpose: alternative
      ? Object.freeze({ kind: "alternative-applicability", invocation, notes: Object.freeze([...notes]) })
      : Object.freeze({ kind: "other" }) });
}

export function withBackingWriteFit<Output>(
  checker: Checker,
  expression: Node | undefined,
  source: Type | undefined,
  target: Type | undefined,
  operation: () => Output,
): Output {
  if (expression === undefined || source === undefined || target === undefined ||
    checker.backingConstraintEvidenceState?.frames.length) return operation();
  const parent = expression.Parent;
  const declaration = parent !== undefined && HasInitializer(parent) && Node_Initializer(parent) === expression ? parent
    : IsReturnStatement(parent) ? GetContainingFunction(parent) : undefined;
  const annotation = declaration === undefined ? undefined : Node_Type(declaration);
  if (annotation === undefined) return operation();
  return withBackingConstraint(checker, { kind: "write-fit", site: expression,
    application: activeBackingCandidate(checker), source: checkedComponent(expression, source),
    destination: checkedComponent(annotation, target, "annotation") }, operation);
}

export function withBackingTypeArgumentFit<Output>(
  checker: Checker,
  argument: Node | undefined,
  source: Type | undefined,
  parameter: Type | undefined,
  target: Type | undefined,
  application: ResolvedCallApplicationEvidence | undefined,
  diagnostics: readonly (Diagnostic | undefined)[] | undefined,
  operation: () => Output,
): Output {
  const declaration = parameter?.symbol?.Declarations?.find(node => node !== undefined && IsTypeParameterDeclaration(node));
  const annotation = declaration === undefined ? undefined : AsTypeParameterDeclaration(declaration)?.Constraint;
  if (argument === undefined || source === undefined || target === undefined || annotation === undefined) return operation();
  const body: ConstraintBody = { kind: "write-fit", site: argument, application,
    source: Object.freeze({ ...checkedComponent(argument, source, "annotation"), application }),
    destination: Object.freeze({ ...checkedComponent(annotation, target, "annotation"), application }) };
  return application === undefined ? withBackingConstraint(checker, body, operation)
    : withBackingApplicabilityConstraint(checker, body, diagnostics, operation);
}

export function observeBackingDiagnostic(checker: Checker, diagnostic: Diagnostic | undefined): void {
  if (diagnostic === undefined) return;
  const state = checker.backingConstraintEvidenceState;
  if (state === undefined) return;
  const frame = state.frames.at(-1);
  if (frame !== undefined && !frame.diagnostics.includes(diagnostic)) {
    frame.diagnostics.push(diagnostic);
    const application = frame.body.application;
    const record: ConstraintRecord = { body: frame.body, diagnostic, root: diagnostic,
      candidate: application?.signature, tree: diagnosticTree(diagnostic) };
    state.records.push(record);
    const origins = state.origins.get(diagnostic);
    if (origins === undefined) state.origins.set(diagnostic, [record]);
    else origins.push(record);
    const roots = state.roots.get(diagnostic);
    if (roots === undefined) state.roots.set(diagnostic, [record]);
    else roots.push(record);
    if (application !== undefined) {
      let invocation = state.invocations.get(application.invocation);
      if (invocation === undefined) state.invocations.set(application.invocation, invocation = new Map());
      const records = invocation.get(application);
      if (records === undefined) invocation.set(application, [record]);
      else records.push(record);
    }
    state.revision++;
  }
  const contained = new Set<Diagnostic>();
  const pending = [diagnostic];
  while (pending.length !== 0) {
    const current = pending.pop()!;
    if (contained.has(current)) continue;
    contained.add(current);
    for (const child of current.messageChain) if (child !== undefined) pending.push(child);
    for (const child of current.relatedInformation) if (child !== undefined) pending.push(child);
  }
  for (const child of contained) {
    if (child === diagnostic) continue;
    const records = state.roots.get(child);
    if (records === undefined) continue;
    state.roots.delete(child);
    const roots = state.roots.get(diagnostic);
    if (roots === undefined) state.roots.set(diagnostic, records);
    else roots.push(...records);
    for (const record of records) record.root = diagnostic;
    state.revision++;
  }
}

export function checkerBackingConstraints(
  checker: Checker,
  application?: ResolvedCallApplicationEvidence,
): readonly ResolvedCheckerBackingConstraint[] {
  const state = checker.backingConstraintEvidenceState;
  if (state === undefined) return Object.freeze([]);
  const snapshot = (record: ConstraintRecord): ResolvedCheckerBackingConstraint => Object.freeze({ ...record.body,
    diagnostic: Object.freeze({ diagnostic: record.diagnostic, root: record.root, candidate: record.candidate,
      rootCoverage: checkerDiagnosticCoverage(checker, record.root) }) });
  if (application !== undefined) {
    return Object.freeze((state.invocations.get(application.invocation)?.get(application) ?? []).map(snapshot));
  }
  if (state.cachedRevision !== state.revision) {
    state.cached = Object.freeze(state.records.map(snapshot));
    state.cachedRevision = state.revision;
  }
  return state.cached;
}
