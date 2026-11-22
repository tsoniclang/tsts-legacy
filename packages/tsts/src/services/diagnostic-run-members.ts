import type { Diagnostic } from "../internal/ast/diagnostic.js";

export function createCheckerDiagnosticPublication() {
  let published: { readonly roots: readonly (Diagnostic | undefined)[]; readonly members: WeakSet<Diagnostic> } | undefined;
  return {
    admits: (diagnostic: Diagnostic): boolean => published?.members.has(diagnostic) ?? true,
    publish(roots: readonly (Diagnostic | undefined)[]): readonly (Diagnostic | undefined)[] {
      if (published !== undefined) return published.roots;
      const members = new WeakSet<Diagnostic>();
      for (const root of roots) {
        if (root === undefined) throw new Error("A published checker diagnostic inventory must be dense.");
        for (const member of getDiagnosticRunMembers(root)) members.add(member);
      }
      published = { roots, members };
      return roots;
    },
  };
}

// The added diagnostics a published diagnostic stands for: the run members compactAndMergeRelatedInfos recorded on its
// clone, or the diagnostic itself when it was published unchanged (a run of one). A cause recorded on an added diagnostic
// leads to the published one when it is in this list.
export function getDiagnosticRunMembers(diagnostic: Diagnostic): readonly Diagnostic[] {
  const members = diagnostic.runMembers;
  if (members === undefined) return [diagnostic];
  if (!hasCompleteRun(members)) throw new Error("A published diagnostic's run members contain an undefined entry.");
  return members;
}

function hasCompleteRun(members: readonly (Diagnostic | undefined)[]): members is readonly Diagnostic[] {
  for (const member of members) {
    if (member === undefined) return false;
  }
  return true;
}
