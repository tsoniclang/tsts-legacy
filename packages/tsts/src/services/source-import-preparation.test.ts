import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prepareSourceImports } from "../index.js";
import type { SourceImportPreparation, SourceImportPreparationFile, SourceImportPreparationReference } from "../index.js";
import type { SourceFile } from "../internal/ast/ast.js";
import { SourceFile_Diagnostics, SourceFile_FileName } from "../internal/ast/ast.js";
import { Diagnostic_Code } from "../internal/ast/diagnostic.js";
import { TextRange_End, TextRange_Pos } from "../internal/core/text.js";
import { GetParsedCommandLineOfConfigFile } from "../internal/tsoptions/tsconfigparsing.js";
import { ParseCommandLine } from "../internal/tsoptions/commandlineparser.js";
import { createCompilerHost, createInMemoryFileSystem } from "./embedding-host.js";

interface FixtureOptions {
  readonly noLib?: boolean;
  readonly lib?: readonly string[];
  readonly allowJs?: boolean;
  readonly types?: readonly string[];
  readonly noResolve?: boolean;
  readonly moduleDetection?: "legacy" | "auto" | "force";
}

function fixture(files: ReadonlyMap<string, string>, roots: readonly string[], options: FixtureOptions = {}) {
  const inputs = new Map(files);
  inputs.set("/src/tsconfig.json", JSON.stringify({
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", noLib: true, types: [], ...options },
    files: roots,
  }));
  const original = createCompilerHost({ currentDirectory: "/src", defaultLibraryPath: "/libs",
    includeBundledLibraries: false, cacheFileSystem: false,
    fileSystem: createInMemoryFileSystem({ files: inputs, includeBundledLibraries: false, useCaseSensitiveFileNames: true }) });
  const parsed: SourceFile[] = [];
  const host = { ...original, GetSourceFile: (options: Parameters<typeof original.GetSourceFile>[0]) => {
    const sourceFile = original.GetSourceFile(options);
    if (sourceFile !== undefined) parsed.push(sourceFile);
    return sourceFile;
  } };
  const [config, diagnostics] = GetParsedCommandLineOfConfigFile("/src/tsconfig.json", undefined, undefined, host, undefined);
  assert.equal(config !== undefined, true, "the real SDK parsed the fixture configuration");
  assert.equal((diagnostics ?? []).length, 0, "configuration acquisition has no unrelated failures, including genuine Go nil diagnostics");
  if (config === undefined) throw new Error("The fixture configuration was not parsed.");
  return { host, config, parsed };
}

function file(result: SourceImportPreparation, fileName: string): SourceImportPreparationFile {
  const found = result.files.find(candidate => candidate.fileName === fileName);
  assert.equal(found !== undefined, true, `the complete file domain contains ${fileName}`);
  if (found === undefined) throw new Error(`The prepared closure omits ${fileName}.`);
  return found;
}

function facts(reference: SourceImportPreparationReference) {
  return [reference.kind, reference.specifier, reference.mode,
    reference.resolution.kind === "resolved" ? reference.resolution.fileName : "unresolved"];
}

