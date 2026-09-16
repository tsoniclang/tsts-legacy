import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { createExtensionConditionalCapture } from "../internal/checker/checker/conditional-evidence.js";
import { Type_AsConditionalType } from "../internal/checker/types.js";

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
export type Preserve<T> = T extends object ? number : T;
export type Replace<T> = T extends object ? T : number;
export type Relayed<Value> = Preserve<Value>;
export type Tail<T> = T extends Stored<infer S> ? S : T extends string ? boolean : T;
export type Default<T = string> = T[];
export type DependentDefault<T = string, Next = T[]> = { first: T; next: Next };
`,
      "/src/index.ts": `
import type { Stored, Storage, Default } from "./storage.js";
export type Text = string;
export type Scalar = number;
export type Wrapped = Stored<{ value: number }>;
export type RecordValue = { value: number };
export type Unrelated = { other: string };
export type Narrow = 7;
export type Optional = Wrapped | undefined;
export type Open<T> = T;
export type Empty = never;
export type Broad = any;
export function read<T>(value: Storage<T>): Storage<T> { return value; }
export function defaulted(value: Default): Default { return value; }
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

function functionParameterType(source: SourceFileQueries, name: string): Type {
  const declaration = findNodes(source.sourceFile, source.ast.children, source.ast.is.IsFunctionDeclaration)
    .find(candidate => source.ast.text(source.ast.name(candidate)) === name);
  assert.ok(declaration);
  const parameter = source.ast.parameters(declaration)[0];
  assert.ok(parameter);
  const typeNode = source.ast.typeNode(parameter);
  assert.ok(typeNode);
  const type = source.typeShape.getTypeFromTypeNode(typeNode);
  assert.ok(type);
  return type;
}

test("retained alias applications expose inferred conditional arguments without type-reference syntax", () => {
  const { source, definitions } = applicationSource();
  const type = functionParameterType(source, "read");
  assert.deepEqual(source.typeShape.getTypeArguments(type), []);
  const selected = source.typeShape.getTypeAliasApplication(type);
  assert.ok(selected);
  assert.equal(selected.kind, "conditional");
  assert.equal(selected.declaration, alias(definitions, "Storage"));
  assert.equal(selected.result, type);
  assert.equal(selected.bindings.length, 1);
  assert.equal(selected.conditionalSteps[0]?.branch, "deferred");
  assert.equal(source.checker.getSymbolName(source.checker.getTypeSymbol(selected.bindings[0]?.argument)), "T");
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.bindings), true);
  assert.equal(selected.bindings.every(Object.isFrozen), true);
  assert.equal(selected.conditionalSteps.every(Object.isFrozen), true);
  for (const queries of [source, definitions]) {
    const repeated = queries.typeShape.getTypeAliasApplication(type);
    assert.ok(repeated);
    assert.equal(repeated.result, type);
    assert.equal(repeated.bindings[0]?.argument, selected.bindings[0]?.argument);
  }
  const defaulted = source.typeShape.getTypeAliasApplication(functionParameterType(source, "defaulted"));
  assert.ok(defaulted);
  assert.equal(defaulted.declaration, alias(definitions, "Default"));
  assert.equal(source.typeShape.isStringLike(defaulted.bindings[0]?.argument), true);
});

test("alias result queries reject foreign programs and do not invent erased provenance", () => {
  const { source, definitions } = applicationSource();
  const foreign = applicationSource();
  const local = functionParameterType(source, "read");
  assert.equal(foreign.source.typeShape.getTypeAliasApplication(local), undefined);
  assert.equal(source.typeShape.getTypeAliasApplication(functionParameterType(foreign.source, "read")), undefined);
  assert.equal(source.typeShape.getTypeAliasApplication(undefined), undefined);
  const scalar = aliasType(source, "Scalar");
  const application = source.typeShape.instantiateTypeAlias(alias(definitions, "Preserve"), [scalar]);
  assert.ok(application);
  assert.equal(application.result, scalar);
  assert.equal(source.typeShape.getTypeAliasApplication(scalar), undefined);
});

