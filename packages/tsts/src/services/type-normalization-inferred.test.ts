import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Arguments } from "../internal/ast/ast.js";
import type { Node } from "../internal/ast/spine.js";
import { Checker_cloneSignature, Checker_getResolvedSignature, Checker_getReturnTypeOfSignature,
  Checker_getSingleCallOrConstructSignature } from "../internal/checker/checker/signatures.js";
import { Checker_isContextSensitive } from "../internal/checker/checker/support-queries.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { CheckModeNormal } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { SignatureFlagsConstruct, Type_AsTypeParameter } from "../internal/checker/types.js";
import type { Signature, Type } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireHigherOrderSignature } from "./type-normalization-signatures.js";

interface InferredRow {
  readonly call: Node;
  readonly signature: Signature;
  readonly returned: Signature;
  readonly result: Type;
}

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/higher", includeBundledLibraries: false,
    files: { "/higher/core.d.ts": testCoreDeclarations,
      "/higher/use.ts": `export declare function identity<T>(value:T):T;
        export declare function array<T>(value:T):T[];
        export declare function compose<A,B,C>(first:(value:A)=>B, second:(value:B)=>C):(value:A)=>C;
        export const simple = compose(identity, array);
        export declare function pairFunctions<A,B,C,D>(left:(value:A)=>B, right:(value:C)=>D, after:(value:number)=>number):(left:A,right:C)=>[B,D];
        export const invoke = pairFunctions(identity, identity, value=>value);
        export const invokeOther = pairFunctions(identity, identity, value=>value);
        export class Box<Value> { constructor(public value:Value) {} }
        export declare function wrap<A,B>(constructor:new(value:A)=>B):new(value:A)=>B;
        export const simpleConstructor = wrap(Box);
        export declare function pairConstructors<A,B,C,D>(left:new(value:A)=>B, right:new(value:C)=>D, after:(value:number)=>number):new(left:A,right:C)=>[B,D];
        export const construct = pairConstructors(Box, Box, value=>value);
        export const constructOther = pairConstructors(Box, Box, value=>value);`,
      "/higher/other.ts": "export const other = 1;", "/higher/last.ts": "export const last = 2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true, "the actual higher-order call and construct sources check successfully");
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
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true,
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
  return { owners, selected };
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
