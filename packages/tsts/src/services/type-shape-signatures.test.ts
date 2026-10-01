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
