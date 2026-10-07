import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

test("type-derived signature queries retain their checker owner across imports and re-exports", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/types.ts": `export interface Callback<Input, Output = Input> {
      (this: { tag: string }, first: Input, ...values: [Input?, string?]): Output;
    }
    export interface Constructor { new (value: number): { value: number }; }
    `,
    "/src/api.ts": `import type { Callback, Constructor } from "./types.js";
      export declare const callback: Callback<number>;
      export declare const constructor: Constructor;
      export const plain = 1;
    `,
    "/src/bridge.ts": `export { callback as forwarded } from "./api.js";`,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", module: "esnext" } }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  const apiFile = checked.getSourceFile("/src/api.ts");
  const bridgeFile = checked.getSourceFile("/src/bridge.ts");
  assert.ok(apiFile && bridgeFile);
  const api = checked.getSourceFileQueries(apiFile);
  const bridge = checked.getSourceFileQueries(bridgeFile);
  const variables = findNodes(apiFile, api.ast.children, api.ast.is.IsVariableDeclaration);
  const typeFor = (name: string) => {
    const declaration = variables.find(node => api.ast.text(api.ast.name(node)) === name);
    assert.ok(declaration);
    return api.checker.getTypeAtLocation(api.ast.name(declaration));
  };
  const callback = typeFor("callback");
  const original = api.typeShape.getSignatureInfos(callback, "call");
  const transported = bridge.typeShape.getSignatureInfos(callback, "call");
  assert.equal(transported.length, 1);
  assert.equal(transported[0]!.signature, original[0]!.signature);
  assert.equal(transported[0]!.returnType, original[0]!.returnType);
  assert.deepEqual(transported[0]!.parameters.map(parameter => parameter.parameterKind), ["required", "optional", "optional"]);
  assert.deepEqual(transported[0]!.parameters.map(parameter => parameter.acceptsOmission), [false, true, true]);
  assert.equal(bridge.typeShape.isNumberLike(transported[0]!.parameters[0]!.type), true);
  assert.equal(bridge.typeShape.isNumberLike(transported[0]!.returnType), true);
  assert.ok(transported[0]!.thisParameter);
  assert.equal(Object.isFrozen(transported), true);
  assert.equal(Object.isFrozen(transported[0]), true);
  assert.equal(Object.isFrozen(transported[0]!.parameters), true);
  assert.equal(transported[0]!.parameters.every(Object.isFrozen), true);
  const constructors = bridge.typeShape.getSignatureInfos(typeFor("constructor"), "construct");
  assert.equal(constructors.length, 1);
  assert.equal(bridge.typeShape.isNumberLike(constructors[0]!.parameters[0]!.type), true);
  assert.deepEqual(bridge.typeShape.getSignatureInfos(typeFor("plain"), "call"), []);
  assert.deepEqual(bridge.typeShape.getSignatureInfos(callback, "construct"), []);
  assert.deepEqual(bridge.typeShape.getSignatureInfos(undefined, "call"), []);
  assert.throws(() => bridge.typeShape.getSignatureInfos(callback, "invalid" as never), /Unknown signature kind/u);
});

test("type-derived omission retains checker arity independently of syntax and absence types", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": `
      export function trailing(value: void | string): void {}
      export function requiredUndefined(value: undefined | string): void {}
      export function requiredNull(value: null | string): void {}
      export function defaults(first = 1, second: string): void {}
      export function optional(value?: string): void {}
      export function tuples(...values: [void | string, number?]): void {}
      trailing(); trailing("value"); requiredUndefined(undefined); requiredNull(null);
      defaults(undefined, "value"); optional(); tuples();
    `,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", module: "esnext" } }).checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, queries.ast.children, queries.ast.is.IsFunctionDeclaration);
  const expected = new Map([
    ["trailing", [true]], ["requiredUndefined", [false]], ["requiredNull", [false]],
    ["defaults", [false, false]], ["optional", [true]], ["tuples", [true, true]],
  ]);
  for (const declaration of declarations) {
    const name = queries.ast.text(queries.ast.name(declaration));
    const type = queries.checker.getTypeAtLocation(queries.ast.name(declaration));
    const signature = queries.typeShape.getSignatureInfos(type, "call")[0];
    assert.ok(signature);
    assert.deepEqual(signature.parameters.map(parameter => parameter.acceptsOmission), expected.get(name), name);
    const authored = queries.typeShape.getDeclarationSignatureInfo(declaration);
    assert.ok(authored);
    assert.equal(authored.signature === signature.signature, true, name);
    assert.deepEqual(authored.parameters.map(parameter => parameter.acceptsOmission), expected.get(name), name);
    assert.equal(Object.isFrozen(authored), true);
    assert.equal(Object.isFrozen(signature.parameters) && signature.parameters.every(Object.isFrozen), true);
  }
  assert.equal(queries.typeShape.getDeclarationSignatureInfo(undefined) === undefined, true);
  assert.equal(queries.typeShape.getDeclarationSignatureInfo(file) === undefined, true);
});

test("authored signature evidence selects an implementation rather than its public overloads", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/api.ts": `
      export function inspect(value: string): string;
      export function inspect(value: number): number;
      export function inspect(value: string | number, suffix?: string): string | number { return value; }
      export class Owner {
        constructor(value: void | string) {}
        inspect(value: void | string): void {}
      }
      export const callback = (value: void | string): void => {};
    `,
    "/src/bridge.ts": `export { inspect, Owner, callback } from "./api.js";`,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", module: "esnext" } }).checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/src/api.ts");
  const bridge = checked.getSourceFile("/src/bridge.ts");
  assert.ok(file && bridge);
  const queries = checked.getSourceFileQueries(file);
  const transported = checked.getSourceFileQueries(bridge);
  const declarations = findNodes(file, queries.ast.children, node => queries.ast.is.IsFunctionDeclaration(node) ||
    queries.ast.is.IsConstructorDeclaration(node) || queries.ast.is.IsMethodDeclaration(node) || queries.ast.is.IsArrowFunction(node));
  const expected = [[false], [false], [false, true], [true], [true], [true]];
  assert.equal(declarations.length, expected.length);
  for (const [index, declaration] of declarations.entries()) {
    const local = queries.typeShape.getDeclarationSignatureInfo(declaration);
    const crossFile = transported.typeShape.getDeclarationSignatureInfo(declaration);
    assert.ok(local && crossFile);
    assert.equal(queries.checker.getSignatureDeclaration(local.signature) === declaration, true);
    assert.equal(crossFile.signature === local.signature, true, `authored signature ${index}`);
    assert.deepEqual(crossFile.parameters.map(parameter => parameter.acceptsOmission), expected[index]);
    assert.equal(Object.isFrozen(crossFile) && crossFile.parameters.every(Object.isFrozen), true);
  }
});
