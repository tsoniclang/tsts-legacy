import assert from "node:assert/strict";
import { test } from "node:test";
import type { bool } from "../go/scalars.js";
import { Node_TypeParameters } from "../internal/ast/ast.js";
import { AsTypeParameterDeclaration } from "../internal/ast/generated/casts.js";
import { KindCallExpression } from "../internal/ast/generated/kinds.js";
import { InferenceFlagsNone, InferencePriorityNone } from "../internal/checker/checker/state.js";
import { Checker_cloneInferenceContext, Checker_getInferredType, Checker_inferTypes, Checker_newInferenceContext,
  clearCachedInferences } from "../internal/checker/inference.js";
import { beginSelectedCallEvidenceFrame, bindSelectedCallDefaultContext, bindSelectedCallDefaultOwner,
  commitSelectedCallEvidenceFrame, rollbackSelectedCallEvidenceFrame,
  selectedCallDefaultNode } from "../internal/checker/checker/selected-call-evidence-transaction.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { assertCleanSemanticDiagnostics, createProgram, findNodesByKind } from "./type-checker-test-support.js";

function selectedCalls(sourceText: string, warm: boolean) {
  const { program, index } = createProgram(sourceText);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const calls = findNodesByKind(index, KindCallExpression);
  if (warm) {
    assertCleanSemanticDiagnostics(program, index);
    for (const call of calls) queries.getTypeAtLocation(call);
  }
  const selected = calls.map(call => {
    const evidence = queries.getResolvedCallInfo(call);
    if (evidence?.outcome !== "applicable") throw new Error("The original valid call requires applicable evidence.");
    const declaration = queries.getSignatureDeclaration(evidence.selectedSignature);
    if (declaration === undefined) throw new Error("A selected default requires the original signature declaration.");
    return { call, evidence, declaration };
  });
  assertCleanSemanticDiagnostics(program, index);
  return { queries, selected };
}

function selectedDefault(argument: object): unknown {
  return "defaultTypeNode" in argument ? argument.defaultTypeNode : undefined;
}

for (const warm of [false, true]) {
  test(`selected generic defaults retain original syntax and binder on ${warm ? "warm" : "cold"} call caches`, () => {
    const { queries, selected } = selectedCalls(`
      type Word = bigint;
      declare function read<Value = Word>(): Value;
      read();
    `, warm);
    const actual = selected[0]!;
    const argument = actual.evidence.sourceSelectedMethodTypeArguments?.[0];
    const binder = Node_TypeParameters(actual.declaration)?.[0];
    const syntax = AsTypeParameterDeclaration(binder)?.DefaultType;
    assert.equal(argument !== undefined && binder !== undefined && syntax !== undefined, true,
      "the original selected signature supplies one exact default syntax and binder");
    assert.equal(selectedDefault(argument!) === syntax, true, "default authority is the original authored node");
    assert.equal(queries.getPrimarySymbolDeclaration(queries.getTypeSymbol(argument!.typeParameter)) === binder, true,
      "the selected argument retains its original declaration binder");
    const repeated = queries.getResolvedCallInfo(actual.call);
    assert.equal(repeated?.selectedSignature === actual.evidence.selectedSignature, true,
      "the ordinary cached signature is not replaced");
    assert.equal(repeated?.sourceSelectedMethodTypeArguments === actual.evidence.sourceSelectedMethodTypeArguments, true,
      "the canonical cached contribution vector is reused");
  });
}

test("an inferred equal backing type does not acquire authored default authority", () => {
  const { queries, selected } = selectedCalls(`
    type Word = bigint;
    declare function read<Value = Word>(value: Value): Value;
    declare const input: bigint;
    read(input);
  `, false);
  const actual = selected[0]!;
  const argument = actual.evidence.sourceSelectedMethodTypeArguments?.[0];
  const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[0])?.DefaultType;
  assert.equal(argument !== undefined && syntax !== undefined, true, "the inferred call has a genuine authored default");
  assert.equal(argument!.selectedType === queries.getTypeFromTypeNode(syntax), true,
    "the inferred value and default really have the identical native backing Type");
  assert.equal(selectedDefault(argument!) === undefined, true, "equal backing identity does not select the default");
});

