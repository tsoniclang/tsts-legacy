import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function aliases(source: SourceFileQueries): ReadonlyMap<string, Type> {
  return new Map(findNodes(source.sourceFile, source.ast.children, source.ast.is.IsTypeAliasDeclaration).map(node => {
    const type = source.typeShape.getTypeFromTypeNode(source.ast.typeNode(node));
    assert.equal(type !== undefined, true);
    return [source.ast.text(source.ast.name(node)), type!];
  }));
}

test("Boolean literal values are exact across query owners without widening", () => {
  const declarations = `export type Yes = true; export type No = false;
    export type Broad = boolean; export type Choice = true | false;
    export type Text = "true"; export type Numeric = 1; export type Wide = 1n;
    export type Mixed = true | string; export type Record = { value: boolean };
    export type Missing = undefined; export type Nil = null;`;
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/core.d.ts": testCoreDeclarations,
    "/src/first.ts": declarations,
    "/src/second.ts": declarations,
  }, compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" } }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const queries = ["/src/first.ts", "/src/second.ts"].map(name => {
    const file = checked.getSourceFile(name);
    assert.equal(file !== undefined, true);
    return checked.getSourceFileQueries(file!);
  });
  for (const query of queries) {
    for (const owner of queries) {
      const types = aliases(owner);
      assert.equal(query.typeShape.getBooleanLiteralTypeValue(types.get("Yes")), true);
      assert.equal(query.typeShape.getBooleanLiteralTypeValue(types.get("No")), false);
      for (const name of ["Broad", "Choice", "Text", "Numeric", "Wide", "Mixed", "Record", "Missing", "Nil"]) {
        assert.equal(query.typeShape.getBooleanLiteralTypeValue(types.get(name)), undefined, name);
      }
      assert.deepEqual(query.typeShape.getUnionOrIntersectionTypes(types.get("Broad"))
        .map(type => query.typeShape.getBooleanLiteralTypeValue(type)).sort(), [false, true]);
    }
    assert.equal(query.typeShape.getBooleanLiteralTypeValue(undefined), undefined);
  }
});
