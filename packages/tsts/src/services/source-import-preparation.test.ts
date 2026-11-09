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
import { GetParsedCommandLineOfConfigFile } from "../internal/tsoptions/tsconfigparsing.js";
import { ParseCommandLine } from "../internal/tsoptions/commandlineparser.js";
import { createCompilerHost, createInMemoryFileSystem } from "./embedding-host.js";

interface FixtureOptions {
  readonly noLib?: boolean;
  readonly lib?: readonly string[];
  readonly allowJs?: boolean;
  readonly types?: readonly string[];
  readonly noResolve?: boolean;
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
  assert.equal(diagnostics.length, 0, "configuration acquisition has no unrelated failures");
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
  const main = [
    '/// <reference path="./ambient.d.ts" />',
    '/// <reference types="ambient" />',
    '/// <reference lib="es5" />',
    'import { value } from "./import.js";',
    'export { value } from "./export.js";',
    'type Selected = import("./type.js").Selected;',
    'const loaded = import("./dynamic.js");',
  ].join("\n");
  const inputs = new Map([
    ["/src/package.json", '{"type":"module"}'], ["/src/main.ts", main],
    ["/src/ambient.d.ts", "declare const ambient: number;"],
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
  assert.deepEqual(file(result, "/src/main.cjs").references.map(facts), [["require", "./required.cjs", "require", "/src/required.cjs"]]);
  const bytes = Buffer.from(main);
  for (const reference of file(result, "/src/main.ts").references) {
    const token = reference.kind.startsWith("reference-") ? reference.specifier : `"${reference.specifier}"`;
    assert.equal(reference.start, bytes.indexOf(token), `${reference.kind} retains its actual authored byte start`);
    assert.equal(reference.length, Buffer.byteLength(token), `${reference.kind} retains its complete authored byte range`);
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
  const config = ParseCommandLine(["--noLib", "--module", "commonjs", "--moduleResolution", "classic", "/src/main.ts"], input.host);
  if (config === undefined) throw new Error("The SDK did not parse the classic-mode control.");
  const result = prepareSourceImports({ host: input.host, config });
  assert.deepEqual(file(result, "/src/main.ts").references.map(facts), [["import", "./dep", "none", "/src/dep.ts"]]);
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
