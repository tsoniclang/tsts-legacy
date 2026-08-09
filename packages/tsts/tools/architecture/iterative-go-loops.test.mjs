import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

test("translated Go loops do not become recursive TypeScript helpers", async () => {
  const violations = [];
  for (const file of await productionTypeScriptFiles(sourceRoot)) {
    const text = await readFile(file, "utf8");
    violations.push(...inventedRecursiveLoops(file, text).map((finding) => ({
      ...finding,
      file: relative(sourceRoot, file).split("\\").join("/"),
    })));
  }
  assert.deepEqual(violations, []);
});

test("translated-loop detector distinguishes an invented helper from source recursion", () => {
  const invented = `/**
 * Go source:
 * func Walk(values []int) {
 *   for i := 0; i < len(values); i++ {}
 * }
 */
export function Walk(values: number[]): void {
  const loop = (index: number): void => {
    if (index < values.length) loop(index + 1);
  };
  loop(0);
}`;
  assert.deepEqual(inventedRecursiveLoops("invented.ts", invented), [{
    column: 9,
    line: 8,
    owner: "Walk",
    helper: "loop",
  }]);

  const sourceRecursive = `/**
 * Go source:
 * func Walk(node *Node) {
 *   var visit func(*Node)
 *   visit = func(child *Node) { visit(child) }
 *   visit(node)
 * }
 */
export function Walk(node: Node): void {
  const visit = (child: Node): void => visit(child);
  visit(node);
}`;
  assert.deepEqual(inventedRecursiveLoops("recursive.ts", sourceRecursive), []);
});

function inventedRecursiveLoops(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const findings = [];
  visit(source, undefined);
  return findings;

  function visit(node, owner) {
    const nextOwner = ts.isFunctionDeclaration(node) && node.name !== undefined
      ? node
      : owner;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      callsName(node.initializer.body, node.name.text)
    ) {
      const ownerPrefix = nextOwner === undefined
        ? text.slice(0, node.getFullStart())
        : text.slice(nextOwner.getFullStart(), nextOwner.getStart(source));
      const goSource = ownerPrefix.match(/Go source:(?<source>[\s\S]*)/u)?.groups?.source ?? "";
      if (/\bfor\b/u.test(goSource) &&
        !new RegExp(`\\b${node.name.text}\\b`, "u").test(goSource)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({
          column: position.character + 1,
          line: position.line + 1,
          owner: nextOwner?.name?.text ?? "<module>",
          helper: node.name.text,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextOwner));
  }
}

function callsName(node, name) {
  let found = false;
  const inspect = (current) => {
    if (found) return;
    if (ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(current, inspect);
  };
  inspect(node);
  return found;
}

async function productionTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionTypeScriptFiles(path));
    } else if (entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files.sort();
}