test("explicit equal arguments retain their own syntax without default authority", () => {
  const { selected } = selectedCalls(`
    type Word = bigint;
    declare function read<Value = Word>(): Value;
    read<bigint>();
  `, true);
  const argument = selected[0]!.evidence.sourceSelectedMethodTypeArguments?.[0];
  assert.equal(argument?.explicitTypeNode !== undefined, true, "the explicit Source argument has its own syntax");
  assert.equal(argument !== undefined && selectedDefault(argument) === undefined, true,
    "explicit evidence cannot also claim an authored default");
});

test("losing overload defaults never replace the winning original default", () => {
  const { queries, selected } = selectedCalls(`
    type Left = bigint;
    type Right = bigint;
    declare function read<Value = Left>(tag: "left"): Value;
    declare function read<Value = Right>(tag: "right"): Value;
    read("right");
  `, false);
  const actual = selected[0]!;
  const argument = actual.evidence.sourceSelectedMethodTypeArguments?.[0];
  const binder = Node_TypeParameters(actual.declaration)?.[0];
  const syntax = AsTypeParameterDeclaration(binder)?.DefaultType;
  assert.equal(argument !== undefined && syntax !== undefined, true, "the winning overload has its original default");
  assert.equal(selectedDefault(argument!) === syntax, true, "only the winning overload's default contribution is published");
  assert.equal(queries.getPrimarySymbolDeclaration(queries.getTypeSymbol(argument!.typeParameter)) === binder, true,
    "same-spelled losing binders are not substituted");
});

test("context-sensitive overload retries retain only the winning default contribution", () => {
  const { selected } = selectedCalls(`
    type Left = bigint;
    type Right = bigint;
    declare function read<Value = Left>(tag: "left", accept: (value: Value) => void): Value;
    declare function read<Value = Right>(tag: "right", accept: (value: Value) => void): Value;
    read("right", value => { void value; });
  `, false);
  const actual = selected[0]!;
  const argument = actual.evidence.sourceSelectedMethodTypeArguments?.[0];
  const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[0])?.DefaultType;
  assert.equal(argument !== undefined && syntax !== undefined, true, "the original contextual overload remains selected");
  assert.equal(selectedDefault(argument!) === syntax, true, "discarded contextual trials do not poison the winning default");
});

test("trailing defaults retain exact authority after an earlier explicit argument", () => {
  const { selected } = selectedCalls(`
    type Word = bigint;
    declare function read<Input, Value = Word>(value: Input): Value;
    read<string>("value");
  `, true);
  const actual = selected[0]!;
  const arguments_ = actual.evidence.sourceSelectedMethodTypeArguments;
  const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[1])?.DefaultType;
  assert.equal(arguments_?.length === 2 && syntax !== undefined, true, "the actual selected call contains both original binders");
  assert.equal(arguments_![0]!.explicitTypeNode !== undefined && selectedDefault(arguments_![0]!) === undefined, true,
    "the first argument remains explicitly authored");
  assert.equal(selectedDefault(arguments_![1]!) === syntax, true, "the omitted trailing argument keeps its actual default syntax");
});

test("nested calls keep their distinct default owners despite identical native backing", () => {
  const { selected } = selectedCalls(`
    type InnerWord = bigint;
    type OuterWord = bigint;
    declare function inner<Value = InnerWord>(): Value;
    declare function outer<Value = OuterWord>(work: () => void): Value;
    outer(() => { inner(); });
  `, true);
  assert.equal(selected.length, 2, "the original program has the two distinct calls");
  const nodes = selected.map(actual => {
    const argument = actual.evidence.sourceSelectedMethodTypeArguments?.[0];
    const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[0])?.DefaultType;
    assert.equal(argument !== undefined && syntax !== undefined, true, "each original signature owns a default");
    assert.equal(selectedDefault(argument!) === syntax, true, "a nested frame cannot publish another call's default");
    return syntax;
  });
  assert.equal(nodes[0] !== nodes[1], true, "equal native Types do not collapse the two original default nodes");
});