test("default alias arguments retain dependent substitutions and exact supplied arity", () => {
  const { source, definitions } = applicationSource();
  const declaration = alias(definitions, "DependentDefault");
  const omitted = source.typeShape.instantiateTypeAlias(declaration, []);
  assert.ok(omitted);
  assert.equal(omitted.bindings.length, 2);
  assert.equal(source.typeShape.isStringLike(omitted.bindings[0]?.argument), true);
  const omittedElements = source.typeShape.getTypeArguments(omitted.bindings[1]?.argument);
  assert.equal(omittedElements.length, 1);
  assert.equal(source.typeShape.isStringLike(omittedElements[0]), true);
  const scalar = aliasType(source, "Scalar");
  const partial = source.typeShape.instantiateTypeAlias(declaration, [scalar]);
  assert.ok(partial);
  assert.ok(partial.bindings[0]?.argument === scalar);
  const partialElements = source.typeShape.getTypeArguments(partial.bindings[1]?.argument);
  assert.equal(partialElements.length, 1);
  assert.ok(partialElements[0] === scalar);
  const text = aliasType(source, "Text");
  const explicit = source.typeShape.instantiateTypeAlias(declaration, [scalar, text]);
  assert.ok(explicit);
  assert.ok(explicit.bindings[1]?.argument === text);
  assert.ok(source.typeShape.instantiateTypeAlias(declaration, [scalar, text, text]) === undefined);
  assert.ok(source.typeShape.instantiateTypeAlias(declaration, new Array<Type>(1)) === undefined);
  assert.ok(Object.isFrozen(partial.bindings) && partial.bindings.every(Object.isFrozen));
});

test("conditional evidence accounting rejects oversized captures without changing normal checking", () => {
  const { source, definitions } = applicationSource();
  const template = aliasType(definitions, "Storage");
  const root = Type_AsConditionalType(template)?.root;
  assert.ok(root);
  const capture = createExtensionConditionalCapture();
  for (let index = 0; index < 1_024; index += 1) {
    capture.record(root, "deferred", undefined, undefined);
  }
  assert.equal(capture.complete, true);
  assert.equal(capture.steps.length, 1_024);
  assert.equal(Object.isFrozen(capture.steps), true);
  capture.record(root, "deferred", undefined, undefined);
  assert.equal(capture.complete, false);
  capture.record(root, "deferred", undefined, undefined);
  assert.equal(capture.steps.length, 1_024);
  const parameter = root.outerTypeParameters[0];
  assert.ok(parameter);
  const oversized = createExtensionConditionalCapture();
  oversized.record({ ...root, outerTypeParameters: Array(8_193).fill(parameter) },
    "deferred", undefined, undefined);
  assert.equal(oversized.complete, false);
  assert.equal(oversized.steps.length, 0);
  const ordinary = source.typeShape.instantiateTypeAlias(alias(definitions, "Storage"),
    [aliasType(source, "Scalar")]);
  assert.ok(ordinary);
  assert.equal(source.typeShape.isNumberLike(ordinary.result), true);
});

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
  const supplied = [wrapped];
  const retained = source.typeShape.instantiateTypeAlias(storage, supplied);
  assert.ok(retained);
  supplied[0] = scalar;
  assert.equal(retained.bindings[0]?.argument, wrapped);
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

test("conditional application provenance distinguishes equal checker results with different source types", () => {
  const { source, definitions } = applicationSource();
  const scalar = aliasType(source, "Scalar");
  for (const name of ["Preserve", "Replace"] as const) {
    const declaration = alias(definitions, name);
    const first = source.typeShape.instantiateTypeAlias(declaration, [scalar]);
    const cached = source.typeShape.instantiateTypeAlias(declaration, [scalar]);
    assert.ok(first && cached);
    assert.equal(first.result, scalar);
    assert.equal(cached.result, first.result);
    assert.equal(first.conditionalSteps.length, 1);
    const step = first.conditionalSteps[0]!;
    assert.equal(step.branch, "false");
    assert.ok(step.selectedNode);
    assert.equal(source.ast.is.IsTypeReferenceNode(step.selectedNode), name === "Preserve");
    assert.equal(step.selectedType, scalar);
    assert.equal(step.bindings[0]?.argument, scalar);
    assert.equal(cached.conditionalSteps[0]?.selectedNode, step.selectedNode);
    assert.equal(Object.isFrozen(first.conditionalSteps), true);
    assert.equal(Object.isFrozen(step), true);
    assert.equal(Object.isFrozen(step.bindings), true);
    assert.equal(Object.isFrozen(step.bindings[0]?.declarations), true);
  }
  const relayed = source.typeShape.instantiateTypeAlias(alias(definitions, "Relayed"), [scalar]);
  assert.ok(relayed);
  assert.equal(relayed.kind, "conditional");
  assert.equal(relayed.conditionalSteps[0]?.bindings[0]?.applicationParameter, relayed.bindings[0]?.parameter);
});

