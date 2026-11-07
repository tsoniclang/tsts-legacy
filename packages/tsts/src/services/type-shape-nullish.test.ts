import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function parameterTypes(source: SourceFileQueries): ReadonlyMap<string, Type> {
  return new Map(findNodes(source.sourceFile, source.ast.children, source.ast.is.IsParameterDeclaration).map(node => {
    const type = source.typeShape.getTypeFromTypeNode(source.ast.typeNode(node));
    assert.equal(type !== undefined, true);
    return [source.ast.text(source.ast.name(node)), type!];
  }));
}

test("non-nullable selection preserves checked generic aliases and exact payloads across query owners", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/contracts.ts": `export type Region<T> = { value: T } | { at: () => T };`,
    "/src/index.ts": `import type { Region } from "./contracts.js";
      export declare function accept(Direct: Region<bigint>, Optional: Region<bigint> | undefined,
        Nullable: Region<bigint> | null, Mixed: Region<bigint> | null | undefined,
        Literal: 9007199254740993n | null | undefined, Absent: null | undefined): void;`,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const owner = checked.getSourceFile("/src/index.ts");
  assert.equal(owner !== undefined, true);
  const types = parameterTypes(checked.getSourceFileQueries(owner!));
  for (const name of ["/src/index.ts", "/src/contracts.ts"]) {
    const file = checked.getSourceFile(name);
    assert.equal(file !== undefined, true);
    const shape = checked.getSourceFileQueries(file!).typeShape;
    const direct = types.get("Direct");
    const expected = shape.getTypeAliasApplication(direct);
    assert.equal(expected !== undefined, true);
    for (const name of ["Direct", "Optional", "Nullable", "Mixed"]) {
      const selected = shape.getNonNullableType(types.get(name));
      assert.equal(shape.isTypeIdenticalTo(selected, direct), true, name);
      const application = shape.getTypeAliasApplication(selected);
      assert.equal(application?.declaration === expected!.declaration, true, name);
      assert.equal(application?.bindings.length, expected!.bindings.length, name);
      assert.equal(application?.bindings[0]?.argument === expected!.bindings[0]?.argument, true, name);
      assert.equal(shape.getUnionOrIntersectionTypes(selected).some(member => shape.isNullish(member)), false, name);
    }
    assert.equal(shape.getNumericLiteralTypeValue(shape.getNonNullableType(types.get("Literal"))), 9007199254740993n);
    assert.equal(shape.isNever(shape.getNonNullableType(types.get("Absent"))), true);
    assert.equal(shape.getNonNullableType(undefined), undefined);
  }
});

test("intrinsic nullish flags retain original constituents without choosing union admission", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": `type Missing = undefined;
      type Empty = null;
      export declare function inspect(NullOnly: Empty, UndefinedOnly: Missing,
        Neither: string, Broad: unknown, Dynamic: any, NoResult: void,
        Mixed: string | null | undefined): void;`,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true } }).checkSource();
  assert.equal(checked.diagnostics.length === 0 && checked.extensionDiagnostics.length === 0, true,
    "the original scalar and aliased nullish components have valid checked Source");
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.equal(sourceFile !== undefined, true, "the original owner file is retained");
  const source = checked.getSourceFileQueries(sourceFile!);
  const types = parameterTypes(source);
  for (const [name, admitsNull, admitsUndefined] of [
    ["NullOnly", true, false], ["UndefinedOnly", false, true],
    ["Neither", false, false], ["Broad", false, false],
    ["Dynamic", false, false], ["NoResult", false, false],
  ] as const) {
    const flags = source.typeShape.intrinsicNullishFlags(types.get(name));
    assert.equal(flags.null === admitsNull && flags.undefined === admitsUndefined, true,
      `${name}: only the exact original intrinsic constituent flags are exposed`);
    assert.equal(Object.isFrozen(flags), true, `${name}: the factual pair is immutable`);
    assert.equal(source.typeShape.isNullish(types.get(name)) === (admitsNull || admitsUndefined), true,
      `${name}: the existing combined nullish query is unchanged`);
  }
  const union = types.get("Mixed");
  const direct = source.typeShape.intrinsicNullishFlags(union);
  assert.equal(direct.null === false && direct.undefined === false, true,
    "the factual reader does not recursively classify a union or infer operation-site admission");
  const components = source.typeShape.getUnionOrIntersectionTypes(union);
  const flags = components.map(component => source.typeShape.intrinsicNullishFlags(component));
  assert.equal(flags.length === 3 && flags.filter(value => value.null).length === 1 &&
    flags.filter(value => value.undefined).length === 1, true,
  "the existing component query retains the exact independent null and undefined constituents");
  const absent = source.typeShape.intrinsicNullishFlags(undefined);
  assert.equal(absent.null === false && absent.undefined === false && Object.isFrozen(absent), true,
    "missing checked type does not manufacture either intrinsic fact");
  const foreignOwner = checked.getSourceFile("/src/core.d.ts");
  const second = checked.getSourceFileQueries(foreignOwner!).typeShape;
  assert.equal(second.intrinsicNullishFlags(types.get("NullOnly")).null === true &&
    second.intrinsicNullishFlags(types.get("UndefinedOnly")).undefined === true, true,
  "query-file ownership does not reinterpret the same checked original intrinsic type");
});
