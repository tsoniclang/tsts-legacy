import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Arguments } from "../internal/ast/ast.js";
import type { Node } from "../internal/ast/spine.js";
import { Checker_cloneSignature, Checker_getResolvedCallSelectionEvidence, Checker_getResolvedSignature, Checker_getReturnTypeOfSignature,
  Checker_getSingleCallOrConstructSignature } from "../internal/checker/checker/signatures.js";
import { Checker_isContextSensitive } from "../internal/checker/checker/support-queries.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { CheckModeNormal } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { SignatureFlagsConstruct, Type_AsTypeParameter } from "../internal/checker/types.js";
import type { Signature, Type } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { cachedSignatureArguments, reacquireHigherOrderSignature, reacquireSignatureInstantiation } from "./type-normalization-signatures.js";
import { reacquireDeclarationSignature } from "./type-normalization-declarations.js";

interface InferredRow {
  readonly call: Node;
  readonly signature: Signature;
  readonly returned: Signature;
  readonly result: Type;
}

function fixture(checkers: number, rejected = false, overloaded = false) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/higher", includeBundledLibraries: false,
    files: { "/higher/core.d.ts": testCoreDeclarations,
      "/higher/use.ts": `export declare function identity<T>(value:T):T;
        export declare function array<T>(value:T):T[];
        export declare function compose<A,B,C>(first:(value:A)=>B, second:(value:B)=>C):(value:A)=>C;
        export const simple = compose(identity, array);
        ${overloaded ? "export declare function pairFunctions<A,B,C,D>(left:(value:A)=>B, right:(value:C)=>D, after:(value:number)=>boolean):(left:A,right:C)=>[B,D];" : ""}
        export declare function pairFunctions<A,B,C,D>(left:(value:A)=>B, right:(value:C)=>D, after:(value:number)=>${rejected ? "string" : "number"}):(left:A,right:C)=>[B,D];
        export const invoke = pairFunctions(identity, identity, value=>value);
        export const invokeOther = pairFunctions(identity, identity, value=>value);
        export class Box<Value> { constructor(public value:Value) {} }
        export declare function wrap<A,B>(constructor:new(value:A)=>B):new(value:A)=>B;
        export const simpleConstructor = wrap(Box);
        ${overloaded ? "export declare function pairConstructors<A,B,C,D>(left:new(value:A)=>B, right:new(value:C)=>D, after:(value:number)=>boolean):new(left:A,right:C)=>[B,D];" : ""}
        export declare function pairConstructors<A,B,C,D>(left:new(value:A)=>B, right:new(value:C)=>D, after:(value:number)=>${rejected ? "string" : "number"}):new(left:A,right:C)=>[B,D];
        export const construct = pairConstructors(Box, Box, value=>value);
        export const constructOther = pairConstructors(Box, Box, value=>value);`,
      "/higher/other.ts": "export const other = 1;", "/higher/last.ts": "export const last = 2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length > 0, rejected, "the actual argument mismatch has original diagnostics, unlike applicable calls");
  const program = session.program;
  if (program === undefined) throw new Error("The actual checked fixture owns its Program");
  const file = checked.getSourceFile("/higher/use.ts");
  if (file === undefined) throw new Error("The actual checked higher-order file is present");
  const view = checked.getSourceFileQueries(file);
  const calls = findNodes(file, view.ast.children, view.ast.is.IsCallExpression);
  assert.equal(calls.length, 6, "the fixture contains all actual selected call occurrences");
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("Every actual selected pool member exists");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers, "the test exercises the actual requested pool, not a single-checker policy fallback");
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && (borrowed.checkSource().diagnostics.length > 0) === rejected, true,
    "a session over the actual existing Program retains its native producer inventory");
  const selected = (owner: Checker): InferredRow[] => calls.map(call => {
    if (call === undefined) throw new Error("The actual checked call occurrence inventory is dense");
    const signature = Checker_getResolvedSignature(owner, call, undefined, CheckModeNormal);
    if (signature?.derivation?.kind !== "higher-order") throw new Error("The actual invocation makes a higher-order native signature");
    const result = Checker_getReturnTypeOfSignature(owner, signature);
    const returned = Checker_getSingleCallOrConstructSignature(owner, result);
    if (result === undefined || returned === undefined) throw new Error("The actual native higher-order return exists");
    assert.equal(signature.derivation.at === call && signature.derivation.returned === returned &&
      LinkStore_TryGet(owner.signatureLinks, call)?.resolvedSignature === signature, true,
      "the outer recipe retains the exact original occurrence and selected completed cache result");
    assert.equal(returned.derivation?.kind === "higher-order-return" && returned.derivation.signature === signature, true,
      "the return recipe names the actual producing outer signature");
    const contextSensitive = (Node_Arguments(call) ?? []).some(argument => Checker_isContextSensitive(owner, argument));
    if (returned.typeParameters.length === 2) {
      assert.equal(contextSensitive && signature.target !== undefined && signature.target.typeParameters.length === 0 &&
        signature.target.target !== undefined && signature.target.target.typeParameters.length > 0, true,
        "the actual generic candidate with a contextual argument takes the native preliminary and final argument passes");
      const declared = returned.typeParameters[0];
      const fresh = returned.typeParameters[1];
      assert.equal(declared !== undefined && declared.derivation === undefined, true,
        "the genuinely shared declared parameter never receives or overwrites a call-owner recipe");
      assert.equal(fresh?.derivation?.kind === "inferred-parameter" && fresh.derivation.signature === returned &&
        fresh.derivation.index === 1 && Type_AsTypeParameter(fresh)?.target !== undefined, true,
        "the real fresh unique parameter belongs to the FINAL selected return, never a preliminary candidate");
    }
    return { call, signature, returned, result };
  });
  return { owners, selected, calls, view };
}

