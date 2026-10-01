import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

test("union and intersection index queries retain exact inherited and generic constituent declarations", () => {
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
declare const both: Values<number> & Writable<number>;
declare const decorated: Values<number> & { readonly tag: "decorated" };
declare const composed: (Values<number> | Inherited) & Writable<number>;
declare const missingContributor: (Values<number> | { readonly tag: "none" }) & Writable<number>;
declare const readonlyBoth: Values<number> & Inherited;
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
  const componentIds = (nodes: readonly unknown[]) => new Set(nodes.map(node => signatures.findIndex(signature => signature === node)));
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
    assert.ok(info.declaration === undefined);
    assert.equal(source.typeShape.isNumberLike(info.keyType), true);
    assert.deepEqual(componentIds(info.components), new Set([0, 1]));
    assert.equal(Object.isFrozen(info.components), true);
    assert.deepEqual(componentIds(indexFor(name)[0]!.components), componentIds(info.components));
    assert.equal(source.typeShape.isNumberLike(info.valueType), name !== "different");
  }
  assert.deepEqual(indexFor("absent"), []);
  assert.deepEqual(indexFor("mixed"), []);
  assert.ok(indexFor("plain")[0]!.declaration === signatures[0]);
  assert.deepEqual(indexFor("plain")[0]!.components, []);
  for (const name of ["both", "composed"]) {
    const info = indexFor(name)[0]!;
    assert.ok(info.declaration === undefined);
    assert.equal(info.readonly, false);
    assert.equal(source.typeShape.isNumberLike(info.valueType), true);
    assert.deepEqual(componentIds(info.components), new Set([0, 1]));
    assert.equal(Object.isFrozen(info.components), true);
    const variable = variables.find(node => source.ast.text(source.ast.name(node)) === name)!;
    const type = source.checker.getTypeAtLocation(source.ast.name(variable));
    const keyNode = findNodes(file, source.ast.children, source.ast.is.IsNumericLiteral)[0];
    assert.ok(keyNode !== undefined);
    const key = source.checker.getTypeAtLocation(keyNode);
    const selected = source.typeShape.selectIndexedAccess(type, key);
    assert.equal(selected?.kind, "resolved");
    if (selected?.kind !== "resolved") assert.fail("Expected exact intersection index selection");
    assert.equal(source.typeShape.isNumberLike(selected.readType), true);
    assert.equal(source.typeShape.isNumberLike(selected.writeType), true);
    assert.equal(selected.members[0]?.kind, "index");
    if (selected.members[0]?.kind !== "index") assert.fail("Expected exact index member");
    assert.deepEqual(componentIds(selected.members[0].index.components), componentIds(info.components));
    assert.equal(Object.isFrozen(selected.members[0].index), true);
  }
  assert.ok(indexFor("decorated")[0]!.declaration === signatures[0]);
  assert.ok(indexFor("missingContributor")[0]!.declaration === undefined);
  assert.equal(indexFor("missingContributor")[0]!.readonly, false);
  assert.deepEqual(componentIds(indexFor("missingContributor")[0]!.components), new Set([0, 1]));
  assert.equal(indexFor("readonlyBoth")[0]!.readonly, true);
  assert.deepEqual(componentIds(indexFor("readonlyBoth")[0]!.components), new Set([0]));
});

test("index provenance accounting fails closed without changing the checked index type", () => {
  const names = Array.from({ length: 2_050 }, (_, index) => `Values${index}`);
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": names.map((name, index) => `interface ${name} { [key: number]: number; readonly tag: ${index}; }`).join("\n") +
      `\ntype Many = ${names.join(" | ")};`,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file !== undefined);
  const source = checked.getSourceFileQueries(file);
  const alias = findNodes(file, source.ast.children, source.ast.is.IsTypeAliasDeclaration)[0];
  assert.ok(alias !== undefined);
  const type = source.checker.getTypeAtLocation(source.ast.name(alias));
  const indexes = source.typeShape.getIndexInfos(type);
  assert.equal(indexes.length, 1);
  assert.equal(source.typeShape.isNumberLike(indexes[0]!.keyType), true);
  assert.equal(source.typeShape.isNumberLike(indexes[0]!.valueType), true);
  assert.deepEqual(indexes[0]!.components, []);
  assert.equal(Object.isFrozen(indexes[0]!.components), true);
});
