import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { LiteralConstructionOwner, LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import { Checker_checkExpressionCached } from "../internal/checker/checker/syntax-checking.js";
import { Checker_GetTypeAtLocation } from "../internal/checker/checker/types.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { LinkStore_Get, LinkStore_TryGet } from "../internal/core/linkstore.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Type } from "../internal/checker/types.js";
import { reacquireFreshLiteral } from "./type-normalization-fresh-literals.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/publication", includeBundledLibraries: false,
    files: { "/publication/core.d.ts": testCoreDeclarations,
      "/publication/use.ts": "declare function identity<T>(value:T):T;declare const Constructor:{new<T>(value:T):T};"
        + "export const call=identity({call:1});export const construct=new Constructor({construct:2});"
        + "export const awaited=await {awaited:3};",
      "/publication/other.ts": "export const other=1;", "/publication/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, noCheck: true, checkers } });
  const checked = session.checkSource();
  const program = session.program;
  const file = checked.getSourceFile("/publication/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual unchecked query fixture retains its native Program");
  const view = checked.getSourceFileQueries(file);
  const calls = findNodes(file, view.ast.children, node => view.ast.is.IsCallExpression(node) || view.ast.is.IsNewExpression(node));
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  assert.equal(calls.length, 2);
  assert.equal(createCompilerSessionFromProgram(program, session.host, session.config).program === program, true);
  const literals = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression);
  const awaits = findNodes(file, view.ast.children, view.ast.is.IsAwaitExpression);
  return { owners, calls, literals, awaits };
}

for (const checkers of [1, 4]) test(`cached native call questions retain actual argument creation publication with ${checkers} checkers`, () => {
  const { owners, calls } = fixture(checkers);
  for (const source of owners) for (const call of calls) {
    assert.equal(LinkStore_TryGet(source.signatureLinks, call)?.resolvedSignature === undefined, true);
    const root = Checker_checkExpressionCached(source, call);
    const links = LinkStore_TryGet(source.typeNodeLinks, call);
    const evidence = LinkStore_TryGet(source.signatureLinks, call)?.resolvedCallSelectionEvidence;
    if (root === undefined || links === undefined || evidence?.kind !== "applicable"
      || evidence.selection.arguments.kind !== "available")
      throw new Error("The actual native call question retains its completed result and checked arguments");
    const selected: Type | undefined = evidence.selection.arguments.values[0]?.selectedArgumentType;
    const creation = selected === undefined ? undefined : LiteralCreation.read(selected);
    assert.equal(creation?.owner !== undefined, true, "The actual cached call must forward its construction owner to the checked argument");
    if (creation?.owner === undefined || selected === undefined) throw new Error("The actual checked argument retains its publication owner");
    const publication = LiteralConstructionOwner.read(creation.owner, source);
    assert.equal(publication !== undefined && publication.node === call && publication.root === root, true);
    const unchanged = Checker_checkExpressionCached(source, call);
    assert.equal(unchanged === root && LiteralCreation.read(selected)?.owner === creation.owner, true,
      "An actual native cache hit creates no replacement construction owner");
    const saved = links.resolvedType;
    try {
      links.resolvedType = source.unknownType;
      const target = new Proxy(source, { get() { assert.fail("A changed original publication is rejected before target access"); } });
      assert.throws(() => reacquireFreshLiteral(target, selected,
        () => assert.fail("A changed original publication cannot normalize dependencies"), new Map()), TypeError);
    } finally { links.resolvedType = saved; }
    assert.equal(LiteralConstructionOwner.read(creation.owner, source)?.root === root, true);
  }
});

for (const checkers of [1, 4]) test(`native cached literal publications reject cleared, replaced and incomplete owners with ${checkers} checkers`, () => {
  const { owners, literals } = fixture(checkers);
  const literal = literals[0];
  if (literal === undefined) throw new Error("The actual call retains its authored literal argument");
  for (const source of owners) {
    const root = Checker_checkExpressionCached(source, literal);
    const links = LinkStore_TryGet(source.typeNodeLinks, literal);
    const creation = root === undefined ? undefined : LiteralCreation.read(root);
    if (root === undefined || links === undefined || creation?.owner === undefined)
      throw new Error("The actual cached literal retains its completed publication");
    const saved = links.resolvedType;
    const reject = () => {
      const unread = new Proxy(source, { get() { assert.fail("Source publication admission precedes every target read"); } });
      assert.equal(LiteralConstructionOwner.read(creation.owner!, source) === undefined, true);
      assert.throws(() => reacquireFreshLiteral(unread, root,
        () => assert.fail("An invalid publication cannot normalize dependencies"), new Map()), TypeError);
    };
    try { links.resolvedType = undefined; reject(); } finally { links.resolvedType = saved; }
    try { source.typeNodeLinks.entries.set(literal, { ...links }); reject(); }
    finally { source.typeNodeLinks.entries.set(literal, links); }
    try { source.typeNodeLinks.entries.delete(literal); reject(); }
    finally { source.typeNodeLinks.entries.set(literal, links); }
    assert.equal(LiteralConstructionOwner.read(creation.owner, source)?.root === root, true);
  }

  const current = fixture(checkers);
  const source = current.owners[0];
  const node = current.literals[0];
  if (source === undefined || node === undefined) throw new Error("The actual incomplete question has its checker and node");
  const links = LinkStore_Get(source.typeNodeLinks, node);
  if (links === undefined) throw new Error("The actual cache-miss question retains its native link record");
  const original = new Error("the actual native cache publication failed");
  const descriptor = Object.getOwnPropertyDescriptor(links, "resolvedType");
  let unpublished: Type | undefined;
  const stack = source.flowLoopStack;
  const flow = source.flowTypeCache;
  Object.defineProperty(links, "resolvedType", { configurable: true, get() { return undefined; },
    set(value: Type | undefined) { unpublished = value; throw original; } });
  try { assert.throws(() => Checker_checkExpressionCached(source, node), error => error === original); }
  finally {
    if (descriptor === undefined) Object.defineProperty(links, "resolvedType",
      { configurable: true, enumerable: true, writable: true, value: undefined });
    else Object.defineProperty(links, "resolvedType", descriptor);
  }
  const creation = unpublished === undefined ? undefined : LiteralCreation.read(unpublished);
  if (unpublished === undefined || creation?.owner === undefined)
    throw new Error("The real failing publication retains its actual unpublished native output");
  const failed = unpublished;
  assert.equal(LiteralConstructionOwner.read(creation.owner, source) === undefined, true);
  const unread = new Proxy(source, { get() { assert.fail("An incomplete publication cannot inspect the target"); } });
  assert.throws(() => reacquireFreshLiteral(unread, failed,
    () => assert.fail("An incomplete publication cannot normalize inputs"), new Map()), TypeError);
  assert.equal(source.flowLoopStack === stack && source.flowTypeCache === flow, true,
    "A failed actual publication restores its native transient flow scope");
});

