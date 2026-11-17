import assert from "node:assert/strict";
import { test } from "node:test";
import { Node_Arguments, Node_Expression, Node_TypeParameters } from "../internal/ast/ast.js";
import { KindCallExpression, KindNewExpression } from "../internal/ast/generated/kinds.js";
import { Checker_cloneInferenceContext, Checker_getInferredType, Checker_inferTypes, Checker_newInferenceContext } from "../internal/checker/inference.js";
import { InferenceFlagsNone, InferencePriorityNone } from "../internal/checker/checker/state.js";
import {
  beginSelectedCallEvidenceFrame,
  bindSelectedCallDefaultContext,
  bindSelectedCallDefaultOwner,
  commitSelectedCallEvidenceFrame,
  rollbackSelectedCallEvidenceFrame,
  selectedCallInferenceJournal,
} from "../internal/checker/checker/selected-call-evidence-transaction.js";
import {
  createSelectedCallInferenceJournal,
  retainSelectedCallInferenceCandidate,
  selectedCallInferenceEvidence,
  withSelectedCallInferenceOrigin,
} from "../internal/checker/checker/selected-call-inference-evidence.js";
import type { ResolvedCallInferenceContribution, ResolvedCallInferenceEvidence } from "../internal/checker/types.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { assertCleanSemanticDiagnostics, createProgram, findNodesByKind, requireApplicableCallInfo } from "./type-checker-test-support.js";

function selectedCalls(text: string, warm = false, libraries = false) {
  const { program, index } = createProgram(text, { noLib: !libraries, target: "esnext" });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  if (warm) assertCleanSemanticDiagnostics(program, index);
  const calls = findNodesByKind(index, KindCallExpression);
  const constructions = findNodesByKind(index, KindNewExpression);
  const selected = [...calls, ...constructions].map(node => requireApplicableCallInfo(queries.getResolvedCallInfo(node)));
  assertCleanSemanticDiagnostics(program, index);
  return { program, index, queries, selected };
}

function contributions(evidence: ResolvedCallInferenceEvidence): readonly ResolvedCallInferenceContribution[] {
  assert.equal(evidence.kind, "available", "the entire original contribution vector is available");
  if (evidence.kind !== "available") throw new Error("The actual selected inference has no complete original receipt.");
  return evidence.contributions;
}

for (const warm of [false, true]) {
  test(`selected inference retains the exact original binder and argument on ${warm ? "warm" : "cold"} caches`, () => {
    const { queries, selected } = selectedCalls("declare function id<Value>(value: Value): Value; id(5n);", warm);
    const call = selected[0]!;
    const application = call.selection.application;
    const vector = contributions(call.selection.inferenceContributions);
    assert.equal(vector.length > 0, true, "actual inference publishes its original producer");
    assert.equal(Object.hasOwn(call, "selectedSignature") || Object.hasOwn(call, "outcome") ||
      Object.hasOwn(call, "sourceSelectedMethodTypeArguments"), false,
    "the superseded flat selected-answer API is not a parallel facade");
    const parameter = application.signature.typeParameters[0];
    const argument = Node_Arguments(call.call)?.[0];
    const declaration = Node_TypeParameters(application.signatureShape.declaration)?.[0];
    for (const entry of vector) {
      assert.equal(entry.typeParameter === parameter && entry.origin.kind === "argument" &&
        entry.origin.subject === argument && entry.origin.parameterIndex === 0, true,
      "neither a same-name binder nor a different argument occurrence can replace the original");
      assert.equal(queries.getPrimarySymbolDeclaration(queries.getTypeSymbol(entry.typeParameter)) === declaration, true,
        "the contribution reaches the actual original type-parameter declaration");
    }
    assert.equal(queries.getResolvedCallInfo(call.call) === call, true, "repeated queries reuse the exact selected receipt");
    assert.equal(parameter?.checker?.selectedCallEvidenceTransactionState === undefined, true,
      "the publication retains no live transaction");
  });
}

test("losing overload contributions never become the winning binder vector", () => {
  const { selected } = selectedCalls(`
    declare function pick<Left>(tag: "left", value: Left): Left;
    declare function pick<Right>(tag: "right", value: Right): Right;
    pick("right", 5n);
  `);
  const call = selected[0]!;
  const parameter = call.selection.application.signature.typeParameters[0];
  const vector = contributions(call.selection.inferenceContributions);
  assert.equal(vector.length > 0 && vector.every(entry => entry.typeParameter === parameter), true,
    "the rejected overload's original parameter is absent from the selected receipt");
});

