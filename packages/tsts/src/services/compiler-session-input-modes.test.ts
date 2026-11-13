import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, formatDiagnostics } from "../index.js";
import type { CompilerSession, Diagnostic, InMemoryCompilerSessionOptions } from "../index.js";
import { Diagnostic_Code, Diagnostic_File } from "../internal/ast/diagnostic.js";

const allDiagnostics = (session: CompilerSession): readonly Diagnostic[] =>
  session.getDiagnostics("all").filter((diagnostic): diagnostic is Diagnostic => diagnostic !== undefined);

// The two input modes of a session over files. A program distinguishes the option sets by its diagnostics:
// `strict` decides whether an implicit any parameter is an error, and the roots decide which files are checked.
const implicitAny = "export function f(x) { return x; }\n";
const typeError = "export const n: number = \"s\";\n";

function open(options: Omit<InMemoryCompilerSessionOptions, "currentDirectory">): { readonly session: CompilerSession; readonly errors: readonly string[]; readonly programFiles: readonly string[] } {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", ...options });
  const checked = session.checkSource();
  const errors = formatDiagnostics(allDiagnostics(session), "/case").split("\n").filter(line => line !== "");
  const programFiles = ["/case/a.ts", "/case/b.ts", "/case/c.ts"].filter(fileName => checked.getSourceFile(fileName) !== undefined);
  return { session, errors, programFiles };
}

const base = { module: "nodenext", moduleResolution: "nodenext", target: "es2024" };

test("options mode: the supplied compiler options decide, and an authored tsconfig with conflicting options at the default path has no influence and stays a readable file", () => {
  const authored = JSON.stringify({ compilerOptions: { ...base, strict: true }, files: ["a.ts", "b.ts"] });
  const files = { "/case/tsconfig.json": authored, "/case/a.ts": implicitAny, "/case/b.ts": typeError };
  // The authored configuration says strict and roots a and b; the supplied policy says not strict and root a.
  const supplied = open({ files, compilerOptions: { ...base, strict: false }, rootFiles: ["a.ts"] });
  assert.deepEqual(supplied.errors, [], "not strict: no implicit-any error; b is no root, so its type error is not checked");
  assert.deepEqual(supplied.programFiles, ["/case/a.ts"]);
  assert.deepEqual(supplied.session.host.FS().ReadFile("/case/tsconfig.json"), [authored, true], "the authored bytes are still a file");
  // The opposite policy over the same files: strict supplied, the authored file says nothing different.
  const strict = open({ files, compilerOptions: { ...base, strict: true }, rootFiles: ["a.ts"] });
  assert.deepEqual(strict.errors, ["a.ts(1,19): error TS7006: Parameter 'x' implicitly has an 'any' type."]);
});

test("options mode with explicit empty options and with options omitted: the defaults apply, not the authored tsconfig", () => {
  const authored = JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false }, files: ["b.ts"] });
  const files = { "/case/tsconfig.json": authored, "/case/a.ts": implicitAny, "/case/b.ts": typeError };
  const withoutAuthored = open({ files: { "/case/a.ts": implicitAny, "/case/b.ts": typeError }, compilerOptions: {} });
  const explicitEmpty = open({ files, compilerOptions: {} });
  const omitted = open({ files });
  // Whatever the defaults make of the two files, the authored file changes nothing, and both files are roots.
  assert.deepEqual(explicitEmpty.errors, withoutAuthored.errors);
  assert.deepEqual(omitted.errors, withoutAuthored.errors);
  assert.deepEqual(explicitEmpty.programFiles, ["/case/a.ts", "/case/b.ts"]);
  assert.equal(withoutAuthored.errors.includes("b.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."), true, "b is checked: it is a root by default");
  assert.equal(withoutAuthored.errors.includes("a.ts(1,19): error TS7006: Parameter 'x' implicitly has an 'any' type."), true, "the default is strict; the authored file says not strict");
});

