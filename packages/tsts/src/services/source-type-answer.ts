import type { Node } from "../internal/ast/spine.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import { SourceFile_FileName } from "../internal/ast/ast.js";
import { GetSourceFileOfNode } from "../internal/ast/utilities.js";
import { Program_GetSourceFile, Program_GetTypeCheckerForFile, type Program } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Background, type Context } from "../go/context.js";
import { borrowedSourceTypeAnswer, type CheckerDiagnosticMembership, type ResolvedSourceTypeInfo,
  type SourceTypeAnswer } from "../internal/checker/checker/source-type-answers.js";

export function admitSourceTypeAnswer(answer: SourceTypeAnswer, admits: CheckerDiagnosticMembership | undefined): SourceTypeAnswer {
  if (admits === undefined || answer.causes.length === 0) return answer;
  const causes = answer.causes.filter(admits);
  return causes.length === answer.causes.length ? answer : { ...answer, causes };
}

export function resolveSourceTypeAnswer(program: Program, options: { readonly context?: Context;
  readonly admitsCheckerDiagnostic?: CheckerDiagnosticMembership }, answer: SourceTypeAnswer | undefined): ResolvedSourceTypeInfo | undefined {
  if (answer?.borrowedFrom === undefined) return answer;
  const context = WithCheckerLifetime(options.context ?? Background(), CheckerLifetimeDiagnostics);
  const type = answer.type;
  const pending: Node[] = [];
  const visited = new Set<Node>();
  const causes = new Set<Diagnostic>();
  let nextSource = answer.typeSource;
  let typeSource: Node | undefined;
  const addSource = (source: NonNullable<SourceTypeAnswer["borrowedFrom"]>): void => {
    if ("Kind" in source) pending.push(source);
    else pending.push(source[1], source[0]);
  };
  addSource(answer.borrowedFrom);
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    if (visited.has(source)) continue;
    visited.add(source);
    const file = GetSourceFileOfNode(source);
    if (file === undefined || Program_GetSourceFile(program, SourceFile_FileName(file)) !== file) continue;
    const [owner, done] = Program_GetTypeCheckerForFile(program, context, file);
    let borrowed: SourceTypeAnswer;
    try {
      if (owner === undefined) continue;
      borrowed = borrowedSourceTypeAnswer(owner, source, type, options.admitsCheckerDiagnostic);
    } finally {
      done();
    }
    if (source === nextSource) {
      typeSource = source;
      nextSource = borrowed.typeSource;
    }
    for (const cause of borrowed.causes) causes.add(cause);
    if (borrowed.borrowedFrom !== undefined) addSource(borrowed.borrowedFrom);
  }
  return causes.size === 0 && typeSource !== undefined && nextSource === undefined
    ? { type, causes: [], typeSource }
    : { type, causes: [...causes] };
}
