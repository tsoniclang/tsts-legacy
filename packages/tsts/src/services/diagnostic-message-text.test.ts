import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, flattenDiagnosticMessageText, formatDiagnostics } from "../index.js";
import type { Diagnostic } from "../index.js";
import { Diagnostic_Code, Diagnostic_File, Diagnostic_MessageChain } from "../internal/ast/diagnostic.js";

function diagnosticsOf(files: Record<string, string>, compilerOptions: Record<string, unknown> = {}): readonly Diagnostic[] {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/case", files, rootFiles: Object.keys(files),
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024", ...compilerOptions },
  });
  session.checkSource();
  return session.getDiagnostics("all").filter((diagnostic): diagnostic is Diagnostic => diagnostic !== undefined);
}

function only(diagnostics: readonly Diagnostic[], code: number): Diagnostic {
  const matches = diagnostics.filter(diagnostic => Diagnostic_Code(diagnostic) === code);
  assert.equal(matches.length, 1, `exactly one diagnostic with code ${code} among ${diagnostics.map(diagnostic => Diagnostic_Code(diagnostic)).join(", ")}`);
  const match = matches[0];
  if (match === undefined) throw new Error("unreachable");
  return match;
}

test("flattenDiagnosticMessageText gives an ordinary source diagnostic's message with its arguments substituted, non-ASCII included", () => {
  const diagnostics = diagnosticsOf({ "/case/a.mts": "const café: number = \"s\";\nexport const use = café.absenté;\n" });
  const assignment = only(diagnostics, 2322);
  assert.equal(flattenDiagnosticMessageText(assignment), "Type 'string' is not assignable to type 'number'.");
  assert.notEqual(Diagnostic_File(assignment), undefined);
  assert.equal(flattenDiagnosticMessageText(only(diagnostics, 2339)), "Property 'absenté' does not exist on type 'number'.");
  // The text is the message part of the formatter's line, without file, position, category and code.
  assert.equal(formatDiagnostics([assignment], "/case"), `a.mts(1,7): error TS2322: ${flattenDiagnosticMessageText(assignment)}\n`);
});

test("flattenDiagnosticMessageText renders a nested message chain completely, one message per line, two spaces per level, with the given line break", () => {
  const diagnostics = diagnosticsOf({
    "/case/a.mts": "declare const source: { a: { b: string } };\nexport const target: { a: { b: number } } = source;\n",
  });
  const diagnostic = only(diagnostics, 2322);
  assert.equal(Diagnostic_MessageChain(diagnostic).length > 0, true, "the diagnostic has a message chain");
  const lines = [
    "Type '{ a: { b: string; }; }' is not assignable to type '{ a: { b: number; }; }'.",
    "  The types of 'a.b' are incompatible between these types.",
    "    Type 'string' is not assignable to type 'number'.",
  ];
  assert.equal(flattenDiagnosticMessageText(diagnostic), lines.join("\n"));
  assert.equal(flattenDiagnosticMessageText(diagnostic, "\r\n"), lines.join("\r\n"));
  assert.equal(formatDiagnostics([diagnostic], "/case"), `a.mts(2,14): error TS2322: ${lines.join("\n")}\n`);
});

test("flattenDiagnosticMessageText gives the message of a diagnostic that has no file", () => {
  const diagnostics = diagnosticsOf({ "/case/a.mts": "export const a = 1;\n" }, { types: ["absent-type-library"] });
  const global = diagnostics.filter(diagnostic => Diagnostic_File(diagnostic) === undefined);
  assert.equal(global.length, 1, `one diagnostic without a file among: ${formatDiagnostics(diagnostics, "/case")}`);
  const diagnostic = global[0];
  if (diagnostic === undefined) throw new Error("unreachable");
  const lines = [
    "Cannot find type definition file for 'absent-type-library'.",
    "  The file is in the program because:",
    "    Entry point of type library 'absent-type-library' specified in compilerOptions",
  ];
  assert.equal(Diagnostic_Code(diagnostic), 2688);
  assert.equal(flattenDiagnosticMessageText(diagnostic), lines.join("\n"), "a substituted argument and a nested chain, with no file");
  assert.equal(formatDiagnostics([diagnostic], "/case"), `error TS2688: ${lines.join("\n")}\n`);
});
