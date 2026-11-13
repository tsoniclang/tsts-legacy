import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prepareSourceImports } from "../index.js";
import { loadedLibraryFilesByName } from "./source-import-preparation.js";
import type { SourceImportPreparation, SourceImportPreparationFile, SourceImportPreparationReference } from "../index.js";
import type { SourceFile } from "../internal/ast/ast.js";
import { SourceFile_Diagnostics, SourceFile_FileName, SourceFile_Imports } from "../internal/ast/ast.js";
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

function fixture(files: ReadonlyMap<string, string>, roots: readonly string[], options: FixtureOptions = {},
  defaultLibraryPath: string | null = "/libs") {
  const inputs = new Map(files);
  inputs.set("/src/tsconfig.json", JSON.stringify({
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", noLib: true, types: [], ...options },
    files: roots,
  }));
  // A null default library path leaves the host's own default: the SDK's bundled library directory.
  const original = createCompilerHost({ currentDirectory: "/src", ...(defaultLibraryPath === null ? {} : { defaultLibraryPath }),
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
  // A first line of two-, three- and four-byte characters: every site below it differs between UTF-16 units and bytes.
  const header = "// \u00e9\u20ac\u{1f600}\n";
  let offset = header.length;
  const expectedRanges = authored.map(occurrence => {
    const range = { start: offset + occurrence.prefix.length, length: occurrence.token.length };
    offset += (occurrence.prefix + occurrence.token + occurrence.suffix).length + 1;
    return range;
  });
  const main = header + authored.map(occurrence => occurrence.prefix + occurrence.token + occurrence.suffix).join("\n");
  const repeatedToken = '"./required.cjs"';
  const repeatedPrefix = "require(";
  const repeatedStatement = `${repeatedPrefix}${repeatedToken});`;
  const repeated = `${header}${repeatedStatement}\n${repeatedStatement}`;
  const repeatedRanges = [header.length, header.length + `${repeatedStatement}\n`.length].map(start => ({
    start: start + repeatedPrefix.length, length: repeatedToken.length,
  }));
  const bytesBefore = (text: string, unitOffset: number): number => Buffer.byteLength(text.slice(0, unitOffset));
  const inputs = new Map([
    ["/src/package.json", '{"type":"module"}'], ["/src/main.ts", main],
    ["/src/ambient.d.ts", "declare const ambient: number;"],
    ["/src/node_modules/@types/ambient/package.json", '{"name":"@types/ambient","version":"1.0.0","types":"index.d.ts"}'],
    ["/src/node_modules/@types/ambient/index.d.ts", "declare const ambientPackage: number;"],
    ["/libs/lib.es5.d.ts", "interface MinimalLibrary {}"],
    ["/src/import.ts", "export const value = 1;"], ["/src/export.ts", "export const value = 2;"],
    ["/src/type.ts", "export type Selected = number;"], ["/src/dynamic.ts", "export const dynamic = 3;"],
    ["/src/main.cjs", 'const loaded = require("./required.cjs");'], ["/src/required.cjs", "exports.value = 4;"],
    ["/src/repeated.cjs", repeated],
  ]);
  const input = fixture(inputs, ["/src/main.ts", "/src/main.cjs", "/src/repeated.cjs"], { noLib: false, lib: [], allowJs: true });
  const result = prepareSourceImports(input);
  const expectedFiles = ["/libs/lib.es5.d.ts", "/src/ambient.d.ts", "/src/node_modules/@types/ambient/index.d.ts",
    "/src/import.ts", "/src/export.ts", "/src/type.ts", "/src/dynamic.ts", "/src/main.ts", "/src/required.cjs", "/src/main.cjs", "/src/repeated.cjs"];
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
  assert.deepEqual(file(result, "/src/repeated.cjs").references.map(facts), [
    ["require", "./required.cjs", "require", "/src/required.cjs"],
    ["require", "./required.cjs", "require", "/src/required.cjs"],
  ], "equal specifiers in distinct authored calls are two occurrences, not one resolver-cache entry");
  assert.deepEqual(file(result, "/src/repeated.cjs").references.map(reference => reference.placement), ["expression", "expression"]);
  assert.deepEqual(file(result, "/src/repeated.cjs").references.map(reference => ({ start: reference.start, length: reference.length })),
    repeatedRanges, "both distinct authored ranges survive repeated parser visits to either literal");
  for (const [fileName, count] of [["/src/main.cjs", 1], ["/src/repeated.cjs", 2]] as const) {
    const parsed = input.parsed.find(source => SourceFile_FileName(source) === fileName);
    if (parsed === undefined) throw new Error(`The genuine authored require source ${fileName} was not parsed.`);
    assert.equal(new Set(SourceFile_Imports(parsed)).size, count,
      "the projected occurrence count is the actual distinct parser-node domain, not substring or specifier multiplicity");
  }
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
    // The parser's own range is in UTF-8 bytes of the text; the reported site is the same place in UTF-16 units.
    assert.deepEqual({ start: TextRange_Pos(directive), length: TextRange_End(directive) - TextRange_Pos(directive) },
      { start: bytesBefore(main, expectedRange.start), length: Buffer.byteLength(main.slice(expectedRange.start, expectedRange.start + expectedRange.length)) },
      `directive ${index} belongs to its own authored attribute, not an earlier equal substring`);
    assert.notEqual(TextRange_Pos(directive), expectedRange.start, `directive ${index}: the byte position and the UTF-16 site differ in this text`);
    assert.deepEqual({ start: reference.start, length: reference.length }, expectedRange,
      `directive ${index} is reported at the parser's own range, converted to UTF-16 units`);
  }
  assert.deepEqual(prepared.map(reference => ({ start: reference.start, length: reference.length })), expectedRanges,
    "the complete occurrence-specific UTF-16 vector retains interior directive and quoted ordinary spans");
  for (const [index, reference] of prepared.entries()) {
    assert.equal(main.slice(reference.start, reference.start + reference.length), authored[index]?.token, `reference ${index}: the UTF-16 slice is the authored token`);
    assert.notEqual(bytesBefore(main, reference.start), reference.start, `reference ${index}: the byte offset differs from the reported site`);
  }
  for (const reference of file(result, "/src/repeated.cjs").references) {
    assert.equal(repeated.slice(reference.start, reference.start + reference.length), repeatedToken);
    assert.notEqual(bytesBefore(repeated, reference.start), reference.start);
  }
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

test("source import preparation retains independent equal-text documents and UTF-16 spans of the parsed text", () => {
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
    // The character before the import is two UTF-8 bytes and one UTF-16 unit, so the two offsets differ.
    assert.notEqual(Buffer.from(source).indexOf('"./dep.mjs"'), source.indexOf('"./dep.mjs"'));
    assert.equal(reference.start, source.indexOf('"./dep.mjs"'));
    assert.equal(reference.length, '"./dep.mjs"'.length);
    assert.equal(source.slice(reference.start, reference.start + reference.length), '"./dep.mjs"');
  }
});

test("source import preparation reports UTF-16 spans after one-, two-, three- and four-byte characters, for directives and imports", () => {
  // Leading comment: U+0041 (1 byte), U+00E9 (2 bytes), U+20AC (3 bytes), U+1F600 (4 bytes, a surrogate pair in UTF-16).
  const header = "// A\u00e9\u20ac\u{1f600}";
  const directiveToken = "./ambient.d.ts";
  const importToken = '"./d\u00e9p.mjs"';
  const source = [header, `/// <reference path="${directiveToken}" />`, `const label = "\u{1f600}"; import ${importToken};`].join("\n");
  const input = fixture(new Map([["/src/main.mts", source], ["/src/ambient.d.ts", "declare const ambient: number;"],
    ["/src/d\u00e9p.mts", "export {};"]]), ["/src/main.mts"]);
  const result = prepareSourceImports(input);
  assert.equal(result.diagnostics.length, 0);
  const references = file(result, "/src/main.mts").references;
  assert.deepEqual(references.map(reference => [reference.kind, reference.specifier]),
    [["reference-path", directiveToken], ["import", "./d\u00e9p.mjs"]]);
  const [directive, imported] = references;
  if (directive === undefined || imported === undefined) throw new Error("The expected references are absent.");
  const directiveStart = source.indexOf(directiveToken);
  const importStart = source.indexOf(importToken);
  // Each expected offset is in UTF-16 units of the text and differs from its UTF-8 byte offset.
  assert.notEqual(Buffer.byteLength(source.slice(0, directiveStart)), directiveStart);
  assert.notEqual(Buffer.byteLength(source.slice(0, importStart)), importStart);
  assert.notEqual(Buffer.byteLength(importToken), importToken.length);
  assert.deepEqual({ start: directive.start, length: directive.length }, { start: directiveStart, length: directiveToken.length });
  assert.deepEqual({ start: imported.start, length: imported.length }, { start: importStart, length: importToken.length });
  assert.equal(source.slice(directive.start, directive.start + directive.length), directiveToken);
  assert.equal(source.slice(imported.start, imported.start + imported.length), importToken);
  assert.deepEqual(imported.resolution, { kind: "resolved", fileName: "/src/d\u00e9p.mts" });
});

test("source import preparation reports a UTF-16 site that differs from the byte offset for every kind of reference: the three directives, import, export from, import type, dynamic import, import = require and a require call", () => {
  const wide = "\u00e9\u20ac\u{1f600}";
  const main = [
    `// ${wide}`,
    '/// <reference path="./ambient.d.ts" />',
    '/// <reference types="ambient" />',
    '/// <reference lib="es5" />',
    `const a\u00e9 = "${wide}"; import { value } from "./import.js";`,
    'export { value as second } from "./export.js";',
    'type Selected = import("./type.js").Selected;',
    'const loaded = import("./dynamic.js");',
    'import assigned = require("./assigned.cjs");',
    "namespace Local { export const inner = 1; }",
    "import entity = Local.inner;",
    `export { a\u00e9, loaded, assigned, entity }; export type { Selected };`, "",
  ].join("\n");
  const common = `const b = "${wide}"; const loaded = require("./required.cjs");\n`;
  const input = fixture(new Map([
    ["/src/package.json", '{"type":"module"}'], ["/src/main.ts", main], ["/src/main.cjs", common],
    ["/src/ambient.d.ts", "declare const ambient: number;"],
    ["/src/node_modules/@types/ambient/package.json", '{"name":"@types/ambient","version":"1.0.0","types":"index.d.ts"}'],
    ["/src/node_modules/@types/ambient/index.d.ts", "declare const ambientPackage: number;"],
    ["/libs/lib.es5.d.ts", "interface MinimalLibrary {}"],
    ["/src/import.ts", "export const value = 1;"], ["/src/export.ts", "export const value = 2;"],
    ["/src/type.ts", "export type Selected = number;"], ["/src/dynamic.ts", "export const dynamic = 3;"],
    ["/src/assigned.cts", "const value = 1; export = value;"], ["/src/required.cjs", "exports.value = 4;"],
  ]), ["/src/main.ts", "/src/main.cjs"], { noLib: false, lib: [], allowJs: true });
  const result = prepareSourceImports(input);
  assert.equal(result.diagnostics.length, 0);
  // The authored token at each site: the bare attribute value for a directive, the quoted literal otherwise.
  const expected = [
    ["reference-path", "directive", "./ambient.d.ts"], ["reference-types", "directive", "ambient"], ["reference-lib", "directive", "es5"],
    ["import", "statement", '"./import.js"'], ["export", "statement", '"./export.js"'],
    ["import-type", "expression", '"./type.js"'], ["dynamic-import", "expression", '"./dynamic.js"'],
    // An import-equals with a module reference has kind "require" and placement "statement"; a require call has
    // kind "require" and placement "expression". An import-equals of an entity name (import entity = Local.inner)
    // names no module and is not a reference.
    ["require", "statement", '"./assigned.cjs"'],
  ];
  const sites = (fileName: string, text: string) => file(result, fileName).references.map(reference => {
    assert.notEqual(Buffer.byteLength(text.slice(0, reference.start)), reference.start,
      `${reference.kind}: the byte offset differs from the reported site`);
    return [reference.kind, reference.placement, text.slice(reference.start, reference.start + reference.length)];
  });
  assert.deepEqual(sites("/src/main.ts", main), expected);
  assert.deepEqual(sites("/src/main.cjs", common), [["require", "expression", '"./required.cjs"']]);
  // Each site is the token's own place, not an earlier equal substring ("ambient" also occurs inside "./ambient.d.ts").
  const before = ['path="', 'types="', 'lib="', "", "", "", "", ""];
  for (const [index, [, , token]] of expected.entries()) {
    const lead = before[index] ?? "";
    assert.equal(file(result, "/src/main.ts").references[index]?.start, main.indexOf(`${lead}${token}`) + lead.length, `reference ${index} is at its authored token`);
  }
});

test("source import preparation reports sites in the text the file system delivers, which has lost exactly one leading byte-order mark if the file had any", () => {
  const token = '"./dep.mjs"';
  const body = `const label = "\u00e9"; import ${token};`;
  // The SDK's file system removes the first leading U+FEFF and no other, as the Go original does.
  for (const [marks, removed] of [[0, 0], [1, 1], [2, 1], [3, 1], [4, 1]] as const) {
    const source = "\ufeff".repeat(marks) + body;
    const input = fixture(new Map([["/src/main.mts", source], ["/src/dep.mts", "export {};"]]), ["/src/main.mts"]);
    const [delivered] = input.host.FS().ReadFile("/src/main.mts");
    assert.equal(source.length - delivered.length, removed, `of ${marks} leading mark(s) the file system removes ${removed}`);
    assert.equal(delivered, source.slice(removed), "the delivered text is the original without its first units");
    assert.equal(delivered.startsWith("\ufeff"), marks > 1, "a second and later mark stay in the delivered text");
    const result = prepareSourceImports(input);
    assert.equal(result.diagnostics.length, 0);
    const reference = file(result, "/src/main.mts").references[0];
    if (reference === undefined) throw new Error("The expected import is absent.");
    // The site is a UTF-16 offset of the delivered text. Its offset in the original document is larger by the
    // number of units removed (the difference of the two lengths), which is not the number of leading marks.
    assert.equal(reference.start, delivered.indexOf(token));
    assert.equal(reference.start + (source.length - delivered.length), source.indexOf(token));
    assert.equal(reference.length, token.length);
    assert.equal(delivered.slice(reference.start, reference.start + reference.length), token);
    assert.notEqual(Buffer.byteLength(delivered.slice(0, reference.start)), reference.start, "a two-byte character precedes the import");
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

// Library references under noLib. The loader follows no library directive then, so a library file is a file of the
// program only when the caller supplies it (roots it). A reference-lib row says whether the supplied program contains
// the SDK's library file of that name: the file at the host's default library path. Every expectation below is
// derived from that rule.
function libraryRows(result: SourceImportPreparation, fileName: string) {
  return file(result, fileName).references.filter(reference => reference.kind === "reference-lib").map(facts);
}

function programFiles(result: SourceImportPreparation): readonly string[] {
  return result.files.map(candidate => candidate.fileName).sort();
}

test("a library reference under noLib resolves only to a supplied file at the default library path", () => {
  const main = '/// <reference lib="es2015" />\nexport {};\n';
  const library = "interface SuppliedLibrary {}\n";
  const unresolved = [["reference-lib", "es2015", "none", "unresolved"]];
  const resolved = [["reference-lib", "es2015", "none", "/libs/lib.es2015.d.ts"]];

  // Named, and no such file anywhere.
  const missing = prepareSourceImports(fixture(new Map([["/src/main.ts", main]]), ["/src/main.ts"]));
  assert.deepEqual(libraryRows(missing, "/src/main.ts"), unresolved);
  assert.deepEqual(programFiles(missing), ["/src/main.ts"]);
  assert.equal(missing.diagnostics.length, 0);

  // The file exists in the file system and is no file of the program: presence is not supply.
  const inputs = new Map([["/src/main.ts", main], ["/libs/lib.es2015.d.ts", library]]);
  const present = prepareSourceImports(fixture(inputs, ["/src/main.ts"]));
  assert.deepEqual(libraryRows(present, "/src/main.ts"), unresolved);
  assert.deepEqual(programFiles(present), ["/src/main.ts"]);
  assert.equal(present.diagnostics.length, 0);

  // Supplied as a root.
  const supplied = prepareSourceImports(fixture(inputs, ["/src/main.ts", "/libs/lib.es2015.d.ts"]));
  assert.deepEqual(libraryRows(supplied, "/src/main.ts"), resolved);
  assert.deepEqual(programFiles(supplied), ["/libs/lib.es2015.d.ts", "/src/main.ts"]);
  assert.equal(supplied.diagnostics.length, 0);

  // Without noLib the loader follows the directive and loads the same file itself: the same row.
  const loaded = prepareSourceImports(fixture(inputs, ["/src/main.ts"], { noLib: false, lib: [] }));
  assert.deepEqual(libraryRows(loaded, "/src/main.ts"), resolved);
  assert.deepEqual(programFiles(loaded), ["/libs/lib.es2015.d.ts", "/src/main.ts"]);
  assert.equal(loaded.diagnostics.length, 0);
});

test("the library references of supplied library files state whether the supplied set is closed", () => {
  const inputs = new Map([
    ["/src/main.ts", '/// <reference lib="es2015" />\nexport {};\n'],
    ["/libs/lib.es2015.d.ts", '/// <reference lib="es5" />\n/// <reference lib="es2015.core" />\ninterface Es2015 {}\n'],
    ["/libs/lib.es2015.core.d.ts", '/// <reference lib="es5" />\ninterface Es2015Core {}\n'],
    ["/libs/lib.es5.d.ts", "interface Es5 {}\n"],
  ]);
  const all = ["/src/main.ts", "/libs/lib.es2015.d.ts", "/libs/lib.es2015.core.d.ts", "/libs/lib.es5.d.ts"];

  const closed = prepareSourceImports(fixture(inputs, all));
  assert.deepEqual(programFiles(closed), [...all].sort());
  assert.deepEqual(libraryRows(closed, "/src/main.ts"), [["reference-lib", "es2015", "none", "/libs/lib.es2015.d.ts"]]);
  assert.deepEqual(libraryRows(closed, "/libs/lib.es2015.d.ts"), [
    ["reference-lib", "es5", "none", "/libs/lib.es5.d.ts"],
    ["reference-lib", "es2015.core", "none", "/libs/lib.es2015.core.d.ts"],
  ]);
  assert.deepEqual(libraryRows(closed, "/libs/lib.es2015.core.d.ts"), [["reference-lib", "es5", "none", "/libs/lib.es5.d.ts"]]);
  assert.deepEqual(libraryRows(closed, "/libs/lib.es5.d.ts"), []);
  assert.equal(closed.diagnostics.length, 0);

  // The same files, with lib.es5.d.ts not supplied: each row that names it is unresolved, the others are unchanged.
  const open = prepareSourceImports(fixture(inputs, all.filter(fileName => fileName !== "/libs/lib.es5.d.ts")));
  assert.deepEqual(programFiles(open), ["/libs/lib.es2015.core.d.ts", "/libs/lib.es2015.d.ts", "/src/main.ts"]);
  assert.deepEqual(libraryRows(open, "/src/main.ts"), [["reference-lib", "es2015", "none", "/libs/lib.es2015.d.ts"]]);
  assert.deepEqual(libraryRows(open, "/libs/lib.es2015.d.ts"), [
    ["reference-lib", "es5", "none", "unresolved"],
    ["reference-lib", "es2015.core", "none", "/libs/lib.es2015.core.d.ts"],
  ]);
  assert.deepEqual(libraryRows(open, "/libs/lib.es2015.core.d.ts"), [["reference-lib", "es5", "none", "unresolved"]]);
  assert.equal(open.diagnostics.length, 0);
});

test("a library reference is matched by the SDK's name mapping and the default library path, never by a file's base name", () => {
  // A supplied file of the library's name in another directory is not the library.
  const elsewhere = prepareSourceImports(fixture(new Map([
    ["/src/main.ts", '/// <reference lib="es5" />\nexport {};\n'],
    ["/src/lib.es5.d.ts", "interface NotTheLibrary {}\n"],
  ]), ["/src/main.ts", "/src/lib.es5.d.ts"]));
  assert.deepEqual(libraryRows(elsewhere, "/src/main.ts"), [["reference-lib", "es5", "none", "unresolved"]]);
  assert.deepEqual(programFiles(elsewhere), ["/src/lib.es5.d.ts", "/src/main.ts"]);

  // The mapping lower-cases a library name and accepts a library file name; the row keeps the authored text.
  const spellings = prepareSourceImports(fixture(new Map([
    ["/src/main.ts", '/// <reference lib="ES5" />\n/// <reference lib="lib.es5.d.ts" />\n/// <reference lib="absent-library" />\nexport {};\n'],
    ["/libs/lib.es5.d.ts", "interface Es5 {}\n"],
  ]), ["/src/main.ts", "/libs/lib.es5.d.ts"]));
  assert.deepEqual(libraryRows(spellings, "/src/main.ts"), [
    ["reference-lib", "ES5", "none", "/libs/lib.es5.d.ts"],
    ["reference-lib", "lib.es5.d.ts", "none", "/libs/lib.es5.d.ts"],
    // A name the mapping does not know is unresolved, and under noLib the loader reports nothing for it.
    ["reference-lib", "absent-library", "none", "unresolved"],
  ]);
  assert.equal(spellings.diagnostics.length, 0);

  // A relative default library path is taken against the current directory, as the loader takes it.
  const relative = prepareSourceImports(fixture(new Map([
    ["/src/main.ts", '/// <reference lib="es5" />\nexport {};\n'],
    ["/src/libs/lib.es5.d.ts", "interface Es5 {}\n"],
    ["/libs/lib.es5.d.ts", "interface NotTheDefaultLibrary {}\n"],
  ]), ["/src/main.ts", "/src/libs/lib.es5.d.ts", "/libs/lib.es5.d.ts"], {}, "libs"));
  assert.deepEqual(libraryRows(relative, "/src/main.ts"), [["reference-lib", "es5", "none", "/src/libs/lib.es5.d.ts"]]);

  // The same relative directory without noLib: the loader normalises it and loads the file itself; the same row.
  const relativeLoaded = prepareSourceImports(fixture(new Map([
    ["/src/main.ts", '/// <reference lib="es5" />\nexport {};\n'],
    ["/src/libs/lib.es5.d.ts", "interface Es5 {}\n"],
    ["/libs/lib.es5.d.ts", "interface NotTheDefaultLibrary {}\n"],
  ]), ["/src/main.ts"], { noLib: false, lib: [] }, "libs"));
  assert.deepEqual(libraryRows(relativeLoaded, "/src/main.ts"), [["reference-lib", "es5", "none", "/src/libs/lib.es5.d.ts"]]);
  assert.deepEqual(programFiles(relativeLoaded), ["/src/libs/lib.es5.d.ts", "/src/main.ts"]);
  assert.equal(relativeLoaded.diagnostics.length, 0);
});

test("a host made without a default library path has the SDK's own library directory, and nothing is taken from it", () => {
  // The caller roots a library file in its own directory but states no default library path. The host's default is
  // the SDK's bundled library directory; the supplied file is not there, so the reference is not satisfied by the
  // program, and no file of that directory becomes a file of the program.
  const result = prepareSourceImports(fixture(new Map([
    ["/src/main.ts", '/// <reference lib="es5" />\nexport {};\n'],
    ["/libs/lib.es5.d.ts", "interface Es5 {}\n"],
  ]), ["/src/main.ts", "/libs/lib.es5.d.ts"], {}, null));
  assert.deepEqual(libraryRows(result, "/src/main.ts"), [["reference-lib", "es5", "none", "unresolved"]]);
  assert.deepEqual(programFiles(result), ["/libs/lib.es5.d.ts", "/src/main.ts"]);
  assert.equal(result.diagnostics.length, 0);
});

test("selected library files decide a library reference, with no fallback to the default directory", () => {
  const main = '/// <reference lib="es5" />\nexport {};\n';
  const resolvedTo = (fileName: string) => [["reference-lib", "es5", "none", fileName]];
  const unresolved = [["reference-lib", "es5", "none", "unresolved"]];

  // The bound file has its own path and base name; it is a file of the program (a root).
  const bound = new Map([["/src/main.ts", main], ["/cap/a/es5.d.ts", "interface Es5 {}\n"]]);
  const selected = prepareSourceImports({ ...fixture(bound, ["/src/main.ts", "/cap/a/es5.d.ts"]),
    libraryFiles: new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"]]) });
  assert.deepEqual(libraryRows(selected, "/src/main.ts"), resolvedTo("/cap/a/es5.d.ts"));

  // An empty selection is authoritative: the default directory's file, rooted, does not satisfy the reference.
  const defaults = new Map([["/src/main.ts", main], ["/libs/lib.es5.d.ts", "interface Es5 {}\n"]]);
  const empty = prepareSourceImports({ ...fixture(defaults, ["/src/main.ts", "/libs/lib.es5.d.ts"]), libraryFiles: new Map() });
  assert.deepEqual(libraryRows(empty, "/src/main.ts"), unresolved);
  // A selection without that name.
  const other = prepareSourceImports({ ...fixture(defaults, ["/src/main.ts", "/libs/lib.es5.d.ts"]),
    libraryFiles: new Map([["lib.es2015.d.ts", "/libs/lib.es5.d.ts"]]) });
  assert.deepEqual(libraryRows(other, "/src/main.ts"), unresolved);
  // A selection naming a file that is not a file of the program.
  const absent = prepareSourceImports({ ...fixture(bound, ["/src/main.ts"]), libraryFiles: new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"]]) });
  assert.deepEqual(libraryRows(absent, "/src/main.ts"), unresolved);
  assert.deepEqual(programFiles(absent), ["/src/main.ts"]);
});

test("with noLib off the loader's record and the selection give the same bound file", () => {
  const inputs = new Map([["/src/main.ts", '/// <reference lib="es5" />\nexport {};\n'], ["/cap/a/es5.d.ts", "interface Es5 {}\n"],
    ["/libs/lib.es5.d.ts", "interface NotSelected {}\n"]]);
  const result = prepareSourceImports({ ...fixture(inputs, ["/src/main.ts"], { noLib: false, lib: [] }),
    libraryFiles: new Map([["lib.es5.d.ts", "/cap/a/es5.d.ts"]]) });
  assert.deepEqual(libraryRows(result, "/src/main.ts"), [["reference-lib", "es5", "none", "/cap/a/es5.d.ts"]]);
  assert.deepEqual(programFiles(result), ["/cap/a/es5.d.ts", "/src/main.ts"]);
});

test("a selected name that is not a library file name of the compiler is refused by the preparation", () => {
  const input = fixture(new Map([["/src/main.ts", "export {};\n"]]), ["/src/main.ts"]);
  assert.throws(() => prepareSourceImports({ ...input, libraryFiles: new Map([["es5", "/cap/a/es5.d.ts"]]) }),
    { name: "TypeError", message: "Selected library 'es5' is not a library file name of the compiler." });
});

test("the loaded-library index is derived in one pass over the loader's records, and lookups do not read the records again", () => {
  let reads = 0;
  const records = [
    { Name: "lib.es5.d.ts", path: "/libs/lib.es5.d.ts", Replaced: false },
    { Name: "lib.es2015.core.d.ts", path: "/libs/lib.es2015.core.d.ts", Replaced: false },
    { Name: "lib.dom.d.ts", path: "/node_modules/@typescript/lib-dom/index.d.ts", Replaced: true },
  ];
  function* counted() {
    for (const record of records) {
      reads += 1;
      yield record;
    }
  }
  const index = loadedLibraryFilesByName(counted());
  assert.equal(reads, records.length);
  for (let lookup = 0; lookup < 1000; lookup += 1) {
    assert.equal(index.get(lookup % 2 === 0 ? "lib.es5.d.ts" : "lib.dom.d.ts"), lookup % 2 === 0 ? "/libs/lib.es5.d.ts" : "/node_modules/@typescript/lib-dom/index.d.ts");
  }
  assert.equal(reads, records.length, "a lookup reads no record");
  assert.equal(index.get("lib.es2015.d.ts"), undefined);
});

test("the loaded-library index refuses two files recorded for one library name", () => {
  const same = loadedLibraryFilesByName([
    { Name: "lib.es5.d.ts", path: "/cap/es5.d.ts", Replaced: false },
    { Name: "lib.es5.d.ts", path: "/cap/es5.d.ts", Replaced: false },
  ]);
  assert.equal(same.get("lib.es5.d.ts"), "/cap/es5.d.ts");
  assert.throws(() => loadedLibraryFilesByName([
    { Name: "lib.es5.d.ts", path: "/cap/a.d.ts", Replaced: false },
    { Name: "lib.es5.d.ts", path: "/cap/b.d.ts", Replaced: false },
  ]), { message: "Invariant: the loader recorded two files for library 'lib.es5.d.ts': '/cap/a.d.ts' and '/cap/b.d.ts'." });
});

test("many directives naming libraries each resolve through the one index", () => {
  const directives = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? '/// <reference lib="es5" />' : '/// <reference lib="es2015.core" />');
  const inputs = new Map([["/src/main.ts", [...directives, "export {};", ""].join("\n")],
    ["/libs/lib.es5.d.ts", "interface Es5 {}\n"], ["/libs/lib.es2015.core.d.ts", "interface Es2015Core {}\n"]]);
  const loaded = prepareSourceImports(fixture(inputs, ["/src/main.ts"], { noLib: false, lib: [] }));
  const rows = libraryRows(loaded, "/src/main.ts");
  assert.equal(rows.length, 40);
  assert.equal(rows.every((row, index) => row[3] === (index % 2 === 0 ? "/libs/lib.es5.d.ts" : "/libs/lib.es2015.core.d.ts")), true);
});

test("two library names bound to one captured file both resolve to it under noLib", () => {
  const inputs = new Map([["/src/main.ts", '/// <reference lib="es5" />\n/// <reference lib="es2015.core" />\nexport {};\n'],
    ["/cap/shared.d.ts", "interface Shared {}\n"]]);
  const result = prepareSourceImports({ ...fixture(inputs, ["/src/main.ts", "/cap/shared.d.ts"]),
    libraryFiles: new Map([["lib.es5.d.ts", "/cap/shared.d.ts"], ["lib.es2015.core.d.ts", "/cap/shared.d.ts"]]) });
  assert.deepEqual(libraryRows(result, "/src/main.ts"), [
    ["reference-lib", "es5", "none", "/cap/shared.d.ts"],
    ["reference-lib", "es2015.core", "none", "/cap/shared.d.ts"],
  ]);
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
