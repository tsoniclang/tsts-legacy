import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { contextWideningKey, UnionReductionNone } from "../internal/checker/checker/state.js";
import { Checker_getTypeArguments } from "../internal/checker/checker/signatures.js";
import { Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_getPropertiesOfType, Checker_getUnionTypeEx, Checker_getWidenedType, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import { Type_Types, TypeFlagsUnion } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { reacquireContextWidening } from "./type-normalization-expressions.js";
import { createTypeNormalization } from "./type-normalization.js";

function record(value: Type) {
  const result = value.derivation;
  if (result?.kind !== "widened-in") throw new Error("The actual native contextual widening retains its fresh producing record");
  const literal = result.source.derivation;
  if (literal?.kind !== "object-literal") throw new Error("This authored widening's source is its complete native object literal");
  return { ...result, node: literal.node };
}

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/context", includeBundledLibraries: false,
    files: { "/context/core.d.ts": testCoreDeclarations,
      "/context/use.ts": `export const xs=[{a:1},{b:2}];
        export const nested=[{a:{x:1}},{a:{y:2}}];
        export const escaped=[{"a/b":{x:1}},{"a/b":{y:2}}];`,
      "/context/other.ts": "export const other=1;", "/context/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/context/use.ts");
  if (program === undefined || file === undefined) throw new Error("The native contextual input retains its actual Program and source file");
  const view = checked.getSourceFileQueries(file);
  const variables = findNodes(file, view.ast.children, view.ast.is.IsVariableDeclaration);
  assert.equal(variables.length, 3);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual native checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  const rows = (owner: Checker): Type[] => {
    const result: Type[] = [];
    for (const [position, variable] of variables.entries()) {
      const array = Checker_getTypeOfSymbol(owner, Node_Symbol(variable));
      const element = Checker_getTypeArguments(owner, array)?.[0];
      if (element === undefined || (element.flags & TypeFlagsUnion) === 0)
        throw new Error("The actual inferred array retains its native union element");
      const members = Type_Types(element);
      if (members === undefined || members.length !== 2) throw new Error("Both actual literal alternatives remain in the widened union");
      for (const member of members) {
        if (member === undefined) throw new Error("The native contextual member inventory is dense");
        result.push(member);
        assert.deepEqual(record(member).path, []);
        if (position === 0) continue;
        const key = position === 1 ? "a" : "a/b";
        const property = Checker_getPropertiesOfType(owner, member)?.find(value => value?.Name === key);
        const nested = Checker_getTypeOfSymbol(owner, property);
        if (nested === undefined) throw new Error("The actual nested property retains its context-selected type");
        assert.deepEqual(record(nested).path, [key]);
        result.push(nested);
      }
    }
    assert.equal(result.length, 10);
    return result;
  };
  return { owners, rows };
}

for (const checkers of [1, 4]) test(`native contextual widening retains actual roots and property paths with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program retains its actual producer");
  const answers = new Map<Checker, Type[]>(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = answers.get(source);
    const expected = answers.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("Both actual producers retain their own contextual answers");
    const basis = originals[0];
    const extra = originals[2];
    if (basis === undefined || extra === undefined) throw new Error("The authored native fixture supplies two actual source literals");
    const first = record(basis);
    const root = Checker_getUnionTypeEx(source, [first.source, record(extra).source], UnionReductionNone, undefined, undefined);
    if (root === undefined) throw new Error("The actual second native union construction completes");
    assert.equal(root !== first.root, true);
    const originalKey = contextWideningKey(first.root, first.path, first.source);
    const alternativeKey = contextWideningKey(root, first.path, first.source);
    if (originalKey === undefined || alternativeKey === undefined) throw new Error("Both actual roots retain their literal coordinates");
    assert.notEqual(originalKey, alternativeKey);
    const previous = source.contextWidened?.get(originalKey);
    Checker_getWidenedType(source, root);
    const alternative = source.contextWidened?.get(alternativeKey);
    if (alternative === undefined) throw new Error("The actual alternative widening produces that source member");
    assert.equal(alternative !== basis && record(alternative).root === root, true);
    assert.equal(source.contextWidened?.get(originalKey) === previous && previous === basis, true,
      "the same literal widened under another actual root cannot overwrite its earlier context coordinate");
    const selected = createTypeNormalization(producer);
    const alternateRoot = selected.type(root);
    const alternateInput = selected.type(first.source);
    const alternateValue = selected.type(alternative);
    const targetKey = contextWideningKey(alternateRoot, first.path, alternateInput);
    if (targetKey === undefined) throw new Error("The target retains the actual normalized root coordinate");
    assert.equal(producer.contextWidened?.get(targetKey) === alternateValue, true);
    assert.notEqual(contextWideningKey(root, ["a/b"], first.source), contextWideningKey(root, ["a", "b"], first.source),
      "actual property names are encoded as path segments, not concatenated into an ambiguous key");
    for (const ordered of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const original of ordered) {
        const producing = record(original);
        const matches: Type[] = expected.filter(value => record(value).node === producing.node
          && JSON.stringify(record(value).path) === JSON.stringify(producing.path));
        assert.equal(matches.length, 1, "the actual literal occurrence and context path, not union position or shape, select this fixture's answer");
        const target = matches[0];
        if (target === undefined) throw new Error("The target has the actual corresponding native contextual member");
        const recipe = original.derivation;
        const value = normalization.type(original);
        assert.equal(value.checker === producer && target.checker === producer, true);
        assert.equal(Checker_isTypeIdenticalTo(producer, value, target), true);
        assert.equal(normalization.type(original) === value, true);
        const root = normalization.type(producing.root);
        const input = normalization.type(producing.source);
        const key = contextWideningKey(root, producing.path, input);
        if (key === undefined) throw new Error("The actual complete source literal supplies this native map coordinate");
        Checker_getWidenedType(producer, root);
        const selected = producer.contextWidened?.get(key);
        assert.equal(selected !== undefined && selected.checker === producer, true);
        assert.equal(reacquireContextWidening(producer, original, normalization.type) === selected, true);
        if (source !== producer) assert.equal(value === selected, true);
        const previous = producer.contextWidened;
        Checker_getWidenedType(producer, root);
        assert.equal(producer.contextWidened === previous && previous?.get(key) === selected, true,
          "native root cache hits retain the original produced context relation");
        assert.equal(original.derivation === recipe, true);
        const clone = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
        if (clone === undefined) throw new Error("The independent native object construction completes");
        assert.equal(reacquireContextWidening(producer, clone, normalization.type), undefined);
        assert.throws(() => reacquireContextWidening(foreign, original, normalization.type), error => error instanceof TypeError);
        assert.throws(() => reacquireContextWidening(producer, original, () => foreign.stringType!), error => error instanceof TypeError);
      }
    }
  }
});