test("nested same-name generic binders retain their distinct original contexts", () => {
  const { selected } = selectedCalls(`
    declare function outer<Value>(value: Value): Value;
    declare function inner<Value>(value: Value): Value;
    outer(inner(5n));
  `, true);
  assert.equal(selected.length, 2);
  const parameters = selected.map(call => call.selection.application.signature.typeParameters[0]);
  assert.equal(parameters[0] !== parameters[1], true, "same spelling does not merge binder identities");
  for (const [index, call] of selected.entries()) {
    assert.equal(contributions(call.selection.inferenceContributions).every(entry => entry.typeParameter === parameters[index]), true,
      "a nested transaction cannot supply another original context's journal");
  }
});

test("equal source programs never share original contribution identities", () => {
  const text = "declare function id<Value>(value: Value): Value; id(5n);";
  const first = selectedCalls(text).selected[0]!;
  const second = selectedCalls(text).selected[0]!;
  const left = contributions(first.selection.inferenceContributions)[0]!;
  const right = contributions(second.selection.inferenceContributions)[0]!;
  assert.equal(left.typeParameter !== right.typeParameter && left.origin.subject !== right.origin.subject, true,
    "equal paths, names and text never authenticate a foreign program's component");
});

test("constructor class arguments are not signature arguments", () => {
  const { selected } = selectedCalls(`
    class Pair<Left, Right> { constructor(public left: Left, public right: Right) {} }
    new Pair<bigint, string>(5n, "value");
  `);
  const application = selected[0]!.selection.application;
  assert.equal(application.kind, "construct");
  assert.equal(application.class?.typeArguments.length, 2);
  assert.equal(application.signatureTypeArguments.length, 0);
  assert.equal(application.class?.typeArguments.every(argument => argument.declaration !== undefined && argument.explicitTypeNode !== undefined), true,
    "each class binder retains its own real declaration and authored argument");
});

test("implicit and inherited constructors retain real signatures without a fake declaration", () => {
  for (const text of [
    "class Empty<Value> {} new Empty<bigint>();",
    "class Base<Value> { constructor(value: Value) {} } class Derived<Value> extends Base<Value> {} new Derived<bigint>(5n);",
  ]) {
    const { queries, selected } = selectedCalls(text);
    const call = selected[0]!;
    const application = call.selection.application;
    assert.equal(application.class?.typeArguments.length, 1);
    assert.equal(application.signatureTypeArguments.length, 0);
    assert.equal(application.signatureShape.declaration === queries.getSignatureDeclaration(application.signature), true,
      "the actual absent or inherited declaration remains unchanged");
    assert.equal(application.instantiatedSignature === queries.getResolvedSignature(call.call), true,
      "the original candidate and actual instantiated checker selection are separately retained");
  }
});

test("a generic construct signature without a class keeps its signature binders", () => {
  const { selected } = selectedCalls(`
    interface Builder { new<Value>(value: Value): { value: Value }; }
    declare const builder: Builder;
    new builder(5n);
  `);
  const application = selected[0]!.selection.application;
  assert.equal(application.class === undefined, true, "a construct signature is not a fabricated class constructor");
  assert.equal(application.signatureTypeArguments.length, 1);
  assert.equal(application.signatureShape.declaration === application.signature.declaration, true);
});

test("receiver class bindings and method signature bindings remain separate", () => {
  const { selected } = selectedCalls(`
    class Box<ClassValue> { pick<MethodValue>(this: Box<ClassValue>, value: MethodValue): MethodValue { return value; } }
    declare const box: Box<bigint>;
    box.pick<string>("value");
  `);
  const call = selected[0]!;
  const application = call.selection.application;
  assert.equal(application.class?.typeArguments.length, 1);
  assert.equal(application.signatureTypeArguments.length, 1);
  assert.equal(application.class?.typeArguments[0]?.typeParameter !== application.signatureTypeArguments[0]?.typeParameter, true);
  assert.equal(application.receiver?.expression === Node_Expression(Node_Expression(call.call)), true,
    "this is the original receiver occurrence, never parameter zero");
});

