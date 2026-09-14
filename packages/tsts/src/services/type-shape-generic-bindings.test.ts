import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

test("type-reference arguments retain outer and local parameter identities without this", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": `
function make<T>(input: T) {
  class Pair<U> {
    left: T;
    right: U;
    constructor(left: T, right: U) { this.left = left; this.right = right; }
  }
  return new Pair<number>(input, 7);
}
const text = make("text");
const numeric = make(8);
class Plain { value: number = 1; }
const plain = new Plain();
interface Value { value: number; }
const record: Value = { value: 1 };
const tuple: [number, string] = [1, "one"];
`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  });
  const checked = session.checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file !== undefined);
  const source = checked.getSourceFileQueries(file);
  const variables = findNodes(file, source.ast.children, source.ast.is.IsVariableDeclaration);
  for (const [name, text] of [["text", true], ["numeric", false]] as const) {
    const variable = variables.find(node => source.ast.text(source.ast.name(node)) === name);
    assert.ok(variable !== undefined);
    const type = source.checker.getTypeAtLocation(source.ast.name(variable));
    const bindings = source.typeShape.getTypeReferenceArgumentInfos(type);
    assert.equal(bindings?.length, 2);
    assert.ok(bindings !== undefined);
    assert.deepEqual(bindings.map(binding => binding.scope), ["outer", "local"]);
    assert.equal(source.typeShape.isStringLike(bindings[0]!.argument), text);
    assert.equal(source.typeShape.isNumberLike(bindings[1]!.argument), true);
    assert.notEqual(bindings[0]!.parameter, bindings[1]!.parameter);
    assert.equal(Object.isFrozen(bindings), true);
    assert.equal(bindings.every(Object.isFrozen), true);
  }
  assert.equal(source.typeShape.getTypeReferenceArgumentInfos(undefined), undefined);
  for (const name of ["plain", "record"]) {
    const variable = variables.find(node => source.ast.text(source.ast.name(node)) === name);
    assert.ok(variable !== undefined);
    const type = source.checker.getTypeAtLocation(source.ast.name(variable));
    assert.deepEqual(source.typeShape.getTypeReferenceArgumentInfos(type), []);
  }
  const tuple = variables.find(node => source.ast.text(source.ast.name(node)) === "tuple");
  assert.ok(tuple !== undefined);
  const tupleType = source.checker.getTypeAtLocation(source.ast.name(tuple));
  assert.equal(source.typeShape.getTypeReferenceArgumentInfos(tupleType), undefined);
  assert.equal(source.typeShape.getTupleElementTypes(tupleType).length, 2);
});

test("type-reference argument queries reject non-reference kinds without object-only access", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": `
const numeric = 7;
const text = "value";
const wide = 9007199254740993n;
const truth = true;
const absent = undefined;
const empty = null;
const callable = (value: number): number => value;
declare const opaque: unknown;
declare const impossible: never;
declare const union: number | string;
declare const intersection: { left: number } & { right: string };
function identity<T>(parameter: T): T { return parameter; }
`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  });
  const checked = session.checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file !== undefined);
  const source = checked.getSourceFileQueries(file);
  const variables = findNodes(file, source.ast.children, source.ast.is.IsVariableDeclaration);
  assert.equal(variables.length, 11);
  for (const variable of variables) {
    const type = source.checker.getTypeAtLocation(source.ast.name(variable));
    assert.ok(type !== undefined);
    assert.equal(source.typeShape.getTypeReferenceArgumentInfos(type), undefined);
  }
  const parameters = findNodes(file, source.ast.children, source.ast.is.IsParameterDeclaration);
  const parameter = parameters.find(node => source.ast.text(source.ast.name(node)) === "parameter");
  assert.ok(parameter !== undefined);
  const parameterType = source.checker.getTypeAtLocation(source.ast.name(parameter));
  assert.ok(parameterType !== undefined);
  assert.equal(source.typeShape.getTypeReferenceArgumentInfos(parameterType), undefined);
});
