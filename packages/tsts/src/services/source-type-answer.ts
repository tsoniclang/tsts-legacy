import type { Node } from "../internal/ast/spine.js";
import type { SourceFile } from "../internal/ast/ast.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import { GetSourceFileOfNode } from "../internal/ast/utilities.js";
import { Node_Type } from "../internal/ast/ast.js";
import { type Program } from "../internal/compiler/program.js";
import { CheckerLifetimeAPI, CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Background, type Context } from "../go/context.js";
import { Checker_GetReturnTypeOfSignature, Checker_GetTypeFromTypeNode } from "../internal/checker/exports.js";
import { Checker_getContextualType, Checker_GetTypeAtLocation } from "../internal/checker/checker/types.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { ContextFlagsNone, TypeFlagsTypeParameter, type ContextFlags, type Signature, type Type } from "../internal/checker/types.js";
import { TypeMapper_Kind, TypeMapper_Map, TypeMapperKindArray, TypeMapperKindSimple } from "../internal/checker/mapper.js";
import { admitNativeChecker, type NativeCheckerAdmission, type NativeCheckerResult } from "../internal/checker/resource-admission.js";
import { borrowedSourceTypeAnswer, completedAnnotationSource, originalSignatureDeclaration, type CheckerDiagnosticMembership, type ResolvedSourceTypeInfo,
  signatureReturnAnswer, sourceTypeAnswer, type SourceTypeAnswer, type SourceTypeAnswerOutput } from "../internal/checker/checker/source-type-answers.js";
import { acquireLeasedChecker, withCheckerById, withSourceFileChecker } from "./checker-ownership.js";

export type SourceTypeRequest =
  | { readonly kind: "expression"; readonly node: Node | undefined }
  | { readonly kind: "annotation"; readonly node: Node | undefined }
  | { readonly kind: "contextual"; readonly node: Node | undefined; readonly flags?: ContextFlags }
  | { readonly kind: "signature-return"; readonly signature: Signature | undefined };

interface SourceTypeOptions {
  readonly sourceFile: SourceFile | undefined;
  readonly context?: Context;
  readonly admitsCheckerDiagnostic?: CheckerDiagnosticMembership;
}

export function admitSourceTypeAnswer(answer: SourceTypeAnswer, admits: CheckerDiagnosticMembership | undefined,
  checker?: Checker): SourceTypeAnswer {
  if (admits === undefined || answer.causes.length === 0) return answer;
  let causes: Diagnostic[] | undefined;
  for (let position = 0; position < answer.causes.length; position += 1) {
    admitNativeChecker(checker, "work");
    const cause = answer.causes[position];
    if (cause === undefined) throw new Error("A source-type answer requires a dense diagnostic vector.");
    if (!admits(cause)) {
      if (causes !== undefined) continue;
      admitNativeChecker(checker, "retained");
      causes = [];
      for (let prefix = 0; prefix < position; prefix += 1) {
        admitNativeChecker(checker, "work");
        admitNativeChecker(checker, "retained");
        causes.push(answer.causes[prefix]!);
      }
    } else if (causes !== undefined) {
      admitNativeChecker(checker, "retained");
      causes.push(cause);
    }
  }
  if (causes === undefined) return answer;
  admitNativeChecker(checker, "retained");
  return { ...answer, causes };
}

function selectedSignatureReturn(checker: Checker, signature: Signature | undefined, type: Type | undefined,
  admits: CheckerDiagnosticMembership | undefined): SourceTypeAnswer | undefined {
  const answer = signatureReturnAnswer(checker, signature, type, admits);
  if (answer === undefined || answer.causes.length !== 0 || signature === undefined || type === undefined
    || type.checker !== checker || (type.flags & TypeFlagsTypeParameter) === 0) return answer;
  admitNativeChecker(checker, "work");
  const target = signature.target;
  const mapper = signature.mapper;
  if (signature.composite !== undefined || target === undefined || mapper === undefined || target.checkerId !== checker.id
    || signature.resolvedReturnType !== type) return answer;
  const original = target.resolvedReturnType;
  if (original === undefined || original === type || original.checker !== checker || (original.flags & TypeFlagsTypeParameter) === 0) return answer;
  const kind = TypeMapper_Kind(mapper);
  if (kind !== TypeMapperKindArray && kind !== TypeMapperKindSimple || TypeMapper_Map(mapper, original) !== type) return answer;
  const declaration = originalSignatureDeclaration(checker, target);
  const annotation = Node_Type(declaration);
  if (declaration === undefined || signature.declaration !== declaration || annotation === undefined
    || completedAnnotationSource(checker, annotation, original) !== annotation) return answer;
  admitNativeChecker(checker, "retained", 2);
  return { ...answer, projectedReturn: { declaration, annotation, original, selected: type } };
}

function readHead(checker: Checker, request: SourceTypeRequest, admits: CheckerDiagnosticMembership | undefined): SourceTypeAnswer | undefined {
  admitNativeChecker(checker, "work");
  switch (request.kind) {
    case "expression": return sourceTypeAnswer(checker, request.node, Checker_GetTypeAtLocation(checker, request.node), admits);
    case "annotation": return sourceTypeAnswer(checker, request.node, Checker_GetTypeFromTypeNode(checker, request.node), admits);
    case "signature-return": return selectedSignatureReturn(checker, request.signature, Checker_GetReturnTypeOfSignature(checker, request.signature), admits);
    case "contextual": {
      const output: SourceTypeAnswerOutput = { value: undefined };
      const type = Checker_getContextualType(checker, request.node, request.flags ?? ContextFlagsNone, output);
      return output.value?.type === type && output.value !== undefined ? admitSourceTypeAnswer(output.value, admits, checker)
        : type === undefined ? undefined : { type, causes: [] };
    }
  }
}

