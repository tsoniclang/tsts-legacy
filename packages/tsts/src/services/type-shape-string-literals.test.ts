import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function aliases(source: SourceFileQueries): ReadonlyMap<string, Type> {
  return new Map(findNodes(source.sourceFile, source.ast.children, source.ast.is.IsTypeAliasDeclaration).map(node => {
    const type = source.typeShape.getTypeFromTypeNode(source.ast.typeNode(node))?.type;
    assert.ok(type);
    return [source.ast.text(source.ast.name(node)), type];
  }));
}

test("an intrinsic alias body retains the native marker, not its any flag or application result", () => {
  const open = () => createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": 'type Uppercase<Text extends string> = intrinsic; type Any = any; type Applied = Uppercase<"mixed">;',
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } }).checkSource();
  const first = open();
  const independent = open();
  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(independent.diagnostics, []);
  const firstFile = first.getSourceFile("/src/index.ts");
  const independentFile = independent.getSourceFile("/src/index.ts");
  assert.ok(firstFile && independentFile);
  const owner = first.getSourceFileQueries(firstFile);
  const differentOwner = independent.getSourceFileQueries(independentFile);
  const values = aliases(owner);
  const marker = values.get("Uppercase");
  const any = values.get("Any");
  const applied = values.get("Applied");
  assert.ok(marker && any && applied);
  assert.equal(owner.typeShape.isAny(marker), true);
  assert.equal(owner.typeShape.isAny(any), true);
  assert.equal(owner.typeShape.isIntrinsicAliasMarker(marker), true);
  assert.equal(owner.typeShape.isIntrinsicAliasMarker(any), false);
  assert.equal(owner.typeShape.isIntrinsicAliasMarker(undefined), false);
  assert.equal(differentOwner.typeShape.isIntrinsicAliasMarker(marker), false);
  assert.equal(owner.typeShape.isIntrinsicAliasMarker(applied), false);
  assert.equal(owner.typeShape.getStringLiteralTypeValue(applied), "MIXED");
});

test("string literal values remain exact across source query owners without widening or text recovery", () => {
  const declarations = `export type Text = "value";
    export type Empty = ""; export type Escaped = "line\\n\\u0000\\u{1f600}";
    export type Other = "other"; export type Broad = string;
    export type Choice = "value" | "other"; export type Numeric = 123;
    export type Wide = 9007199254740993n; export type Truth = true;`;
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/first.ts": declarations,
    "/src/second.ts": declarations,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const firstFile = checked.getSourceFile("/src/first.ts");
  const secondFile = checked.getSourceFile("/src/second.ts");
  assert.ok(firstFile && secondFile);
  const first = checked.getSourceFileQueries(firstFile);
  const second = checked.getSourceFileQueries(secondFile);
  const firstAliases = aliases(first);
  const secondAliases = aliases(second);
  for (const query of [first.typeShape, second.typeShape]) {
    for (const types of [firstAliases, secondAliases]) {
      assert.equal(query.getStringLiteralTypeValue(types.get("Text")), "value");
      assert.equal(query.getStringLiteralTypeValue(types.get("Other")), "other");
      assert.equal(query.getStringLiteralTypeValue(types.get("Empty")), "");
      assert.equal(query.getStringLiteralTypeValue(types.get("Escaped")), "line\n\0😀");
      for (const name of ["Broad", "Choice", "Numeric", "Wide", "Truth"]) {
        assert.equal(query.getStringLiteralTypeValue(types.get(name)), undefined);
      }
      assert.equal(query.getNumericLiteralTypeValue(types.get("Wide")), 9007199254740993n);
    }
    assert.equal(query.getStringLiteralTypeValue(undefined), undefined);
  }
});

test("literal base queries use the checked type owner without discarding literal evidence", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/first.ts": 'export type Text = "first"; export type Wide = 9007199254740993n; export type Choice = "first" | 7; export type Broad = string;',
    "/src/second.ts": 'export type Text = "second"; export type Wide = 18446744073709551615n; export type Choice = "second" | 11; export type Broad = string;',
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } }).checkSource();
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const firstFile = checked.getSourceFile("/src/first.ts");
  const secondFile = checked.getSourceFile("/src/second.ts");
  assert.ok(firstFile && secondFile);
  const first = checked.getSourceFileQueries(firstFile);
  const second = checked.getSourceFileQueries(secondFile);
  for (const query of [first.typeShape, second.typeShape]) {
    for (const [owner, text, integer] of [[first, "first", 9007199254740993n], [second, "second", 18446744073709551615n]] as const) {
      const types = aliases(owner);
      const literal = types.get("Text");
      const wide = types.get("Wide");
      assert.ok(literal && wide);
      const base = query.getBaseTypeOfLiteralType(literal);
      const integerBase = query.getBaseTypeOfLiteralType(wide);
      assert.ok(base && integerBase);
      assert.equal(query.isStringLike(base), true);
      assert.equal(query.getStringLiteralTypeValue(base), undefined);
      assert.equal(query.getStringLiteralTypeValue(literal), text);
      assert.equal(query.isBigIntLike(integerBase), true);
      assert.equal(query.getNumericLiteralTypeValue(integerBase), undefined);
      assert.equal(query.getNumericLiteralTypeValue(wide), integer);
      const choice = types.get("Choice");
      const broad = types.get("Broad");
      assert.ok(choice && broad);
      assert.equal(query.getBaseTypeOfLiteralType(broad), broad);
      const choiceBase = query.getBaseTypeOfLiteralType(choice);
      assert.ok(choiceBase);
      assert.equal(query.isUnion(choiceBase), true);
      assert.equal(query.getUnionOrIntersectionTypes(choiceBase).every(member =>
        query.getStringLiteralTypeValue(member) === undefined && query.getNumericLiteralTypeValue(member) === undefined), true);
    }
    assert.equal(query.getBaseTypeOfLiteralType(undefined), undefined);
  }
});