test("source import preparation preserves all eight authored reference families and genuine resolution", () => {
  const authored = [
    { prefix: '/// <reference path="', token: "./ambient.d.ts", suffix: '" />' },
    { prefix: '/// <reference types="', token: "ambient", suffix: '" />' },
    { prefix: '/// <reference lib="', token: "es5", suffix: '" />' },
    { prefix: "import { value } from ", token: '"./import.js"', suffix: ";" },
    { prefix: "export { value } from ", token: '"./export.js"', suffix: ";" },
    { prefix: "type Selected = import(", token: '"./type.js"', suffix: ").Selected;" },
    { prefix: "const loaded = import(", token: '"./dynamic.js"', suffix: ");" },
  ];
  let byteOffset = 0;
  const expectedRanges = authored.map(occurrence => {
    const range = { start: byteOffset + Buffer.byteLength(occurrence.prefix), length: Buffer.byteLength(occurrence.token) };
    byteOffset += Buffer.byteLength(occurrence.prefix + occurrence.token + occurrence.suffix) + 1;
    return range;
  });
  const main = authored.map(occurrence => occurrence.prefix + occurrence.token + occurrence.suffix).join("\n");
  const inputs = new Map([
    ["/src/package.json", '{"type":"module"}'], ["/src/main.ts", main],
    ["/src/ambient.d.ts", "declare const ambient: number;"],
    ["/src/node_modules/@types/ambient/package.json", '{"name":"@types/ambient","version":"1.0.0","types":"index.d.ts"}'],
    ["/src/node_modules/@types/ambient/index.d.ts", "declare const ambientPackage: number;"],
    ["/libs/lib.es5.d.ts", "interface MinimalLibrary {}"],
    ["/src/import.ts", "export const value = 1;"], ["/src/export.ts", "export const value = 2;"],
    ["/src/type.ts", "export type Selected = number;"], ["/src/dynamic.ts", "export const dynamic = 3;"],
    ["/src/main.cjs", 'const loaded = require("./required.cjs");'], ["/src/required.cjs", "exports.value = 4;"],
  ]);
  const input = fixture(inputs, ["/src/main.ts", "/src/main.cjs"], { noLib: false, lib: [], allowJs: true });
  const result = prepareSourceImports(input);
  const expectedFiles = ["/libs/lib.es5.d.ts", "/src/ambient.d.ts", "/src/node_modules/@types/ambient/index.d.ts",
    "/src/import.ts", "/src/export.ts", "/src/type.ts", "/src/dynamic.ts", "/src/main.ts", "/src/required.cjs", "/src/main.cjs"];
  assert.deepEqual(result.files.map(candidate => candidate.fileName).sort(), [...expectedFiles].sort());
  assert.equal(result.diagnostics.length, 0);
  const expected = [
    ["reference-path", "./ambient.d.ts", "none", "/src/ambient.d.ts"],
    ["reference-types", "ambient", "import", "/src/node_modules/@types/ambient/index.d.ts"],
    ["reference-lib", "es5", "none", "/libs/lib.es5.d.ts"],
    ["import", "./import.js", "import", "/src/import.ts"],
    ["export", "./export.js", "import", "/src/export.ts"],
    ["import-type", "./type.js", "import", "/src/type.ts"],
    ["dynamic-import", "./dynamic.js", "import", "/src/dynamic.ts"],
  ];
  assert.deepEqual(file(result, "/src/main.ts").references.map(facts), expected);
  assert.deepEqual(file(result, "/src/main.ts").references.map(reference => reference.placement),
    ["directive", "directive", "directive", "statement", "statement", "expression", "expression"]);
  assert.deepEqual(file(result, "/src/main.cjs").references.map(facts), [["require", "./required.cjs", "require", "/src/required.cjs"]]);
  assert.deepEqual(file(result, "/src/main.cjs").references.map(reference => reference.placement), ["expression"]);
  const parsedMain = input.parsed.find(source => SourceFile_FileName(source) === "/src/main.ts");
  if (parsedMain === undefined) throw new Error("The expected genuine main source was not parsed.");
  const directiveGroups = [parsedMain.ReferencedFiles, parsedMain.TypeReferenceDirectives, parsedMain.LibReferenceDirectives];
  assert.deepEqual(directiveGroups.map(group => group.length), [1, 1, 1], "every independently authored directive has one genuine parser record");
  const prepared = file(result, "/src/main.ts").references;
  for (const [index, group] of directiveGroups.entries()) {
    const directive = group[0];
    const expectedRange = expectedRanges[index];
    const reference = prepared[index];
    if (directive === undefined || expectedRange === undefined || reference === undefined) {
      throw new Error("The complete authored directive range domain is absent.");
    }
    assert.deepEqual({ start: TextRange_Pos(directive), length: TextRange_End(directive) - TextRange_Pos(directive) },
      expectedRange, `directive ${index} belongs to its own authored attribute, not an earlier equal substring`);
    assert.equal(reference.start, TextRange_Pos(directive), `directive ${index} retains the genuine parser's own range start`);
    assert.equal(reference.length, TextRange_End(directive) - TextRange_Pos(directive), `directive ${index} retains the genuine parser's own full range`);
  }
  assert.deepEqual(prepared.map(reference => ({ start: reference.start, length: reference.length })), expectedRanges,
    "the complete occurrence-specific UTF8 vector retains interior directive and quoted ordinary spans");
  assert.equal(input.parsed.every(source => !source.isBound.Load()), true,
    "every genuine parsed source remains unbound, without checked semantic state");
});

