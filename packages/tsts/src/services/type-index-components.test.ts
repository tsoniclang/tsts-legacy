import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

test("union index queries retain exact inherited and generic constituent declarations", () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/types.ts": `
export interface Values<T> { readonly [index: number]: T; }
export interface Writable<T> { [index: number]: T; }
export interface Named { readonly [key: string]: number; }
export interface Inherited extends Values<number> { readonly tag: "inherited"; }
`,
    "/src/index.ts": `
import type { Values, Writable, Named, Inherited } from "./types.js";
type Numeric = Values<number> | Writable<number>;
declare const numeric: Numeric;
declare const inherited: Inherited | Writable<number>;
declare const nested: Numeric | Inherited;
declare const different: Values<number> | Writable<string>;
declare const mixed: Numeric | Named;
declare const absent: Numeric | { readonly tag: "none" };
declare const plain: Values<number>;
const value = numeric[1];
`,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } });
  const checked = session.checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  const file = checked.getSourceFile("/src/index.ts");
  const declarations = checked.getSourceFile("/src/types.ts");
  assert.ok(file !== undefined && declarations !== undefined);
  const source = checked.getSourceFileQueries(file);
  const signatures = findNodes(declarations, source.ast.children, node => source.ast.kindName(node) === "KindIndexSignature");
  assert.equal(signatures.length, 3);
  const variables = findNodes(file, source.ast.children, source.ast.is.IsVariableDeclaration);
  const indexFor = (name: string) => {
    const variable = variables.find(node => source.ast.text(source.ast.name(node)) === name);
    assert.ok(variable !== undefined);
    return source.typeShape.getIndexInfos(source.checker.getTypeAtLocation(source.ast.name(variable)));
  };
  for (const name of ["numeric", "inherited", "nested", "different"]) {
    const indexes = indexFor(name);
    assert.equal(indexes.length, 1);
    const info = indexes[0]!;
    assert.equal(info.readonly, true);
    assert.equal(info.declaration, undefined);
    assert.equal(source.typeShape.isNumberLike(info.keyType), true);
    assert.deepEqual(new Set(info.components), new Set(signatures.slice(0, 2)));
    assert.equal(Object.isFrozen(info.components), true);
    assert.deepEqual(new Set(indexFor(name)[0]!.components), new Set(info.components));
    assert.equal(source.typeShape.isNumberLike(info.valueType), name !== "different");
  }
  assert.deepEqual(indexFor("absent"), []);
  assert.deepEqual(indexFor("mixed"), []);
  assert.equal(indexFor("plain")[0]!.declaration, signatures[0]);
  assert.deepEqual(indexFor("plain")[0]!.components, []);
});