test("callable parameter and result paths retain the original signature before erasure", () => {
  for (const [text, kind] of [
    ["declare function consume<Value>(work: (value: Value) => void): void; declare const work: (value: bigint) => void; consume(work);", "callable-parameter"],
    ["declare function produce<Value>(work: () => Value): Value; declare const work: () => bigint; produce(work);", "callable-result"],
  ] as const) {
    const { queries, selected } = selectedCalls(text);
    const vector = contributions(selected[0]!.selection.inferenceContributions);
    const parts = vector.flatMap(entry => entry.sourcePath).filter(part => part.kind === kind);
    assert.equal(parts.length > 0, true, `the actual ${kind} projection is observed`);
    for (const part of parts) {
      if (part.kind !== "callable-parameter" && part.kind !== "callable-result") throw new Error("Unexpected callable projection.");
      assert.equal(queries.getCallSignaturesOfType(part.owner).includes(part.signature), true,
        "the path contains the original owner's signature, not its erased substitute");
    }
  }
});

test("tuple-rest arguments retain original source/effective/formal indices", () => {
  const { selected } = selectedCalls(`
    declare function first<Value>(...values: [Value, Value]): Value;
    declare const values: [bigint, bigint]; first(...values);
  `, false, true);
  const call = selected[0]!;
  assert.deepEqual(call.selection.arguments.values.map(binding => [binding.sourceArgumentIndex,
    binding.effectiveArgumentIndex, binding.parameterIndex, binding.spreadElementIndex]), [[0, 0, 0, 0], [0, 1, 0, 1]]);
  const vector = contributions(call.selection.inferenceContributions);
  assert.equal(vector.length > 0 && vector.every(entry => {
    const origin = entry.origin;
    return origin.kind === "argument" && call.selection.arguments.values.some(binding => binding.sourceArgument === origin.subject &&
      binding.effectiveArgumentIndex === origin.effectiveArgumentIndex && binding.parameterIndex === origin.parameterIndex);
  }), true,
  "each inferred producer starts at the resolver's exact effective place");
});

test("nested tuple values retain projections after the effective argument place", () => {
  const { selected } = selectedCalls(`
    declare function first<Value>(values: readonly [Value, Value]): Value;
    declare const values: readonly [bigint, bigint]; first(values);
  `, false, true);
  const call = selected[0]!;
  const vector = contributions(call.selection.inferenceContributions);
  assert.equal(vector.some(entry => entry.sourcePath.some(part => part.kind === "tuple")) &&
    vector.some(entry => entry.formalPath.some(part => part.kind === "tuple")), true,
  "a nested tuple projection is distinct from the effective spread map");
  assert.equal(vector.every(entry => entry.origin.kind === "argument" &&
    entry.origin.effectiveArgumentIndex === 0 && entry.origin.parameterIndex === 0), true);
});

test("empty tuple spreads remain authored evaluations with zero effective bindings", () => {
  const { selected } = selectedCalls("declare const empty: []; declare function use(value: bigint): void; use(...empty, 5n);", false, true);
  const call = selected[0]!;
  assert.equal(call.selection.sourceArguments.length, 2);
  assert.equal(call.selection.argumentValues.length, 2);
  assert.equal(call.selection.arguments.values.length, 1);
  assert.equal(call.selection.arguments.values[0]?.sourceArgument === call.selection.sourceArguments[1], true,
    "the following value never binds to the empty spread occurrence");
});

test("variadic tuple receipts retain actual both-end trimming and slice mutability", () => {
  const { selected } = selectedCalls(`
    declare function middle<Values extends unknown[]>(value: readonly [bigint, ...Values, string]): Values;
    declare const value: readonly [bigint, boolean, string]; middle(value);
  `, false, true);
  const vector = contributions(selected[0]!.selection.inferenceContributions);
  assert.equal(vector.some(entry => entry.sourcePath.some(part => part.kind === "tuple-slice" &&
    part.start === 1 && part.endCount === 1 && part.readonly === false)), true,
  "the checker creates a mutable middle slice, not a fabricated readonly tail");
});

test("signature tails retain an explicit original aggregate projection", () => {
  const { selected } = selectedCalls(`
    declare function argumentsOf<Values extends unknown[]>(work: (...args: Values) => void): Values;
    argumentsOf((first: bigint, second: string) => {});
  `, false, true);
  const vector = contributions(selected[0]!.selection.inferenceContributions);
  assert.equal(vector.some(entry => entry.sourcePath.some(part => part.kind === "signature-tail" && part.start === 0)), true,
    "fixed original parameters remain an authenticated signature-tail rather than one selected parameter");
});

test("receiver inference retains its original occurrence independently from arguments", () => {
  const { selected } = selectedCalls("declare function fromThis<Value>(this: Value): Value; const object = { fromThis }; object.fromThis();");
  const call = selected[0]!;
  const vector = contributions(call.selection.inferenceContributions);
  assert.equal(vector.some(entry => entry.origin.kind === "receiver" &&
    entry.origin.subject === call.selection.application.receiver?.expression), true,
  "the original this component is not manufactured as argument zero");
});

