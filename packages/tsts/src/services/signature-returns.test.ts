import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import {
  findNodes,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "../extensions/source-provider-test-support.js";
import { SignatureFlagsCallChainFlags } from "../internal/checker/types.js";

function fixture(body: string, declarations = "") {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/types.ts": declarations || "export {};",
      "/src/bridge.ts": `export * from "./types.js";`,
      "/src/index.ts": body,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  }).checkSource();
  assert.deepEqual(checked.diagnostics, []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = checked.getSourceFileQueries(file);
  const calls = findNodes(file, queries.ast.children, queries.ast.is.IsCallExpression);
  const results = calls.map(call => {
    const signature = queries.checker.getResolvedSignature(call);
    assert.ok(signature);
    return {
      signature,
      invocation: queries.checker.getInvocationReturnTypeOfSignature(signature),
      completion: queries.checker.getTypeAtLocation(call),
    };
  });
  return { queries, results };
}

test("invocation returns remove only optional receiver completion, not declared absence", () => {
  for (const declared of ["number", "number | undefined", "number | null", "number | null | undefined"]) {
    for (const optional of [false, true]) {
      const current = fixture(`
        declare const source: { read(): ${declared} }${optional ? " | undefined" : ""};
        source${optional ? "?." : "."}read();
      `);
      const result = current.results[0];
      assert.ok(result?.invocation);
      const members = current.queries.typeShape.isUnion(result.invocation)
        ? current.queries.typeShape.getUnionOrIntersectionTypes(result.invocation)
        : [result.invocation];
      assert.deepEqual(members.map(member => current.queries.checker.typeToString(member)).sort(), declared.split(" | ").sort());
      const completed = current.queries.checker.typeToString(result.completion);
      assert.equal(completed.includes("undefined"), optional || declared.includes("undefined"));
      assert.equal(completed.includes("null"), declared.includes("null"));
    }
  }
});

test("invocation returns retain exact optional-callee, overload and inner-chain selection", () => {
  for (const body of [
    `declare const callback: (() => number) | undefined; callback?.();`,
    `declare const source: { read(value: string): string; read(value: number): number } | undefined; source?.read(1);`,
    `declare const source: { child(): { read(): number } } | undefined; source?.child().read();`,
  ]) {
    const current = fixture(body);
    const result = current.results[0];
    assert.ok(result?.invocation);
    assert.equal(current.queries.typeShape.isNumberLike(result.invocation), true);
    assert.equal(current.queries.checker.typeToString(result.completion), "number | undefined");
    for (const selected of current.results) {
      const cached = selected.signature.resolvedReturnType;
      const flags = selected.signature.flags;
      const target = selected.signature.target;
      const mapper = selected.signature.mapper;
      for (let repeat = 0; repeat < 3; repeat++) {
        assert.equal(current.queries.checker.getInvocationReturnTypeOfSignature(selected.signature), selected.invocation);
      }
      assert.equal(selected.signature.resolvedReturnType, cached);
      assert.equal(selected.signature.flags, flags);
      assert.equal(selected.signature.target, target);
      assert.equal(selected.signature.mapper, mapper);
    }
  }
});

test("invocation returns retain cross-file generic and mapped-member instantiation", () => {
  const current = fixture(`
    import type { Holder, Mapped } from "./bridge.js";
    declare const holder: Holder<string> | undefined;
    declare const mapped: Mapped<{ count: number }> | undefined;
    holder?.get(); holder?.map<number>(1); mapped?.count(1);
  `, `
    export interface Holder<Value> { get(): Value; map<Result>(value: Result): Result; }
    export type Mapped<Value> = { [Key in keyof Value]: (value: Value[Key]) => Value[Key] };
  `);
  assert.deepEqual(current.results.map(result => current.queries.checker.typeToString(result.invocation)), ["string", "number", "number"]);
  assert.deepEqual(current.results.map(result => current.queries.checker.typeToString(result.completion)), ["string | undefined", "number | undefined", "number | undefined"]);
});

test("invocation return queries reject incomplete and contradictory optional wrappers", () => {
  const current = fixture(`declare const callback: (() => number) | undefined; callback?.();`);
  const signature = current.results[0]?.signature;
  assert.ok(signature);
  assert.equal(current.queries.checker.getInvocationReturnTypeOfSignature(undefined), undefined);
  assert.equal(current.queries.checker.getInvocationReturnTypeOfSignature({ ...signature, target: undefined }), undefined);
  assert.equal(current.queries.checker.getInvocationReturnTypeOfSignature({ ...signature, flags: SignatureFlagsCallChainFlags }), undefined);
  const cyclic = { ...signature, flags: 0 };
  cyclic.target = cyclic;
  assert.equal(current.queries.checker.getInvocationReturnTypeOfSignature(cyclic), undefined);
});
