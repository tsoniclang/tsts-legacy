import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

test("intrinsic object identity remains exact across aliases and source query owners", () => {
  const declarations = `export type Broad = object; export type Alias = Broad;
    export type Empty = {}; export interface EmptyInterface {}
    export type Interface = EmptyInterface; export class EmptyClass {}
    export type Class = EmptyClass; export type Record = { value: number };
    export type Text = string; export type Numeric = number;
    export type Wide = bigint; export type Truth = boolean;
    export type Absent = null | undefined; export type Mixed = object | null;
    export type Unknown = unknown; export type Any = any;
    export type Never = never; export type Parameter<Value extends object> = Value;`;
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/first.ts": declarations,
      "/src/second.ts": `${declarations} import type { Alias as Imported } from "./first.js";
        export type CrossFile = Imported;`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const owners = ["/src/first.ts", "/src/second.ts"].map(name => {
    const file = checked.getSourceFile(name);
    assert.equal(file !== undefined, true, name);
    return checked.getSourceFileQueries(file!);
  });
  for (const query of owners) {
    assert.equal(query.typeShape.isNonPrimitive(undefined), false);
    for (const owner of owners) {
      const aliases = findNodes(owner.sourceFile, owner.ast.children, owner.ast.is.IsTypeAliasDeclaration);
      for (const declaration of aliases) {
        const name = owner.ast.text(owner.ast.name(declaration));
        const type = owner.typeShape.getTypeFromTypeNode(owner.ast.typeNode(declaration));
        assert.equal(type !== undefined, true, name);
        assert.equal(query.typeShape.isNonPrimitive(type), ["Broad", "Alias", "CrossFile"].includes(name), name);
      }
    }
  }
});
