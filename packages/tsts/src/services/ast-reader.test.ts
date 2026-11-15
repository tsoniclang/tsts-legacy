import assert from "node:assert/strict";
import { test } from "node:test";
import { createAstReader } from "./ast-reader.js";
import { createProgram } from "./type-checker-test-support.js";
import type { Node } from "../internal/ast/ast.js";

test("module keyword names retain the actual pinned namespace, module, global and dotted syntax", () => {
  const { index } = createProgram(`namespace Outer.Inner { export const x=1; }
    module Legacy {}
    declare module "external" {}
    export {};
    declare global { interface GlobalValue {} }`, { noLib: true });
  const ast = createAstReader();
  const names: string[] = [];
  const pending: (Node | undefined)[] = [index];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) throw new Error("The actual syntax traversal is dense");
    if (ast.kindName(node) === "KindModuleDeclaration") {
      const keyword = ast.moduleKeywordKindName(node);
      if (keyword === undefined) throw new Error("An actual module declaration retains its pinned keyword");
      names.push(keyword);
    } else assert.equal(ast.moduleKeywordKindName(node), undefined);
    const children = ast.children(node);
    for (let position = children.length - 1; position >= 0; position -= 1) {
      const child = children[position];
      if (child === undefined) throw new Error("The native child traversal retains its actual syntax");
      pending.push(child);
    }
  }
  assert.deepEqual(names, ["KindNamespaceKeyword", "KindNamespaceKeyword", "KindModuleKeyword", "KindModuleKeyword", "KindGlobalKeyword"]);
  const foreign = createProgram("module Foreign {}", { noLib: true });
  const declaration = ast.statements(foreign.index)[0];
  assert.equal(ast.moduleKeywordKindName(declaration), "KindModuleKeyword",
    "the structural reader retains another Program's actual field without borrowing local syntax");
  assert.equal(ast.moduleKeywordKindName(undefined), undefined);
  assert.equal(ast.operatorKindName(index), undefined);
});

test("short-circuit child visits preserve actual native order and stop at the selected child", () => {
  const { index } = createProgram("export function f<T>(a:T,b:number):T{return a;} export const x=1;", { noLib: true });
  const ast = createAstReader();
  const nodes = [index, ...ast.children(index)];
  for (const node of nodes) {
    const expected = ast.children(node);
    for (let limit = 0; limit <= expected.length; limit += 1) {
      const seen: typeof expected[number][] = [];
      const stopped = ast.forEachChildUntil(node, child => {
        seen.push(child);
        return seen.length === limit + 1;
      });
      assert.equal(stopped, limit < expected.length);
      assert.equal(seen.length, Math.min(limit + 1, expected.length));
      for (let position = 0; position < seen.length; position += 1)
        assert.equal(seen[position] === expected[position], true, "native child identity/order");
    }
    const complete: typeof expected[number][] = [];
    ast.forEachChild(node, child => { complete.push(child); });
    assert.equal(complete.length, expected.length);
    assert.equal(ast.forEachChildUntil(node, () => false), false);
  }
});

test("short-circuit traversal does not enumerate the rest of a wide native source", () => {
  const { index } = createProgram(Array.from({ length: 20000 }, (_value, position) => `const x${position}=0;`).join("\n"), { noLib: true });
  const ast = createAstReader();
  for (const limit of [1, 2, 7, 100, 20000]) {
    let visits = 0;
    assert.equal(ast.forEachChildUntil(index, () => {
      visits += 1;
      assert.ok(visits <= limit, "no callback after original stop");
      return visits === limit;
    }), true);
    assert.equal(visits, limit);
  }
});

test("absent and leaf syntax cannot fabricate a stopped child", () => {
  const ast = createAstReader();
  assert.equal(ast.forEachChildUntil(undefined, () => { throw new Error("absent child"); }), false);
  const { index } = createProgram("const leaf=1;", { noLib: true });
  const statement = ast.children(index)[0];
  assert.ok(statement);
  const declarationList = ast.children(statement)[0];
  assert.ok(declarationList);
  const declaration = ast.children(declarationList)[0];
  assert.ok(declaration);
  const name = ast.name(declaration);
  assert.ok(name);
  assert.equal(ast.forEachChildUntil(name, () => { throw new Error("leaf child"); }), false);
});
