import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { Node_Name } from "../internal/ast/spine.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_getSymbolOfDeclaration, Checker_getTypeOfSymbol, Checker_newSymbolEx } from "../internal/checker/checker/symbols.js";
import { Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { LinkStore_Get, LinkStore_TryGet } from "../internal/core/linkstore.js";
import { reacquireCachedFunctionType, reacquireCachedLateBoundSymbol } from "./type-normalization-declarations.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/late-symbols", includeBundledLibraries: false,
    files: { "/late-symbols/core.d.ts": testCoreDeclarations,
      "/late-symbols/use.ts": `declare const key:unique symbol;
        const property={[key]:1};
        const object={[key](value:number){return value;}};
        const accessor={get [key](){return "yes";},set [key](value:string){}};
        class Box{[key](value:boolean){return value;}static [key](){return true;}}
        export {property,object,accessor,Box};`,
      "/late-symbols/other.ts": "export const other=1;", "/late-symbols/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const program = session.program;
  const file = checked.getSourceFile("/late-symbols/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual late-bound declarations retain their Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, node => {
    const name = Node_Name(node);
    return name !== undefined && view.ast.is.IsComputedPropertyName(name);
  });
  assert.equal(declarations.length, 6);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { declarations, owners, view };
}

for (const checkers of [1, 4]) test(`late-bound symbol counterparts retain both actual caches with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  let coldTargets = 0;
  for (const source of current.owners) for (const producer of current.owners) {
    const normalization = createTypeNormalization(producer);
    const sourceReadOnly = new Proxy(source, { get(owner, key, receiver) {
      if (key === "typeNodeLinks" || key === "valueSymbolLinks" || key === "membersAndExportsLinks" || key === "cachedTypes")
        assert.fail("completed source symbol admission cannot evaluate a source type or resolve members");
      return Reflect.get(owner, key, receiver);
    } });
    for (const declarations of [current.declarations, [...current.declarations].reverse()]) {
      for (const declaration of declarations) {
        const early = Node_Symbol(declaration);
        const original = Checker_getSymbolOfDeclaration(source, declaration);
        if (early === undefined || original === undefined) throw new Error("The actual early and late symbols exist");
        assert.equal(early.checkerId, undefined);
        assert.equal(original.checkerId === source.id
          && LinkStore_TryGet(source.symbolNodeLinks, declaration)?.resolvedSymbol === original
          && LinkStore_TryGet(source.lateBoundLinks, early)?.lateSymbol === original, true);
        const before = LinkStore_TryGet(producer.symbolNodeLinks, declaration)?.resolvedSymbol;
        const result = reacquireCachedLateBoundSymbol(sourceReadOnly, producer, original);
        const expected = Checker_getSymbolOfDeclaration(producer, declaration);
        assert.equal(result !== undefined && result === expected && result.checkerId === producer.id, true);
        assert.equal(LinkStore_TryGet(producer.symbolNodeLinks, declaration)?.resolvedSymbol === result
          && LinkStore_TryGet(producer.lateBoundLinks, early)?.lateSymbol === result, true);
        assert.equal(reacquireCachedLateBoundSymbol(source, producer, original) === result, true);
        assert.equal((source === producer) === (original === result), true);
        assert.equal(LinkStore_TryGet(source.symbolNodeLinks, declaration)?.resolvedSymbol === original
          && LinkStore_TryGet(source.lateBoundLinks, early)?.lateSymbol === original, true);
        if (before === undefined && source !== producer) coldTargets += 1;
        if (current.view.ast.is.IsMethodDeclaration(declaration)) {
          const input = Checker_getTypeOfSymbol(source, original);
          if (input === undefined || result === undefined) throw new Error("The actual method retains its cached function value");
          const normalized = normalization.type(input);
          const expectedType = Checker_getTypeOfSymbol(producer, result);
          assert.equal(normalized === expectedType && normalized.checker === producer && normalized.symbol === result, true);
          assert.equal(reacquireCachedFunctionType(producer, input) === expectedType, true);
          assert.equal(normalization.type(input) === normalized, true);
        }
      }
    }
    const getter = current.declarations[2];
    const setter = current.declarations[3];
    if (getter === undefined || setter === undefined) throw new Error("Both genuine accessor declarations exist");
    assert.equal(Checker_getSymbolOfDeclaration(source, getter) === Checker_getSymbolOfDeclaration(source, setter), true,
      "the native merged getter/setter has one actual source symbol, not a declaration ordinal");
    assert.equal(Checker_getSymbolOfDeclaration(producer, getter) === Checker_getSymbolOfDeclaration(producer, setter), true);
  }
  assert.equal(checkers === 1 ? coldTargets === 0 : coldTargets > 0, true);
});

for (const checkers of [1, 4]) test(`late-bound source ownership rejects copies before target access with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1);
  const foreignOwner = foreign.owners[0];
  const foreignDeclaration = foreign.declarations[0];
  if (foreignOwner === undefined || foreignDeclaration === undefined) throw new Error("The independent Program has its actual owner and declaration");
  for (const source of current.owners) {
    const producer = current.owners.find(owner => owner !== source) ?? source;
    const unread = new Proxy(producer, { get(owner, key, receiver) {
      if (key !== "program" && key !== "id") assert.fail("an unowned source symbol cannot access any target cache or native query");
      return Reflect.get(owner, key, receiver);
    } });
    for (const declaration of current.declarations) {
      const original = Checker_getSymbolOfDeclaration(source, declaration);
      const actual = original?.ValueDeclaration;
      const early = actual === undefined ? undefined : Node_Symbol(actual);
      if (original === undefined || actual === undefined || early === undefined) throw new Error("The actual symbol retains its precise owning declaration");
      const nodeLinks = LinkStore_Get(source.symbolNodeLinks, actual);
      const lateLinks = LinkStore_Get(source.lateBoundLinks, early);
      if (nodeLinks === undefined || lateLinks === undefined) throw new Error("Both actual source cache records exist");
      const clone = Checker_newSymbolEx(source, original.Flags, original.Name, original.CheckFlags);
      if (clone === undefined) throw new Error("The native uncached symbol clone exists");
      clone.ValueDeclaration = actual;
      clone.Declarations = original.Declarations;
      clone.Parent = original.Parent;
      assert.equal(reacquireCachedLateBoundSymbol(source, unread, clone), undefined);
      assert.equal(reacquireCachedLateBoundSymbol(source, unread, { ...original }), undefined,
        "copied fields cannot borrow either native cache's actual source pointer");
      clone.ValueDeclaration = foreignDeclaration;
      assert.equal(reacquireCachedLateBoundSymbol(source, unread, clone), undefined,
        "a same-URI foreign declaration cannot join the actual original Program file");
      clone.ValueDeclaration = actual;
      for (const invalid of [undefined, clone]) {
        const retainedNode = nodeLinks.resolvedSymbol;
        try {
          nodeLinks.resolvedSymbol = invalid;
          assert.equal(reacquireCachedLateBoundSymbol(source, unread, original), undefined);
          assert.equal(nodeLinks.resolvedSymbol === invalid, true, "source admission never fills a missing or mismatched declaration cache");
        } finally { nodeLinks.resolvedSymbol = retainedNode; }
        const retainedLate = lateLinks.lateSymbol;
        try {
          lateLinks.lateSymbol = invalid;
          assert.equal(reacquireCachedLateBoundSymbol(source, unread, original), undefined);
          assert.equal(lateLinks.lateSymbol === invalid, true, "source admission never fills a missing or mismatched binder cache");
        } finally { lateLinks.lateSymbol = retainedLate; }
      }
      assert.throws(() => reacquireCachedLateBoundSymbol(foreignOwner, unread, original), TypeError);
      assert.throws(() => reacquireCachedLateBoundSymbol(source, foreignOwner, original), TypeError);
      if (current.view.ast.is.IsMethodDeclaration(declaration)) {
        const input = Checker_getTypeOfSymbol(source, original);
        const uncached = Checker_newAnonymousType(source, original, new Map(), [], [], []);
        const copiedType = Checker_newAnonymousType(source, clone, new Map(), [], [], []);
        if (input === undefined || uncached === undefined || copiedType === undefined) throw new Error("The actual cached method and uncached native objects exist");
        assert.equal(reacquireCachedFunctionType(unread, uncached), undefined);
        const cloneLinks = LinkStore_Get(source.valueSymbolLinks, clone);
        const valueLinks = LinkStore_Get(source.valueSymbolLinks, original);
        if (cloneLinks === undefined || valueLinks === undefined) throw new Error("The actual native value link records exist");
        cloneLinks.resolvedType = copiedType;
        assert.equal(reacquireCachedFunctionType(unread, copiedType), undefined,
          "a symbol-keyed value pointer alone cannot fabricate the two native declaration/binder cache relations");
        const retainedValue = valueLinks.resolvedType;
        try {
          valueLinks.resolvedType = uncached;
          assert.equal(reacquireCachedFunctionType(unread, input), undefined);
        } finally { valueLinks.resolvedType = retainedValue; }
      }
      if (source !== producer) {
        const target = Checker_getSymbolOfDeclaration(producer, actual);
        const targetNode = LinkStore_Get(producer.symbolNodeLinks, actual);
        const targetLate = LinkStore_Get(producer.lateBoundLinks, early);
        const targetClone = Checker_newSymbolEx(producer, original.Flags, original.Name, original.CheckFlags);
        if (target === undefined || targetNode === undefined || targetLate === undefined || targetClone === undefined)
          throw new Error("The actual target symbol and both target cache records exist");
        try {
          targetNode.resolvedSymbol = targetClone;
          assert.throws(() => reacquireCachedLateBoundSymbol(source, producer, original), TypeError);
        } finally { targetNode.resolvedSymbol = target; }
        try {
          targetLate.lateSymbol = targetClone;
          assert.throws(() => reacquireCachedLateBoundSymbol(source, producer, original), TypeError);
        } finally { targetLate.lateSymbol = target; }
        try {
          targetNode.resolvedSymbol = original;
          targetLate.lateSymbol = original;
          assert.throws(() => reacquireCachedLateBoundSymbol(source, producer, original), TypeError,
            "even two agreeing target cache pointers cannot import another checker's actual symbol");
        } finally { targetNode.resolvedSymbol = target; targetLate.lateSymbol = target; }
      }
    }
  }
});