function underLease<Value, Stop extends object>(checker: Checker, context: Context, admit: NativeCheckerAdmission<Stop> | null,
  read: () => Value): NativeCheckerResult<Value, Stop> {
  return admit === null ? { kind: "complete", value: read() } : acquireLeasedChecker(checker, context, admit, read);
}

export function readSourceType<Stop extends object>(program: Program, options: SourceTypeOptions, request: SourceTypeRequest,
  admit: NativeCheckerAdmission<Stop> | null): NativeCheckerResult<ResolvedSourceTypeInfo, Stop> {
  const context = options.context ?? Background();
  const lifetime = request.kind === "signature-return" ? CheckerLifetimeAPI : CheckerLifetimeDiagnostics;
  const read = (checker: Checker) => underLease(checker, WithCheckerLifetime(context, lifetime), admit,
    () => readHead(checker, request, options.admitsCheckerDiagnostic));
  const head = request.kind === "signature-return"
    ? request.signature === undefined ? undefined : withCheckerById(program, options.sourceFile, request.signature.checkerId, context, read)
    : withSourceFileChecker(program, options.sourceFile, GetSourceFileOfNode(request.node), context, read);
  if (head === undefined || head.kind === "unavailable") return { kind: "unavailable" };
  if (head.kind === "refused") return head;
  return settleSourceTypeAnswer(program, options, head.value, admit);
}

export function querySourceType(program: Program, options: SourceTypeOptions, request: SourceTypeRequest): ResolvedSourceTypeInfo | undefined {
  const result = readSourceType(program, options, request, null);
  return result.kind === "complete" ? result.value : undefined;
}

export function resolveSourceTypeAnswer(program: Program, options: SourceTypeOptions, answer: SourceTypeAnswer | undefined): ResolvedSourceTypeInfo | undefined {
  const result = settleSourceTypeAnswer(program, options, answer, null);
  return result.kind === "complete" ? result.value : undefined;
}

export function settleSourceTypeAnswer<Stop extends object>(program: Program, options: SourceTypeOptions, answer: SourceTypeAnswer | undefined,
  admit: NativeCheckerAdmission<Stop> | null): NativeCheckerResult<ResolvedSourceTypeInfo, Stop> {
  if (answer === undefined) return { kind: "unavailable" };
  if (answer.borrowedFrom === undefined) return { kind: "complete", value: answer };
  const start = admit?.("retained", 3) ?? null;
  if (start !== null) return { kind: "refused", stop: start };
  const context = options.context ?? Background();
  const lifetime = WithCheckerLifetime(context, CheckerLifetimeDiagnostics);
  const type = answer.type;
  const pending: Node[] = [];
  const visited = new Set<Node>();
  const causes = new Set<Diagnostic>();
  let nextSource = answer.typeSource;
  let typeSource: Node | undefined;
  let indexedRead: ResolvedSourceTypeInfo["indexedRead"];
  const addSource = (source: NonNullable<SourceTypeAnswer["borrowedFrom"]>): Stop | null => {
    const single = "Kind" in source;
    const stop = admit?.("retained", single ? 1 : 2) ?? null;
    if (stop === null) {
      if (single) pending.push(source);
      else pending.push(source[1], source[0]);
    }
    return stop;
  };
  const entered = addSource(answer.borrowedFrom);
  if (entered !== null) return { kind: "refused", stop: entered };
  while (pending.length > 0) {
    const next = admit?.("work", 1) ?? null;
    if (next !== null) return { kind: "refused", stop: next };
    const source = pending.pop();
    if (source === undefined) throw new Error("A pending source type requires its actual borrowed source.");
    if (visited.has(source)) continue;
    const retained = admit?.("retained", 1) ?? null;
    if (retained !== null) return { kind: "refused", stop: retained };
    visited.add(source);
    const consumed = withSourceFileChecker(program, options.sourceFile, GetSourceFileOfNode(source), context, checker =>
      underLease(checker, lifetime, admit, () => borrowedSourceTypeAnswer(checker, source, type, options.admitsCheckerDiagnostic)));
    if (consumed === undefined || consumed.kind === "unavailable") continue;
    if (consumed.kind === "refused") return consumed;
    const borrowed = consumed.value;
    if (source === nextSource) {
      typeSource = source;
      nextSource = borrowed.typeSource;
      indexedRead = borrowed.indexedRead;
    }
    for (let index = 0; index < borrowed.causes.length; index += 1) {
      const nextCause = admit?.("work", 1) ?? null;
      if (nextCause !== null) return { kind: "refused", stop: nextCause };
      const cause = borrowed.causes[index];
      if (cause === undefined) throw new Error("A borrowed source type requires its complete diagnostic vector.");
      if (causes.has(cause)) continue;
      const retainCause = admit?.("retained", 1) ?? null;
      if (retainCause !== null) return { kind: "refused", stop: retainCause };
      causes.add(cause);
    }
    if (borrowed.borrowedFrom !== undefined) {
      const stop = addSource(borrowed.borrowedFrom);
      if (stop !== null) return { kind: "refused", stop };
    }
  }
  const output = admit?.("retained", 2 + causes.size) ?? null;
  if (output !== null) return { kind: "refused", stop: output };
  const value = causes.size === 0 && typeSource !== undefined && nextSource === undefined
    ? { type, causes: [], typeSource, ...(indexedRead === undefined ? {} : { indexedRead }) }
    : { type, causes: [...causes] };
  return { kind: "complete", value };
}
