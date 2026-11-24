import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import type { Node, TypeReferenceArgumentInfo } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { NativeCheckerResult } from "../internal/checker/resource-admission.js";

test("interface applications retain the actual neutral target and complete interface facets separately from ordered arguments", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": `
      interface Matrix<Item, Key> { left: Item; }
      interface Matrix<Item, Key> { right: Key; }
      declare const Matrix: { readonly label: "Matrix" };
      interface Distinct<Item, Key> { left: Item; }
      interface Distinct<Item, Key> { right: Key; }
      type Read = Matrix<string, boolean>;
      type Write = Matrix<boolean, string>;
      type Foreign = Distinct<string, boolean>;
    `,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true } }).checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const { ast, checker, typeShape: shape } = checked.getSourceFileQueries(file);
  const statements = ast.statements(file);
  const type = (name: string) => shape.getTypeFromTypeNode(ast.typeNode(statements.find(node => ast.is.IsTypeAliasDeclaration(node)
    && ast.text(ast.name(node)) === name)))?.type;
  const read = type("Read");
  const write = type("Write");
  const foreign = type("Foreign");
  const receiver = statements.flatMap(statement => findNodes(statement, ast.children, ast.is.IsVariableDeclaration))
    .find(node => ast.text(ast.name(node)) === "Matrix");
  const value = checker.getTypeAtLocation(ast.name(receiver))?.type;
  const target = shape.getTypeReferenceTarget(read);
  const different = shape.getTypeReferenceTarget(foreign);
  assert.ok(target && different);
  assert.equal(shape.getTypeReferenceTarget(write) === target && different !== target, true);
  const declared = shape.acquireInterfaceDeclarations(target, () => null);
  const otherDeclared = shape.acquireInterfaceDeclarations(different, () => null);
  const cold: [string, number][] = [];
  const acquired = shape.acquireInterfaceArguments(read, target, (axis, count) => { cold.push([axis, count]); return null; });
  const crossed = shape.acquireInterfaceArguments(write, target, () => null);
  assert.ok(declared.kind === "complete" && otherDeclared.kind === "complete" && acquired.kind === "complete" && crossed.kind === "complete");
  const matrix = statements.filter(node => ast.kindName(node) === "KindInterfaceDeclaration" && ast.text(ast.name(node)) === "Matrix");
  assert.equal(declared.value.length, matrix.length);
  assert.equal(declared.value.every((row, position) => row === matrix[position]), true);
  assert.equal(otherDeclared.value.every(row => !matrix.includes(row)), true);
  assert.equal(shape.acquireInterfaceDeclarations(value, () => null).kind, "unavailable", "the value facet is not the interface");
  assert.equal(shape.acquireInterfaceDeclarations(read, () => null).kind, "unavailable", "an application is not its target");
  assert.equal(shape.acquireInterfaceArguments(foreign, target, () => null).kind, "unavailable");
  assert.equal(shape.acquireInterfaceArguments(read, { ...target }, () => null).kind, "unavailable");
  const argumentKinds = (values: typeof acquired.value) =>
    values.map(row => [row.scope, shape.isStringLike(row.argument), shape.isBooleanLike(row.argument)]);
  assert.deepEqual(argumentKinds(acquired.value), [["local", true, false], ["local", false, true]]);
  assert.deepEqual(argumentKinds(crossed.value), [["local", false, true], ["local", true, false]]);
  for (const [position, slot] of acquired.value.entries()) {
    assert.equal(slot.parameter === crossed.value[position]?.parameter, true);
    const selected = shape.acquireCompletedTypeArgument(read, slot.parameter, () => null);
    assert.equal(selected.kind === "complete" && selected.value === slot.argument, true);
    const sources = checker.getSymbolDeclarations(checker.getTypeSymbol(slot.parameter));
    assert.equal(sources.length, matrix.length);
    assert.equal(sources.every((row, fragment) => row === ast.typeParameters(matrix[fragment])[position]), true);
  }
  const cost: [string, number][] = [];
  const warm = shape.acquireInterfaceArguments(read, target, (axis, count) => { cost.push([axis, count]); return null; });
  assert.equal(warm.kind === "complete" && warm.value[0]?.argument === acquired.value[0]?.argument, true);
  assert.equal(cold.filter(([axis]) => axis === "work").length > cost.filter(([axis]) => axis === "work").length, true);
  const original = { budget: "interface application" };
  for (let cutoff = 0; cutoff < cost.length; ++cutoff) {
    let reached = 0;
    const stopped: NativeCheckerResult<readonly TypeReferenceArgumentInfo[], { readonly budget: string }> =
      shape.acquireInterfaceArguments(read, target, (axis, count) => {
      assert.deepEqual([axis, count], cost[reached]);
      return reached++ === cutoff ? original : null;
    });
    assert.equal(reached, cutoff + 1);
    assert.equal(stopped.kind === "refused" && stopped.stop === original, true);
  }
  const declarationCost: [string, number][] = [];
  const again = shape.acquireInterfaceDeclarations(target, (axis, count) => { declarationCost.push([axis, count]); return null; });
  assert.ok(again.kind === "complete" && again.value.every((fragment, index) => fragment === declared.value[index]));
  for (let cutoff = 0; cutoff < declarationCost.length; ++cutoff) {
    let reached = 0;
    const stopped: NativeCheckerResult<readonly [Node, ...Node[]], { readonly budget: string }> =
      shape.acquireInterfaceDeclarations(target, (axis, count) => {
      assert.deepEqual([axis, count], declarationCost[reached]);
      return reached++ === cutoff ? original : null;
    });
    assert.equal(reached, cutoff + 1);
    assert.equal(stopped.kind === "refused" && stopped.stop === original, true);
  }
  const fragments = target.symbol?.Declarations;
  assert.ok(fragments);
  const laterIndex = fragments.findIndex(node => node === matrix[1]);
  const later = String(laterIndex);
  const descriptor = Object.getOwnPropertyDescriptor(fragments, later);
  const actualLater = fragments[laterIndex];
  assert.ok(laterIndex > 0 && descriptor && actualLater);
  let reads = 0;
  try {
    Object.defineProperty(fragments, later, { configurable: true, get: () => { ++reads; return actualLater; } });
    assert.equal(shape.acquireInterfaceArguments(write, target, () => null).kind, "complete");
    assert.equal(shape.acquireInterfaceArguments(foreign, target, () => null).kind, "unavailable");
    assert.equal(reads, 0);
    let work = 0;
    const stopped = shape.acquireInterfaceDeclarations<typeof original>(target, axis =>
      axis === "work" && ++work === laterIndex + 2 ? original : null);
    assert.equal(stopped.kind === "refused" && stopped.stop === original, true);
    assert.equal(reads, 0);
    assert.equal(shape.acquireInterfaceDeclarations(target, () => null).kind, "complete");
    assert.equal(reads, 1);
  } finally {
    Object.defineProperty(fragments, later, descriptor);
  }
});

test("a completed selected argument borrows only its actual reached native target slot", () => {
  const open = () => {
    const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": `
interface Matrix<Item, Key> { [index: number]: Item; marker: Key; }
interface Matrix<Item, Key> { other: Key; }
declare const receiver: Matrix<boolean, string>;
function irrelevant<Free>(value: Free): Free { return value; }
const read = receiver[0];
const marker = receiver.marker;
`,
    }, compilerOptions: { ...testNoLibCompilerOptions, strict: true } });
    const checked = session.checkSource();
    assert.deepEqual(checked.diagnostics, []);
    const file = checked.getSourceFile("/src/index.ts");
    assert.ok(file !== undefined);
    const source = checked.getSourceFileQueries(file);
    const receiver = findNodes(file, source.ast.children, source.ast.is.IsVariableDeclaration)
      .find(node => source.ast.text(source.ast.name(node)) === "receiver");
    const type = source.checker.getTypeAtLocation(source.ast.name(receiver))?.type;
    const parameters = findNodes(file, source.ast.children, source.ast.is.IsTypeParameterDeclaration);
    const parameter = (name: string) => {
      const declaration = parameters.find(node => source.ast.text(source.ast.name(node)) === name);
      return source.checker.getTypeAtLocation(source.ast.name(declaration))?.type;
    };
    const item = parameter("Item");
    const key = parameter("Key");
    const free = parameter("Free");
    assert.ok(type && item && key && free);
    return { source, type, item, key, free };
  };
  const actual = open();
  const trace: unknown[] = [];
  const selected = actual.source.typeShape.acquireCompletedTypeArgument(actual.type, actual.key,
    (axis, count) => { trace.push([axis, count]); return null; });
  assert.ok(selected.kind === "complete" && actual.source.typeShape.isStringLike(selected.value));
  assert.deepEqual(trace, Array.from({ length: 4 }, () => ["work", 1]));
  const first = actual.source.typeShape.acquireCompletedTypeArgument(actual.type, actual.item, () => null);
  assert.ok(first.kind === "complete" && actual.source.typeShape.isBooleanLike(first.value));
  assert.equal(actual.source.typeShape.acquireCompletedTypeArgument(actual.type, actual.free, () => null).kind, "unavailable");
  assert.equal(open().source.typeShape.acquireCompletedTypeArgument(actual.type, actual.key,
    () => assert.fail("a foreign receiver must be refused without a charge")).kind, "unavailable");
  const original = { resource: "completed argument slot" };
  for (let cutoff = 0; cutoff < trace.length; cutoff += 1) {
    const fresh = open();
    let read = 0;
    const stopped = fresh.source.typeShape.acquireCompletedTypeArgument(fresh.type, fresh.key,
      (axis, count): typeof original | null => {
        assert.deepEqual([axis, count], trace[read]);
        return read++ === cutoff ? original : null;
      });
    assert.equal(read, cutoff + 1);
    assert.equal(stopped.kind === "refused" && stopped.stop === original, true);
  }
});

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
    const type = source.checker.getTypeAtLocation(source.ast.name(variable))?.type;
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
    const type = source.checker.getTypeAtLocation(source.ast.name(variable))?.type;
    assert.deepEqual(source.typeShape.getTypeReferenceArgumentInfos(type), []);
  }
  const tuple = variables.find(node => source.ast.text(source.ast.name(node)) === "tuple");
  assert.ok(tuple !== undefined);
  const tupleType = source.checker.getTypeAtLocation(source.ast.name(tuple))?.type;
  assert.equal(source.typeShape.getTypeReferenceArgumentInfos(tupleType), undefined);
  assert.equal(source.typeShape.getTupleInfo(tupleType)?.elements.length, 2);
  assert.equal(source.typeShape.getTypeReferenceTarget(tupleType) !== undefined, true);
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
    const type = source.checker.getTypeAtLocation(source.ast.name(variable))?.type;
    assert.ok(type !== undefined);
    assert.equal(source.typeShape.getTypeReferenceArgumentInfos(type), undefined);
    assert.equal(source.typeShape.getTypeReferenceTarget(type), undefined);
  }
  const parameters = findNodes(file, source.ast.children, source.ast.is.IsParameterDeclaration);
  const parameter = parameters.find(node => source.ast.text(source.ast.name(node)) === "parameter");
  assert.ok(parameter !== undefined);
  const parameterType = source.checker.getTypeAtLocation(source.ast.name(parameter))?.type;
  assert.ok(parameterType !== undefined);
  assert.equal(source.typeShape.getTypeReferenceArgumentInfos(parameterType), undefined);
  assert.equal(source.typeShape.getTypeReferenceTarget(parameterType), undefined);
});
