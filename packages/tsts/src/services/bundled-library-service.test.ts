import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, getBundledLibraryClosure } from "../index.js";

test("selected bundled library closure is exact, deterministic, and sufficient under noLib", () => {
  const first = getBundledLibraryClosure(["lib.es2024.d.ts"]);
  const second = getBundledLibraryClosure(["lib.es2024.d.ts", "lib.es2024.d.ts"]);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.ok(first.every(Object.isFrozen));
  assert.equal(first.at(-1)?.name, "lib.es2024.d.ts");
  assert.ok(first.some((source) => source.name === "lib.es5.d.ts"));
  assert.equal(first.some((source) => source.name === "lib.dom.d.ts"), false);
  assert.equal(new Set(first.map((source) => source.name)).size, first.length);

  const applicationPath = "/src/index.ts";
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: [...first.map((source) => source.path), applicationPath],
    files: {
      [applicationPath]: "export const values = new Map<string, number>();\n",
    },
    compilerOptions: {
      noLib: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2024",
    },
  });
  const checked = session.checkSource();
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic !== undefined).map((diagnostic) => diagnostic.code),
    [],
  );
  const sourceFileNames = checked.getSourceFiles().map((sourceFile) => checked.ast.getFileName(sourceFile));
  assert.ok(sourceFileNames.includes("bundled:///libs/lib.es2024.d.ts"));
  assert.equal(sourceFileNames.includes("bundled:///libs/lib.dom.d.ts"), false);
});

test("selected bundled library closure rejects unknown roots", () => {
  assert.throws(
    () => getBundledLibraryClosure(["lib.not-real.d.ts"]),
    /Unknown bundled library 'lib\.not-real\.d\.ts'/u,
  );
});
