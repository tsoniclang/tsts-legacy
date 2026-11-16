import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import type { Symbol as NativeSymbol } from "../internal/ast/symbol.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_GetTypeAtLocation, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import { Checker_getTypeOfSymbol, Checker_newSymbolEx } from "../internal/checker/checker/symbols.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { LinkStore_Get, LinkStore_TryGet } from "../internal/core/linkstore.js";
import { reacquireCachedValueType } from "./type-normalization-declarations.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/function-values", includeBundledLibraries: false,
    files: { "/function-values/core.d.ts": testCoreDeclarations,
      "/function-values/use.ts": `function plain(value:number){return value;}
        function overloaded(value:number):number;
        function overloaded(value:string):string;
        function overloaded(value:number|string){return value;}
        const object={method(value:string){return value;},recursive(){return object;}};
        class Box{method<T>(value:T){return value;}}
        export {plain,overloaded,object,Box};`,
      "/function-values/other.ts": "export const other=1;", "/function-values/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const program = session.program;
  const file = checked.getSourceFile("/function-values/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual function values retain their Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children,
    node => view.ast.is.IsFunctionDeclaration(node) || view.ast.is.IsMethodDeclaration(node));
  const symbols = new Set<NativeSymbol>();
  for (const declaration of declarations) {
    const symbol = Node_Symbol(declaration);
    if (symbol === undefined) throw new Error("The real function or method retains its shared binder symbol");
    assert.equal(symbol.checkerId, undefined);
    symbols.add(symbol);
  }
  assert.equal(declarations.length, 7);
  assert.equal(symbols.size, 5);
  const literal = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression)[0];
  if (literal === undefined) throw new Error("The recursive method belongs to its actual object literal");
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { owners, symbols: [...symbols], literal };
}

