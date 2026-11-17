import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { CheckModeNormal, CheckModeTypeOnly } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionCached, Checker_checkExpressionEx } from "../internal/checker/checker/syntax-checking.js";
import { Checker_GetTypeAtLocation, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { Checker_getStringLiteralType } from "../internal/checker/checker/types.js";
import { Checker_getIndexedAccessType } from "../internal/checker/checker/symbols.js";
import { Checker_getTypeAliasInstantiation } from "../internal/checker/checker/inference.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { Type_AsStructuredType, ObjectFlagsJSLiteral, ObjectFlagsCouldContainTypeVariablesComputed } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireFreshLiteral } from "./type-normalization-fresh-literals.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/fresh-literals", includeBundledLibraries: false,
    files: { "/fresh-literals/core.d.ts": testCoreDeclarations,
      "/fresh-literals/use.ts": `declare const key:unique symbol;
        export const plain={a:1}; export const other={a:"different"};
        export const nested={outer:{inner:2}};
        export const computed={[key]:true,method(){return plain;}};
        export const accessors={get value():number{return 1;},set value(next:number){}};
        export const indexed={ ["wide" as string]:3 };
        export const method={recursive(){return this;}};
        export class Box<T>{value!:T;} declare const instance:Box<string>;
        export enum Tag{First,Second}
        type Alias={tag:string}; declare const aliasValue:Alias;
        type Wrap<T>={value:T};
        export const inputs={instance,constructor:Box,enumValue:Tag,enumMember:Tag.First,aliasValue};`,
      "/fresh-literals/other.ts": "export const other=1;", "/fresh-literals/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true, "the actual fresh-family source checks without diagnostics");
  const program = session.program;
  const file = checked.getSourceFile("/fresh-literals/use.ts");
  if (program === undefined || file === undefined) throw new Error("The real source retains its Program and file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression);
  assert.equal(nodes.length, 9);
  const aliases = findNodes(file, view.ast.children, view.ast.is.IsTypeAliasDeclaration);
  const wrap = aliases[1] === undefined ? undefined : Node_Symbol(aliases[1]);
  if (wrap === undefined) throw new Error("The actual generic wrapper alias has its real binder");
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual source checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers, "the fixture actually creates the requested native pool");
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  return { owners, nodes, wrap };
}

for (const checkers of [1, 4]) test(`actual fresh literal handouts retain native factory inputs with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  let differentCreations = 0;
  for (const source of current.owners) {
    const inputs = current.nodes.map((node, position) => {
      const first = Checker_GetTypeAtLocation(source, node);
      const second = Checker_GetTypeAtLocation(source, node);
      if (first === undefined || second === undefined) throw new Error("Both actual TypeOnly handouts complete");
      assert.equal(LiteralCreation.read(first)?.mode === CheckModeTypeOnly, true,
        `native literal ${position}: ids=${first.id}/${second.id}; kinds=${first.derivation?.kind}/${second.derivation?.kind}`);
      if (first === second) assert.equal(source.flowTypeCache?.get(node) === first, true,
        "a native flow-producing question retains its actual completed flow cache instead of manufacturing freshness");
      if (position === 0) assert.equal(first !== second, true,
        "the actual plain-literal query remains intrinsically fresh with no permanent cache");
      return { node, first, second };
    });
    for (const producer of current.owners) for (const order of [inputs, [...inputs].reverse()]) {
      const normalization = createTypeNormalization(producer);
      const sourceLinks = new Map(source.typeNodeLinks.entries);
      for (const { node, first, second } of order) {
        const record = first.derivation;
        const result = normalization.type(first);
        const other = normalization.type(second);
        assert.equal(result.checker === producer && normalization.type(first) === result && (first === second ? result === other : result !== other), true,
          "one invocation memo preserves actual cached inputs and keeps independent creations distinct");
        assert.equal(source === producer ? result === first && other === second : result !== first && other !== second, true);
        const actual = Checker_GetTypeAtLocation(producer, node);
        if (actual === undefined) throw new Error("The independent native target handout completes");
        assert.equal(Checker_isTypeIdenticalTo(producer, result, actual), true,
          "fresh target allocation retains native semantic equality with the actual target query");
        const creation = LiteralCreation.read(result);
        if (creation === undefined) throw new Error("The target native factory authenticates its own completed output");
        assert.equal(creation.mode, CheckModeTypeOnly);
        for (const member of creation.inputs().members) {
          assert.equal(member.symbol.checkerId === undefined || member.symbol.checkerId === producer.id, true);
          if (member.value !== undefined) assert.equal(member.value.checker === producer, true);
          if (member.nameType !== undefined) assert.equal(member.nameType.checker === producer, true);
        }
        for (const index of creation.inputs().indexes)
          assert.equal(index.keyType?.checker === producer && index.valueType?.checker === producer, true);
        assert.equal(first.derivation === record, true, "normalization never overwrites original native provenance");
        differentCreations++;
      }
      if (source !== producer) {
        assert.equal(source.typeNodeLinks.entries.size, sourceLinks.size);
        for (const [node, links] of sourceLinks) assert.equal(source.typeNodeLinks.entries.get(node) === links, true,
          "normalization does not replay or rewrite source expression queries");
      }
    }
  }
  assert.equal(differentCreations > 0, true);
});

for (const checkers of [1, 4]) test(`fresh literal capabilities cannot be copied or retargeted with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent foreign Program exists");
  for (const source of current.owners) for (const producer of current.owners) {
    const node = current.nodes[0];
    if (node === undefined) throw new Error("The genuine literal source exists");
    const value = Checker_checkExpressionEx(source, node, CheckModeTypeOnly);
    if (value?.derivation?.kind !== "object-literal") throw new Error("The actual native creation authenticates its Type");
    const record = value.derivation;
    const clone = Checker_newAnonymousType(source, value.symbol, new Map(), [], [], []);
    if (clone === undefined) throw new Error("The independent anonymous output exists");
    const unread = new Proxy(producer, { get() { assert.fail("invalid source creation must fail before any target access"); } });
    clone.derivation = record;
    assert.equal(LiteralCreation.read(clone), undefined);
    assert.throws(() => reacquireFreshLiteral(unread, clone, () => assert.fail("no invalid input normalization"), new Map()), TypeError);
    value.derivation = { kind: "object-literal", creation: Object.assign({}, record.creation) };
    try {
      assert.equal(LiteralCreation.read(value), undefined);
      assert.throws(() => reacquireFreshLiteral(unread, value, () => assert.fail("no forged input normalization"), new Map()), TypeError);
    } finally { value.derivation = record; }
    const members = Type_AsStructuredType(value)?.members;
    const member = members?.values().next().value;
    const links = member === undefined ? undefined : LinkStore_TryGet(source.valueSymbolLinks, member);
    if (links === undefined) throw new Error("The actual native wrapper retains its final value input");
    const original = links.resolvedType;
    try {
      links.resolvedType = foreign.stringType;
      assert.equal(LiteralCreation.read(value), undefined);
      assert.throws(() => reacquireFreshLiteral(unread, value, () => assert.fail("no crossed wrapper normalization"), new Map()), TypeError);
    } finally { links.resolvedType = original; }
    assert.throws(() => createTypeNormalization(foreign).type(value), TypeError);
    const copiedInputs = LiteralCreation.read(value)!.inputs();
    Reflect.set(copiedInputs, "flags", 0);
    assert.equal(LiteralCreation.read(value)!.inputs().flags === value.objectFlags, true,
      "a caller's input snapshot cannot mutate the authenticated private construction");
    const actualView = LiteralCreation.read(value);
    if (actualView === undefined) throw new Error("The genuine output retains its private factory capability");
    Object.assign(record.creation, { node: undefined, mode: undefined,
      inputs: () => assert.fail("A capability's caller-installed input method is not authority"),
      creator: () => assert.fail("A capability's caller-installed creator method is not authority") });
    const privateView = LiteralCreation.read(value);
    if (privateView === undefined) throw new Error("Caller-shadowed methods cannot replace the genuine private-slot view");
    assert.equal(privateView?.capability === record.creation && privateView.node === actualView.node
      && privateView.mode === actualView.mode, true);
    assert.deepEqual(privateView.inputs(), actualView.inputs());
    assert.deepEqual(privateView.creator, actualView.creator);
    const flags = value.objectFlags;
    try {
      value.objectFlags ^= ObjectFlagsJSLiteral;
      assert.throws(() => reacquireFreshLiteral(unread, value, () => assert.fail("no corrupted factory flags"), new Map()), TypeError);
      value.objectFlags = flags | ObjectFlagsCouldContainTypeVariablesComputed;
      assert.equal(LiteralCreation.read(value)?.capability === record.creation, true,
        "genuine lazy native computation bits do not replace retained factory semantics");
    } finally { value.objectFlags = flags; }
    try {
      source.patternForType.set(value, node);
      assert.throws(() => reacquireFreshLiteral(unread, value, () => assert.fail("no crossed pattern association"), new Map()), TypeError);
    } finally { source.patternForType.delete(value); }
  }
});

