import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function aliases(source: SourceFileQueries): ReadonlyMap<string, Type> {
  return new Map(findNodes(source.sourceFile, source.ast.children, source.ast.is.IsTypeAliasDeclaration).map(node => {
    const type = source.typeShape.getTypeFromTypeNode(source.ast.typeNode(node));
    assert.ok(type);
    return [source.ast.text(source.ast.name(node)), type];
  }));
}

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