test("conditional application provenance retains inferred bindings, distribution and tail selections", () => {
  const { source, definitions } = applicationSource();
  const declaration = alias(definitions, "Storage");
  const wrapped = source.typeShape.instantiateTypeAlias(declaration, [aliasType(source, "Wrapped")]);
  assert.ok(wrapped);
  const selected = wrapped.conditionalSteps[0]!;
  assert.equal(selected.branch, "true");
  const inferred = selected.bindings.find(binding => binding.declarations.some(node =>
    source.ast.text(source.ast.name(node)) === "S"));
  assert.ok(inferred);
  assert.equal(source.typeShape.isTypeIdenticalTo(inferred.argument, wrapped.result), true);
  const optional = source.typeShape.instantiateTypeAlias(declaration, [aliasType(source, "Optional")]);
  assert.ok(optional);
  assert.deepEqual(optional.conditionalSteps.map(step => step.branch).sort(), ["false", "true"]);
  const open = source.typeShape.instantiateTypeAlias(declaration, [aliasType(source, "Open")]);
  assert.ok(open);
  assert.deepEqual(open.conditionalSteps.map(step => step.branch), ["deferred"]);
  assert.equal(open.conditionalSteps[0]?.selectedNode, undefined);
  const empty = source.typeShape.instantiateTypeAlias(declaration, [aliasType(source, "Empty")]);
  assert.ok(empty);
  assert.equal(source.typeShape.isNever(empty.result), true);
  assert.deepEqual(empty.conditionalSteps, []);
  const broad = source.typeShape.instantiateTypeAlias(declaration, [aliasType(source, "Broad")]);
  assert.ok(broad);
  assert.deepEqual(broad.conditionalSteps.map(step => step.branch), ["true", "false"]);
  const tail = source.typeShape.instantiateTypeAlias(alias(definitions, "Tail"), [aliasType(source, "Text")]);
  assert.ok(tail);
  assert.equal(source.typeShape.isBooleanLike(tail.result), true);
  assert.deepEqual(tail.conditionalSteps.map(step => step.branch), ["false", "true"]);
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
  const wrongArity = new Proxy([valid.result, valid.result], {
    get(target, key, receiver) {
      assert.notEqual(key, "0", "invalid arity must be rejected before reading arguments");
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(source.typeShape.instantiateTypeAlias(constrained, wrongArity), undefined);
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

test("alias queries preserve retained argument ownership across files in one checked program", () => {
  const { source, definitions } = applicationSource();
  const declaration = alias(definitions, "Storage");
  const scalar = aliasType(source, "Scalar");
  const local = aliasType(definitions, "Constant");
  assert.notEqual(scalar.checker, local.checker);
  for (const queries of [source, definitions]) {
    for (const argument of [scalar, local]) {
      const application = queries.typeShape.instantiateTypeAlias(declaration, [argument]);
      assert.ok(application);
      assert.equal(application.bindings[0]?.argument, argument);
      assert.equal(application.result.checker, argument.checker);
      assert.equal(queries.typeShape.isNumberLike(application.result), true);
    }
  }
  const foreign = applicationSource();
  assert.equal(definitions.typeShape.instantiateTypeAlias(declaration, [aliasType(foreign.source, "Scalar")]), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(alias(foreign.definitions, "Storage"), [scalar]), undefined);
  assert.equal(source.typeShape.instantiateTypeAlias(alias(definitions, "Pair"), [scalar, local]), undefined);
});