test("source import preparation omits nonliteral calls and retains their literal opposites", () => {
  const input = fixture(new Map([
    ["/src/main.js", [
      'const name = "./dep.js";', 'import(name);', 'require(name);',
      'import("./dep.js");', 'require("./dep.js");',
      `const text = 'import("./not-an-edge.js")';`,
      'const template = import(`./${name}.js`);',
    ].join("\n")], ["/src/dep.js", "exports.value = 1;"],
  ]), ["/src/main.js"], { allowJs: true });
  const result = prepareSourceImports(input);
  assert.deepEqual(result.files.map(candidate => candidate.fileName), ["/src/dep.js", "/src/main.js"]);
  assert.deepEqual(file(result, "/src/main.js").references.map(facts), [
    ["dynamic-import", "./dep.js", "import", "/src/dep.js"], ["require", "./dep.js", "require", "/src/dep.js"],
  ]);
  assert.equal(result.diagnostics.length, 0);
});

test("source import preparation derives statement, ambient, expression and directive placement from the genuine parser", () => {
  const ambientModule = [
    'declare module "declared" {', 'import type { Value } from "owned";', 'export type { Value } from "owned";',
    'import selected = require("owned");', 'type Selected = import("owned").Value;', '}',
  ].join("\n");
  const inputs = new Map([
    ["/src/top.mts", [
      'import type { Value } from "owned";', 'export type { Value } from "owned";',
      'type Selected = import("owned").Value;', 'function load() { return import("owned"); }',
    ].join("\n")],
    ["/src/ambient.ts", [
      '/// <reference path="./directive.d.ts" />', '/// <reference types="ambient" />', '/// <reference lib="es5" />',
      ambientModule,
    ].join("\n")],
    ["/src/augmentation-export.ts", `export {};\n${ambientModule}`],
    ["/src/augmentation-import.ts", `import type { Value } from "owned";\n${ambientModule}`],
    ["/src/static.cts", 'import selected = require("owned");'],
    ["/src/calls.js", 'function load(name) { require(name); import(name); return require("owned"); }'],
    ["/src/docs.js", '/** @import { Value } from "owned" */\nconst value = 1;'],
    ["/src/directive.d.ts", "declare const directive: number;"],
    ["/src/node_modules/@types/ambient/package.json", '{"name":"@types/ambient","version":"1.0.0","types":"index.d.ts"}'],
    ["/src/node_modules/@types/ambient/index.d.ts", "declare const ambient: number;"],
    ["/libs/lib.es5.d.ts", "interface MinimalLibrary {}"],
    ["/src/node_modules/owned/package.json", '{"name":"owned","version":"1.0.0","types":"index.d.ts"}'],
    ["/src/node_modules/owned/index.d.ts", "export type Value = number;"],
  ]);
  const roots = ["/src/top.mts", "/src/ambient.ts", "/src/augmentation-export.ts", "/src/augmentation-import.ts",
    "/src/static.cts", "/src/calls.js", "/src/docs.js"];
  const input = fixture(inputs, roots, { noLib: false, lib: [], allowJs: true, moduleDetection: "legacy" });
  const result = prepareSourceImports(input);
  const expected: readonly { readonly fileName: string; readonly references: readonly (readonly string[])[] }[] = [
    { fileName: "/src/top.mts", references: [["import", "statement"], ["export", "statement"],
      ["import-type", "expression"], ["dynamic-import", "expression"]] },
    { fileName: "/src/ambient.ts", references: [["reference-path", "directive"], ["reference-types", "directive"],
      ["reference-lib", "directive"], ["import", "ambient-module"], ["export", "ambient-module"],
      ["require", "ambient-module"], ["import-type", "expression"]] },
    { fileName: "/src/augmentation-export.ts", references: [["import-type", "expression"]] },
    { fileName: "/src/augmentation-import.ts", references: [["import", "statement"], ["import-type", "expression"]] },
    { fileName: "/src/static.cts", references: [["require", "statement"]] },
    { fileName: "/src/calls.js", references: [["require", "expression"]] },
    { fileName: "/src/docs.js", references: [["import-type", "statement"]] },
  ];
  assert.deepEqual(result.files.map(candidate => candidate.fileName).sort(), [
    "/src/top.mts", "/src/ambient.ts", "/src/augmentation-export.ts", "/src/augmentation-import.ts",
    "/src/static.cts", "/src/calls.js", "/src/docs.js", "/src/directive.d.ts",
    "/src/node_modules/@types/ambient/index.d.ts", "/libs/lib.es5.d.ts", "/src/node_modules/owned/index.d.ts",
  ].sort(), "the complete placement-control file domain is fixed independently");
  for (const original of expected) {
    assert.deepEqual(file(result, original.fileName).references.map(reference => [reference.kind, reference.placement]),
      original.references, `${original.fileName} retains every expected kind/placement pair and excludes its opposites`);
  }
  const activationOccurrences = result.files.flatMap(candidate => candidate.references
    .filter(reference => (reference.kind === "import" || reference.kind === "export") && reference.placement === "statement")
    .map(reference => [candidate.fileName, reference.kind, reference.specifier]));
  assert.deepEqual(activationOccurrences, [["/src/top.mts", "import", "owned"], ["/src/top.mts", "export", "owned"],
    ["/src/augmentation-import.ts", "import", "owned"]],
    "same-spelled ambient exports/imports, type expressions, calls, directives and JS doc imports do not broaden the original activation domain");
  const forced = prepareSourceImports(fixture(inputs, ["/src/ambient.ts"], { noLib: false, lib: [], allowJs: true }));
  assert.deepEqual(file(forced, "/src/ambient.ts").references.map(reference => [reference.kind, reference.placement]),
    [["reference-path", "directive"], ["reference-types", "directive"], ["reference-lib", "directive"], ["import-type", "expression"]],
    "actual NodeNext default Force makes this nondeclaration source an augmentation, unlike the explicit Legacy script");
});