test("dependent defaults preserve each original syntax in binder order", () => {
  const { selected } = selectedCalls(`
    type Word = bigint;
    declare function read<First = Word, Second = First>(): Second;
    read();
  `, false);
  const actual = selected[0]!;
  const arguments_ = actual.evidence.sourceSelectedMethodTypeArguments;
  const binders = Node_TypeParameters(actual.declaration) ?? [];
  assert.equal(arguments_?.length === 2 && binders.length === 2, true, "both dependent binder identities are selected");
  for (const [index, argument] of arguments_!.entries()) {
    const syntax = AsTypeParameterDeclaration(binders[index])?.DefaultType;
    assert.equal(syntax !== undefined && selectedDefault(argument) === syntax, true,
      `dependent binder ${index} retains its own original selected default`);
  }
});

test("nested calls to one generic signature retain their own inference-context owners", () => {
  const { selected } = selectedCalls(`
    type Word = bigint;
    declare function read<Value = Word>(work: () => void): Value;
    read(() => { read(() => {}); });
  `, false);
  assert.equal(selected.length, 2, "both actual calls use the same declaration");
  assert.equal(selected[0]!.declaration === selected[1]!.declaration, true,
    "signature identity alone cannot distinguish the nested default owner");
  for (const actual of selected) {
    const argument = actual.evidence.sourceSelectedMethodTypeArguments?.[0];
    const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[0])?.DefaultType;
    assert.equal(argument !== undefined && syntax !== undefined && selectedDefault(argument) === syntax, true,
      "each actual inference context retains the original selected default");
  }
});

test("a constraint fallback without a default publishes no default authority", () => {
  const { selected } = selectedCalls(`
    declare function read<Value extends string>(): Value;
    read();
  `, true);
  const argument = selected[0]!.evidence.sourceSelectedMethodTypeArguments?.[0];
  assert.equal(argument !== undefined && selectedDefault(argument) === undefined, true,
    "a native constraint result is not an authored default selection");
});

test("native inference cache reuse and invalidation preserve and clear exact default proof", () => {
  const { selected } = selectedCalls(`
    type Word = bigint;
    declare function read<Value = Word>(): Value;
    read();
  `, true);
  const actual = selected[0]!;
  const candidate = actual.evidence.selectedSignature.target;
  const parameter = candidate?.typeParameters[0];
  const checker = parameter?.checker;
  const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[0])?.DefaultType;
  if (candidate === undefined || parameter === undefined || checker === undefined || syntax === undefined) {
    throw new Error("The original selected native signature must retain its checker, binder and default.");
  }
  const root = beginSelectedCallEvidenceFrame(checker, "signature-resolution");
  const frame = beginSelectedCallEvidenceFrame(checker, "overload-candidate");
  bindSelectedCallDefaultOwner(checker, frame, candidate);
  const context = Checker_newInferenceContext(checker, candidate.typeParameters, candidate, InferenceFlagsNone, undefined);
  if (context === undefined) throw new Error("The native factory requires an inference context.");
  bindSelectedCallDefaultContext(checker, frame, context);
  try {
    const defaulted = Checker_getInferredType(checker, context, 0);
    if (defaulted === undefined) throw new Error("The actual native default computation must select its type.");
    assert.equal(selectedCallDefaultNode(checker, context, parameter, defaulted) === syntax, true,
      "the actual default-selection branch supplies the original syntax");
    assert.equal(Checker_getInferredType(checker, context, 0) === defaulted &&
      selectedCallDefaultNode(checker, context, parameter, defaulted) === syntax, true,
    "a warm native inference cache reuses its exact original proof");
    const cloned = Checker_cloneInferenceContext(checker, context, InferenceFlagsNone);
    assert.equal(cloned !== undefined && cloned !== context && cloned.inferences[0]?.inferredType === defaulted &&
      selectedCallDefaultNode(checker, cloned, parameter, defaulted) === syntax, true,
    "the native context clone retains its actual copied cache and original proof");
    clearCachedInferences(context.inferences);
    assert.equal(selectedCallDefaultNode(checker, context, parameter, defaulted) === undefined, true,
      "an invalidated native inference cache cannot publish stale default evidence");
    Checker_inferTypes(checker, context.inferences, defaulted, parameter, InferencePriorityNone, false as bool);
    const inferred = Checker_getInferredType(checker, context, 0);
    assert.equal(inferred === defaulted, true, "native inference now selects the identical backing Type without a default");
    assert.equal(selectedCallDefaultNode(checker, context, parameter, defaulted) === undefined, true,
      "native recomputation clears default authority even when the backing Type is unchanged");
    assert.equal(cloned !== undefined && selectedCallDefaultNode(checker, cloned, parameter, defaulted) === syntax, true,
      "clearing one actual inference context does not alter a distinct copied native cache");
  } finally {
    rollbackSelectedCallEvidenceFrame(checker, frame);
    commitSelectedCallEvidenceFrame(checker, root);
  }
  assert.equal(checker.selectedCallEvidenceTransactionState === undefined, true,
    "the sole journal and its shared entry budget drain after native cache proof");
});