test("options mode: an authored tsconfig that extends another file is not followed", () => {
  const files = {
    "/case/tsconfig.json": JSON.stringify({ extends: "./base.json", files: ["a.ts", "b.ts"] }),
    "/case/base.json": JSON.stringify({ compilerOptions: { ...base, strict: true } }),
    "/case/a.ts": implicitAny, "/case/b.ts": typeError,
  };
  const supplied = open({ files, compilerOptions: { ...base, strict: false }, rootFiles: ["a.ts"] });
  assert.deepEqual(supplied.errors, []);
  assert.deepEqual(supplied.programFiles, ["/case/a.ts"]);
});

test("options mode: the roots are the supplied root files, not the files or include of an authored tsconfig", () => {
  const files = {
    "/case/tsconfig.json": JSON.stringify({ compilerOptions: { ...base, strict: true }, include: ["*.ts"], files: ["c.ts"] }),
    "/case/a.ts": "export const a = 1;\n", "/case/b.ts": typeError, "/case/c.ts": typeError,
  };
  const supplied = open({ files, compilerOptions: { ...base, strict: true }, rootFiles: ["a.ts"] });
  assert.deepEqual(supplied.programFiles, ["/case/a.ts"]);
  assert.deepEqual(supplied.errors, []);
  const two = open({ files, compilerOptions: { ...base, strict: true }, rootFiles: ["a.ts", "b.ts"] });
  assert.deepEqual(two.programFiles, ["/case/a.ts", "/case/b.ts"]);
  assert.deepEqual(two.errors, ["b.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."]);
});

test("configuration mode, selected by naming the file: the same files are opened from the authored tsconfig and what it extends", () => {
  const files = {
    "/case/tsconfig.json": JSON.stringify({ extends: "./base.json", files: ["a.ts", "b.ts"] }),
    "/case/base.json": JSON.stringify({ compilerOptions: { ...base, strict: true } }),
    "/case/a.ts": implicitAny, "/case/b.ts": typeError, "/case/c.ts": typeError,
  };
  const configured = open({ files, configFileName: "/case/tsconfig.json" });
  assert.deepEqual(configured.programFiles, ["/case/a.ts", "/case/b.ts"], "the roots are the authored files list");
  assert.deepEqual(configured.errors, [
    "a.ts(1,19): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    "b.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
  ], "strict comes from the extended file");
  // A configuration file at another path is selected the same way.
  const other = open({ files: { ...files, "/case/build/tsconfig.loose.json": JSON.stringify({ compilerOptions: { ...base, strict: false }, files: ["../a.ts"] }) },
    configFileName: "/case/build/tsconfig.loose.json" });
  assert.deepEqual(other.programFiles, ["/case/a.ts"]);
  assert.deepEqual(other.errors, []);
});