test("source import preparation retains the SDK declaration-file classification for project, resolved and library files", () => {
  const input = fixture(new Map([
    ["/src/main.ts", 'import type { Value } from "package-declaration"; import "./implementation.js";'],
    ["/src/project.d.ts", "declare interface ProjectDeclaration {}"],
    ["/src/implementation.ts", "export declare const implementation: number;"],
    ["/src/node_modules/package-declaration/package.json", '{"name":"package-declaration","version":"1.0.0","types":"index.d.ts"}'],
    ["/src/node_modules/package-declaration/index.d.ts", "export type Value = number;"],
    ["/libs/lib.es5.d.ts", "interface MinimalLibrary {}"],
  ]), ["/src/main.ts", "/src/project.d.ts"], { noLib: false, lib: ["es5"] });
  const result = prepareSourceImports(input);
  const expected = [
    ["/libs/lib.es5.d.ts", true], ["/src/implementation.ts", false], ["/src/main.ts", false],
    ["/src/node_modules/package-declaration/index.d.ts", true], ["/src/project.d.ts", true],
  ];
  assert.deepEqual(result.files.map(candidate => [candidate.fileName, candidate.declarationFile])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))), expected,
  "the complete independent domain distinguishes project declarations, reached declarations and libs from genuine source files");
  for (const candidate of result.files) {
    const original = input.parsed.find(source => SourceFile_FileName(source) === candidate.fileName);
    if (original === undefined) throw new Error("The declaration flag lacks its actual parsed SDK source file.");
    assert.equal(candidate.declarationFile, original.IsDeclarationFile,
      `${candidate.fileName} retains the SDK flag instead of a Host suffix or role guess`);
  }
  assert.deepEqual(result.files.filter(candidate => !candidate.declarationFile).map(candidate => candidate.fileName).sort(),
    ["/src/implementation.ts", "/src/main.ts"], "the original project-source filter excludes all three genuine declaration origins");
  assert.equal(result.roots.some(root => root.fileName === "/src/project.d.ts" && root.state === "loaded"), true,
    "a project declaration is still a loaded root, not a missing or dropped file");
});

