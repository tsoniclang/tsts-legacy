import type { GoPtr } from "../go/compat.js";
import type { Node } from "../internal/ast/spine.js";
import { Node_AsFlowReduceLabelData } from "../internal/ast/ast.js";
import {
  FlowFlagsCondition,
  FlowFlagsAssignment,
  FlowFlagsLabel,
  FlowFlagsReduceLabel,
  FlowFlagsStart,
  FlowFlagsTrueCondition,
  FlowFlagsUnreachable,
} from "../internal/ast/flow.js";
import type { FlowList, FlowNode } from "../internal/ast/flow.js";
import { getFlowNodeOfNode } from "../internal/checker/flow.js";
import { Checker_GetTypeAtLocation } from "../internal/checker/checker/types.js";
import type { Checker } from "../internal/checker/checker/state.js";

export interface ResolvedSourceFlowCondition {
  readonly expression: Node;
  readonly assumed: boolean;
  readonly assignments: readonly Node[];
}

export interface ResolvedSourceFlowConditionInfo {
  readonly reference: Node;
  readonly conditions: readonly ResolvedSourceFlowCondition[];
}

const maximumFlowEvidenceNodes = 65_536;
const maximumFlowEvidenceWork = 2_097_152;

export function resolveSourceFlowConditionInfo(
  checker: GoPtr<Checker>,
  reference: GoPtr<Node>,
): GoPtr<ResolvedSourceFlowConditionInfo> {
  if (checker === undefined || reference === undefined) return undefined;
  Checker_GetTypeAtLocation(checker, reference);
  const origin = getFlowNodeOfNode(reference);
  if (origin === undefined) return undefined;
  let remainingWork = maximumFlowEvidenceWork;
  const consume = (): boolean => --remainingWork >= 0;
  const antecedents = (head: GoPtr<FlowList>): readonly FlowNode[] | undefined => {
    const result: FlowNode[] = [];
    const visited = new Set<FlowList>();
    for (let current = head; current !== undefined; current = current.Next) {
      if (!consume() || visited.has(current) || current.Flow === undefined) return undefined;
      visited.add(current);
      result.push(current.Flow);
    }
    return result;
  };
  const graph = new Map<FlowNode, readonly FlowNode[]>();
  const reductions = new Map<FlowNode, FlowNode[]>();
  const candidates: { readonly expression: Node; readonly assumed: boolean }[] = [];
  const selectedOutcomes = new Map<Node, Set<boolean>>();
  const pending = [origin];
  let hasStart = false;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!consume()) return undefined;
    if (graph.has(current)) continue;
    if (graph.size >= maximumFlowEvidenceNodes) return undefined;
    const flags = current.Flags;
    if ((flags & FlowFlagsUnreachable) !== 0) {
      graph.set(current, []);
      continue;
    }
    if ((flags & FlowFlagsStart) !== 0) {
      hasStart = true;
      graph.set(current, []);
      continue;
    }
    const previous = (flags & FlowFlagsLabel) !== 0
      ? antecedents(current.Antecedents)
      : current.Antecedent === undefined ? undefined : [current.Antecedent];
    if (previous === undefined) return undefined;
    graph.set(current, previous);
    for (const predecessor of previous) pending.push(predecessor);
    if ((flags & FlowFlagsCondition) !== 0) {
      if (current.Node === undefined) return undefined;
      const assumed = (flags & FlowFlagsTrueCondition) !== 0;
      const outcomes = selectedOutcomes.get(current.Node) ?? new Set<boolean>();
      if (!outcomes.has(assumed)) {
        outcomes.add(assumed);
        selectedOutcomes.set(current.Node, outcomes);
        candidates.push(Object.freeze({ expression: current.Node, assumed }));
      }
    }
    if ((flags & FlowFlagsReduceLabel) !== 0) {
      if (current.Node === undefined) return undefined;
      const reduced = Node_AsFlowReduceLabelData(current.Node);
      const target = reduced?.Target;
      const replacements = reduced === undefined ? undefined : antecedents(reduced.Antecedents);
      if (target === undefined || replacements === undefined) return undefined;
      const retained = reductions.get(target) ?? [];
      for (const replacement of replacements) retained.push(replacement);
      reductions.set(target, retained);
      pending.push(target);
      for (const replacement of replacements) pending.push(replacement);
    }
  }
  if (!hasStart) return undefined;
  const conditions: ResolvedSourceFlowCondition[] = [];
  for (const candidate of candidates) {
    const visited = new Set<FlowNode>();
    const assignments = new Set<Node>();
    const pending = [origin];
    let bypasses = false;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!consume()) return undefined;
      if (visited.has(current)) continue;
      visited.add(current);
      const flags = current.Flags;
      if ((flags & FlowFlagsUnreachable) !== 0 ||
        (flags & FlowFlagsCondition) !== 0 && current.Node === candidate.expression &&
        ((flags & FlowFlagsTrueCondition) !== 0) === candidate.assumed) continue;
      if ((flags & FlowFlagsStart) !== 0) {
        bypasses = true;
        break;
      }
      if ((flags & FlowFlagsAssignment) !== 0) {
        if (current.Node === undefined) return undefined;
        assignments.add(current.Node);
      }
      const previous = graph.get(current);
      if (previous === undefined) return undefined;
      for (const predecessor of previous) pending.push(predecessor);
      for (const predecessor of reductions.get(current) ?? []) pending.push(predecessor);
    }
    if (!bypasses) conditions.push(Object.freeze({
      ...candidate, assignments: Object.freeze([...assignments]),
    }));
  }
  return Object.freeze({ reference, conditions: Object.freeze(conditions) });
}
