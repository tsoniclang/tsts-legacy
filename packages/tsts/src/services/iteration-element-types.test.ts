import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "../internal/ast/ast.js";
import { createCompilerSessionFromFiles } from "./compiler-session.js";

test("iteration element queries retain the checker's protocol types without requiring a loop", () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files: { "/src/index.ts": `
    declare const array: readonly number[];
    declare const set: Set<string>;
    declare const map: Map<string, number>;
    function* values() { yield true; }
    const generator = values();
    declare const custom: Iterable<bigint>;
    declare const opaque: any;
    declare const opaqueElement: Iterable<any>;
    declare const nonIterable: { readonly value: number };
    export {};
  ` }, compilerOptions: { strict: true, target: "es2022", module: "esnext" } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0, "the five iterable types are valid checked source");
  const file = checked.getSourceFile("/src/index.ts");
  assert.equal(file !== undefined, true, "the actual source file exists");
  const source = checked.getSourceFileQueries(file!);
  const queries = source.checker;
  const declarations: Node[] = [];
  const visit = (node: Node): void => {
    if (source.ast.is.IsVariableDeclaration(node)) declarations.push(node);
    source.ast.forEachChild(node, visit);
  };
  visit(file!);
  const expected = new Map([
    ["array", "number"],
    ["set", "string"],
    ["map", "[string, number]"],
    ["generator", "boolean"],
    ["custom", "bigint"],
  ]);
  for (const declaration of declarations) {
    const name = source.ast.text(source.ast.name(declaration));
    const type = queries.getIterationElementType(declaration);
    const expectedType = expected.get(name);
    if (expectedType === undefined) {
      assert.equal(type === undefined, true, `${name}: an unchecked or non-iterable input stays unresolved`);
      continue;
    }
    assert.equal(type !== undefined, true, `${name}: the actual protocol supplies an element type`);
    assert.equal(queries.typeToString(type), expectedType, `${name}: the element is not guessed from the first type argument`);
    assert.equal(queries.getIterationElementType(declaration) === type, true, `${name}: repeat queries retain canonical identity`);
  }
  assert.equal(declarations.length, 8, "all five iterable shapes and three unresolved controls were checked");
  assert.equal(queries.getIterationElementType(undefined) === undefined, true, "absence has no manufactured iteration type");
  assert.equal(session.checkSource().diagnostics.length, 0, "iteration queries add no source diagnostics");
});
