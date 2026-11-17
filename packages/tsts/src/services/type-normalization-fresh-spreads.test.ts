import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Checker_GetTypeAtLocation } from "../internal/checker/checker/types.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import { Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { LinkStore_Get } from "../internal/core/linkstore.js";
import { Type_Types, TypeFlagsUnion } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { reacquireFreshLiteral } from "./type-normalization-fresh-literals.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/fresh-spreads", includeBundledLibraries: false,
    files: { "/fresh-spreads/core.d.ts": testCoreDeclarations,
      "/fresh-spreads/use.ts": `declare const choice:{a:number}|{b:string};declare const maybe:{}|{optional:string};
        export const single={...choice}; export const both={p:1,...choice,q:2};
        export const optional={...choice,...maybe}; export const repeated={...maybe,...maybe};
        export const nested={...{...choice,x:1},...maybe};`,
      "/fresh-spreads/other.ts": "export const other=1;", "/fresh-spreads/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/fresh-spreads/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual spread source retains its Program and file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression);
  assert.equal(nodes.length, 6);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  assert.equal(createCompilerSessionFromProgram(program, session.host, session.config).checkSource().diagnostics.length === 0, true);
  return { owners, nodes };
}

function creations(root: Type): readonly Type[] {
  const pending = [root];
  const seen = new Set<Type>();
  const values: Type[] = [];
  for (const type of pending) {
    if (seen.has(type)) continue;
    seen.add(type);
    const creation = LiteralCreation.read(type);
    if (creation !== undefined) {
      values.push(type);
      const operation = creation.creator;
      if (operation.kind === "literal-merge") pending.push(operation.left, operation.right);
      if (operation.kind === "literal-partial") pending.push(operation.source, operation.other);
    }
    if ((type.flags & TypeFlagsUnion) !== 0) for (const member of Type_Types(type) ?? []) {
      if (member === undefined) throw new Error("The actual native union has dense members");
      pending.push(member);
    }
  }
  return values;
}

for (const checkers of [1, 4]) test(`actual uncached spread constructions retain their native family with ${checkers} checkers`, () => {
  const { owners, nodes } = fixture(checkers);
  for (const source of owners) for (const producer of owners) for (const order of [nodes, [...nodes].reverse()]) {
    const normalization = createTypeNormalization(producer);
    for (const node of order) {
      const original = Checker_GetTypeAtLocation(source, node);
      const expected = Checker_GetTypeAtLocation(producer, node);
      if (original === undefined || expected === undefined) throw new Error("Both actual native spread handouts complete");
      const selected = normalization.type(original);
      assert.equal(selected.checker === producer && normalization.type(original) === selected, true);
      assert.equal(Checker_isTypeIdenticalTo(producer, selected, expected), true,
        "a genuine fresh spread retains its native partial/merge/fragment semantics without a plain-literal disguise");
      if (source === producer) assert.equal(selected === original, true);
    }
  }
});

for (const checkers of [1, 4]) test(`fresh spread deferred values and forged operands retain actual input ownership with ${checkers} checkers`, () => {
  const { owners, nodes } = fixture(checkers);
  const source = owners[0];
  const producer = owners[owners.length - 1];
  const node = nodes[1];
  if (source === undefined || producer === undefined || node === undefined) throw new Error("The actual fixture retains its owners and spread");
  const root = Checker_GetTypeAtLocation(source, node);
  if (root === undefined) throw new Error("The genuine native spread answer completes");
  const values = creations(root);
  const kinds = new Set(values.map(type => LiteralCreation.read(type)?.creator.kind));
  assert.equal(kinds.has("literal-merge"), true);
  const unread = new Proxy(producer, { get() { assert.fail("Full source admission precedes every target read"); } });
  let deferred = 0;
  for (const value of values) {
    const creation = LiteralCreation.read(value);
    if (creation === undefined) throw new Error("Actual spread outputs retain their native capability");
    for (const member of creation.inputs().members) {
      if (member.value === undefined) {
        const resolved = Checker_getTypeOfSymbol(source, member.symbol);
        assert.equal(resolved?.checker === source, true);
        deferred++;
      }
      const links = LinkStore_Get(source.valueSymbolLinks, member.symbol);
      if (links === undefined) throw new Error("An actual native member retains its symbol links");
      const target = links.target;
      try {
        links.target = source.unknownSymbol;
        assert.equal(LiteralCreation.read(value), undefined);
        assert.throws(() => reacquireFreshLiteral(unread, value,
          () => assert.fail("A crossed actual member target cannot normalize operands"), new Map()), TypeError);
      } finally { links.target = target; }
    }
    const copy = Checker_newAnonymousType(source, value.symbol, new Map(), [], [], []);
    if (copy === undefined) throw new Error("The independent native anonymous allocation completes");
    const record = value.derivation;
    if (record === undefined) throw new Error("The actual creation retains its owning record");
    copy.derivation = record;
    assert.equal(LiteralCreation.read(copy), undefined);
    assert.throws(() => reacquireFreshLiteral(unread, copy,
      () => assert.fail("A copied capability cannot normalize an input"), new Map()), TypeError);
  }
  assert.equal(deferred > 0, checkers === 4,
    "The actual cold four-checker input retains deferred values; the checked one-checker input already resolved them");
  const first = createTypeNormalization(producer).type(root);
  const second = createTypeNormalization(producer).type(root);
  assert.equal(first.checker === producer && second.checker === producer, true);
  assert.equal(Checker_isTypeIdenticalTo(producer, first, second), true);
  for (const value of values) assert.equal(LiteralCreation.read(value) !== undefined, true,
    "A completed native property read does not erase its actual factory input relation");
});
