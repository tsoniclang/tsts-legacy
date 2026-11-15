import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Checker_getResolvedSignature } from "../internal/checker/checker/signatures.js";
import { Checker_getPropertiesOfType, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { CheckModeNormal } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Node } from "../internal/ast/spine.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { Type_Types, TypeFlagsUnion } from "../internal/checker/types.js";
import type { ResolvedCallSelectionEvidence, Type, TypeDerivation } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireContextualArgument } from "./type-normalization-contextual-arguments.js";

function fixture(checkers: number, rejected = false) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/arguments", includeBundledLibraries: false,
    files: { "/arguments/core.d.ts": testCoreDeclarations,
      "/arguments/use.ts": `declare function identity<T>(value:T):T;
        declare function pick<T>(value:T[]):T;
        export const direct=identity({n:1}); export const other=identity({n:1});
        export const union=pick([{a:1},{b:2}]);
        export const nested=pick([{a:{x:1}},{a:{y:2}}]);
        export const normal={n:1}; export const shared=identity(normal);
        export const nestedCall=identity(identity({n:2}));
        ${rejected ? "declare function needs<T>(value:T,after:string):T; export const bad=needs({reject:1},false);" : ""}`,
      "/arguments/other.ts": "export const other=1;", "/arguments/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === (rejected ? 1 : 0), true);
  const program = session.program;
  const file = checked.getSourceFile("/arguments/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual contextual call retains its Program and source file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsCallExpression).map(node => {
    if (node === undefined) throw new Error("The actual authored call occurrence vector is dense");
    return node;
  });
  assert.equal(nodes.length, rejected ? 8 : 7);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The native checker pool is dense");
    owners.push(owner);
  }
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === checked.diagnostics.length, true);
  return { owners, nodes };
}

function argument(owner: Checker, at: Node): Type {
  const signature = Checker_getResolvedSignature(owner, at, undefined, CheckModeNormal);
  const evidence = LinkStore_TryGet(owner.signatureLinks, at)?.resolvedCallSelectionEvidence;
  if (evidence?.kind !== "applicable" || evidence.selection.application.instantiatedSignature !== signature)
    throw new Error("The actual completed call has its selected application");
  const result = evidence.selection.application.signatureTypeArguments[0]?.checkedArgument;
  if (result === undefined) throw new Error("The actual selected signature retains its checked argument");
  return result;
}

function members(owner: Checker, type: Type): Type[] {
  if ((type.flags & TypeFlagsUnion) === 0) return [];
  const result: Type[] = [];
  for (const member of Type_Types(type) ?? []) {
    if (member === undefined) throw new Error("The actual inferred union retains every member");
    result.push(member);
    const property = Checker_getPropertiesOfType(owner, member)?.find(value => value?.Name === "a");
    const nested = property === undefined ? undefined : Checker_getTypeOfSymbol(owner, property);
    if (nested?.derivation?.kind === "widened-in") result.push(nested);
  }
  return result;
}

function literal(type: Type) {
  const recipe = type.derivation;
  if (recipe?.kind !== "widened-in" || recipe.source.derivation?.kind !== "object-literal")
    throw new Error("The contextual member retains its actual literal and widening path");
  return { path: recipe.path, node: recipe.source.derivation.node, mode: recipe.source.derivation.mode };
}

