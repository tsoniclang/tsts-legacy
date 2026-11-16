import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { CheckModeContextual, CheckModeNormal } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionCached, Checker_checkExpressionEx } from "../internal/checker/checker/syntax-checking.js";
import { Checker_getRegularTypeOfObjectLiteral, Checker_getWidenedType, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import type { Type } from "../internal/checker/types.js";
import { reacquireExpressionConstruction } from "./type-normalization-expressions.js";
import { reacquireLiteralGraph } from "./type-normalization-spreads.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/literals", includeBundledLibraries: false,
    files: { "/literals/core.d.ts": testCoreDeclarations,
      "/literals/use.ts": "export const first={a:1}; export const same={a:1}; export const nested={a:{b:2}};",
      "/literals/other.ts": "export const other=1;", "/literals/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/literals/use.ts");
  if (program === undefined || file === undefined) throw new Error("The complete literal retains its actual Program and source file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression);
  assert.equal(nodes.length, 4);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual native checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { nodes, owners };
}

for (const checkers of [1, 4]) test(`fresh complete literal and context-free constructions retain actual inputs with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The unrelated Program retains its actual producer");
  for (const source of current.owners) for (const producer of current.owners) {
    for (const nodes of [current.nodes, [...current.nodes].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const node of nodes) {
        const original = Checker_checkExpressionCached(source, node);
        const expected = Checker_checkExpressionCached(producer, node);
        if (original === undefined || expected === undefined) throw new Error("The actual fresh and cached literal operations complete");
        assert.equal(original.derivation?.kind === "object-literal" && original.derivation.creation.node === node
          && original.derivation.creation.mode === CheckModeNormal, true);
        assert.equal(LinkStore_TryGet(source.typeNodeLinks, node)?.resolvedType === original, true,
          "the complete normal literal belongs to its actual completed cached question");
        const recipe = original.derivation;
        const normalized = normalization.type(original);
        assert.equal(normalized === (source === producer ? original : expected), true);
        assert.equal(normalization.type(original) === normalized, true);
        assert.equal(reacquireExpressionConstruction(producer, original, normalization.type), undefined,
          "complete normal inputs have one canonical graph reader, not a blind expression recheck");
        const uncached = Checker_checkExpressionEx(source, node, CheckModeNormal);
        if (uncached?.derivation?.kind !== "object-literal") throw new Error("The actual uncached normal check completes with its creation");
        assert.equal(uncached !== original && uncached.derivation?.kind === "object-literal", true);
        const unread = new Proxy(producer, { get(owner, key, receiver) {
          if (key === "typeNodeLinks" || key === "cachedTypes") assert.fail("an unowned normal construction cannot read a target cache");
          return Reflect.get(owner, key, receiver);
        } });
        const fresh = normalization.type(uncached);
        assert.equal(fresh.checker === producer && (source === producer ? fresh === uncached : fresh !== expected), true,
          "an authenticated uncached normal creation keeps its actual native freshness");
        const clone = Checker_newAnonymousType(source, uncached.symbol, new Map(), [], [], []);
        if (clone === undefined) throw new Error("The actual independent native clone is produced");
        clone.derivation = uncached.derivation;
        assert.equal(reacquireLiteralGraph(unread, clone, () => assert.fail("a copied capability cannot normalize"),
          () => assert.fail("a copied capability cannot seed a memo"), new Map()), undefined,
        "copying the genuine creation record cannot retarget its authenticated output");
        const constructions = [
          ["regular-of", Checker_getRegularTypeOfObjectLiteral(source, original), Checker_getRegularTypeOfObjectLiteral(producer, expected)],
          ["widened-from", Checker_getWidenedType(source, original), Checker_getWidenedType(producer, expected)],
        ] as const;
        for (const [kind, value, target] of constructions) {
          if (value === undefined || target === undefined) throw new Error("The actual native literal constructions complete");
          assert.equal(value.derivation?.kind === kind && value.derivation.source === original, true);
          const constructionRecipe = value.derivation;
          assert.equal(normalization.type(value) === (source === producer ? value : target), true);
          assert.equal(reacquireExpressionConstruction(producer, value, input => {
            assert.equal(input === original, true);
            return expected;
          }) === target, true);
          const repeated: Type | undefined = kind === "regular-of" ? Checker_getRegularTypeOfObjectLiteral(source, original)
            : Checker_getWidenedType(source, original);
          assert.equal(repeated === value && repeated.derivation === constructionRecipe, true,
            "native cache hits retain the first actual construction record unchanged");
          assert.throws(() => reacquireExpressionConstruction(producer, value, () => foreign.stringType!), error => error instanceof TypeError);
        }
        assert.equal(original.derivation === recipe, true, "derived results never overwrite the fresh input's own recipe");
        const contextual = Checker_checkExpressionEx(source, node, CheckModeContextual);
        if (contextual === undefined) throw new Error("The genuine contextual producing operation completes");
        assert.equal(contextual.derivation?.kind === "object-literal" && contextual.derivation.creation.mode === CheckModeContextual, true);
        assert.equal(reacquireExpressionConstruction(producer, contextual, normalization.type), undefined,
          "an uncached contextual operation cannot be relabeled as its normal cached answer");
        const unrelated = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
        if (unrelated === undefined) throw new Error("The actual independent anonymous construction completes");
        assert.equal(unrelated.derivation, undefined);
        assert.equal(reacquireExpressionConstruction(producer, unrelated, normalization.type), undefined,
          "sharing a declaration symbol does not create a producing record");
        assert.throws(() => createTypeNormalization(foreign).type(original), error => error instanceof TypeError);
      }
    }
  }
});