test("source import preparation preserves complete deterministic shared and cyclic closure once", () => {
  const inputs = new Map([
    ["/src/main.mts", 'import "./left.mjs"; import "./right.mjs"; import "./left.mjs";'],
    ["/src/left.mts", 'import "./shared.mjs"; import "./main.mjs";'],
    ["/src/right.mts", 'import "./shared.mjs";'], ["/src/shared.mts", "export const value = 1;"],
  ]);
  const input = fixture(inputs, ["/src/main.mts"]);
  const first = prepareSourceImports(input);
  const second = prepareSourceImports(fixture(new Map([...inputs].reverse()), ["/src/main.mts"]));
  assert.deepEqual(first.files.map(candidate => candidate.fileName), ["/src/shared.mts", "/src/left.mts", "/src/right.mts", "/src/main.mts"]);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(file(first, "/src/main.mts").references.map(reference => reference.specifier), ["./left.mjs", "./right.mjs", "./left.mjs"]);
  assert.equal(input.parsed.length, 4, "shared and cyclic sources are actually parsed once, not just deduplicated afterward");
  assert.equal(new Set(input.parsed.map(SourceFile_FileName)).size, 4);
  assert.equal(Object.isFrozen(first) && Object.isFrozen(first.roots) && Object.isFrozen(first.files) && Object.isFrozen(first.diagnostics), true);
  for (const root of first.roots) {
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Reflect.defineProperty(root, "state", { value: "missing" }), false,
      "the actual frozen root status rejects mutation");
  }
  for (const candidate of first.files) {
    assert.equal(Object.isFrozen(candidate) && Object.isFrozen(candidate.references), true);
    for (const reference of candidate.references) {
      assert.equal(Object.isFrozen(reference) && Object.isFrozen(reference.resolution), true);
      assert.equal(Reflect.defineProperty(reference, "specifier", { value: "changed" }), false,
        "the actual frozen occurrence rejects mutation");
    }
  }
});

test("source import preparation uses NodeNext package conditions, self names and import-equals modes", () => {
  const input = fixture(new Map([
    ["/src/package.json", '{"name":"self-package","type":"module","exports":{"./feature":"./feature.mts"}}'],
    ["/src/main.mts", 'import "conditions"; export type { Value } from "conditions"; import "self-package/feature";'],
    ["/src/main.cts", 'import selected = require("conditions");'], ["/src/feature.mts", "export const feature = 1;"],
    ["/src/node_modules/conditions/package.json", JSON.stringify({ name: "conditions", version: "1.0.0", exports: {
      ".": { import: { types: "./import.d.mts" }, require: { types: "./require.d.cts" } },
    } })],
    ["/src/node_modules/conditions/import.d.mts", "export type Value = number;"],
    ["/src/node_modules/conditions/require.d.cts", "export declare const value: number;"],
  ]), ["/src/main.mts", "/src/main.cts"]);
  const result = prepareSourceImports(input);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(file(result, "/src/main.mts").references.map(facts), [
    ["import", "conditions", "import", "/src/node_modules/conditions/import.d.mts"],
    ["export", "conditions", "import", "/src/node_modules/conditions/import.d.mts"],
    ["import", "self-package/feature", "import", "/src/feature.mts"],
  ]);
  assert.deepEqual(file(result, "/src/main.cts").references.map(facts), [
    ["require", "conditions", "require", "/src/node_modules/conditions/require.d.cts"],
  ]);
});