test("configuration mode resolves the configuration file name as root file names are resolved", () => {
  const files = {
    "/case/tsconfig.json": JSON.stringify({ compilerOptions: { ...base, strict: true }, files: ["a.ts"] }),
    "/case/a.ts": implicitAny,
  };
  for (const configFileName of ["tsconfig.json", "./tsconfig.json", "/case/sub/../tsconfig.json", "/case/TSCONFIG.json"]) {
    const configured = open({ files, configFileName });
    assert.deepEqual(configured.programFiles, ["/case/a.ts"], configFileName);
    assert.deepEqual(configured.errors, ["a.ts(1,19): error TS7006: Parameter 'x' implicitly has an 'any' type."], configFileName);
  }
  // The file system's own case rule decides: with case-sensitive names another letter case is another file.
  assert.throws(() => createCompilerSessionFromFiles({ currentDirectory: "/case", files, configFileName: "/case/TSCONFIG.json", useCaseSensitiveFileNames: true }), /is not among the session's files/u);
  assert.throws(() => createCompilerSessionFromFiles({ currentDirectory: "/case", files, configFileName: "absent.json" }), /is not among the session's files/u);
});

test("the two modes cannot be mixed, and configuration mode requires its file", () => {
  const files = { "/case/tsconfig.json": "{}", "/case/a.ts": "export const a = 1;\n" };
  assert.throws(() => createCompilerSessionFromFiles({ currentDirectory: "/case", files, configFileName: "/case/tsconfig.json", compilerOptions: {} }), /either a configuration file name, or compiler options and root files/u);
  assert.throws(() => createCompilerSessionFromFiles({ currentDirectory: "/case", files, configFileName: "/case/tsconfig.json", rootFiles: ["a.ts"] }), /either a configuration file name, or compiler options and root files/u);
  assert.throws(() => createCompilerSessionFromFiles({ currentDirectory: "/case", files, configFileName: "/case/absent.json" }), /is not among the session's files/u);
});

const configDiagnostics = (session: CompilerSession): readonly Diagnostic[] =>
  session.getDiagnostics("config").filter((diagnostic): diagnostic is Diagnostic => diagnostic !== undefined);
const configLines = (session: CompilerSession): readonly string[] =>
  formatDiagnostics(configDiagnostics(session), "/case").split("\n").filter(line => line !== "");
const one = { "/case/a.ts": "export const a = 1;\n" };

test("options mode: explicit empty root files are a valid empty program with no diagnostic; an authored empty files list keeps its diagnostic in configuration mode", () => {
  const files = { "/case/tsconfig.json": JSON.stringify({ files: ["a.ts"] }), "/case/a.ts": typeError, "/case/b.ts": typeError };
  const empty = open({ files, compilerOptions: { ...base, strict: true }, rootFiles: [] });
  assert.deepEqual(empty.programFiles, [], "no file is a root: not the inferred ones, not the authored ones");
  assert.deepEqual(empty.errors, [], "no diagnostic: no file and no list was written");
  const omitted = open({ files, compilerOptions: { ...base, strict: true } });
  assert.deepEqual(omitted.programFiles, ["/case/a.ts", "/case/b.ts"], "omitted roots are inferred from the supplied files alone");
  // Omitted roots with no supported source file: an empty program, no diagnostic either.
  const noSource = open({ files: { "/case/notes.txt": "text\n" }, compilerOptions: { ...base, strict: true } });
  assert.deepEqual([noSource.programFiles, noSource.errors], [[], []]);
  // Configuration mode with an authored empty files list: the configuration's own diagnostic, against that file.
  const authoredEmpty = open({ files: { "/case/tsconfig.json": JSON.stringify({ files: [] }), "/case/a.ts": typeError }, configFileName: "/case/tsconfig.json" });
  assert.deepEqual(authoredEmpty.errors.map(line => line.replace(/\(\d+,\d+\)/u, "")), ["tsconfig.json: error TS18002: The 'files' list in config file '/case/tsconfig.json' is empty."]);
});

test("options mode: omitted roots are every supplied file the compiler supports under the options: TypeScript extensions always, JavaScript ones only with allowJs", () => {
  const sources = {
    "/case/a.ts": "export const a = 1;\n", "/case/b.tsx": "export const b = 1;\n", "/case/c.d.ts": "export declare const c: number;\n",
    "/case/d.mts": "export const d = 1;\n", "/case/e.d.mts": "export declare const e: number;\n",
    "/case/f.cts": "export const f = 1;\n", "/case/g.d.cts": "export declare const g: number;\n",
    "/case/h.js": "export const h = 1;\n", "/case/i.jsx": "export const i = 1;\n", "/case/j.mjs": "export const j = 1;\n", "/case/k.cjs": "exports.k = 1;\n",
    "/case/l.json": "{}\n", "/case/node_modules/pkg/index.ts": "export const p = 1;\n", "/elsewhere/m.ts": "export const m = 1;\n",
  };
  const program = (allowJs: boolean): readonly string[] => {
    const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files: sources, compilerOptions: { ...base, allowJs, jsx: "preserve" } });
    const checked = session.checkSource();
    return Object.keys(sources).filter(fileName => checked.getSourceFile(fileName) !== undefined);
  };
  const typescript = ["/case/a.ts", "/case/b.tsx", "/case/c.d.ts", "/case/d.mts", "/case/e.d.mts", "/case/f.cts", "/case/g.d.cts", "/case/node_modules/pkg/index.ts", "/elsewhere/m.ts"];
  assert.deepEqual(program(false), typescript);
  assert.deepEqual(program(true), [...typescript.slice(0, 7), "/case/h.js", "/case/i.jsx", "/case/j.mjs", "/case/k.cjs", ...typescript.slice(7)]);
});

// The sixteen options of the Host's table, each with the value the table gives it, through the object reader.
const tableOptions: Record<string, unknown> = {
  module: "nodenext", moduleResolution: "nodenext", target: "es2024", strict: true, noEmit: true, noLib: true,
  allowImportingTsExtensions: true, allowArbitraryExtensions: true, types: [], skipLibCheck: false,
  noUncheckedIndexedAccess: false, exactOptionalPropertyTypes: false, useDefineForClassFields: true,
  esModuleInterop: true, resolveJsonModule: false, allowJs: false,
};

test("options mode: each of the sixteen option forms of the Host's table is accepted through the object reader, alone and together", () => {
  assert.equal(Object.keys(tableOptions).length, 16);
  for (const [name, value] of Object.entries(tableOptions)) {
    const { session } = open({ files: one, compilerOptions: { [name]: value }, rootFiles: ["a.ts"] });
    assert.deepEqual(configLines(session), [], `${name}: ${JSON.stringify(value)}`);
  }
  const all = open({ files: one, compilerOptions: tableOptions, rootFiles: ["a.ts"] });
  assert.deepEqual(configLines(all.session), []);
  // The other value of the one list-valued row, and a value read back from the parsed options.
  assert.deepEqual(configLines(open({ files: one, compilerOptions: { ...tableOptions, types: ["*"] }, rootFiles: ["a.ts"] }).session), []);
  assert.deepEqual(all.programFiles, ["/case/a.ts"]);
});

test("options mode: a rejected enumerated value is reported, with no file and no site", () => {
  const rejected = open({ files: one, compilerOptions: { ...base, target: "no-such-target" }, rootFiles: ["a.ts"] });
  const lines = configLines(rejected.session);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^error TS6046: Argument for '--target' option must be: /u, "no file name and no position precede the diagnostic");
  for (const diagnostic of configDiagnostics(rejected.session)) assert.equal(Diagnostic_File(diagnostic), undefined);
  // The opposite: the same option with a valid value, in another letter case, is accepted.
  assert.deepEqual(configLines(open({ files: one, compilerOptions: { ...base, target: "ES2024" }, rootFiles: ["a.ts"] }).session), []);
  assert.deepEqual(configLines(open({ files: one, compilerOptions: { module: "no-such-module" }, rootFiles: ["a.ts"] }).session).map(line => line.slice(0, 44)),
    ["error TS6046: Argument for '--module' option"]);
});

test("options mode: every rejection is kept, in the order of the supplied options: an unknown option before and after a valid enumerated option, and several rejections", () => {
  const codes = (compilerOptions: Record<string, unknown>): readonly number[] =>
    configDiagnostics(open({ files: one, compilerOptions, rootFiles: ["a.ts"] }).session).map(diagnostic => Diagnostic_Code(diagnostic) as number);
  assert.deepEqual(codes({ noSuchOption: true, target: "es2024" }), [5023], "an unknown option BEFORE a valid enumerated option is kept");
  assert.deepEqual(codes({ target: "es2024", noSuchOption: true }), [5023], "an unknown option AFTER a valid enumerated option is kept");
  assert.deepEqual(codes({ noSuchOption: true, target: "no-such-target", strict: "yes", module: "nodenext", otherUnknown: 1, moduleResolution: "no-such-resolution" }),
    [5023, 6046, 5024, 5023, 6046], "unknown, rejected value, wrong type, unknown, rejected value");
  assert.deepEqual(codes({ module: "nodenext", moduleResolution: "nodenext", target: "es2024", strict: true }), [], "the valid opposite");
});
