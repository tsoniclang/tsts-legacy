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
