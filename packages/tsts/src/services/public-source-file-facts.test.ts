import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommentDirectiveKindExpectError,
  CommentDirectiveKindIgnore,
  LanguageVariantJSX,
  LanguageVariantStandard,
  LanguageVariant_String,
  ScriptKindTS,
  ScriptKindTSX,
  ScriptKind_String,
  createCompilerSessionFromFiles,
} from "../index.js";

// The script kind, language variant and comment-directive names come from the public entry and describe the facts
// the parser records on a source file. The kind name of a node is already public: AstReader.kindName.
test("script kind, language variant and comment-directive names from the public entry describe parsed source files, each with its opposite", () => {
  const files = {
    "/case/a.ts": "// @ts-expect-error\nexport const a: number = \"s\";\n// @ts-ignore\nexport const b: number = \"t\";\n",
    "/case/b.tsx": "export const element = <div />;\n",
  };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: Object.keys(files),
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024", jsx: "preserve" } });
  const checked = session.checkSource();
  const a = checked.getSourceFile("/case/a.ts");
  const b = checked.getSourceFile("/case/b.tsx");
  if (a === undefined || b === undefined) throw new Error("The session lacks a source file.");
  assert.equal(a.ScriptKind, ScriptKindTS);
  assert.equal(b.ScriptKind, ScriptKindTSX);
  assert.deepEqual([ScriptKind_String(a.ScriptKind), ScriptKind_String(b.ScriptKind)], ["ScriptKindTS", "ScriptKindTSX"]);
  assert.equal(a.LanguageVariant, LanguageVariantStandard);
  assert.equal(b.LanguageVariant, LanguageVariantJSX);
  assert.deepEqual([LanguageVariant_String(a.LanguageVariant), LanguageVariant_String(b.LanguageVariant)], ["LanguageVariantStandard", "LanguageVariantJSX"]);
  assert.deepEqual(a.CommentDirectives.map(directive => directive.Kind), [CommentDirectiveKindExpectError, CommentDirectiveKindIgnore]);
  assert.deepEqual(b.CommentDirectives, []);
  assert.equal(checked.ast.kindName(a), "KindSourceFile");
});
