import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_getDeclaredTypeOfSymbol, Checker_getSymbolOfDeclaration, Checker_getTypeOfSymbol, Checker_newSymbolEx } from "../internal/checker/checker/symbols.js";
import { Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { LinkStore_Get, LinkStore_TryGet } from "../internal/core/linkstore.js";
import { reacquireCachedValueType } from "./type-normalization-declarations.js";
import { createTypeNormalization } from "./type-normalization.js";
import type { Type } from "../internal/checker/types.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/symbol-values", includeBundledLibraries: false,
    files: { "/symbol-values/core.d.ts": testCoreDeclarations,
      "/symbol-values/use.ts": `export class Box<T>{value!:T;static flag=true;}
        export class Other{value=1;}
        export enum Tag{First,Second}
        export namespace Space{export const value="space";}
        export function factory(){return 1;} export namespace factory{export const value=2;}`,
      "/symbol-values/other.ts": "export const other=1;", "/symbol-values/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const program = session.program;
  const file = checked.getSourceFile("/symbol-values/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual symbol-value declarations retain their Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, node => view.ast.is.IsClassDeclaration(node)
    || view.ast.is.IsEnumDeclaration(node) || view.ast.is.IsModuleDeclaration(node) || view.ast.is.IsFunctionDeclaration(node));
  assert.equal(declarations.length, 6);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker inventory is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { owners, declarations, view };
}

for (const checkers of [1, 4]) test(`actual class, enum and module values retain their native symbol cache with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  let coldTargets = 0;
  for (const source of current.owners) for (const producer of current.owners) {
    const normalization = createTypeNormalization(producer);
    const values = new Set<Type>();
    for (const declarations of [current.declarations, [...current.declarations].reverse()]) {
      for (const declaration of declarations) {
        const symbol = Checker_getSymbolOfDeclaration(source, declaration);
        const original = symbol === undefined ? undefined : Checker_getTypeOfSymbol(source, symbol);
        if (symbol === undefined || original === undefined) throw new Error("The genuine source symbol and cached value exist");
        assert.equal(symbol.checkerId, undefined);
        assert.equal(original.checker === source && original.symbol === symbol
          && LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType === original, true);
        const before = LinkStore_TryGet(producer.valueSymbolLinks, symbol)?.resolvedType;
        const result = normalization.type(original);
        assert.equal(result.checker === producer && result.symbol === symbol && result === Checker_getTypeOfSymbol(producer, symbol), true);
        assert.equal(LinkStore_TryGet(producer.valueSymbolLinks, symbol)?.resolvedType === result, true);
        assert.equal(reacquireCachedValueType(producer, original) === result && normalization.type(original) === result, true);
        assert.equal(LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType === original, true);
        assert.equal((source === producer) === (original === result), true);
        if (current.view.ast.is.IsClassDeclaration(declaration) || current.view.ast.is.IsEnumDeclaration(declaration)) {
          const declared = Checker_getDeclaredTypeOfSymbol(source, symbol);
          assert.equal(original !== declared && declared !== undefined, true, "a constructor or enum value is not its declared instance type");
          if (declared === undefined) throw new Error("The independent declared type exists");
          assert.equal(reacquireCachedValueType(producer, declared), undefined);
        }
        if (source !== producer && before === undefined) coldTargets += 1;
        values.add(result);
      }
    }
    assert.equal(values.size, 5, "the genuine merged function/namespace retains one symbol, other declaration values remain distinct");
  }
  assert.equal(checkers === 1 ? coldTargets === 0 : coldTargets > 0, true);
});

for (const checkers of [1, 4]) test(`cached symbol-value admission rejects clones before target access with ${checkers} checkers`, async () => {
  const current = fixture(checkers);
  const foreign = fixture(1);
  const foreignOwner = foreign.owners[0];
  if (foreignOwner === undefined) throw new Error("The actual foreign Program retains its owner");
  for (const source of current.owners) {
    const producer = current.owners.find(owner => owner !== source) ?? source;
    const unread = new Proxy(producer, { get(owner, key, receiver) {
      if (key !== "program" && key !== "id") assert.fail("an unowned symbol value cannot read a target cache or query");
      return Reflect.get(owner, key, receiver);
    } });
    for (const declaration of current.declarations) {
      const symbol = Checker_getSymbolOfDeclaration(source, declaration);
      const original = symbol === undefined ? undefined : Checker_getTypeOfSymbol(source, symbol);
      if (symbol === undefined || original === undefined) throw new Error("The original cached native value exists");
      const clone = Checker_newAnonymousType(source, symbol, new Map(), [], [], []);
      const copied = Checker_newAnonymousType(source, { ...symbol }, new Map(), [], [], []);
      const transient = Checker_newSymbolEx(source, symbol.Flags, symbol.Name, symbol.CheckFlags);
      if (clone === undefined || copied === undefined || transient === undefined) throw new Error("The native uncached opposites exist");
      transient.ValueDeclaration = symbol.ValueDeclaration;
      transient.Declarations = symbol.Declarations;
      transient.Parent = symbol.Parent;
      const transientType = Checker_newAnonymousType(source, transient, new Map(), [], [], []);
      const transientLinks = LinkStore_Get(source.valueSymbolLinks, transient);
      const sourceLinks = LinkStore_Get(source.valueSymbolLinks, symbol);
      if (transientType === undefined || transientLinks === undefined || sourceLinks === undefined)
        throw new Error("The native uncached value and its allocated cache records exist");
      transientLinks.resolvedType = transientType;
      assert.equal(reacquireCachedValueType(unread, clone), undefined);
      assert.equal(reacquireCachedValueType(unread, { ...original }), undefined);
      assert.equal(reacquireCachedValueType(unread, copied), undefined);
      assert.equal(reacquireCachedValueType(unread, transientType), undefined,
        "a copied declaration/symbol cache cannot fabricate actual shared or late-bound ownership");
      const retained = sourceLinks.resolvedType;
      for (const invalid of [undefined, clone]) {
        try {
          sourceLinks.resolvedType = invalid;
          assert.equal(reacquireCachedValueType(unread, original), undefined);
          assert.equal(sourceLinks.resolvedType === invalid, true, "source admission does not fill or replace its native cache");
        } finally { sourceLinks.resolvedType = retained; }
      }
      assert.throws(() => reacquireCachedValueType(foreignOwner, original), TypeError);
      if (source !== producer) {
        const result = reacquireCachedValueType(producer, original);
        const targetLinks = LinkStore_Get(producer.valueSymbolLinks, symbol);
        if (result === undefined || targetLinks === undefined) throw new Error("The actual target cached value exists");
        try {
          targetLinks.resolvedType = original;
          assert.throws(() => reacquireCachedValueType(producer, original), TypeError);
        } finally { targetLinks.resolvedType = result; }
        assert.equal(reacquireCachedValueType(producer, original) === result, true);
      }
    }
  }
  const declarations = await import("./type-normalization-declarations.js");
  assert.equal("reacquireCachedFunctionType" in declarations, false, "one canonical cached-value helper replaces the narrower private name");
});