for (const checkers of [1, 4]) test(`cached function values retain their exact shared symbol owner with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  let coldTargets = 0;
  for (const source of current.owners) for (const producer of current.owners) {
    for (const symbols of [current.symbols, [...current.symbols].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const symbol of symbols) {
        const original = Checker_getTypeOfSymbol(source, symbol);
        if (original === undefined) throw new Error("The actual native function value is produced");
        assert.equal(original.symbol === symbol && original.checker === source
          && LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType === original, true);
        const record = original.derivation;
        const before = LinkStore_TryGet(producer.valueSymbolLinks, symbol)?.resolvedType;
        const result = normalization.type(original);
        const expected = Checker_getTypeOfSymbol(producer, symbol);
        assert.equal(result === expected && result.checker === producer && result.symbol === symbol, true);
        assert.equal(LinkStore_TryGet(producer.valueSymbolLinks, symbol)?.resolvedType === result, true);
        assert.equal(reacquireCachedValueType(producer, original) === result, true);
        assert.equal(normalization.type(original) === result, true, "the invocation memo preserves an admitted native pointer");
        assert.equal(Checker_isTypeIdenticalTo(producer, result, expected), true);
        assert.equal(original.derivation === record, true, "the cache reader writes no creation or contextual owner record");
        if (source === producer) assert.equal(result === original, true);
        if (before === undefined && source !== producer) coldTargets += 1;
      }
      const first = current.symbols[0];
      const different = current.symbols[2];
      if (first === undefined || different === undefined) throw new Error("The two distinct native function signatures exist");
      const left = Checker_getTypeOfSymbol(source, first);
      const right = Checker_getTypeOfSymbol(source, different);
      if (left === undefined || right === undefined) throw new Error("Both genuine source values are produced");
      assert.equal(Checker_isTypeIdenticalTo(producer, normalization.type(left), normalization.type(right)), false,
        "different genuine signatures are not selected by a function or method name");
    }
  }
  assert.equal(checkers === 1 ? coldTargets === 0 : coldTargets > 0, true);
});

for (const checkers of [1, 4]) test(`cached function source admission precedes target work with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1);
  const foreignOwner = foreign.owners[0];
  if (foreignOwner === undefined) throw new Error("The foreign Program retains its real owner");
  for (const source of current.owners) {
    const producer = current.owners.find(owner => owner !== source) ?? source;
    const unread = new Proxy(producer, { get(owner, key, receiver) {
      if (key !== "program" && key !== "id") assert.fail("invalid source ownership cannot read a target native cache or query");
      return Reflect.get(owner, key, receiver);
    } });
    for (const symbol of current.symbols) {
      const original = Checker_getTypeOfSymbol(source, symbol);
      if (original === undefined) throw new Error("The real source function value exists");
      const clone = Checker_newAnonymousType(source, symbol, new Map(), [], [], []);
      const copiedSymbol = { ...symbol };
      const copied = Checker_newAnonymousType(source, copiedSymbol, new Map(), [], [], []);
      const transient = Checker_newSymbolEx(source, symbol.Flags, symbol.Name, symbol.CheckFlags);
      if (transient === undefined) throw new Error("The genuine transient native symbol is created");
      const transientType = Checker_newAnonymousType(source, transient, new Map(), [], [], []);
      if (clone === undefined || copied === undefined || transientType === undefined)
        throw new Error("The actual uncached native constructions exist");
      if (original.derivation !== undefined) clone.derivation = original.derivation;
      const transientLinks = LinkStore_Get(source.valueSymbolLinks, transient);
      if (transientLinks === undefined) throw new Error("The actual transient native symbol has its allocated links");
      transientLinks.resolvedType = transientType;
      assert.equal(reacquireCachedValueType(unread, clone), undefined, "same symbol does not admit an uncached native clone");
      assert.equal(reacquireCachedValueType(unread, copied), undefined, "a copied symbol does not own the original cache entry");
      assert.equal(reacquireCachedValueType(unread, transientType), undefined,
        "a transient native symbol is not a shared function binder even with its own cache entry");
      const sourceLinks = LinkStore_Get(source.valueSymbolLinks, symbol);
      if (sourceLinks === undefined) throw new Error("The actual source symbol retains its cached links");
      const retained = sourceLinks.resolvedType;
      try {
        sourceLinks.resolvedType = clone;
        assert.equal(reacquireCachedValueType(unread, original), undefined, "the exact original source cache pointer is required");
      } finally {
        sourceLinks.resolvedType = retained;
      }
      assert.throws(() => reacquireCachedValueType(foreignOwner, original), TypeError);
      if (source !== producer) {
        const expected = Checker_getTypeOfSymbol(producer, symbol);
        const targetLinks = LinkStore_Get(producer.valueSymbolLinks, symbol);
        if (targetLinks === undefined) throw new Error("The actual target symbol retains its cached links");
        try {
          targetLinks.resolvedType = original;
          assert.throws(() => reacquireCachedValueType(producer, original), TypeError,
            "a target cache cannot hand a source-checker Type into a native target operation");
        } finally {
          targetLinks.resolvedType = expected;
        }
      }
    }
    const foreignSymbol = foreign.symbols[0];
    if (foreignSymbol === undefined) throw new Error("The independent Program has its actual function symbol");
    const foreignType = Checker_getTypeOfSymbol(foreignOwner, foreignSymbol);
    if (foreignType === undefined) throw new Error("The foreign function value is produced");
    assert.throws(() => reacquireCachedValueType(unread, foreignType), TypeError);
    const fresh = Checker_GetTypeAtLocation(source, current.literal);
    if (fresh === undefined) throw new Error("The genuine fresh TypeOnly recursive literal is handed out");
    assert.equal(reacquireCachedValueType(unread, fresh), undefined,
      "the cached method input does not turn its fresh containing literal into a cached function value");
    const selected = createTypeNormalization(producer).type(fresh);
    const actual = Checker_GetTypeAtLocation(producer, current.literal);
    if (actual === undefined) throw new Error("The actual target retains its independent literal handout");
    assert.equal(selected.checker === producer && LiteralCreation.read(selected) !== undefined, true,
      "the fresh containing literal uses its authenticated native creation, not the method's value cache");
    assert.equal(Checker_isTypeIdenticalTo(producer, selected, actual), true);
    if (source !== producer) assert.equal(selected !== fresh, true);
  }
});
