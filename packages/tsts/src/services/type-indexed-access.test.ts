import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function fixture() {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/models.ts": `
export interface Base<Value> { value: Value; }
export interface Model extends Base<number> { optional?: string; readonly locked: boolean; }
export interface Accessors { get value(): number; set value(input: number | string); }
`,
      "/src/index.ts": `
import type { Model, Accessors } from "./models.js";
export type RecordValue = Model;
export type AccessorValue = Accessors;
export type Mapped = { readonly [Key in keyof Model]?: Model[Key] };
export type ReadonlyIndex = { readonly [key: string]: number };
export type MutableIndex = { [key: string]: string };
export type Tuple = readonly [number, string];
export type ValueKey = "value";
export type OptionalKey = "optional";
export type LockedKey = "locked";
export type Keys = "value" | "optional";
export type BadKeys = "value" | "missing";
export type MissingKey = "missing";
export type ZeroKey = 0;
export type OneKey = 1;
export type StringKey = string;
export type NeverKey = never;
export type NumberValue = number;
export type StringValue = string;
export type NumberOrString = number | string;
export type OptionalString = string | undefined;
export type OptionalNumber = number | undefined;
export type Open<Source, Key extends keyof Source> = Source[Key];
export type BooleanValue = boolean;
`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", noUncheckedIndexedAccess: true },
  }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const file = checked.getSourceFile("/src/index.ts");
  const models = checked.getSourceFile("/src/models.ts");
  assert.ok(file && models);
  return { source: checked.getSourceFileQueries(file), models: checked.getSourceFileQueries(models) };
}

function alias(source: SourceFileQueries, name: string): Type {
  const declaration = findNodes(source.sourceFile, source.ast.children, source.ast.is.IsTypeAliasDeclaration)
    .find(node => source.ast.text(source.ast.name(node)) === name);
  const typeNode = declaration === undefined ? undefined : source.ast.typeNode(declaration);
  const type = typeNode === undefined ? undefined : source.typeShape.getTypeFromTypeNode(typeNode);
  assert.ok(type, name);
  return type;
}

function selected(source: SourceFileQueries, owner: string, key: string) {
  const result = source.typeShape.selectIndexedAccess(alias(source, owner), alias(source, key));
  assert.ok(result?.kind === "resolved");
  return result;
}

test("indexed type selections retain inherited member identities and optional read types", () => {
  const {source, models} = fixture();
  const value = selected(source, "RecordValue", "ValueKey");
  assert.equal(source.typeShape.isTypeIdenticalTo(value.readType, alias(source, "NumberValue")), true);
  assert.equal(value.members.length, 1);
  const member = value.members[0]!;
  assert.equal(member.kind, "property");
  if (member.kind !== "property") return;
  assert.equal(member.property.name, "value");
  const inherited = findNodes(models.sourceFile, models.ast.children,
    node => models.ast.kindName(node) === "KindPropertySignature")
    .find(node => models.ast.text(models.ast.name(node)) === "value");
  assert.ok(inherited);
  assert.ok(member.property.rootSymbols.some(symbol => source.checker.getSymbolDeclarations(symbol).includes(inherited)));
  const optional = selected(source, "RecordValue", "OptionalKey");
  assert.equal(source.typeShape.isTypeIdenticalTo(optional.readType, alias(source, "OptionalString")), true);
  assert.ok(optional.members[0]?.kind === "property" && optional.members[0].property.optional);
  const locked = selected(source, "RecordValue", "LockedKey");
  assert.ok(locked.members[0]?.kind === "property" && locked.members[0].property.readonly);
});

test("indexed type queries preserve separate getter/setter types and mapped modifiers", () => {
  const {source} = fixture();
  const accessor = selected(source, "AccessorValue", "ValueKey");
  assert.equal(source.typeShape.isTypeIdenticalTo(accessor.readType, alias(source, "NumberValue")), true);
  assert.equal(source.typeShape.isTypeIdenticalTo(accessor.writeType, alias(source, "NumberOrString")), true);
  const mapped = selected(source, "Mapped", "ValueKey");
  assert.equal(source.typeShape.isTypeIdenticalTo(mapped.readType, alias(source, "OptionalNumber")), true);
  assert.ok(mapped.members[0]?.kind === "property");
  assert.equal(mapped.members[0].property.optional, true);
  assert.equal(mapped.members[0].property.readonly, true);
});

test("union keys retain all selected members and the checker's read/write combination", () => {
  const {source} = fixture();
  const result = selected(source, "RecordValue", "Keys");
  assert.deepEqual(result.members.map(member => member.kind === "property" ? member.property.name : "index").sort(),
    ["optional", "value"]);
  assert.equal(source.typeShape.isUnion(result.readType), true);
  assert.equal(source.typeShape.isNever(result.writeType), true);
  assert.equal(source.typeShape.selectIndexedAccess(alias(source, "RecordValue"), alias(source, "BadKeys")), undefined);
  assert.equal(source.typeShape.selectIndexedAccess(alias(source, "RecordValue"), alias(source, "MissingKey")), undefined);
});

test("index signatures and tuple keys retain their actual declaration evidence", () => {
  const {source} = fixture();
  const dictionary = selected(source, "ReadonlyIndex", "StringKey");
  assert.equal(source.typeShape.isTypeIdenticalTo(dictionary.readType, alias(source, "NumberValue")), true);
  assert.ok(dictionary.members[0]?.kind === "index");
  assert.equal(dictionary.members[0].index.readonly, true);
  assert.ok(dictionary.members[0].index.declaration);
  const mutable = selected(source, "MutableIndex", "MissingKey");
  assert.ok(mutable.members[0]?.kind === "index");
  assert.equal(mutable.members[0].index.readonly, false);
  assert.equal(source.typeShape.isTypeIdenticalTo(selected(source, "Tuple", "ZeroKey").readType, alias(source, "NumberValue")), true);
  assert.equal(source.typeShape.isTypeIdenticalTo(selected(source, "Tuple", "OneKey").readType, alias(source, "StringValue")), true);
});

test("deferred indexed types expose exact components without fabricating concrete members", () => {
  const {source} = fixture();
  const open = alias(source, "Open");
  const components = source.typeShape.getIndexedAccessComponents(open);
  assert.ok(components);
  assert.ok(Object.isFrozen(components));
  const result = source.typeShape.selectIndexedAccess(components.objectType, components.indexType);
  assert.ok(result?.kind === "deferred");
  assert.equal(source.typeShape.isTypeIdenticalTo(result.readType, open), true);
  const selectedComponents = source.typeShape.getIndexedAccessComponents(result.readType);
  assert.ok(selectedComponents);
  assert.ok(selectedComponents.objectType === components.objectType, "Deferred selection must retain the exact object type");
  assert.ok(selectedComponents.indexType === components.indexType, "Deferred selection must retain the exact index type");
  assert.ok(source.typeShape.selectIndexedAccess(components.objectType, components.indexType)?.readType === result.readType,
    "Repeated deferred selections must retain the same checker type");
  assert.equal(source.typeShape.getIndexedAccessComponents(alias(source, "NumberValue")), undefined);
});

test("an empty key domain preserves the checker's never result without inventing a member", () => {
  const {source} = fixture();
  const result = selected(source, "RecordValue", "NeverKey");
  assert.equal(source.typeShape.isNever(result.readType), true);
  assert.equal(source.typeShape.isNever(result.writeType), true);
  assert.deepEqual(result.members, []);
  assert.ok(Object.isFrozen(result.members));
});

test("indexed selections reject foreign types and publish immutable complete rows", () => {
  const {source} = fixture();
  const foreign = fixture().source;
  const owner = alias(source, "RecordValue");
  const key = alias(source, "ValueKey");
  assert.ok(source.typeShape.selectIndexedAccess(owner, alias(foreign, "ValueKey")) === undefined, "Foreign index types must be rejected");
  assert.ok(source.typeShape.selectIndexedAccess(alias(foreign, "RecordValue"), alias(foreign, "ValueKey")) === undefined, "Foreign object and index types must be rejected");
  assert.ok(source.typeShape.getIndexedAccessComponents(alias(foreign, "Open")) === undefined, "Foreign indexed types must be rejected");
  assert.equal(source.typeShape.selectIndexedAccess(undefined, key), undefined);
  assert.equal(source.typeShape.selectIndexedAccess(owner, undefined), undefined);
  const result = selected(source, "RecordValue", "ValueKey");
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.members) && Object.isFrozen(result.members[0]));
  assert.ok(result.members[0]?.kind === "property" && Object.isFrozen(result.members[0].property));
  assert.ok(source.typeShape.selectIndexedAccess(owner, key)?.readType === result.readType, "Repeated queries must preserve read-type identity");
});
