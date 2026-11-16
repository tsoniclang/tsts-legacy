import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Checker_getResolvedSignature } from "../internal/checker/checker/signatures.js";
import { LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import { Checker_getPropertiesOfType, Checker_newAnonymousType, Checker_newObjectType } from "../internal/checker/checker/types.js";
import { cachedReferenceInputs } from "../internal/checker/checker.js";
import { Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { CheckModeNormal, getTypeListKey } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Node } from "../internal/ast/spine.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { ObjectFlagsReference, Type_AsObjectType, Type_AsTypeReference, Type_Target, Type_Types, TypeFlagsUnion } from "../internal/checker/types.js";
import type { ResolvedCallSelectionEvidence, Type, TypeDerivation } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireContextualArgument } from "./type-normalization-contextual-arguments.js";

function fixture(checkers: number, rejected = false) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/arguments", includeBundledLibraries: false,
    files: { "/arguments/core.d.ts": testCoreDeclarations,
      "/arguments/use.ts": `declare function identity<T>(value:T):T;
        declare function pick<T>(value:T[]):T;
        export const direct=identity({n:1}); export const other=identity({n:1});
        export const union=pick([{a:1},{b:2}]);
        export const nested=pick([{a:{x:1}},{a:{y:2}}]);
        export const normal={n:1}; export const shared=identity(normal);
        export const nestedCall=identity(identity({n:2}));
        ${rejected ? "declare function needs<T>(value:T,after:string):T; export const bad=needs({reject:1},false);" : ""}`,
      "/arguments/other.ts": "export const other=1;", "/arguments/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === (rejected ? 1 : 0), true);
  const program = session.program;
  const file = checked.getSourceFile("/arguments/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual contextual call retains its Program and source file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsCallExpression).map(node => {
    if (node === undefined) throw new Error("The actual authored call occurrence vector is dense");
    return node;
  });
  assert.equal(nodes.length, rejected ? 8 : 7);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The native checker pool is dense");
    owners.push(owner);
  }
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === checked.diagnostics.length, true);
  return { owners, nodes };
}

function argument(owner: Checker, at: Node): Type {
  const signature = Checker_getResolvedSignature(owner, at, undefined, CheckModeNormal);
  const evidence = LinkStore_TryGet(owner.signatureLinks, at)?.resolvedCallSelectionEvidence;
  if (evidence?.kind !== "applicable" || evidence.selection.application.instantiatedSignature !== signature)
    throw new Error("The actual completed call has its selected application");
  const result = evidence.selection.application.signatureTypeArguments[0]?.checkedArgument;
  if (result === undefined) throw new Error("The actual selected signature retains its checked argument");
  return result;
}

function members(owner: Checker, type: Type): Type[] {
  if ((type.flags & TypeFlagsUnion) === 0) return [];
  const result: Type[] = [];
  for (const member of Type_Types(type) ?? []) {
    if (member === undefined) throw new Error("The actual inferred union retains every member");
    result.push(member);
    const property = Checker_getPropertiesOfType(owner, member)?.find(value => value?.Name === "a");
    const nested = property === undefined ? undefined : Checker_getTypeOfSymbol(owner, property);
    if (nested?.derivation?.kind === "widened-in") result.push(nested);
  }
  return result;
}

function literal(type: Type) {
  const recipe = type.derivation;
  if (recipe?.kind !== "widened-in" || recipe.source.derivation?.kind !== "object-literal")
    throw new Error("The contextual member retains its actual literal and widening path");
  const creation = LiteralCreation.read(recipe.source);
  if (creation === undefined) throw new Error("The contextual source retains its authenticated creation");
  return { path: recipe.path, node: creation.node, mode: creation.mode };
}

