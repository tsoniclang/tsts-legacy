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
});