test("native context clones preserve receipts and all journal lifetime charges drain", () => {
  const { selected } = selectedCalls("declare function id<Value>(value: Value): Value; id(5n);");
  const call = selected[0]!;
  const candidate = call.selection.application.signature;
  const parameter = candidate.typeParameters[0];
  const checker = parameter?.checker;
  const source = call.selection.argumentValues[0];
  if (parameter === undefined || checker === undefined || source === undefined) throw new Error("Original inference inputs are required.");
  const root = beginSelectedCallEvidenceFrame(checker, "signature-resolution");
  const frame = beginSelectedCallEvidenceFrame(checker, "overload-candidate");
  bindSelectedCallDefaultOwner(checker, frame, candidate);
  const context = Checker_newInferenceContext(checker, candidate.typeParameters, candidate, InferenceFlagsNone, undefined);
  if (context === undefined) throw new Error("The native context is required.");
  const snapshotCount = checker.selectedCallEvidenceTransactionState?.entryCount;
  bindSelectedCallDefaultContext(checker, frame, context);
  assert.equal(checker.selectedCallEvidenceTransactionState?.entryCount === snapshotCount, true,
    "the observation context never spends the independent SignatureLinks snapshot quota");
  const journal = selectedCallInferenceJournal(checker, context.inferences);
  try {
    withSelectedCallInferenceOrigin(journal, context, { kind: "argument", subject: source.expression,
      effectiveArgumentIndex: 0, parameterIndex: 0 }, source.type, parameter,
    () => Checker_inferTypes(checker, context.inferences, source.type, parameter, InferencePriorityNone, false));
    const clone = Checker_cloneInferenceContext(checker, context, InferenceFlagsNone);
    assert.equal(clone !== undefined && clone !== context, true);
    assert.equal(contributions(selectedCallInferenceEvidence(journal, context)).length > 0, true);
    assert.equal(contributions(selectedCallInferenceEvidence(journal, clone)).every(entry => entry.origin.subject === source.expression), true);
  } finally {
    rollbackSelectedCallEvidenceFrame(checker, frame);
    commitSelectedCallEvidenceFrame(checker, root);
  }
  assert.equal(checker.selectedCallEvidenceTransactionState === undefined, true);
});

test("journal quota exhaustion is observational and preserves the original thrown exception", () => {
  const { selected } = selectedCalls("declare function id<Value>(value: Value): Value; id(5n);");
  const call = selected[0]!;
  const candidate = call.selection.application.signature;
  const parameter = candidate.typeParameters[0];
  const checker = parameter?.checker;
  const source = call.selection.argumentValues[0];
  if (parameter === undefined || checker === undefined || source === undefined) throw new Error("Original inference inputs are required.");
  const context = Checker_newInferenceContext(checker, candidate.typeParameters, candidate, InferenceFlagsNone, undefined);
  const control = Checker_newInferenceContext(checker, candidate.typeParameters, candidate, InferenceFlagsNone, undefined);
  if (context === undefined || control === undefined) throw new Error("Both original native contexts are required.");
  let live = 0;
  const journal = createSelectedCallInferenceJournal([context], () => live === 0 ? (++live, true) : false, () => { live--; });
  withSelectedCallInferenceOrigin(journal, context, { kind: "argument", subject: source.expression,
    effectiveArgumentIndex: 0, parameterIndex: 0 }, source.type, parameter, () => {
    Checker_inferTypes(checker, context.inferences, source.type, parameter, InferencePriorityNone, false);
    const inference = context.inferences[0];
    if (inference === undefined) throw new Error("The native inference record is required.");
    retainSelectedCallInferenceCandidate(journal, context.inferences, inference, source.type, parameter,
      source.type, inference.priority, false);
  });
  Checker_inferTypes(checker, control.inferences, source.type, parameter, InferencePriorityNone, false);
  assert.equal(Checker_getInferredType(checker, context, 0) === Checker_getInferredType(checker, control, 0), true,
    "exhausting the separate observation quota does not change native inference");
  assert.equal(selectedCallInferenceEvidence(journal, context).kind, "unavailable");
  assert.equal(live, 0, "the live trace reservation is released even after observation exhaustion");
  const original = new Error("original checker operation");
  assert.throws(() => withSelectedCallInferenceOrigin(journal, context, { kind: "receiver", subject: source.expression },
    source.type, parameter, () => { throw original; }), error => error === original);
  assert.equal(live, 0);
});