test("source import preparation retains unavailable physical imports without semantic checking or a fallback", () => {
  const input = fixture(new Map([["/src/main.mts", [
    'import type { Profile } from "@acme/profile";',
    "const value: MissingType = unusedCapabilityValue;",
  ].join("\n")]]), ["/src/main.mts"]);
  const result = prepareSourceImports(input);
  assert.deepEqual(result.files.map(candidate => candidate.fileName), ["/src/main.mts"]);
  assert.deepEqual(file(result, "/src/main.mts").references.map(facts), [["import", "@acme/profile", "import", "unresolved"]]);
  assert.equal(result.diagnostics.length, 0, "unresolved physical ownership is not a fabricated semantic TS2304/TS2307 verdict");
  assert.equal(input.parsed.every(source => !source.isBound.Load()), true);
});

test("source import preparation retains actual resolver diagnostics and duplicate authored unresolved edges", () => {
  const input = fixture(new Map([
    ["/src/package.json", '{"type":"module","imports":{"#feature":"./dist/feature.js"}}'],
    ["/src/main.mts", 'import "#feature"; import "#feature";'],
  ]), ["/src/main.mts"]);
  const config = ParseCommandLine(["--module", "nodenext", "--noLib", "--outDir", "/src/dist", "/src/main.mts"], input.host);
  if (config === undefined) throw new Error("The SDK did not parse the import-map control.");
  const result = prepareSourceImports({ host: input.host, config });
  assert.deepEqual(file(result, "/src/main.mts").references.map(facts), [
    ["import", "#feature", "import", "unresolved"], ["import", "#feature", "import", "unresolved"],
  ]);
  assert.equal(result.diagnostics.length, 1, "one actual cached resolution diagnostic does not erase two authored occurrences");
  assert.equal(result.diagnostics.every(diagnostic => Diagnostic_Code(diagnostic) === 2210), true,
    "the actual SDK resolver reports ambiguous project-root attribution");
});

test("source import preparation preserves parser identity and factual loaded, empty and missing roots without inclusion messages", () => {
  const input = fixture(new Map([["/src/main.mts", [
    '/// <reference types="absent-types" />', '/// <reference lib="absent-library" />', "const = ;",
  ].join("\n")], ["/src/empty.ts", ""]]), ["/src/main.mts", "/src/missing.ts", "/src/empty.ts"], { noLib: false, lib: [] });
  const result = prepareSourceImports(input);
  assert.deepEqual(result.roots, [
    { fileName: "/src/main.mts", state: "loaded" },
    { fileName: "/src/missing.ts", state: "missing" },
    { fileName: "/src/empty.ts", state: "loaded" },
  ], "root facts retain configuration order and distinguish a genuine empty file from an unread root");
  assert.equal(result.files.some(candidate => candidate.fileName === "/src/missing.ts"), false);
  assert.equal(result.files.some(candidate => candidate.fileName === "/src/empty.ts"), true);
  assert.equal(result.diagnostics.some(diagnostic => [6053, 2688, 2726, 2727].includes(Diagnostic_Code(diagnostic))), false,
    "Program-owned inclusion messages are left to the one real check");
  const parsed = input.parsed.find(source => SourceFile_FileName(source) === "/src/main.mts");
  assert.equal(parsed !== undefined, true);
  const parserDiagnostics = SourceFile_Diagnostics(parsed) ?? [];
  assert.equal(parserDiagnostics.length > 0, true, "the actual SDK parser observed the malformed declaration");
  assert.equal(parserDiagnostics.every(diagnostic => diagnostic !== undefined && result.diagnostics.includes(diagnostic)), true,
    "every genuine parser diagnostic is retained by identity, not rebuilt or suppressed");
  assert.equal(result.diagnostics.every(diagnostic => parserDiagnostics.includes(diagnostic)), true,
    "preparation did not manufacture another diagnostic owner");
  assert.deepEqual(file(result, "/src/main.mts").references.map(reference => reference.resolution.kind), ["unresolved", "unresolved"]);
});

