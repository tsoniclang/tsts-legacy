import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionCached } from "../internal/checker/checker/syntax-checking.js";
import { Checker_getRegularTypeOfObjectLiteral, Checker_getSpreadType, Checker_getWidenedType } from "../internal/checker/checker/types.js";
import { ObjectFlagsNone } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { reacquireCachedObjectExpression } from "./type-normalization-expressions.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/spread", includeBundledLibraries: false,
    files: { "/spread/core.d.ts": testCoreDeclarations,
      "/spread/use.ts": `export declare const input:{take:number;left:{value:string};right:boolean};
        export const direct={...input,take:2};
        export const same={...input,take:2};
        export const next={...direct,take:3};`,
      "/spread/other.ts": "export const other=1;", "/spread/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/spread/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual spread expression retains its Program and file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression);
  assert.equal(nodes.length, 3);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual native checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  const rows = (owner: Checker): Type[][] => nodes.map(node => {
    const original = Checker_checkExpressionCached(owner, node);
    if (original === undefined) throw new Error("The spread expression returns its actual cached answer");
    assert.equal(original.symbol === Node_Symbol(node) && original.symbol?.ValueDeclaration === node, true);
    const regular = Checker_getRegularTypeOfObjectLiteral(owner, original);
    const widened = Checker_getWidenedType(owner, original);
    if (regular === undefined || widened === undefined) throw new Error("The actual cached expression has both native derived forms");
    return [original, regular, widened];
  });
  return { nodes, owners, rows };
}

for (const checkers of [1, 4]) test(`cached spread expression roots retain their actual producer with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program retains its actual checker");
  const answers = new Map<Checker, Type[][]>(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = answers.get(source);
    const expected = answers.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("Both actual producers retain the checked literal's answers");
    assert.equal(new Set(originals.map(row => row[0])).size, 3, "equal shapes from distinct literal owners do not share an answer");
    for (const order of [[0, 1, 2], [2, 1, 0]]) {
      const normalization = createTypeNormalization(producer);
      for (const position of order) {
        const originalsAt: Type[] | undefined = originals[position];
        const expectedAt: Type[] | undefined = expected[position];
        const node = current.nodes[position];
        if (originalsAt === undefined || expectedAt === undefined || node === undefined)
          throw new Error("Each actual literal keeps its independently selected result forms");
        for (const [form, original] of originalsAt.entries()) {
          const target: Type | undefined = expectedAt[form];
          if (target === undefined) throw new Error("The target checker retains that exact native cached form");
          assert.equal(reacquireCachedObjectExpression(producer, original) === target, true);
          assert.equal(normalization.type(original) === target && normalization.type(original) === target, true);
          if (original === originalsAt[0]) assert.equal(original.derivation?.kind === "literal-merge"
            && LiteralCreation.read(original)?.node === node, true,
          "the fresh creation record preserves the existing complete expression cache identity");
          else assert.equal((original.derivation?.kind === "regular-of" || original.derivation?.kind === "widened-from")
            && original.derivation.source === originalsAt[0], true,
          "a fresh derived form retains its exact source, not a guessed complete-literal recipe");
          assert.throws(() => createTypeNormalization(foreign).type(original), error => error instanceof TypeError);
        }
        const original: Type | undefined = originalsAt[0];
        if (original === undefined) throw new Error("The literal has its real initial cached answer");
        const uncached = Checker_getSpreadType(source, source.emptyObjectType, original, Node_Symbol(node), ObjectFlagsNone, false, null);
        if (uncached === undefined) throw new Error("The actual native spread construction returns its fresh result");
        assert.equal(uncached !== original && uncached.symbol === original.symbol, true);
        assert.equal(reacquireCachedObjectExpression(producer, uncached), undefined,
          "an uncached spread cannot borrow an expression's cached-owner proof merely by sharing its symbol");
      }
    }
  }
});