for (const checkers of [1, 4]) test(`every fresh input source cache is admitted before a valid earlier member touches P with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  for (const source of current.owners) for (const producer of current.owners) {
    const node = current.nodes[4];
    if (node === undefined) throw new Error("The actual computed-key literal with its second method exists");
    const value = Checker_checkExpressionEx(source, node, CheckModeTypeOnly);
    const creation = value === undefined ? undefined : LiteralCreation.read(value);
    if (value === undefined || creation === undefined) throw new Error("The real completed factory retains its source creation");
    const members = creation.inputs().members;
    assert.equal(members.length, 2);
    const target = members[1]?.target;
    if (target === undefined) throw new Error("The second actual method retains its target symbol");
    const links = source.valueSymbolLinks.entries.get(target);
    if (links === undefined) throw new Error("The genuine method has its actual completed source cache");
    const unread = new Proxy(producer, { get() { assert.fail("ALL actual source inputs are admitted before ANY P access"); } });
    try {
      source.valueSymbolLinks.entries.delete(target);
      assert.throws(() => reacquireFreshLiteral(unread, value, () => assert.fail("no target normalization before full source admission"), new Map()), TypeError);
    } finally { source.valueSymbolLinks.entries.set(target, links); }
  }
});

for (const checkers of [1, 4]) test(`fresh factory inputs retain declared instances, native values and alias/index consumers with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  for (const source of current.owners) for (const producer of current.owners) {
    const node = current.nodes[8];
    if (node === undefined) throw new Error("The actual instance/constructor/enum/alias literal exists");
    const value = Checker_GetTypeAtLocation(source, node);
    if (value === undefined) throw new Error("The real source factory finishes its input vector");
    const normalization = createTypeNormalization(producer);
    const selected = normalization.type(value);
    const creation = LiteralCreation.read(value);
    if (creation === undefined) throw new Error("The genuine native factory authenticates its complete input vector");
    for (const member of creation.inputs().members) {
      if (member.value === undefined) throw new Error("The real shorthand member retains its actual type input");
      const key = Checker_getStringLiteralType(producer, member.symbol.Name);
      const indexed = Checker_getIndexedAccessType(producer, selected, key);
      assert.equal(indexed === normalization.type(member.value), true,
        "an instance, constructor, enum or alias uses its own native producer rather than the declaration's symbol category");
    }
    const alias = Checker_getTypeAliasInstantiation(source, current.wrap, [value], undefined);
    const expected = Checker_getTypeAliasInstantiation(producer, current.wrap, [selected], undefined);
    if (alias === undefined || expected === undefined) throw new Error("Both native aliases retain their actual constructor inputs");
    assert.equal(normalization.type(alias) === expected, true);
    const repeated = createTypeNormalization(producer).type(value);
    assert.equal(source === producer ? repeated === value : repeated !== selected, true,
      "independent normalization invocations do not add a permanent fresh-type cache");
    assert.equal(Checker_isTypeIdenticalTo(producer, repeated, selected), true);
  }
});

for (const checkers of [1, 4]) test(`uncached normal literals and cold accessors preserve their genuine source lifetime with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  for (const source of current.owners) for (const producer of current.owners) {
    const node = current.nodes[0];
    const accessor = current.nodes[5];
    if (node === undefined || accessor === undefined) throw new Error("Actual plain and accessor literals exist");
    const cached = Checker_checkExpressionCached(source, node);
    const fresh = Checker_checkExpressionEx(source, node, CheckModeNormal);
    const value = Checker_checkExpressionEx(source, accessor, CheckModeTypeOnly);
    if (cached === undefined || fresh === undefined || value === undefined) throw new Error("The actual native questions complete");
    const normalization = createTypeNormalization(producer);
    const selectedFresh = normalization.type(fresh);
    const selectedCached = normalization.type(cached);
    assert.equal(selectedCached === (source === producer ? cached : Checker_checkExpressionCached(producer, node)), true);
    assert.equal(selectedFresh !== selectedCached && normalization.type(fresh) === selectedFresh, true);
    const before = new Map(source.valueSymbolLinks.entries);
    assert.equal(normalization.type(value).checker === producer, true);
    for (const [symbol, links] of before) assert.equal(source.valueSymbolLinks.entries.get(symbol) === links, true);
  }
});
