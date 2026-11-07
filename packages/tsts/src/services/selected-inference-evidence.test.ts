import assert from "node:assert/strict";
import { test } from "node:test";
import { KindCallExpression, KindNewExpression } from "../internal/ast/generated/kinds.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { assertCleanSemanticDiagnostics, createProgram, findNodesByKind } from "./type-checker-test-support.js";

test("selected aggregate inference publishes its winning original contribution vector", () => {
  const { program, index } = createProgram(`
    declare function first<Value>(input: Value[]): Value;
    first([1, 2]);
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findNodesByKind(index, KindCallExpression)[0];
  assert.equal(call !== undefined, true, "the original program contains one aggregate generic call");
  const evidence = queries.getResolvedCallInfo(call!);
  assert.equal(evidence?.outcome === "applicable", true, "the original call has a winning checked signature");
  assert.equal(evidence !== undefined && Object.hasOwn(evidence, "sourceInferenceContributions"), true,
    "the winning call publishes its original inference contribution vector rather than selected backing types");
  const inference = evidence!.sourceInferenceContributions;
  assert.equal(inference.kind === "available", true, "the winning aggregate traversal has complete original evidence");
  if (inference.kind !== "available") return;
  assert.equal(inference.contributions.length, 1, "the original array contributes once to its exact original binder");
  const contribution = inference.contributions[0]!;
  assert.equal(contribution.typeParameter === evidence!.sourceSelectedMethodTypeArguments?.[0]?.typeParameter, true,
    "the contribution retains the original selected declaration binder");
  assert.equal(contribution.origin.subject === evidence!.sourceArguments[0]?.expression &&
    contribution.origin.kind === "argument" && contribution.origin.effectiveArgumentIndex === 0 &&
    contribution.origin.parameterIndex === 0, true, "the contribution names the actual original argument and formal position");
  assert.equal(contribution.sourcePath.length === 1 && contribution.sourcePath[0]?.kind === "element" &&
    contribution.formalPath.length === 1 && contribution.formalPath[0]?.kind === "element", true,
  "the retained contribution records the actual source and formal element projections");
  assert.equal(Object.isFrozen(inference) && Object.isFrozen(inference.contributions) &&
    Object.isFrozen(contribution) && Object.isFrozen(contribution.sourcePath), true, "the published winning evidence is immutable");
});

for (const fixture of [
  { name: "array union", source: `declare function choose<Value>(input: (string | Value)[]): Value; choose(["known", 1]);`,
    actual: ["element", "union-member"], formal: ["element", "union-member"] },
  { name: "callback array union", source: `declare function choose<Value>(input: () => (string | Value)[]): Value; choose(() => ["known", 1]);`,
    actual: ["callable-result", "element", "union-member"], formal: ["callable-result", "element", "union-member"] },
  { name: "declared member", source: `declare function choose<Value>(input: { item: Value }): Value; choose({ item: 1 });`,
    actual: ["member"], formal: ["member"] },
  { name: "arraylike index", source: `declare function choose<Value>(input: ArrayLike<Value>): Value; choose([1, 2]);`,
    actual: ["element"], formal: ["index"] },
]) {
  test(`selected ${fixture.name} inference retains original recursive positions`, () => {
    const { program, index } = createProgram(fixture.source, { noLib: false });
    assertCleanSemanticDiagnostics(program, index);
    const queries = createTypeCheckerQueries(program, { sourceFile: index });
    const call = findNodesByKind(index, KindCallExpression)[0]!;
    const evidence = queries.getResolvedCallInfo(call);
    assert.equal(evidence?.outcome === "applicable", true, "the original checked generic call succeeds");
    const inference = evidence!.sourceInferenceContributions;
    assert.equal(inference.kind === "available", true, "the winning transaction retains all original contributions");
    if (inference.kind !== "available") return;
    assert.equal(inference.contributions.length > 0, true, "the recursive inference really contributed a candidate");
    for (const contribution of inference.contributions) {
      assert.equal(contribution.typeParameter === evidence!.sourceSelectedMethodTypeArguments?.[0]?.typeParameter, true,
        "the path belongs to the exact original selected method binder");
      assert.equal(contribution.origin.kind === "argument" && contribution.origin.subject === evidence!.sourceArguments[0]?.expression,
        true, "the path starts at the original actual expression, not selected backing Type syntax");
      assert.equal(contribution.sourcePath.map(part => part.kind).join("/") === fixture.actual.join("/"), true,
        "the exact actual aggregate roles are retained");
      assert.equal(contribution.formalPath.map(part => part.kind).join("/") === fixture.formal.join("/"), true,
        "the exact formal aggregate roles are retained");
    }
  });
}

for (const fixture of [
  { name: "constructor", source: `declare const construct: { new<Value>(input: Value[]): object }; new construct([1, 2]);`, kind: KindNewExpression,
    origin: "argument", actual: ["element"], formal: ["element"] },
  { name: "contextual return", source: `declare function choose<Value>(): Value[]; const output: number[] = choose();`, kind: KindCallExpression,
    origin: "contextual-result", actual: ["element"], formal: ["element"] },
  { name: "receiver", source: `declare function choose<Value>(this: { item: Value }): Value; const receiver = { item: 1, choose }; receiver.choose();`, kind: KindCallExpression,
    origin: "receiver", actual: ["member"], formal: ["member"] },
]) {
  test(`selected ${fixture.name} inference keeps its exact original origin`, () => {
    const { program, index } = createProgram(fixture.source, { noLib: false });
    assertCleanSemanticDiagnostics(program, index);
    const call = findNodesByKind(index, fixture.kind)[0]!;
    const evidence = createTypeCheckerQueries(program, { sourceFile: index }).getResolvedCallInfo(call);
    assert.equal(evidence?.outcome === "applicable", true, "the original checked call is applicable");
    const inference = evidence!.sourceInferenceContributions;
    assert.equal(inference.kind === "available", true, "the actual inference transaction has complete origin evidence");
    if (inference.kind !== "available") return;
    assert.equal(inference.contributions.length > 0, true, "the checker really inferred an original candidate");
    assert.equal(inference.contributions.every(contribution => contribution.origin.kind === fixture.origin), true,
      "receiver, actual argument and contextual return are never conflated");
    for (const contribution of inference.contributions) {
      assert.equal(contribution.sourcePath.map(part => part.kind).join("/") === fixture.actual.join("/"), true,
        "actual recursive positions belong to this origin");
      assert.equal(contribution.formalPath.map(part => part.kind).join("/") === fixture.formal.join("/"), true,
        "formal recursive positions belong to the selected original signature");
    }
  });
}

test("explicit and default selections never fabricate inference contributions", () => {
  const { program, index } = createProgram(`
    declare function explicit<Value>(input: Value[]): Value;
    declare function fallback<Value = string>(): Value;
    explicit<number>([1]); fallback();
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  for (const call of findNodesByKind(index, KindCallExpression)) {
    const evidence = queries.getResolvedCallInfo(call);
    assert.equal(evidence?.sourceInferenceContributions.kind === "available" &&
      evidence.sourceInferenceContributions.contributions.length === 0, true,
      "authored/default authority stays distinct from an actual inferred contribution");
  }
});

test("losing overloads and nested same-spelled binders cannot supply winning contributions", () => {
  const { program, index } = createProgram(`
    declare function choose<Value>(input: { item: Value }, tag: "loser"): Value;
    declare function choose<Value>(input: Value[], tag: "winner"): Value;
    declare function inner<Value>(input: Value[]): Value;
    choose([inner([1])], "winner");
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const evidence = findNodesByKind(index, KindCallExpression).map(call => queries.getResolvedCallInfo(call)!);
  const binders = evidence.map(call => call.sourceSelectedMethodTypeArguments?.[0]?.typeParameter);
  assert.equal(evidence.length === 2 && binders[0] !== undefined && binders[1] !== undefined && binders[0] !== binders[1], true,
    "nested calls retain distinct exact binders despite identical spellings and backing widths");
  for (const [index, call] of evidence.entries()) {
    const inference = call.sourceInferenceContributions;
    assert.equal(inference.kind === "available", true, "the winning original transaction is complete");
    if (inference.kind !== "available") continue;
    assert.equal(inference.contributions.length > 0 && inference.contributions.every(contribution =>
      contribution.typeParameter === binders[index] && contribution.sourcePath[0]?.kind === "element" &&
      contribution.formalPath[0]?.kind === "element"), true,
    "the losing member-path overload and nested other binder publish no winning contribution");
    assert.equal(queries.getResolvedCallInfo(call.call) === call, true, "the retained immutable call cache is reused");
  }
});

for (const fixture of [
  { name: "winning union array formal", source: `declare function choose<Value>(input: ArrayLike<Value> | Value[]): Value; choose([1, 2]);`, rest: false },
  { name: "sparse optional contribution", source: `declare function choose<Value>(input: ArrayLike<Value>): Value; choose([, 1]);`, rest: false },
  { name: "rest arguments", source: `declare function choose<Value>(...input: Value[]): Value; choose(1, 2);`, rest: true },
  { name: "tuple spread", source: `declare function choose<Value>(...input: Value[]): Value; const pair: [number, number] = [1, 2]; choose(...pair);`, rest: true },
]) {
  test(`${fixture.name} retains original source argument bindings`, () => {
    const { program, index } = createProgram(fixture.source, { noLib: false });
    assertCleanSemanticDiagnostics(program, index);
    const call = findNodesByKind(index, KindCallExpression)[0]!;
    const evidence = createTypeCheckerQueries(program, { sourceFile: index }).getResolvedCallInfo(call)!;
    const inference = evidence.sourceInferenceContributions;
    assert.equal(inference.kind === "available", true, "the original supported inference has complete winning paths");
    if (inference.kind !== "available") return;
    assert.equal(inference.contributions.length > 0, true, "an actual candidate was retained");
    for (const contribution of inference.contributions) {
      assert.equal(contribution.origin.kind === "argument", true, "this contribution comes from an actual source argument");
      if (contribution.origin.kind !== "argument") continue;
      const origin = contribution.origin;
      const binding = evidence.sourceArgumentBindings.find(binding => binding.effectiveArgumentIndex === origin.effectiveArgumentIndex);
      assert.equal(binding !== undefined && contribution.origin.subject === evidence.sourceArguments[binding.sourceArgumentIndex]?.expression &&
        contribution.origin.parameterIndex === binding.sourceParameterIndex, true,
      "the winning contribution joins its original source/effective/formal binding without positional guessing");
      if (fixture.rest) assert.equal(binding?.sourceParameterForm === "rest-element", true, "the actual rest formal remains explicit");
      if (fixture.name === "tuple spread") assert.equal(contribution.sourcePath[0]?.kind === "tuple" &&
        contribution.sourcePath[0].index === binding?.spreadElementIndex, true, "the exact original tuple spread position is retained");
    }
  });
}
