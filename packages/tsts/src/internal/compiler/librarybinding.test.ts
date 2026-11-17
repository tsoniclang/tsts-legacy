import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceFile_FileName, SourceFile_Path } from "../ast/ast.js";
import { Diagnostic_Code, Diagnostic_MessageArgs } from "../ast/diagnostic.js";
import { ParseCommandLine } from "../tsoptions/commandlineparser.js";
import { ToPath } from "../tspath/path.js";
import { createCompilerHost, createInMemoryFileSystem } from "../../services/embedding-host.js";
import { boundLibraryNames, firstLibraryName, libraryBindingOf, libraryNamePriority, selectedLibraryFile } from "./librarybinding.js";
import { NewProgram, Program_GetIncludeProcessorDiagnostics, Program_GetProgramDiagnostics, Program_GetSourceFiles, Program_IsSourceFileDefaultLibrary } from "./program.js";
import type { ProgramOptions } from "./program.js";

// Expectations follow from the rule of librarybinding.ts: one binding per program, from the caller's selected
// library files when given (an empty map included), otherwise from the host's default library directory; no
// fallback from one to the other.

function host(files: ReadonlyMap<string, string>, defaultLibraryPath = "/libs", useCaseSensitiveFileNames = true) {
  return createCompilerHost({
    currentDirectory: "/src",
    defaultLibraryPath,
    includeBundledLibraries: false,
    cacheFileSystem: false,
    fileSystem: createInMemoryFileSystem({ files, includeBundledLibraries: false, useCaseSensitiveFileNames }),
  });
}

function options(selected?: ReadonlyMap<string, string>, files = new Map<string, string>(), useCaseSensitiveFileNames = true): ProgramOptions {
  return {
    Host: host(files, "/libs", useCaseSensitiveFileNames),
    Config: undefined,
    ...(selected === undefined ? {} : { SelectedLibraries: selected }),
  };
}

test("without selected library files the binding is the default library directory", () => {
  const binding = libraryBindingOf({ Host: host(new Map(), "libs"), Config: undefined });
  assert.deepEqual(binding, { kind: "directory", directory: "/src/libs" });
  assert.equal(selectedLibraryFile(binding, "lib.es5.d.ts"), "/src/libs/lib.es5.d.ts");
  assert.equal(boundLibraryNames(binding, ToPath("/src/libs/lib.es5.d.ts", "/src", true)), undefined);
});