for (const checkers of [1, 4]) test(`completed contextual arguments and their members retain actual owners with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program retains its checker");
  const answers = new Map(current.owners.map(owner => [owner, current.nodes.map(node => argument(owner, node))]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = answers.get(source);
    const expected = answers.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("Both native producers retain their selected applications");
    assert.equal(originals[0] !== originals[1], true, "distinct call-owned literals retain distinct native answers");
    assert.equal(originals[4]?.derivation?.kind !== "inferred-at", true, "a normal call-free source cannot receive a call ownership record");
    assert.equal(originals[5] === originals[6] && originals[5]?.derivation?.kind === "inferred-at"
      && originals[5].derivation.at === current.nodes[6], true,
    "the outer call cannot overwrite its inner call's completed contextual owner");
    for (const order of [[0, 1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1, 0]]) {
      const normalization = createTypeNormalization(producer);
      for (const position of order) {
        const original: Type | undefined = originals[position];
        const target: Type | undefined = expected[position];
        const node = current.nodes[position];
        if (original === undefined || target === undefined || node === undefined) throw new Error("The actual call vector is dense");
        const recipe: TypeDerivation | undefined = original.derivation;
        assert.equal(normalization.type(original) === target && normalization.type(original) === target, true);
        assert.equal(argument(source, node) === original && original.derivation === recipe, true,
          "repeated native cache reads preserve the first actual owning record");
        const targets = members(producer, target);
        for (const member of members(source, original)) {
          const coordinate = literal(member);
          const matches = targets.filter(value => {
            const actual = literal(value);
            return actual.node === coordinate.node && actual.mode === coordinate.mode
              && JSON.stringify(actual.path) === JSON.stringify(coordinate.path);
          });
          assert.equal(matches.length, 1);
          const value = normalization.type(member);
          assert.equal(value === matches[0] && value.checker === producer, true,
            "the target's actual producing coordinates select the member, not union position or structural shape");
          const other = targets.find(candidate => literal(candidate).node !== coordinate.node
            && JSON.stringify(literal(candidate).path) === JSON.stringify(coordinate.path));
          if (other !== undefined) assert.equal(Checker_isTypeIdenticalTo(producer, value, other), false);
        }
        if (recipe?.kind !== "inferred-at") continue;
        const clone = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
        if (clone === undefined) throw new Error("The independent native clone completes");
        const unread = new Proxy(producer, { get(owner, key, receiver) {
          if (key === "signatureLinks") assert.fail("An unproduced inferred recipe cannot query the target call");
          return Reflect.get(owner, key, receiver);
        } });
        clone.derivation = recipe;
        assert.equal(reacquireContextualArgument(unread, clone), undefined);
        clone.derivation = { ...recipe, index: 999 };
        assert.equal(reacquireContextualArgument(unread, clone), undefined);
        const otherAt = current.nodes.find(value => value !== recipe.at && value !== node);
        if (otherAt === undefined) throw new Error("The actual input retains another call occurrence");
        clone.derivation = { ...recipe, at: otherAt };
        assert.equal(reacquireContextualArgument(unread, clone), undefined);
        assert.throws(() => reacquireContextualArgument(foreign, original), error => error instanceof TypeError);
      }
    }
  }
});

test("a genuine contextual member resolves its cold target call only after exact source admission", () => {
  const current = fixture(4);
  const at = current.nodes[2];
  const source = current.owners[0];
  if (at === undefined || source === undefined) throw new Error("The actual contextual union and native source exist");
  const original = argument(source, at);
  const producer = current.owners.find(value => value !== source && LinkStore_TryGet(value.signatureLinks, at)?.resolvedSignature === undefined);
  if (producer === undefined) throw new Error("The actual native pool retains an unqueried target call");
  const before = LinkStore_TryGet(producer.signatureLinks, at);
  const clone = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
  if (clone === undefined || original.derivation?.kind !== "inferred-at") throw new Error("The actual contextual argument retains its completed source owner");
  clone.derivation = original.derivation;
  assert.equal(reacquireContextualArgument(producer, clone), undefined);
  assert.equal(LinkStore_TryGet(producer.signatureLinks, at) === before && before?.resolvedSignature === undefined, true,
    "a copied recipe cannot initialize an unqueried target signature");
  const member = members(source, original)[0];
  if (member === undefined) throw new Error("The actual contextual union retains its first authored member");
  const coordinate = literal(member);
  const normalization = createTypeNormalization(producer);
  const value = normalization.type(member);
  const target = argument(producer, at);
  assert.equal(normalization.type(original) === target, true);
  const expected = members(producer, target).filter(candidate => literal(candidate).node === coordinate.node
    && JSON.stringify(literal(candidate).path) === JSON.stringify(coordinate.path));
  assert.equal(expected.length === 1 && expected[0] === value, true,
    "the actual native call creates its own matching contextual member on a cold cache");
});

for (const checkers of [1, 4]) test(`rejected contextual candidates do not acquire a completed argument owner with ${checkers} checkers`, () => {
  const current = fixture(checkers, true);
  const bad = current.nodes[7];
  if (bad === undefined) throw new Error("The actual rejected call occurrence is retained");
  for (const owner of current.owners) {
    Checker_getResolvedSignature(owner, bad, undefined, CheckModeNormal);
    const evidence: ResolvedCallSelectionEvidence | undefined = LinkStore_TryGet(owner.signatureLinks, bad)?.resolvedCallSelectionEvidence;
    assert.equal(evidence?.kind === "conditional-candidates", true);
    if (evidence?.kind !== "conditional-candidates") throw new Error("The actual rejected application retains its candidates");
    assert.equal(evidence.candidates.length > 0, true);
    for (const candidate of evidence.candidates) for (const row of candidate.application.signatureTypeArguments)
      assert.equal(row.checkedArgument?.derivation?.kind !== "inferred-at", true);
  }
});
