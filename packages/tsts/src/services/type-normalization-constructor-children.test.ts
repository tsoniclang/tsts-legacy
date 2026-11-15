import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Type } from "../internal/checker/types.js";
import { Type_Types, TypeFlagsObject, TypeFlagsIntersection } from "../internal/checker/types.js";
import { Checker_getDeclaredTypeOfSymbol, Checker_getSymbolOfDeclaration, Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_GetTypeAtLocation, Checker_newAnonymousType, Checker_newIntersectionType } from "../internal/checker/checker/types.js";
import { LinkStore_Get, LinkStore_TryGet } from "../internal/core/linkstore.js";
import { reacquireCachedValueType } from "./type-normalization-declarations.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/constructor-children", includeBundledLibraries: false,
    files: { "/constructor-children/core.d.ts": testCoreDeclarations,
      "/constructor-children/use.ts": `export function mix<T extends new (...args:any[])=>object>(Base:T){
        const Left=class extends Base{static marker=1;};
        const Right=class extends Base{static marker=1;};return {Left,Right};}`,
      "/constructor-children/other.ts": "export const other=1;", "/constructor-children/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const program = session.program;
  const file = checked.getSourceFile("/constructor-children/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual generic constructor retains its Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, view.ast.is.IsClassExpression);
  assert.equal(declarations.length, 2);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker inventory is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { declarations, owners };
}

function childOf(value: Type, symbol: Type["symbol"]) {
  const children = Type_Types(value).filter(child => child !== undefined && child.symbol === symbol && (child.flags & TypeFlagsObject) !== 0);
  assert.equal(children.length, 1);
  const child = children[0];
  if (child === undefined) throw new Error("The actual cached constructor owns its child");
  return child;
}

for (const checkers of [1, 4]) test(`cached generic-class constructors retain their actual child with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  let coldTargets = 0;
  for (const source of current.owners) for (const producer of current.owners) {
    const normalization = createTypeNormalization(producer);
    const children = new Set<Type>();
    for (const declarations of [current.declarations, [...current.declarations].reverse()]) {
      for (const declaration of declarations) {
        const symbol = Checker_getSymbolOfDeclaration(source, declaration);
        const root = symbol === undefined ? undefined : Checker_getTypeOfSymbol(source, symbol);
        if (symbol === undefined || root === undefined) throw new Error("The source class symbol owns its actual cached constructor");
        assert.equal((root.flags & TypeFlagsIntersection) !== 0 && Checker_GetTypeAtLocation(source, declaration) === root
          && LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType === root, true);
        const child = childOf(root, symbol);
        assert.equal(child !== root && child.checker === source, true);
        const before = LinkStore_TryGet(producer.valueSymbolLinks, symbol)?.resolvedType;
        const result = normalization.type(child);
        const targetRoot = Checker_getTypeOfSymbol(producer, symbol);
        if (targetRoot === undefined) throw new Error("The target native constructor is cached");
        assert.equal(result === childOf(targetRoot, symbol) && result.checker === producer, true);
        assert.equal(normalization.type(root) === targetRoot, true, "the whole intersection consumes its actual native constructor child");
        assert.equal(reacquireCachedValueType(producer, child) === result && normalization.type(child) === result, true);
        assert.equal(LinkStore_TryGet(source.valueSymbolLinks, symbol)?.resolvedType === root, true);
        assert.equal((source === producer) === (result === child), true);
        const instance = Checker_getDeclaredTypeOfSymbol(source, symbol);
        assert.equal(instance !== child && instance !== undefined, true);
        if (instance === undefined) throw new Error("The independent class instance type exists");
        assert.equal(reacquireCachedValueType(producer, instance), undefined, "the class instance is not its cached constructor child");
        if (source !== producer && before === undefined) coldTargets += 1;
        children.add(result);
      }
    }
    assert.equal(children.size, 2, "two same-shaped classes with the same base retain their different actual class symbols");
  }
  assert.equal(checkers === 1 ? coldTargets === 0 : coldTargets > 0, true);
});

for (const checkers of [1, 4]) test(`constructor children require exact whole-cache source ownership before target work with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1);
  const foreignOwner = foreign.owners[0];
  if (foreignOwner === undefined) throw new Error("The genuine other Program retains its checker");
  const foreignDeclaration = foreign.declarations[0];
  const foreignSymbol = foreignDeclaration === undefined ? undefined : Checker_getSymbolOfDeclaration(foreignOwner, foreignDeclaration);
  const foreignRoot = foreignSymbol === undefined ? undefined : Checker_getTypeOfSymbol(foreignOwner, foreignSymbol);
  if (foreignRoot === undefined) throw new Error("The genuine other Program retains its cached constructor");
  for (const source of current.owners) {
    const producer = current.owners.find(owner => owner !== source) ?? source;
    const unread = new Proxy(producer, { get(owner, key, receiver) {
      if (key !== "program" && key !== "id") assert.fail("an unowned constructor child cannot read a target cache or query");
      return Reflect.get(owner, key, receiver);
    } });
    const roots = current.declarations.map(declaration => {
      const symbol = Checker_getSymbolOfDeclaration(source, declaration);
      const root = symbol === undefined ? undefined : Checker_getTypeOfSymbol(source, symbol);
      if (symbol === undefined || root === undefined) throw new Error("Both distinct actual class constructors exist");
      return { symbol, root, child: childOf(root, symbol) };
    });
    for (const current of roots) {
      const sourceLinks = LinkStore_Get(source.valueSymbolLinks, current.symbol);
      if (sourceLinks === undefined) throw new Error("The actual constructor retains its completed cache");
      const clone = Checker_newAnonymousType(source, current.symbol, new Map(), [], [], []);
      const copiedSymbol = { ...current.symbol };
      const copied = Checker_newAnonymousType(source, copiedSymbol, new Map(), [], [], []);
      if (clone === undefined || copied === undefined) throw new Error("The native uncached constructor children exist");
      assert.equal(reacquireCachedValueType(unread, clone), undefined);
      assert.equal(reacquireCachedValueType(unread, { ...current.child }), undefined);
      assert.equal(reacquireCachedValueType(unread, copied), undefined);
      const other = roots.find(value => value.symbol !== current.symbol);
      if (other === undefined) throw new Error("The independent same-shaped constructor exists");
      const duplicate = Checker_newIntersectionType(source, current.root.objectFlags, [current.child, current.child]);
      if (duplicate === undefined) throw new Error("The malformed native duplicate constructor owner exists");
      for (const invalid of [undefined, source.stringType, other.root, duplicate, foreignRoot]) {
        try {
          sourceLinks.resolvedType = invalid;
          assert.equal(reacquireCachedValueType(unread, current.child), undefined);
          assert.equal(sourceLinks.resolvedType === invalid, true, "source admission never repairs or rechecks the whole constructor cache");
        } finally { sourceLinks.resolvedType = current.root; }
      }
      assert.throws(() => reacquireCachedValueType(foreignOwner, current.child), TypeError);
      if (source !== producer) {
        const targetRoot = Checker_getTypeOfSymbol(producer, current.symbol);
        const targetLinks = LinkStore_Get(producer.valueSymbolLinks, current.symbol);
        if (targetRoot === undefined || targetLinks === undefined) throw new Error("The actual target whole constructor cache exists");
        const targetChild = childOf(targetRoot, current.symbol);
        const otherTarget = Checker_getTypeOfSymbol(producer, other.symbol);
        const duplicateTarget = Checker_newIntersectionType(producer, targetRoot.objectFlags, [targetChild, targetChild]);
        if (duplicateTarget === undefined || otherTarget === undefined) throw new Error("The malformed and distinct target constructors exist");
        for (const invalid of [current.root, producer.stringType, duplicateTarget, otherTarget]) {
          try {
            targetLinks.resolvedType = invalid;
            assert.throws(() => reacquireCachedValueType(producer, current.child), TypeError);
          } finally { targetLinks.resolvedType = targetRoot; }
        }
        assert.equal(reacquireCachedValueType(producer, current.child) === targetChild, true);
      }
    }
  }
});
