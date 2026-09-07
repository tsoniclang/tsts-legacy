import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, formatDiagnostics } from "../index.js";
import type { Node } from "../index.js";

const cases = [
  ["empty", "", true],
  ["bare", "return;", false],
  ["value", "return 1;", false],
  ["thrown", "throw 1;", false],
  ["conditional", "if (flag) return 1;", true],
  ["branches", "if (flag) return 1; else throw 2;", false],
  ["constantTrue", "if (true) return 1;", false],
  ["constantFalse", "if (false) return 1;", true],
  ["nested", "function local() { return 1; } const closure = () => 1; class Local { localMethod() { return 2; } }", true],
  ["finallyReturns", "try { if (flag) return 1; } finally { return 2; }", false],
  ["catchReturns", "try { return 1; } catch { return 2; }", false],
  ["catchCompletes", "try { return 1; } catch {}", true],
  ["finallyCompletes", "try { return 1; } finally {}", false],
  ["loop", "while (flag) {}", true],
  ["loopThenReturn", "while (flag) {} return 1;", false],
  ["forever", "while (true) {}", false],
  ["loopBreak", "while (true) { if (flag) break; }", true],
  ["forEver", "for (;;) {}", false],
  ["doReturn", "do { return 1; } while (flag);", false],
  ["label", "exit: { if (flag) break exit; return 1; }", true],
  ["labelReturns", "exit: { if (flag) return 1; else throw 2; }", false],
  ["exhaustiveSwitch", "switch (flag) { case true: return 1; case false: return 2; }", false],
  ["incompleteSwitch", "switch (flag) { case true: return 1; }", true],
  ["neverCall", "fail();", false],
] as const;

function check() {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/index.ts": [
        "declare function fail(): never;",
        ...cases.map(([name, body]) => `function ${name}(flag: boolean) { ${body} }`),
        "const expression = () => 1;",
        "const block = function(flag: boolean) { if (flag) return 1; };",
        "class Box { method(flag: boolean) { if (flag) return 1; } get value() { return 1; } }",
        "interface Callable { (flag: boolean): number; method(): number; }",
      ].join("\n"),
      "/src/other.ts": "export function other(flag: boolean) { if (flag) return 1; }",
    },
    compilerOptions: { strict: true, target: "es2022", module: "esnext" },
  }).checkSource();
}

const checked = check();
const diagnostics = checked.diagnostics.filter(diagnostic => diagnostic !== undefined);
assert.equal(diagnostics.length, 0, formatDiagnostics(diagnostics, "/src"));
const file = checked.getSourceFile("/src/index.ts");
assert.ok(file);
const queries = checked.getSourceFileQueries(file).checker;

for (const [name, , expected] of cases) {
  test(`callable completion retains checked ${name} flow`, () => {
    const declaration = checked.ast.statements(file).find(node => checked.ast.text(checked.ast.name(node)) === name);
    assert.ok(declaration);
    const result = queries.getResolvedCallableCompletionInfo(declaration);
    assert.ok(result);
    assert.equal(result.declaration, declaration);
    assert.equal(result.canFallThrough, expected);
    assert.ok(Object.isFrozen(result));
    assert.equal(queries.getResolvedCallableCompletionInfo(declaration), result);
  });
}

test("callable completion distinguishes authored bodies from bodyless and noncallable nodes", () => {
  const pending: Node[] = [file];
  const observed = new Map<string, boolean>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    const result = queries.getResolvedCallableCompletionInfo(node);
    if (result !== undefined) {
      assert.ok(checked.ast.body(node));
      if (checked.ast.is.IsArrowFunction(node)) observed.set("expression", result.canFallThrough);
      if (checked.ast.is.IsFunctionExpression(node)) observed.set("block", result.canFallThrough);
      if (checked.ast.is.IsMethodDeclaration(node) && checked.ast.text(checked.ast.name(node)) === "method") observed.set("method", result.canFallThrough);
      if (checked.ast.is.IsGetAccessorDeclaration(node)) observed.set("getter", result.canFallThrough);
    } else if (checked.ast.body(node) === undefined) {
      assert.equal(result, undefined);
    }
    checked.ast.forEachChild(node, child => { if (child !== undefined) pending.push(child); });
  }
  assert.deepEqual(Object.fromEntries(observed), { getter: false, method: true, block: true, expression: false });
  const ambient = checked.ast.statements(file)[0];
  assert.equal(queries.getResolvedCallableCompletionInfo(ambient), undefined);
  assert.equal(queries.getResolvedCallableCompletionInfo(file), undefined);
  assert.equal(queries.getResolvedCallableCompletionInfo(undefined), undefined);
});

test("callable completion belongs to the checked source program and owning file", () => {
  const other = checked.getSourceFile("/src/other.ts");
  assert.ok(other);
  const declaration = checked.ast.statements(other)[0];
  const result = checked.getSourceFileQueries(other).checker.getResolvedCallableCompletionInfo(declaration);
  assert.equal(result?.canFallThrough, true);
  const second = check();
  const secondFile = second.getSourceFile("/src/other.ts");
  assert.ok(secondFile);
  const secondDeclaration = second.ast.statements(secondFile)[0];
  const secondResult = second.getSourceFileQueries(secondFile).checker.getResolvedCallableCompletionInfo(secondDeclaration);
  assert.equal(secondResult?.canFallThrough, true);
  assert.notEqual(secondResult, result);
  assert.notEqual(secondResult?.declaration, result?.declaration);
});