for (const checkers of [1, 4]) test(`completed contextual arguments and their members retain actual owners with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program retains its checker");
  const answers = new Map(current.owners.map(owner => [owner, current.nodes.map(node => argument(owner, node))]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = answers.get(source);
    const expected = answers.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("Both native producers retain their selected applications");
    assert.equal(originals[0] !== originals[1], true, "distinct call-owned literals retain distinct native answers");
    assert.equal(originals[4]?.derivation?.kind !== "inferred-at", true, "a normal call-free source cannot receive a call ownership record");
    assert.equal(originals[5] === originals[6] && originals[5]?.derivation?.kind === "inferred-at"
      && originals[5].derivation.at === current.nodes[6], true,
    "the outer call cannot overwrite its inner call's completed contextual owner");
    for (const order of [[0, 1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1, 0]]) {
      const normalization = createTypeNormalization(producer);
      for (const position of order) {
        const original: Type | undefined = originals[position];
        const target: Type | undefined = expected[position];
        const node = current.nodes[position];
        if (original === undefined || target === undefined || node === undefined) throw new Error("The actual call vector is dense");
        const recipe: TypeDerivation | undefined = original.derivation;
        assert.equal(normalization.type(original) === target && normalization.type(original) === target, true);
        assert.equal(argument(source, node) === original && original.derivation === recipe, true,
          "repeated native cache reads preserve the first actual owning record");
        const targets = members(producer, target);
        for (const member of members(source, original)) {
          const coordinate = literal(member);
          const matches = targets.filter(value => {
            const actual = literal(value);
            return actual.node === coordinate.node && actual.mode === coordinate.mode
              && JSON.stringify(actual.path) === JSON.stringify(coordinate.path);
          });
          assert.equal(matches.length, 1);
          const value = normalization.type(member);
          assert.equal(value === matches[0] && value.checker === producer, true,
            "the target's actual producing coordinates select the member, not union position or structural shape");
          const other = targets.find(candidate => literal(candidate).node !== coordinate.node
            && JSON.stringify(literal(candidate).path) === JSON.stringify(coordinate.path));
          if (other !== undefined) assert.equal(Checker_isTypeIdenticalTo(producer, value, other), false);
        }
        if (recipe?.kind !== "inferred-at") continue;
        const clone = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
        if (clone === undefined) throw new Error("The independent native clone completes");
        const unread = new Proxy(producer, { get(owner, key, receiver) {
          if (key === "signatureLinks") assert.fail("An unproduced inferred recipe cannot query the target call");
          return Reflect.get(owner, key, receiver);
        } });
        clone.derivation = recipe;
        assert.equal(reacquireContextualArgument(unread, clone), undefined);
        clone.derivation = { ...recipe, index: 999 };
        assert.equal(reacquireContextualArgument(unread, clone), undefined);
        const otherAt = current.nodes.find(value => value !== recipe.at && value !== node);
        if (otherAt === undefined) throw new Error("The actual input retains another call occurrence");
        clone.derivation = { ...recipe, at: otherAt };
        assert.equal(reacquireContextualArgument(unread, clone), undefined);
        assert.throws(() => reacquireContextualArgument(foreign, original), error => error instanceof TypeError);
      }
    }
  }
});

test("a genuine contextual member resolves its cold target call only after exact source admission", () => {
  const current = fixture(4);
  const at = current.nodes[2];
  const source = current.owners[0];
  if (at === undefined || source === undefined) throw new Error("The actual contextual union and native source exist");
  const original = argument(source, at);
  const producer = current.owners.find(value => value !== source && LinkStore_TryGet(value.signatureLinks, at)?.resolvedSignature === undefined);
  if (producer === undefined) throw new Error("The actual native pool retains an unqueried target call");
  const before = LinkStore_TryGet(producer.signatureLinks, at);
  const clone = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
  if (clone === undefined || original.derivation?.kind !== "inferred-at") throw new Error("The actual contextual argument retains its completed source owner");
  clone.derivation = original.derivation;
  assert.equal(reacquireContextualArgument(producer, clone), undefined);
  assert.equal(LinkStore_TryGet(producer.signatureLinks, at) === before && before?.resolvedSignature === undefined, true,
    "a copied recipe cannot initialize an unqueried target signature");
  const member = members(source, original)[0];
  if (member === undefined) throw new Error("The actual contextual union retains its first authored member");
  const coordinate = literal(member);
  const normalization = createTypeNormalization(producer);
  const value = normalization.type(member);
  const target = argument(producer, at);
  assert.equal(normalization.type(original) === target, true);
  const expected = members(producer, target).filter(candidate => literal(candidate).node === coordinate.node
    && JSON.stringify(literal(candidate).path) === JSON.stringify(coordinate.path));
  assert.equal(expected.length === 1 && expected[0] === value, true,
    "the actual native call creates its own matching contextual member on a cold cache");
});

for (const checkers of [1, 4]) test(`rejected contextual candidates do not acquire a completed argument owner with ${checkers} checkers`, () => {
  const current = fixture(checkers, true);
  const bad = current.nodes[7];
  if (bad === undefined) throw new Error("The actual rejected call occurrence is retained");
  for (const owner of current.owners) {
    Checker_getResolvedSignature(owner, bad, undefined, CheckModeNormal);
    const evidence: ResolvedCallSelectionEvidence | undefined = LinkStore_TryGet(owner.signatureLinks, bad)?.resolvedCallSelectionEvidence;
    assert.equal(evidence?.kind === "conditional-candidates", true);
    if (evidence?.kind !== "conditional-candidates") throw new Error("The actual rejected application retains its candidates");
    assert.equal(evidence.candidates.length > 0, true);
    for (const candidate of evidence.candidates) for (const row of candidate.application.signatureTypeArguments)
      assert.equal(row.checkedArgument?.derivation?.kind !== "inferred-at", true);
  }
});

function constructorFixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/constructors", includeBundledLibraries: false,
    files: { "/constructors/core.d.ts": testCoreDeclarations,
      "/constructors/use.ts": `declare function identity<T>(value:T):T;
        export const array=identity([{a:1},{b:2}]);
        export const nested=identity([[{a:{x:1}},{a:{y:2}}]]);
        export const tuple=identity([{a:1},{b:2}] as const);
        export const once=identity([{a:1},{b:2}]);
        export const repeated=identity([once,once] as const);`,
      "/constructors/other.ts": "export const other=1;", "/constructors/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const program = session.program;
  const file = checked.getSourceFile("/constructors/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual reference-input source is retained");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsCallExpression).map(node => {
    if (node === undefined) throw new Error("The actual reference-input calls are dense");
    return node;
  });
  assert.equal(nodes.length, 5);
  const owners = program.compilerCheckerPool!.checkers.map(owner => {
    if (owner === undefined) throw new Error("The actual reference-input producers are dense");
    return owner;
  });
  assert.equal(createCompilerSessionFromProgram(program, session.host, session.config).program === program, true);
  return { owners, nodes };
}

function inputAt(owner: Checker, root: Type, path: readonly number[]): Type {
  let value = root;
  for (const position of path) {
    const input = cachedReferenceInputs(owner, value)?.[position];
    if (input === undefined) throw new Error("The actual cached constructor retains its selected input");
    value = input;
  }
  return value;
}

for (const checkers of [1, 4]) test(`cached constructor inputs retain contextual owners with ${checkers} checkers`, () => {
  const current = constructorFixture(checkers);
  const answers = new Map(current.owners.map(owner => [owner, current.nodes.map(at => argument(owner, at))]));
  const coordinates = [[], [0], [0, 0]];
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = answers.get(source);
    const expected = answers.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The actual selected reference roots are retained");
    for (const order of [[0, 1], [1, 0]]) {
      const normalization = createTypeNormalization(producer);
      for (const position of order) {
        const root = originals[position];
        const target = expected[position];
        if (root === undefined || target === undefined) throw new Error("The reference-input root vector is dense");
        for (const path of coordinates.slice(0, position + 2)) {
          const value = inputAt(source, root, path);
          const result = inputAt(producer, target, path);
          const recipe = value.derivation;
          if (cachedReferenceInputs(source, value) === undefined) {
            assert.equal(recipe?.kind === "inferred-at" && recipe.at === current.nodes[position]
              && JSON.stringify(recipe.path) === JSON.stringify(path), true, "the final call names its actual contextual input");
          } else {
            assert.equal(recipe === undefined, true, "cached reference prefixes retain their single native constructor authority");
          }
          assert.equal(normalization.type(value) === result && normalization.type(value) === result, true);
          assert.equal(value.derivation === recipe, true, "repeated reads retain the first native owner witness");
          const targets = members(producer, result);
          for (const member of members(source, value)) {
            const coordinate = literal(member);
            const matches = targets.filter(candidate => {
              const actual = literal(candidate);
              return actual.node === coordinate.node && actual.mode === coordinate.mode
                && JSON.stringify(actual.path) === JSON.stringify(coordinate.path);
            });
            assert.equal(matches.length === 1 && normalization.type(member) === matches[0], true);
            const other = targets.find(candidate => literal(candidate).node !== coordinate.node
              && JSON.stringify(literal(candidate).path) === JSON.stringify(coordinate.path));
            if (other !== undefined) assert.equal(Checker_isTypeIdenticalTo(producer, normalization.type(member), other), false);
          }
        }
      }
    }
    const tuple = originals[2];
    const targetTuple = expected[2];
    const once = originals[3];
    const repeated = originals[4];
    if (tuple === undefined || targetTuple === undefined || once === undefined || repeated === undefined)
      throw new Error("The actual multi-position and repeated input roots exist");
    for (const position of [0, 1]) {
      const value = inputAt(source, tuple, [position]);
      assert.equal(createTypeNormalization(producer).type(value) === inputAt(producer, targetTuple, [position]), true);
      assert.equal(value.derivation?.kind === "inferred-at" && JSON.stringify(value.derivation.path) === JSON.stringify([position]), true);
    }
    assert.equal(inputAt(source, repeated, [0]) === once && inputAt(source, repeated, [1]) === once, true);
    const onceInput = inputAt(source, once, [0]);
    assert.equal(once.derivation === undefined && onceInput.derivation?.kind === "inferred-at"
      && onceInput.derivation.at === current.nodes[3], true,
      "repeated genuine coordinates preserve the first call's native identity witness");
  }
});

test("constructor paths admit every actual source prefix before a cold target call", () => {
  const current = constructorFixture(4);
  const source = current.owners[0];
  const at = current.nodes[1];
  const tupleAt = current.nodes[2];
  if (source === undefined || at === undefined || tupleAt === undefined) throw new Error("The actual constructor source exists");
  const root = argument(source, at);
  const value = inputAt(source, root, [0, 0]);
  const recipe = value.derivation;
  if (recipe?.kind !== "inferred-at") throw new Error("The nested reference input retains its actual owner");
  const producer = current.owners.find(owner => owner !== source && LinkStore_TryGet(owner.signatureLinks, at)?.resolvedSignature === undefined);
  if (producer === undefined) throw new Error("The actual target call is cold");
  const before = LinkStore_TryGet(producer.signatureLinks, at);
  const unread = new Proxy(producer, { get(owner, key, receiver) {
    if (key === "signatureLinks") assert.fail("Invalid constructor source admission cannot read the target call");
    return Reflect.get(owner, key, receiver);
  } });
  const clone = Checker_newAnonymousType(source, value.symbol, new Map(), [], [], []);
  if (clone === undefined) throw new Error("The actual independent clone exists");
  clone.derivation = recipe;
  assert.equal(reacquireContextualArgument(unread, clone), undefined);
  const malformed = [[-1], [-0], [0.5], [Number.NaN], [Number.POSITIVE_INFINITY], [999], [0, 0, 0], new Array<number>(1)];
  try {
    for (const path of malformed) {
      value.derivation = { ...recipe, path };
      assert.equal(reacquireContextualArgument(unread, value), undefined);
    }
    Object.assign(value, { derivation: { kind: "inferred-at", at: recipe.at, index: recipe.index } });
    assert.equal(reacquireContextualArgument(unread, value), undefined, "the superseded missing-path record is not admitted");
  } finally {
    value.derivation = recipe;
  }
  const tuple = argument(source, tupleAt);
  const first = inputAt(source, tuple, [0]);
  const tupleRecipe = first.derivation;
  if (tupleRecipe?.kind !== "inferred-at") throw new Error("The actual tuple input retains its source path");
  try {
    first.derivation = { ...tupleRecipe, path: [1] };
    assert.equal(reacquireContextualArgument(unread, first), undefined, "another actual constructor position cannot borrow this value");
  } finally {
    first.derivation = tupleRecipe;
  }
  const target = Type_Target(root);
  const inputs = Type_AsTypeReference(root)?.resolvedTypeArguments;
  const targetObject = Type_AsObjectType(target);
  const uncached = Checker_newObjectType(source, ObjectFlagsReference, root.symbol);
  if (target === undefined || inputs === undefined || targetObject === undefined || uncached === undefined)
    throw new Error("The actual native reference retains its constructor inputs and cache");
  Type_AsObjectType(uncached)!.target = target;
  Type_AsTypeReference(uncached)!.resolvedTypeArguments = inputs;
  uncached.derivation = { ...recipe, path: [] };
  assert.equal(cachedReferenceInputs(source, uncached), undefined, "uncached native reference clones cannot publish constructor inputs");
  assert.equal(reacquireContextualArgument(unread, uncached), undefined);
  const key = getTypeListKey(inputs);
  assert.equal(targetObject.instantiations.get(key) === root, true);
  targetObject.instantiations.delete(key);
  try {
    assert.equal(reacquireContextualArgument(unread, value), undefined, "every prefix must still be the actual cached reference");
  } finally {
    targetObject.instantiations.set(key, root);
  }
  assert.equal(LinkStore_TryGet(producer.signatureLinks, at) === before && before?.resolvedSignature === undefined, true);
  const member = members(source, value)[0];
  if (member === undefined) throw new Error("The actual nested reference input has a contextual member");
  const coordinate = literal(member);
  const normalization = createTypeNormalization(producer);
  const result = normalization.type(member);
  const selected = inputAt(producer, argument(producer, at), [0, 0]);
  assert.equal(normalization.type(value) === selected, true);
  assert.equal(members(producer, selected).some(candidate => candidate === result && literal(candidate).node === coordinate.node
    && JSON.stringify(literal(candidate).path) === JSON.stringify(coordinate.path)), true);
});