for (const checkers of [1, 4]) test(`unchanged call publications preserve genuinely unretained and independent creations with ${checkers} checkers`, () => {
  const { owners, calls, literals } = fixture(checkers);
  for (const source of owners) for (const call of calls) {
    const root = Checker_checkExpressionCached(source, call);
    const evidence = LinkStore_TryGet(source.signatureLinks, call)?.resolvedCallSelectionEvidence;
    if (root === undefined || evidence?.kind !== "applicable" || evidence.selection.arguments.kind !== "available")
      throw new Error("The actual cached question retains its result and argument evidence");
    const selected = evidence.selection.arguments.values[0]?.selectedArgumentType;
    const creation = selected === undefined ? undefined : LiteralCreation.read(selected);
    if (selected === undefined || creation?.owner === undefined)
      throw new Error("The genuine argument retains its completed construction question");
    assert.equal(selected !== root, true, "The actual argument is not the call's separately retained result");
    for (const target of owners) {
      const normalization = createTypeNormalization(target);
      const cached = LinkStore_TryGet(target.signatureLinks, call)?.resolvedSignature;
      const result = normalization.type(selected);
      assert.equal(result.checker === target && normalization.type(selected) === result, true);
      assert.equal(LinkStore_TryGet(target.signatureLinks, call)?.resolvedSignature === cached, true,
        "An unretained genuine construction does not replay the target call");
      if (target === source) assert.equal(result === selected, true);
      const expectedRoot = Checker_checkExpressionCached(target, call);
      const expected = LinkStore_TryGet(target.signatureLinks, call)?.resolvedCallSelectionEvidence;
      if (expectedRoot === undefined || expected?.kind !== "applicable" || expected.selection.arguments.kind !== "available")
        throw new Error("The target's independent native query retains its actual argument");
      const argument = expected.selection.arguments.values[0]?.selectedArgumentType;
      if (argument === undefined) throw new Error("The native argument vector is dense");
      assert.equal(Checker_isTypeIdenticalTo(target, result, argument), true);
    }
  }
  for (const source of owners) for (const literal of literals) {
    const cached = Checker_checkExpressionCached(source, literal);
    const cachedCreation = cached === undefined ? undefined : LiteralCreation.read(cached);
    const direct = Checker_GetTypeAtLocation(source, literal);
    const directCreation = direct === undefined ? undefined : LiteralCreation.read(direct);
    if (cachedCreation?.owner === undefined || directCreation === undefined)
      throw new Error("Both native literal lifetime categories retain authenticated creations");
    assert.equal(directCreation.owner === undefined && direct !== cached, true,
      "An independent TypeOnly query cannot inherit an earlier normal construction question");
    assert.equal(LiteralConstructionOwner.read(cachedCreation.owner, source)?.root === cached, true);
  }
});

for (const checkers of [1, 4]) test(`await preserves its actual result construction question with ${checkers} checkers`, () => {
  const { owners, awaits } = fixture(checkers);
  const node = awaits[0];
  if (node === undefined) throw new Error("The native fixture retains its actual await expression");
  for (const source of owners) {
    const root = Checker_checkExpressionCached(source, node);
    const creation = root === undefined ? undefined : LiteralCreation.read(root);
    assert.equal(creation?.owner !== undefined, true,
      "An await whose native result is its literal operand retains the actual outer publication");
    if (root === undefined || creation?.owner === undefined)
      throw new Error("The native awaited literal retains its completed construction question");
    assert.equal(LiteralConstructionOwner.read(creation.owner, source)?.node === node, true);
    for (const target of owners) {
      const result = createTypeNormalization(target).type(root);
      const expected = Checker_checkExpressionCached(target, node);
      if (expected === undefined) throw new Error("The native target await completes");
      assert.equal(result === expected, true, "A cached native await retains canonical target identity");
    }
    const links = LinkStore_TryGet(source.typeNodeLinks, node);
    if (links === undefined) throw new Error("The actual native await has its published link");
    const saved = links.resolvedType;
    try {
      links.resolvedType = source.unknownType;
      const unread = new Proxy(source, { get() { assert.fail("Await source admission precedes every target read"); } });
      assert.throws(() => reacquireFreshLiteral(unread, root,
        () => assert.fail("An invalid await publication cannot normalize inputs"), new Map()), TypeError);
    } finally { links.resolvedType = saved; }
  }
});
