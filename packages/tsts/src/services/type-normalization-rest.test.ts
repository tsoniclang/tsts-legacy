import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_getRestType } from "../internal/checker/checker/signatures.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { hasDotDotDotToken } from "../internal/checker/utilities.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { ObjectFlagsObjectRestType } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { reacquireCachedRestType } from "./type-normalization-expressions.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/rest", includeBundledLibraries: false,
    files: { "/rest/core.d.ts": testCoreDeclarations,
      "/rest/use.ts": `export declare const input:{take:number;left:{value:string};right:boolean};
        export const {take,...rest}=input;
        export const {take:other,...same}=input;
        export const {...all}=rest;`,
      "/rest/other.ts": "export const other=1;", "/rest/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/rest/use.ts");
  if (program === undefined || file === undefined) throw new Error("The checked binding owns its actual Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, view.ast.is.IsBindingElement).filter(hasDotDotDotToken);
  assert.equal(declarations.length, 3);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The native checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  const rows = (owner: Checker): Type[] => declarations.map(declaration => {
    const symbol = Node_Symbol(declaration);
    if (symbol === undefined) throw new Error("The actual rest binding retains its native symbol");
    const type = Checker_getTypeOfSymbol(owner, symbol);
    if (type === undefined) throw new Error("The actual binding returns its cached native Type");
    assert.equal((type.objectFlags & ObjectFlagsObjectRestType) !== 0, true);
    assert.equal(type.symbol === symbol && type.symbol.ValueDeclaration === declaration, true);
    assert.equal(LinkStore_TryGet(owner.valueSymbolLinks, symbol)?.resolvedType === type, true);
    return type;
  });
  return { owners, rows };
}

for (const checkers of [1, 4]) test(`native object-rest types retain their actual cached binding with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The foreign Program retains its actual checker");
  const rows = new Map(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = rows.get(source);
    const expected = rows.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The same authored binding has both native answers");
    assert.equal(new Set(originals).size, 3, "equal member shapes from distinct bindings retain distinct native cache owners");
    for (const ordered of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const original of ordered) {
        const target: Type | undefined = expected[originals.indexOf(original)];
        if (target === undefined) throw new Error("The actual target binding retains its own cached answer");
        assert.equal(reacquireCachedRestType(producer, original) === target, true);
        assert.equal(normalization.type(original) === target && normalization.type(original) === target, true);
        assert.equal(original.derivation === undefined, true, "the actual native binding cache needs no added provenance record");
        const uncached = Checker_getRestType(source, original, [], original.symbol);
        if (uncached === undefined) throw new Error("The native rest construction returns its actual fresh result");
        assert.equal(uncached !== original && uncached.symbol === original.symbol, true);
        assert.equal(reacquireCachedRestType(producer, uncached), undefined,
          "the same genuine binding symbol cannot authorize a different uncached native result");
        assert.throws(() => reacquireCachedRestType(foreign, original), error => error instanceof TypeError);
        assert.equal(reacquireCachedRestType(producer, source.stringType!), undefined);
      }
    }
  }
});