for (const checkers of [1, 4]) test(`higher-order native recipes preserve call and construct owners with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1);
  const foreignOwner = foreign.owners[0];
  if (foreignOwner === undefined) throw new Error("The independent Program owns its native checker");
  const rows = new Map<Checker, InferredRow[]>();
  for (const owner of current.owners) rows.set(owner, current.selected(owner));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = rows.get(source);
    const expected = rows.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The actual selected native rows are retained");
    for (const order of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const original of order) {
        const target: InferredRow | undefined = expected.find(row => row.call === original.call);
        if (target === undefined) throw new Error("The target producer resolves the same actual source occurrence");
        assert.equal(reacquireHigherOrderSignature(source, producer, original.signature, () => {
          throw new Error("The selected outer recipe needs no signature reconstruction callback");
        }) === target.signature, true);
        assert.equal(normalization.type(original.result) === target.result &&
          Checker_isTypeIdenticalTo(producer, normalization.type(original.result), target.result), true,
          "the SAME native isolated signature constructor retains the complete inferred result");
        assert.equal((original.returned.flags & SignatureFlagsConstruct) === (target.returned.flags & SignatureFlagsConstruct), true,
          "a genuine construct return is not reconstructed as a call-only signature");
        const parameter = original.returned.typeParameters[1];
        if (parameter !== undefined) {
          const normalized = normalization.type(parameter);
          assert.equal(normalized === target.returned.typeParameters[1] && normalized.checker === producer, true,
            "the actual selected return and parameter position determine the target's unique parameter");
          const other: InferredRow | undefined = expected.find(row => row.call !== original.call && row.returned.typeParameters.length === 2 &&
            (row.returned.flags & SignatureFlagsConstruct) === (target.returned.flags & SignatureFlagsConstruct));
          assert.equal(other !== undefined && normalized !== other.returned.typeParameters[1] &&
            !Checker_isTypeIdenticalTo(producer, normalized, other.returned.typeParameters[1]), true,
            "different selected invocations never merge equal-spelled fresh parameter constructions");
        }
        const outerClone = Checker_cloneSignature(source, original.signature, original.signature.constructorClass);
        const returnClone = Checker_cloneSignature(source, original.returned, original.returned.constructorClass);
        if (outerClone === undefined || returnClone === undefined) throw new Error("The genuine native signature clone operation completes");
        assert.equal(outerClone.derivation === undefined && returnClone.derivation === undefined, true,
          "ordinary native clones do not inherit another invocation's producing relation");
        const outerRecipe = original.signature.derivation;
        const returnRecipe = original.returned.derivation;
        if (outerRecipe === undefined || returnRecipe === undefined) throw new Error("The genuine native recipes exist");
        outerClone.derivation = outerRecipe;
        returnClone.derivation = returnRecipe;
        assert.equal(reacquireHigherOrderSignature(source, producer, outerClone, value => value) === undefined &&
          reacquireHigherOrderSignature(source, producer, returnClone, value => value) === undefined, true,
          "copied recipe payload never replaces exact cached result and original return-pointer membership");
        assert.throws(() => reacquireHigherOrderSignature(source, foreignOwner, original.signature, value => value),
          error => error instanceof TypeError && error.message === "A native higher-order signature requires the same actual Program");
      }
    }
  }
});

for (const checkers of [1, 4]) test(`published conditional higher-order candidates retain their actual producers with ${checkers} checkers`, () => {
  const current = fixture(checkers, true);
  let published = 0;
  for (const call of current.calls) {
    if (call === undefined) throw new Error("The actual invocation inventory is dense");
    const answer = current.view.checker.getResolvedCallInfo(call);
    if (answer?.kind !== "conditional-candidates") continue;
    published += 1;
    assert.equal(answer.candidates.length === 1 && answer.diagnostics.length > 0, true,
      "the genuine public answer exposes the failed candidate and its original diagnostics");
  }
  assert.equal(published, 4, "both repeated call and construct mismatches expose their actual candidate answers");
  interface ConditionalRow extends InferredRow {
    readonly original: Signature;
    readonly kind: "call" | "construct";
  }
  const rows = new Map<Checker, ConditionalRow[]>();
  for (const owner of current.owners) {
    const values: ConditionalRow[] = [];
    for (const call of current.calls) {
      if (call === undefined) throw new Error("The actual invocation inventory is dense");
      Checker_getResolvedSignature(owner, call, undefined, CheckModeNormal);
      const evidence = Checker_getResolvedCallSelectionEvidence(owner, call);
      if (evidence?.kind !== "conditional-candidates") continue;
      for (const candidate of evidence.candidates) {
        const signature = candidate.application.instantiatedSignature;
        if (signature?.derivation?.kind !== "higher-order") throw new Error("The published candidate has its actual higher-order construction");
        const returned = signature.derivation.returned;
        const result = Checker_getReturnTypeOfSignature(owner, signature);
        if (result === undefined) throw new Error("The actual native candidate return exists");
        assert.equal(LinkStore_TryGet(owner.signatureLinks, call)?.resolvedSignature !== signature, true,
          "a published conditional candidate is not falsely treated as the selected cache answer");
        const fresh = returned.typeParameters[1];
        assert.equal(fresh?.derivation?.kind === "inferred-parameter" && fresh.derivation.signature === returned &&
          fresh.derivation.index === 1 && returned.typeParameters[0]?.derivation === undefined, true,
          "the published final candidate owns only its genuinely fresh parameter, not a shared declaration");
        values.push({ call, signature, returned, result, original: candidate.application.signature, kind: candidate.application.kind });
      }
    }
    assert.equal(values.length, 4, "every actual checker publishes all four genuine higher-order conditional candidates");
    rows.set(owner, values);
  }
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = rows.get(source);
    const expected = rows.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The actual completed candidate inventories are present");
    for (const order of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const original of order) {
        const target: ConditionalRow | undefined = expected.find(value => value.call === original.call && value.kind === original.kind
          && value.original.declaration === original.original.declaration);
        if (target === undefined) throw new Error("The target producer checks the same actual invocation");
        assert.equal(normalization.type(original.result) === target.result, true,
          "normalization uses the actual original candidate signature, not a candidate ordinal or reconstructed call signature");
        const fresh = original.returned.typeParameters[1];
        if (fresh === undefined) throw new Error("The actual native return owns its fresh parameter");
        assert.equal(normalization.type(fresh) === target.returned.typeParameters[1], true);
        const other: ConditionalRow | undefined = expected.find(value => value.call !== original.call && value.kind === original.kind);
        assert.equal(other !== undefined && target.returned.typeParameters[1] !== other.returned.typeParameters[1], true,
          "separate failed invocation occurrences do not merge equal-spelled unique parameter constructions");
        const clone = Checker_cloneSignature(source, original.signature, original.signature.constructorClass);
        if (clone === undefined || original.signature.derivation === undefined) throw new Error("The actual native clone and original recipe exist");
        clone.derivation = original.signature.derivation;
        assert.equal(reacquireHigherOrderSignature(source, producer, clone, () => {
          throw new Error("An unpublished clone is rejected before candidate normalization");
        }) === undefined, true, "a copied recipe cannot borrow exact completed candidate membership");
      }
    }
  }
});

for (const checkers of [1, 4]) test(`two public rejected overloads preserve their actual ordinary cached construction with ${checkers} checkers`, () => {
  const current = fixture(checkers, true, true);
  const answers = (owner: Checker, call: Node) => {
    Checker_getResolvedSignature(owner, call, undefined, CheckModeNormal);
    const answer = Checker_getResolvedCallSelectionEvidence(owner, call);
    if (answer?.kind !== "conditional-candidates") throw new Error("The actual overloaded invocation has its completed conditional answer");
    assert.equal(answer.candidates.length, 2, "both real rejected original overload signatures remain published");
    return answer.candidates;
  };
  let publicAnswers = 0;
  for (const call of current.calls) {
    if (call === undefined) throw new Error("The actual invocation inventory is dense");
    const publicAnswer = current.view.checker.getResolvedCallInfo(call);
    if (publicAnswer?.kind !== "conditional-candidates") continue;
    assert.equal(publicAnswer.candidates.length, 2);
    publicAnswers += 1;
    for (const source of current.owners) for (const producer of current.owners) {
      const originals = answers(source, call);
      const targets = answers(producer, call);
      const normalize = createTypeNormalization(producer);
      for (const order of [originals, [...originals].reverse()]) for (const original of order) {
        const signature = original.application.instantiatedSignature;
        if (signature === undefined) throw new Error("The actual ordinary rejected application has its instantiated signature");
        assert.equal(signature.derivation === undefined, true,
          "native overload inference did not create a higher-order result; no fresh recipe is fabricated");
        const arguments_ = cachedSignatureArguments(source, signature);
        const selected = reacquireDeclarationSignature(source, producer, original.application.signature);
        if (arguments_ === undefined || selected === undefined) throw new Error("The actual declared candidate and cached instantiation inputs are retained");
        const actualArguments: Type[] = [];
        for (const argument of arguments_) {
          if (argument === undefined) throw new Error("The actual cached native argument vector is dense");
          actualArguments.push(normalize.type(argument));
        }
        const result = reacquireSignatureInstantiation(producer, selected, actualArguments);
        const matches = targets.filter(value => value.application.signature === selected && value.application.kind === original.application.kind);
        assert.equal(matches.length === 1 && matches[0]?.application.instantiatedSignature === result, true,
          "actual original-signature identity and call/construct kind select exactly one native candidate, never an ordinal");
        const other = targets.find(value => value.application.signature !== selected);
        assert.equal(other !== undefined && other.application.instantiatedSignature !== result, true,
          "two distinct original overloads at the SAME invocation do not share a cached instantiation");
        assert.equal(reacquireHigherOrderSignature(source, producer, signature, () => {
          throw new Error("An ordinary construction never pretends to be a higher-order recipe");
        }) === undefined, true);
      }
    }
  }
  assert.equal(publicAnswers, 4, "the original public call and construct mismatches both retain two candidates");
});