test("selected library files are the only source, an empty selection included", () => {
  const binding = libraryBindingOf(options(new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"], ["lib.es2015.core.d.ts", "core.d.ts"]])));
  assert.equal(selectedLibraryFile(binding, "lib.es5.d.ts"), "/cap/a/es5.d.ts");
  // A relative file name is taken against the current directory, as a root file name is.
  assert.equal(selectedLibraryFile(binding, "lib.es2015.core.d.ts"), "/src/core.d.ts");
  assert.equal(selectedLibraryFile(binding, "lib.es2015.d.ts"), undefined);
  const empty = libraryBindingOf(options(new Map()));
  assert.equal(empty.kind, "explicit");
  assert.equal(selectedLibraryFile(empty, "lib.es5.d.ts"), undefined);
});

test("a selected name that is not a library file name of the compiler is refused", () => {
  assert.throws(() => libraryBindingOf(options(new Map([["lib.nosuch.d.ts", "/cap/x.d.ts"]]))),
    { name: "TypeError", message: "Selected library 'lib.nosuch.d.ts' is not a library file name of the compiler." });
  assert.throws(() => libraryBindingOf(options(new Map([["es5", "/cap/x.d.ts"]]))), { name: "TypeError" });
});

test("several names bound to one file are all kept, and the first by library order names its record", () => {
  const binding = libraryBindingOf(options(new Map([["lib.es2015.d.ts", "/cap/shared.d.ts"], ["lib.es5.d.ts", "/cap/shared.d.ts"]])));
  assert.deepEqual(boundLibraryNames(binding, ToPath("/cap/shared.d.ts", "/src", true)), ["lib.es2015.d.ts", "lib.es5.d.ts"]);
  assert.equal(firstLibraryName(["lib.es2015.d.ts", "lib.es5.d.ts"]), "lib.es5.d.ts");
  assert.equal(libraryNamePriority("lib.d.ts"), 0);
  assert.ok(libraryNamePriority("lib.es5.d.ts") < libraryNamePriority("lib.es2015.d.ts"));
});

test("the inverse uses the canonical path, so a case-insensitive file system matches regardless of case", () => {
  const binding = libraryBindingOf(options(new Map([["lib.es5.d.ts", "/Cap/ES5.d.ts"]]), new Map(), false));
  const path = ToPath("/cap/es5.D.TS", "/src", false);
  assert.deepEqual(boundLibraryNames(binding, path), ["lib.es5.d.ts"]);
});

function program(args: readonly string[], files: ReadonlyMap<string, string>, selected?: ReadonlyMap<string, string>) {
  const compilerHost = host(files);
  const config = ParseCommandLine([...args], compilerHost);
  assert.ok(config);
  assert.ok(config.Errors !== undefined && config.Errors.length === 0, `command-line errors: ${config.Errors === undefined ? "absent" : config.Errors.length}`);
  const built = NewProgram({ Host: compilerHost, Config: config, ...(selected === undefined ? {} : { SelectedLibraries: selected }) });
  assert.ok(built);
  return built;
}

function sourceFileNamed(built: ReturnType<typeof program>, fileName: string) {
  const file = Program_GetSourceFiles(built).find(candidate => SourceFile_FileName(candidate) === fileName);
  if (file === undefined) assert.fail(`${fileName} is not a file of the program`);
  return file;
}

// The library diagnostics of the program: those without a file (a default library or lib entry), then those of a
// directive in /src/main.ts.
function libraryDiagnostics(built: ReturnType<typeof program>) {
  const main = Program_GetSourceFiles(built).find(file => SourceFile_FileName(file) === "/src/main.ts");
  return [...Program_GetProgramDiagnostics(built), ...(main === undefined ? [] : Program_GetIncludeProcessorDiagnostics(built, main) ?? [])].filter(diagnostic => Diagnostic_Code(diagnostic) === 2726 || Diagnostic_Code(diagnostic) === 2727)
    .map(diagnostic => [Diagnostic_Code(diagnostic), Diagnostic_MessageArgs(diagnostic).filter(arg => arg !== "")]);
}

test("under noLib a rooted bound file is a library file of the program, and an ordinary root is not", () => {
  const files = new Map([
    ["/src/main.ts", "export const value = 1;\n"],
    ["/cap/a/es5.d.ts", "interface Es5 {}\n"],
    ["/cap/b/core.d.ts", "interface Es2015Core {}\n"],
  ]);
  const built = program(["--noLib", "/src/main.ts", "/cap/b/core.d.ts", "/cap/a/es5.d.ts"], files,
    new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"], ["lib.es2015.core.d.ts", "/cap/b/core.d.ts"]]));
  assert.equal(Program_IsSourceFileDefaultLibrary(built, SourceFile_Path(sourceFileNamed(built, "/cap/a/es5.d.ts"))), true);
  assert.equal(Program_IsSourceFileDefaultLibrary(built, SourceFile_Path(sourceFileNamed(built, "/cap/b/core.d.ts"))), true);
  assert.equal(Program_IsSourceFileDefaultLibrary(built, SourceFile_Path(sourceFileNamed(built, "/src/main.ts"))), false);
  // Library files come first, in library order, whatever the order of the roots.
  assert.deepEqual(Program_GetSourceFiles(built).map(SourceFile_FileName), ["/cap/a/es5.d.ts", "/cap/b/core.d.ts", "/src/main.ts"]);
});

test("the same roots without selected library files: a file in no library position is an ordinary file", () => {
  const files = new Map([["/src/main.ts", "export const value = 1;\n"], ["/cap/a/es5.d.ts", "interface Es5 {}\n"]]);
  const built = program(["--noLib", "/src/main.ts", "/cap/a/es5.d.ts"], files);
  assert.equal(Program_IsSourceFileDefaultLibrary(built, SourceFile_Path(sourceFileNamed(built, "/cap/a/es5.d.ts"))), false);
});

test("with noLib off the loader takes every library from the selection and never from the default directory", () => {
  const files = new Map([
    ["/src/main.ts", '/// <reference lib="es2015.core" />\nexport const value = 1;\n'],
    ["/cap/a/es5.d.ts", "interface Es5 {}\n"],
    ["/cap/b/core.d.ts", "interface Es2015Core {}\n"],
    ["/libs/lib.es5.d.ts", "interface NotSelected {}\n"],
    ["/libs/lib.es2015.core.d.ts", "interface NotSelected {}\n"],
  ]);
  const built = program(["--lib", "es5", "/src/main.ts"], files,
    new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"], ["lib.es2015.core.d.ts", "/cap/b/core.d.ts"]]));
  assert.deepEqual(Program_GetSourceFiles(built).map(SourceFile_FileName), ["/cap/a/es5.d.ts", "/cap/b/core.d.ts", "/src/main.ts"]);
  assert.deepEqual(libraryDiagnostics(built), []);
});

test("a library the selection does not bind is reported, for a directive without a spelling suggestion", () => {
  const files = new Map([
    ["/src/main.ts", '/// <reference lib="es2015.core" />\nexport const value = 1;\n'],
    ["/cap/a/es5.d.ts", "interface Es5 {}\n"],
    ["/libs/lib.es2015.core.d.ts", "interface NotSelected {}\n"],
  ]);
  const built = program(["--lib", "es5", "/src/main.ts"], files, new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"]]));
  assert.deepEqual(Program_GetSourceFiles(built).map(SourceFile_FileName), ["/cap/a/es5.d.ts", "/src/main.ts"]);
  assert.deepEqual(libraryDiagnostics(built), [[2726, ["es2015.core"]]]);
});

test("a default library or lib entry the selection does not bind is reported for its library file name", () => {
  const files = new Map([["/src/main.ts", "export const value = 1;\n"], ["/libs/lib.es5.d.ts", "interface NotSelected {}\n"]]);
  const withEntry = program(["--lib", "es5", "/src/main.ts"], files, new Map());
  assert.deepEqual(Program_GetSourceFiles(withEntry).map(SourceFile_FileName), ["/src/main.ts"]);
  assert.deepEqual(libraryDiagnostics(withEntry), [[2726, ["lib.es5.d.ts"]]]);
  const withDefault = program(["--target", "es5", "/src/main.ts"], files, new Map());
  assert.deepEqual(Program_GetSourceFiles(withDefault).map(SourceFile_FileName), ["/src/main.ts"]);
  assert.deepEqual(libraryDiagnostics(withDefault), [[2726, ["lib.d.ts"]]]);
});

test("ordinary input is unchanged: libraries from the default directory, and an unknown name keeps its suggestion", () => {
  const files = new Map([
    ["/src/main.ts", '/// <reference lib="es2015.cor" />\nexport const value = 1;\n'],
    ["/libs/lib.es5.d.ts", "interface Es5 {}\n"],
  ]);
  const built = program(["--lib", "es5", "/src/main.ts"], files);
  assert.deepEqual(Program_GetSourceFiles(built).map(SourceFile_FileName), ["/libs/lib.es5.d.ts", "/src/main.ts"]);
  assert.deepEqual(libraryDiagnostics(built), [[2727, ["es2015.cor", "es2015.core"]]]);
});

test("libReplacement does not apply to selected library files", () => {
  const files = new Map([
    ["/src/main.ts", "export const value = 1;\n"],
    ["/cap/a/es5.d.ts", "interface Es5 {}\n"],
    ["/src/node_modules/@typescript/lib-es5/package.json", '{"name":"@typescript/lib-es5","types":"index.d.ts"}'],
    ["/src/node_modules/@typescript/lib-es5/index.d.ts", "interface Replacement {}\n"],
  ]);
  const built = program(["--lib", "es5", "--libReplacement", "/src/main.ts"], files, new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"]]));
  assert.deepEqual(Program_GetSourceFiles(built).map(SourceFile_FileName), ["/cap/a/es5.d.ts", "/src/main.ts"]);
});