test("source import preparation retains independent equal-text documents and original UTF8 spans", () => {
  const source = 'const label = "λ"; import "./dep.mjs";';
  const input = fixture(new Map([["/src/first.mts", source], ["/src/second.mts", source], ["/src/dep.mts", "export {};"],
  ]), ["/src/first.mts", "/src/second.mts"]);
  const result = prepareSourceImports(input);
  assert.deepEqual(result.files.map(candidate => candidate.fileName), ["/src/dep.mts", "/src/first.mts", "/src/second.mts"]);
  for (const name of ["/src/first.mts", "/src/second.mts"]) {
    const references = file(result, name).references;
    assert.equal(references.length, 1);
    const reference = references[0];
    if (reference === undefined) throw new Error("The expected original import is absent.");
    assert.equal(reference.start, Buffer.from(source).indexOf('"./dep.mjs"'));
    assert.equal(reference.length, Buffer.byteLength('"./dep.mjs"'));
  }
});

test("source import preparation retains invalid configuration instead of returning an empty successful result", () => {
  const input = fixture(new Map([["/src/main.mts", "export {}; "]]), ["/src/main.mts"]);
  const config = ParseCommandLine(["--noLib", "--unrecognisedSDKflag", "/src/main.mts"], input.host);
  if (config === undefined) throw new Error("The SDK did not retain its invalid command line.");
  assert.equal(config.Errors.length > 0, true, "the real option parser rejected the unsupported flag");
  const result = prepareSourceImports({ host: input.host, config });
  assert.equal(config.Errors.every(diagnostic => diagnostic !== undefined && result.diagnostics.includes(diagnostic)), true,
    "all actual configuration errors survive by identity");
});

test("source import preparation preserves the actual none resolution mode and disabled directive policy", () => {
  const input = fixture(new Map([["/src/main.ts", 'import "./dep";'], ["/src/dep.ts", "export {};"],
  ]), ["/src/main.ts"]);
  const commonJs = ["--noLib", "--module", "commonjs", "--moduleResolution", "classic"];
  const config = ParseCommandLine([...commonJs, "--resolvePackageJsonExports", "false",
    "--resolvePackageJsonImports", "false", "/src/main.ts"], input.host);
  if (config === undefined) throw new Error("The SDK did not parse the explicit mode-insensitive control.");
  assert.equal(config.Errors.length, 0, "the actual registered false package-map flags are valid command-line input");
  const result = prepareSourceImports({ host: input.host, config });
  assert.deepEqual(file(result, "/src/main.ts").references.map(facts), [["import", "./dep", "none", "/src/dep.ts"]]);
  const defaults = ParseCommandLine([...commonJs, "/src/main.ts"], input.host);
  if (defaults === undefined) throw new Error("The SDK did not parse the default package-map opposite.");
  assert.equal(defaults.Errors.length, 0, "the actual CommonJS/Classic input remains valid before mode normalization");
  const defaultResult = prepareSourceImports({ host: input.host, config: defaults });
  assert.deepEqual(file(defaultResult, "/src/main.ts").references.map(facts), [["import", "./dep", "require", "/src/dep.ts"]],
    "actual Classic normalizes to Bundler and default package maps preserve the CommonJS syntax mode");
  const skipped = prepareSourceImports(fixture(new Map([["/src/main.mts", [
    '/// <reference types="disabled-type-resolution" />', '/// <reference lib="es5" />', "export {};",
  ].join("\n")]]), ["/src/main.mts"], { noResolve: true }));
  assert.equal(skipped.diagnostics.length, 0, "disabled resolution does not manufacture missing-directive diagnostics");
  assert.deepEqual(file(skipped, "/src/main.mts").references.map(reference => reference.resolution.kind), ["unresolved", "unresolved"]);
});

