import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, getBundledLibraryPath } from "../index.js";
import type { CompilerSession, InMemoryCompilerSessionOptions } from "../index.js";
import { Diagnostic_Code } from "../internal/ast/diagnostic.js";

const currentDirectory = "/captured";
const main = "/captured/main.ts";
const selectedPath = "/different/root/unrelated-name.d.ts";
const selectedText = "interface CapturedOnly { readonly fromSnapshot: true; }\n";
const bundledPath = `${getBundledLibraryPath()}/lib.es5.d.ts`;
const compilerOptions = { module: "nodenext", moduleResolution: "nodenext", target: "es2024", lib: ["es5"] };
const open = (options: Partial<InMemoryCompilerSessionOptions> = {}): CompilerSession => createCompilerSessionFromFiles({
  currentDirectory, files: { [main]: "export const value = 1;\n" }, rootFiles: [main], compilerOptions, ...options,
});
const codes = (session: CompilerSession): readonly number[] => session.getDiagnostics("program")
  .filter(diagnostic => diagnostic !== undefined).map(Diagnostic_Code);

test("the public files session carries the selected logical name to its exact captured arbitrary path", () => {
  const session = open({ files: { [main]: "export const value = 1;\n", [selectedPath]: selectedText },
    selectedLibraries: new Map([["lib.es5.d.ts", selectedPath]]), includeBundledLibraries: false });
  const checked = session.checkSource();
  const selected = checked.getSourceFile(selectedPath);
  assert.equal(selected !== undefined, true, "the selected captured file is loaded");
  assert.equal(checked.ast.getSourceText(selected), selectedText);
  assert.equal(checked.getSourceFile(bundledPath) === undefined, true, "no default directory fallback");
  assert.deepEqual(codes(session), []);
});

test("an explicitly empty library map is authoritative independently of bundled filesystem policy", () => {
  for (const includeBundledLibraries of [true, false]) {
    const session = open({ selectedLibraries: new Map(), includeBundledLibraries });
    assert.equal(session.checkSource().getSourceFile(bundledPath) === undefined, true, "no selected file exists");
    assert.equal(codes(session).includes(2726), true, "the owning loader reports the absent selected library");
    assert.equal(session.host.FS().ReadFile(bundledPath)[1], includeBundledLibraries, "the independent FS choice is preserved");
  }
});

test("a mapped missing file cannot fall back to the installed default text", () => {
  const missing = "/different/root/missing.d.ts";
  const session = open({ selectedLibraries: new Map([["lib.es5.d.ts", missing]]) });
  const checked = session.checkSource();
  assert.equal(checked.getSourceFile(missing) === undefined, true);
  assert.equal(checked.getSourceFile(bundledPath) === undefined, true);
  assert.equal(session.host.FS().ReadFile(bundledPath)[1], true, "ordinary FS defaults are independent of selection");
  assert.deepEqual(session.host.FS().ReadFile(missing), ["", false], "the selected missing file has no bytes");
  assert.equal(checked.programSourceFiles.length, 1, "no library file was manufactured or loaded from a fallback");
});

test("false disables both wrapper layers for direct bundled-path roots and reads", () => {
  for (const includeBundledLibraries of [false, true]) {
    const session = open({ compilerOptions: { ...compilerOptions, noLib: true },
      rootFiles: [main, bundledPath],
      includeBundledLibraries });
    const checked = session.checkSource();
    assert.equal(checked.getSourceFile(bundledPath) !== undefined, includeBundledLibraries, "direct roots obey the actual filesystem policy");
    assert.equal(session.host.FS().ReadFile(bundledPath)[1], includeBundledLibraries, "no host rewrap restores SDK text");
  }
});

test("false retains captured text without implicitly rebinding a same-basename root", () => {
  const capturedPath = "/captured/lib.es5.d.ts";
  const session = open({ includeBundledLibraries: false, rootFiles: [main, capturedPath],
    files: { [main]: "export const value = 1;\n", [capturedPath]: selectedText } });
  const checked = session.checkSource();
  const selected = checked.getSourceFile(capturedPath);
  assert.equal(selected !== undefined, true);
  assert.equal(checked.ast.getSourceText(selected), selectedText, "only the captured bytes are used");
  assert.deepEqual(session.host.FS().ReadFile(capturedPath), [selectedText, true]);
  assert.deepEqual(session.host.FS().ReadFile(bundledPath), ["", false]);
  assert.equal(checked.getSourceFile(bundledPath) === undefined, true);
});

test("a direct bundled-URI import cannot restore text through a disabled wrapper", () => {
  const session = open({ includeBundledLibraries: false, compilerOptions: { ...compilerOptions, noLib: true },
    files: { [main]: `import type {} from ${JSON.stringify(bundledPath)}; export const value = 1;\n` } });
  assert.equal(session.checkSource().getSourceFile(bundledPath) === undefined, true);
  assert.deepEqual(session.host.FS().ReadFile(bundledPath), ["", false]);
});

test("omitted wrapper controls preserve the ordinary SDK library defaults", () => {
  const session = open();
  assert.equal(session.checkSource().getSourceFile(bundledPath) !== undefined, true);
  assert.equal(session.host.FS().ReadFile(bundledPath)[1], true);
  assert.deepEqual(codes(session), []);
});

test("configuration mode shares the same explicit selection and captured-files-only choice", () => {
  const configFileName = "/captured/project.json";
  const session = createCompilerSessionFromFiles({ currentDirectory, configFileName,
    selectedLibraries: new Map([["lib.es5.d.ts", selectedPath]]), includeBundledLibraries: false,
    files: { [configFileName]: JSON.stringify({ compilerOptions, files: ["main.ts"] }),
      [main]: "export const value = 1;\n", [selectedPath]: selectedText } });
  assert.equal(session.checkSource().getSourceFile(selectedPath) !== undefined, true);
  assert.deepEqual(session.host.FS().ReadFile(bundledPath), ["", false]);
  assert.deepEqual(codes(session), []);
});
