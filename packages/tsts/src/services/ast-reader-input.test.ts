import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeList_HasTrailingComma } from "../internal/ast/spine.js";
import { createSourceProgramQueries } from "../extensions/source-program.js";
import { createCompilerSessionFromFiles } from "./compiler-session.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function syntax(text: string) {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": text },
    compilerOptions: testNoLibCompilerOptions,
  });
  session.ensureBound();
  const source = createSourceProgramQueries(session.program);
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  return { session, source, file, ast: source.ast };
}

test("public list punctuation delegates to the exact TS-Go list contract", () => {
  const { session, file, ast } = syntax([
    "emit(); emit(value); emit(value,); emit(value /* trivia */);",
    "emit(value /* before */, /* after */);",
    "const values = [[], [value], [value,], [,], [value,,], [value /* trivia */]];",
  ].join("\n"));
  assert.deepEqual(session.getDiagnostics("syntactic"), []);
  const calls = findNodes(file, ast.children, ast.is.IsCallExpression);
  const callLists = calls.map(call => ast.as.AsCallExpression(call)!.Arguments);
  assert.deepEqual(callLists.map(ast.listHasTrailingComma), [false, false, true, false, true]);
  const arrays = findNodes(file, ast.children, ast.is.IsArrayLiteralExpression);
  const arrayLists = arrays.map(array => ast.as.AsArrayLiteralExpression(array)!.Elements);
  assert.deepEqual(arrayLists.map(ast.listHasTrailingComma), [false, false, false, true, true, true, false]);
  for (const list of [...callLists, ...arrayLists]) {
    assert.equal(ast.listHasTrailingComma(list), NodeList_HasTrailingComma(list));
  }
  assert.equal(ast.listHasTrailingComma(undefined), false);
});

test("public cooked-template text preserves source escapes without executing substitutions", () => {
  const { session, file, ast } = syntax([
    'tag`first\\n${notExecuted()}middle\\t${notExecuted()}last`;',
    'tag`"é"`; tag`b"\\\\xff"`; tag`\\` and \\${text}`; tag``;',
  ].join("\n"));
  assert.deepEqual(session.getDiagnostics("syntactic"), []);
  const parts = findNodes(file, ast.children, node => ast.kindName(node) === "KindTemplateHead" ||
    ast.kindName(node) === "KindTemplateMiddle" || ast.kindName(node) === "KindTemplateTail" ||
    ast.is.IsNoSubstitutionTemplateLiteral(node));
  assert.deepEqual(parts.map(ast.cookedTemplateText), ["first\n", "middle\t", "last", '"é"', 'b"\\xff"', "` and ${text}", ""]);
  const calls = findNodes(file, ast.children, ast.is.IsCallExpression);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(ast.cookedTemplateText(call), undefined);
  assert.equal(ast.cookedTemplateText(file), undefined);
  assert.equal(ast.cookedTemplateText(undefined), undefined);
});

test("invalid or unterminated template escapes never masquerade as cooked native text", () => {
  const { session, file, ast } = syntax('tag`\\x`; tag`prefix${value}\\u{}`;');
  assert.deepEqual(session.getDiagnostics("syntactic"), []);
  const invalid = findNodes(file, ast.children, node => ast.is.IsNoSubstitutionTemplateLiteral(node) ||
    ast.kindName(node) === "KindTemplateTail");
  assert.equal(invalid.length, 2);
  assert.deepEqual(invalid.map(ast.cookedTemplateText), [undefined, undefined]);
  const incomplete = syntax('tag`unterminated');
  assert.notEqual(incomplete.session.getDiagnostics("syntactic").length, 0);
  const literal = findNodes(incomplete.file, incomplete.ast.children, incomplete.ast.is.IsNoSubstitutionTemplateLiteral)[0];
  assert.ok(literal);
  assert.equal(incomplete.ast.cookedTemplateText(literal), undefined);
});
