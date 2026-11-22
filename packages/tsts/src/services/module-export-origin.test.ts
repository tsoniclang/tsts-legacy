import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import type { ResolvedModuleExport } from "../index.js";

for (const checkers of [1, 4]) test(`module exports retain actual per-module type-only star origins with ${checkers} checkers`, () => {
  const files = {
    "/case/leaf.mts": "export function value(): boolean { return true; } const quoted = false; export { quoted as 'external-value' }; export default true;",
    "/case/value.mts": "export * from './leaf.mjs';",
    "/case/type.mts": "export type * from './leaf.mjs';",
    "/case/mixed.mts": "export type * from './leaf.mjs'; export * from './leaf.mjs';",
    "/case/through.mts": "export * from './type.mjs';",
    "/case/named.mts": "export type { value } from './leaf.mjs';",
    "/case/named-through.mts": "export { value } from './type.mjs';",
    "/case/star-through-named.mts": "export * from './named-through.mjs';",
  };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: Object.keys(files),
    compilerOptions: { checkers, module: "nodenext", moduleResolution: "nodenext", target: "es2024", strict: true } });
  const checked = session.checkSource();
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const fileOf = (name: string) => {
    const file = checked.getSourceFile(`/case/${name}.mts`);
    if (file === undefined) throw new Error("The case requires its actual source file.");
    return file;
  };
  const read = (name: string, from = name): readonly ResolvedModuleExport[] => {
    const file = fileOf(name);
    const { checker } = checked.getSourceFileQueries(file);
    const symbol = checker.getSymbolAtLocation(file);
    assert.ok(symbol);
    return checked.getSourceFileQueries(fileOf(from)).checker.getExportsOfModule(symbol);
  };
  const leaf = read("leaf");
  assert.deepEqual(leaf.map(row => row.name).sort(), ["default", "external-value", "value"]);
  const starFile = fileOf("type");
  const origin = checked.ast.children(starFile).find(node => checked.ast.kindName(node) === "KindExportDeclaration");
  assert.ok(origin);
  for (const name of ["value", "type", "mixed", "through", "type"]) {
    const rows = read(name);
    assert.deepEqual(rows.map(row => row.name).sort(), ["external-value", "value"]);
    for (const row of rows) {
      const original = leaf.find(candidate => candidate.name === row.name);
      assert.equal(row.symbol === original?.symbol, true, name + ":" + row.name);
      assert.equal(row.typeOnlyStar === (name === "type" || name === "through" ? origin : null), true, name + ":" + row.name);
    }
  }
  const [named] = read("named");
  assert.equal(named?.name, "value");
  assert.equal(named.symbol !== leaf.find(row => row.name === "value")?.symbol, true);
  assert.equal(named.typeOnlyStar, null, "an authored named alias is not a star");
  const [namedThrough] = read("named-through");
  assert.equal(namedThrough?.name, "value");
  assert.equal(namedThrough.typeOnlyStar === origin, true, "an ordinary named hop retains the upstream star qualifier");
  assert.equal(read("named-through", "mixed")[0]?.typeOnlyStar === origin, true, "a cross-file read uses the exporting module's owner");
  const [starThroughNamed] = read("star-through-named");
  assert.equal(starThroughNamed?.symbol === namedThrough.symbol, true);
  assert.equal(starThroughNamed?.typeOnlyStar === origin, true, "a re-exported alias uses its own file's completed qualifier");
  assert.deepEqual(checked.getSourceFileQueries(starFile).checker.getExportsOfModule(undefined), []);
});
