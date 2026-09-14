import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function applicationSource() {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/storage.ts": `
export declare const storage: unique symbol;
export interface Stored<S> { readonly [storage]: S; }
export type Storage<T> = T extends Stored<infer S> ? S : T;
export type Rows<T> = { value: Storage<T>; rows: Storage<T>[] };
export type Constrained<T extends { value: number }> = T["value"];
export type Second<T, S extends T> = S;
export type Pair<T, S> = [T, S];
export type Constant = number;
`,
      "/src/index.ts": `
import type { Stored } from "./storage.js";
export type Text = string;
export type Scalar = number;
export type Wrapped = Stored<{ value: number }>;
export type RecordValue = { value: number };
export type Unrelated = { other: string };
export type Narrow = 7;
export type Optional = Wrapped | undefined;
export type Open<T> = T;
`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const file = checked.getSourceFile("/src/index.ts");
  const definitions = checked.getSourceFile("/src/storage.ts");
  assert.ok(file && definitions);
  return { source: checked.getSourceFileQueries(file), definitions: checked.getSourceFileQueries(definitions) };
}

function alias(source: SourceFileQueries, name: string) {
  const node = findNodes(source.sourceFile, source.ast.children, source.ast.is.IsTypeAliasDeclaration)
    .find(declaration => source.ast.text(source.ast.name(declaration)) === name);
  assert.ok(node, name);
  return node;
}

function aliasType(source: SourceFileQueries, name: string): Type {
  const typeNode = source.ast.typeNode(alias(source, name));
  assert.ok(typeNode, name);
  const type = source.typeShape.getTypeFromTypeNode(typeNode);
  assert.ok(type, name);
  return type;
}

test("alias applications preserve conditional inference, identity and cross-file ownership", () => {
  const { source, definitions } = applicationSource();
  const scalar = aliasType(source, "Scalar");
  const wrapped = aliasType(source, "Wrapped");
  const storage = alias(definitions, "Storage");
  const number = source.typeShape.instantiateTypeAlias(storage, [scalar]);
  assert.ok(number);
  assert.equal(source.typeShape.isNumberLike(number.result), true);
  const record = source.typeShape.instantiateTypeAlias(storage, [wrapped]);
  assert.ok(record);
  const properties = source.typeShape.getPropertyInfos(record.result);
  assert.deepEqual(properties.map(property => property.name), ["value"]);
  assert.equal(source.typeShape.isNumberLike(properties[0]?.type), true);
  assert.equal(record.declaration, storage);
  assert.equal(record.bindings[0]?.argument, wrapped);
  assert.equal(source.ast.text(source.ast.name(record.bindings[0]?.declaration)), "T");
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.bindings), true);
  assert.equal(record.bindings.every(Object.isFrozen), true);
  const repeated = source.typeShape.instantiateTypeAlias(storage, [wrapped]);
  assert.ok(repeated);
  assert.equal(source.typeShape.isTypeIdenticalTo(record.result, repeated.result), true);
  const rows = source.typeShape.instantiateTypeAlias(alias(definitions, "Rows"), [wrapped]);
  assert.ok(rows);
  const row = source.typeShape.getPropertyInfos(rows.result).find(property => property.name === "rows");
  assert.ok(row);
  assert.equal(source.typeShape.isArrayLike(row.type), true);
  const rowType = source.typeShape.getTypeArguments(row.type)[0];
  assert.ok(rowType);
  assert.equal(source.typeShape.isTypeIdenticalTo(rowType, record.result), true);
  const optional = source.typeShape.instantiateTypeAlias(storage, [aliasType(source, "Optional")]);
  assert.ok(optional);
  assert.equal(source.typeShape.isUnion(optional.result), true);
  assert.equal(source.typeShape.getUnionOrIntersectionTypes(optional.result)
    .filter(member => source.typeShape.isNullish(member)).length, 1);
  const open = source.typeShape.instantiateTypeAlias(storage, [aliasType(source, "Open")]);
  assert.ok(open);
  assert.equal(source.typeShape.couldContainTypeVariables(open.result), true);
  const constant = source.typeShape.instantiateTypeAlias(alias(definitions, "Constant"), []);
  assert.ok(constant);
  assert.equal(source.typeShape.isNumberLike(constant.result), true);
});

test("alias applications preserve constraints and reject malformed or mixed-owner selections", () => {
  const { source, definitions } = applicationSource();
  const constrained = alias(definitions, "Constrained");
  const valid = source.typeShape.instantiateTypeAlias(constrained, [aliasType(source, "RecordValue")]);
  assert.ok(valid);
  assert.equal(source.typeShape.isNumberLike(valid.result), true);
  assert.equal(source.typeShape.instantiateTypeAlias(constrained, [aliasType(source, "Unrelated")]), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(constrained, []), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(constrained, [valid.result, valid.result]), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(source.sourceFile, []), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(undefined, []), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(constrained, new Array<Type>(1)), undefined);
  const second = alias(definitions, "Second");
  const selected = source.typeShape.instantiateTypeAlias(second, [aliasType(source, "Scalar"), aliasType(source, "Narrow")]);
  assert.ok(selected);
  assert.equal(source.typeShape.getNumericLiteralTypeValue(selected.result), 7);
  assert.equal(source.typeShape.instantiateTypeAlias(second, [aliasType(source, "Scalar"), aliasType(source, "Text")]), undefined);
  const foreign = applicationSource();
  assert.equal(source.typeShape.instantiateTypeAlias(constrained, [aliasType(foreign.source, "RecordValue")]), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(alias(foreign.definitions, "Constant"), []), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(alias(definitions, "Pair"),
    [aliasType(source, "Scalar"), aliasType(foreign.source, "Text")]), undefined);
});