test("source import preparation executes real parser and resolver without constructing compiler semantic owners", () => {
  const coverageDirectory = mkdtempSync(join(process.cwd(), ".temp/source-import-preparation-"));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const sdk = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});
    const host = sdk.createCompilerHost({currentDirectory:"/src", includeBundledLibraries:false,
      fileSystem:sdk.createInMemoryFileSystem({includeBundledLibraries:false, files:{
        "/src/main.mts":'import "./dep.mjs"; const value: MissingType = unusedCapabilityValue;',
        "/src/dep.mts":"export {};"
      }})});
    const config = sdk.ParseCommandLine(["--module","nodenext","--noLib","/src/main.mts"],host);
    if (config === undefined) throw new Error("Actual SDK command-line parsing failed.");
    const result = sdk.prepareSourceImports({host,config});
    process.stdout.write(JSON.stringify({files:result.files.map(file=>file.fileName),diagnostics:result.diagnostics.length}));
  `], { encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, maxBuffer: 65536 });
  assert.equal(child.status, 0, `the genuine SDK preparation child completes: ${child.stderr.slice(0, 2048)}`);
  assert.deepEqual(JSON.parse(child.stdout), { files: ["/src/dep.mts", "/src/main.mts"], diagnostics: 0 });
  interface CoverageReport {
    readonly result: readonly {
      readonly url: string;
      readonly functions: readonly {
        readonly functionName: string;
        readonly ranges: readonly { readonly count: number }[];
      }[];
    }[];
  }
  const reports: CoverageReport[] = readdirSync(coverageDirectory).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(coverageDirectory, name), "utf8")));
  assert.equal(reports.length > 0, true, "the actual unmodified SDK child emitted V8 execution evidence");
  const expected = [
    { path: "../internal/parser/parser/statements-declarations.js", name: "ParseSourceFile", executes: true },
    { path: "../internal/compiler/fileloader.js", name: "processAllProgramFiles", executes: true },
    { path: "../internal/module/resolver.js", name: "Resolver_ResolveModuleName", executes: true },
    { path: "../internal/compiler/program.js", name: "NewProgram", executes: false },
    { path: "../internal/compiler/checkerpool.js", name: "newCheckerPool", executes: false },
    { path: "../internal/compiler/checkerpool.js", name: "newCheckerPoolWithTracing", executes: false },
    { path: "../internal/binder/binder.js", name: "BindSourceFile", executes: false },
    { path: "../extensions/host.js", name: "ExtensionHost", executes: false },
    { path: "../extensions/host.js", name: "attachExtensionHost", executes: false },
    { path: "../extensions/host.js", name: "attachExtensionHostToProgram", executes: false },
  ];
  for (const owner of expected) {
    const url = new URL(owner.path, import.meta.url).href;
    const functions = reports.flatMap(report => report.result).filter(script => script.url === url)
      .flatMap(script => script.functions).filter(func => func.functionName === owner.name);
    assert.equal(functions.length > 0, true, `${owner.name} is present in genuine current SDK V8 records`);
    const counts = functions.map(func => func.ranges[0]?.count);
    assert.equal(counts.every(count => count !== undefined && (owner.executes ? count > 0 : count === 0)), true,
      `${owner.name} has the independently expected construction/execution status`);
  }
});
