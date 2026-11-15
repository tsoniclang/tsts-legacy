import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Type } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_getSymbolOfDeclaration, Checker_getTypeOfSymbol, Checker_newSymbolEx, Checker_newUniqueESSymbolType } from "../internal/checker/checker/symbols.js";
import { TypeFlagsUniqueESSymbol } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { LinkStore_Get, LinkStore_TryGet } from "../internal/core/linkstore.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireLiteralType } from "./type-normalization-literals.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/unique-symbols", includeBundledLibraries: false,
    files: { "/unique-symbols/core.d.ts": testCoreDeclarations,
      "/unique-symbols/use.ts": `declare const key:unique symbol;
        export declare const first:unique symbol;
        export declare const second:unique symbol;
        export declare class Box { static readonly named:unique symbol; static readonly [key]:unique symbol; }
        export interface Holder { readonly field:unique symbol; readonly [key]:unique symbol; }`,
      "/unique-symbols/other.ts": "export const other=1;", "/unique-symbols/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const program = session.program;
  const file = checked.getSourceFile("/unique-symbols/use.ts");
  if (program === undefined || file === undefined) throw new Error("The genuine unique declarations retain their actual Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, node =>
    (view.ast.is.IsVariableDeclaration(node) || view.ast.is.IsPropertyDeclaration(node)
      || view.ast.is.IsPropertySignatureDeclaration(node)) && Node_Type(node) !== undefined);
  assert.equal(declarations.length, 7);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The native checker inventory is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { owners, declarations };
}

for (const checkers of [1, 4]) test(`unique symbols retain their actual native cache with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  let coldTargets = 0;
  for (const source of current.owners) for (const producer of current.owners) {
    const normalization = createTypeNormalization(producer);
    const selected = new Set<Type>();
    for (const declarations of [current.declarations, [...current.declarations].reverse()]) {
      for (const declaration of declarations) {
        const symbol = Checker_getSymbolOfDeclaration(source, declaration);
        const original = symbol === undefined ? undefined : Checker_getTypeOfSymbol(source, symbol);
        if (symbol === undefined || original === undefined) throw new Error("The actual declaration supplies its native symbol and value");
        assert.equal(original.checker === source && original.symbol === symbol
          && (original.flags & TypeFlagsUniqueESSymbol) !== 0 && source.uniqueESSymbolTypes.get(symbol) === original, true);
        const before = producer.uniqueESSymbolTypes.size;
        const result = normalization.type(original);
        const targetSymbol = Checker_getSymbolOfDeclaration(producer, declaration);
        const expected = targetSymbol === undefined ? undefined : Checker_getTypeOfSymbol(producer, targetSymbol);
        assert.equal(result === expected && result.checker === producer && result.symbol === targetSymbol, true);
        assert.equal(targetSymbol !== undefined && producer.uniqueESSymbolTypes.get(targetSymbol) === result
          && LinkStore_TryGet(producer.valueSymbolLinks, targetSymbol)?.resolvedType === result, true);
        assert.equal(reacquireLiteralType(producer, original) === result && normalization.type(original) === result, true);
        assert.equal(source.uniqueESSymbolTypes.get(symbol) === original, true);
        assert.equal((source === producer) === (original === result), true);
        if (producer.uniqueESSymbolTypes.size > before && source !== producer) coldTargets += 1;
        selected.add(result);
      }
    }
    assert.equal(selected.size, current.declarations.length, "different actual symbol declarations retain distinct native types");
  }
  assert.equal(checkers === 1 ? coldTargets === 0 : coldTargets > 0, true);
});

for (const checkers of [1, 4]) test(`unique symbol source admission precedes target access with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1);
  const foreignOwner = foreign.owners[0];
  if (foreignOwner === undefined) throw new Error("The other genuine Program retains its checker");
  for (const source of current.owners) {
    const producer = current.owners.find(owner => owner !== source) ?? source;
    const unread = new Proxy(producer, { get(owner, key, receiver) {
      if (key !== "program" && key !== "id") assert.fail("a noncanonical source unique symbol cannot access the target native cache or query");
      return Reflect.get(owner, key, receiver);
    } });
    const foreignUnread = new Proxy(foreignOwner, { get(owner, key, receiver) {
      if (key !== "program" && key !== "id") assert.fail("a foreign Program fails before target native work");
      return Reflect.get(owner, key, receiver);
    } });
    for (const declaration of current.declarations) {
      const symbol = Checker_getSymbolOfDeclaration(source, declaration);
      const original = symbol === undefined ? undefined : Checker_getTypeOfSymbol(source, symbol);
      if (symbol === undefined || original === undefined) throw new Error("The native unique declaration retains its actual value");
      const clone = Checker_newUniqueESSymbolType(source, symbol, "uncached");
      const clonedSymbol = Checker_newSymbolEx(source, symbol.Flags, symbol.Name, symbol.CheckFlags);
      if (clone === undefined || clonedSymbol === undefined) throw new Error("The uncached native opposites exist");
      clonedSymbol.ValueDeclaration = symbol.ValueDeclaration;
      clonedSymbol.Declarations = symbol.Declarations;
      clonedSymbol.Parent = symbol.Parent;
      const symbolClone = Checker_newUniqueESSymbolType(source, clonedSymbol, "uncached-symbol");
      if (symbolClone === undefined) throw new Error("The uncached copied-symbol value exists");
      assert.equal(reacquireLiteralType(unread, clone), undefined);
      assert.equal(reacquireLiteralType(unread, { ...original }), undefined);
      assert.equal(reacquireLiteralType(unread, symbolClone), undefined);
      for (const invalid of [undefined, clone]) {
        try {
          if (invalid === undefined) source.uniqueESSymbolTypes.delete(symbol);
          else source.uniqueESSymbolTypes.set(symbol, invalid);
          assert.equal(reacquireLiteralType(unread, original), undefined);
          assert.equal(source.uniqueESSymbolTypes.get(symbol) === invalid, true, "source admission never fills its native cache");
        } finally { source.uniqueESSymbolTypes.set(symbol, original); }
      }
      assert.throws(() => reacquireLiteralType(foreignUnread, original), TypeError);
      assert.throws(() => createTypeNormalization(foreignUnread).type(original), TypeError);
      assert.equal(source.uniqueESSymbolTypes.get(symbol) === original, true);
      if (source !== producer) {
        const wrongOwner = Checker_newUniqueESSymbolType(producer, symbol, "wrong-producer");
        if (wrongOwner === undefined) throw new Error("The foreign native value exists");
        assert.equal(reacquireLiteralType(unread, wrongOwner), undefined);
        const result = reacquireLiteralType(producer, original);
        const targetSymbol = result?.symbol;
        const targetLinks = targetSymbol === undefined ? undefined : LinkStore_Get(producer.valueSymbolLinks, targetSymbol);
        if (result === undefined || targetSymbol === undefined || targetLinks === undefined)
          throw new Error("The genuine target unique symbol retains both cache records");
        try {
          producer.uniqueESSymbolTypes.set(targetSymbol, wrongOwner);
          assert.throws(() => reacquireLiteralType(producer, original), TypeError);
        } finally { producer.uniqueESSymbolTypes.set(targetSymbol, result); }
        try {
          targetLinks.resolvedType = wrongOwner;
          assert.throws(() => reacquireLiteralType(producer, original), TypeError);
        } finally { targetLinks.resolvedType = result; }
        assert.equal(reacquireLiteralType(producer, original) === result, true);
      }
    }
  }
});