test("same-signature nested candidate rollback cannot consume another inference context's proof", () => {
  const { selected } = selectedCalls(`
    type Word = bigint;
    declare function read<Value = Word>(): Value;
    read();
  `, false);
  const actual = selected[0]!;
  const candidate = actual.evidence.selectedSignature.target;
  const parameter = candidate?.typeParameters[0];
  const checker = parameter?.checker;
  const syntax = AsTypeParameterDeclaration(Node_TypeParameters(actual.declaration)?.[0])?.DefaultType;
  if (candidate === undefined || parameter === undefined || checker === undefined || syntax === undefined) {
    throw new Error("The actual generic signature must retain its native owner.");
  }
  const root = beginSelectedCallEvidenceFrame(checker, "signature-resolution");
  const outer = beginSelectedCallEvidenceFrame(checker, "overload-candidate");
  bindSelectedCallDefaultOwner(checker, outer, candidate);
  const outerContext = Checker_newInferenceContext(checker, candidate.typeParameters, candidate, InferenceFlagsNone, undefined);
  if (outerContext === undefined) throw new Error("The actual outer native context is required.");
  bindSelectedCallDefaultContext(checker, outer, outerContext);
  const nested = beginSelectedCallEvidenceFrame(checker, "overload-candidate");
  bindSelectedCallDefaultOwner(checker, nested, candidate);
  const nestedContext = Checker_newInferenceContext(checker, candidate.typeParameters, candidate, InferenceFlagsNone, undefined);
  if (nestedContext === undefined) throw new Error("The actual nested native context is required.");
  bindSelectedCallDefaultContext(checker, nested, nestedContext);
  const outerType = Checker_getInferredType(checker, outerContext, 0);
  const nestedType = Checker_getInferredType(checker, nestedContext, 0);
  if (outerType === undefined || nestedType === undefined) throw new Error("Both native contexts must select actual defaults.");
  assert.equal(outerType === nestedType && outerContext !== nestedContext, true,
    "the native backing Type and signature are equal while actual inference owners are distinct");
  rollbackSelectedCallEvidenceFrame(checker, nested);
  assert.equal(selectedCallDefaultNode(checker, nestedContext, parameter, nestedType) === undefined, true,
    "losing-candidate rollback removes its contribution and owner");
  assert.equal(selectedCallDefaultNode(checker, outerContext, parameter, outerType) === syntax, true,
    "the outer native cache retains its exact proof despite being computed inside the nested frame");
  commitSelectedCallEvidenceFrame(checker, outer);
  commitSelectedCallEvidenceFrame(checker, root);
  assert.equal(checker.selectedCallEvidenceTransactionState === undefined, true,
    "nested candidate settlement leaves no independent context registry or retained journal entries");
});
