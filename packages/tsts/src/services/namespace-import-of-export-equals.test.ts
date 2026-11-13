import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

// Each program is checked in a child process under a time limit. Four of these programs once made the checker's own
// check of a file not return (Checker_resolveESModuleSymbol copied the unknown symbol, and the loop of
// Checker_resolveAliasWithDeprecationCheck did not advance past a target without declarations). A check that does
// not return must fail its case and must not stop the suite: a child still running at the limit is killed and the
// case fails. Nothing but failure is concluded from reaching the limit.
const limitMilliseconds = 60_000;

interface Checked {
  readonly errors: readonly string[];
  readonly suggestions: readonly string[];
}

function check(files: Record<string, string>): Checked {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const sdk = await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)});
    const files = ${JSON.stringify(files)};
    const session = sdk.createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: Object.keys(files),
      compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024" } });
    session.checkSource();
    const lines = kind => sdk.formatDiagnostics(session.getDiagnostics(kind), "/case").split("\\n")
      .filter(line => line !== "" && !line.startsWith("bundled:"));
    process.stdout.write(JSON.stringify({ errors: lines("all"), suggestions: lines("suggestion") }));
  `], { encoding: "utf8", timeout: limitMilliseconds, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
  assert.equal(child.signal, null, `the check returned within ${limitMilliseconds / 1000} seconds (it was killed at the limit)`);
  assert.equal(child.status, 0, `the checking child completes: ${child.stderr.slice(0, 2048)}`);
  return JSON.parse(child.stdout) as Checked;
}

const unresolved = "import inner = require(\"./missing.cjs\");\nexport = inner;\n";
const missingModule = (file: string): string =>
  `${file}(1,24): error TS2307: Cannot find module './missing.cjs' or its corresponding type declarations.`;

test("a namespace import, in an ECMAScript-format file, of a CommonJS-format declaration file whose export = does not resolve is checked to the end: value use and type use", () => {
  const value = check({
    "/case/eqm.d.cts": unresolved,
    "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport const v = nsm;\n",
  });
  assert.deepEqual(value.errors, [missingModule("eqm.d.cts")], "the one diagnostic is the unresolved module; the use adds none");
  const type = check({
    "/case/eqm.d.cts": unresolved,
    "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport type V = typeof nsm;\n",
  });
  assert.deepEqual(type.errors, [missingModule("eqm.d.cts")]);
});

test("the same program is checked to the end with the module as a .cts source file and as a .d.ts file of CommonJS format", () => {
  assert.deepEqual(check({
    "/case/eqm.cts": unresolved,
    "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport const v = nsm;\n",
  }).errors, [missingModule("eqm.cts")]);
  assert.deepEqual(check({
    "/case/eqm.d.ts": unresolved,
    "/case/u.mts": "import * as nsm from \"./eqm.js\";\nexport const v = nsm;\n",
  }).errors, [missingModule("eqm.d.ts")]);
});

test("every binding form over a module whose export = does not resolve is checked to the end, each used", () => {
  const checked = check({
    "/case/eqm.d.cts": unresolved,
    "/case/x.mts": "export * as box from \"./eqm.cjs\";\n",
    "/case/u.mts": [
      "import { box } from \"./x.mjs\";", "import d from \"./eqm.cjs\";", "import { named } from \"./eqm.cjs\";",
      "import * as nsm from \"./eqm.cjs\";", "export const v = [box, d, named, nsm];", "export type T = typeof nsm;",
      "export const dynamic = import(\"./eqm.cjs\");", "",
    ].join("\n"),
    "/case/r.cts": "import r = require(\"./eqm.cjs\");\nexport const v = r;\n",
  });
  assert.deepEqual(checked.errors, [
    missingModule("eqm.d.cts"),
    "u.mts(3,10): error TS2305: Module '\"./eqm.cjs\"' has no exported member 'named'.",
    "x.mts(1,22): error TS2498: Module '\"/case/eqm\"' uses 'export =' and cannot be used with 'export *'.",
  ]);
});

test("a namespace import of two declaration files whose export = assignments name each other is checked to the end and reports the cycle", () => {
  const checked = check({
    "/case/a.d.cts": "import b = require(\"./b.cjs\");\nexport = b;\n",
    "/case/b.d.cts": "import a = require(\"./a.cjs\");\nexport = a;\n",
    "/case/u.mts": "import * as n from \"./a.cjs\";\nimport d from \"./a.cjs\";\nexport const v = [n, d];\n",
  });
  assert.deepEqual(checked.errors, [
    "a.d.cts(1,1): error TS2303: Circular definition of import alias 'b'.",
    "a.d.cts(2,1): error TS2303: Circular definition of import alias 'b'.",
    "b.d.cts(1,1): error TS2303: Circular definition of import alias 'a'.",
    "b.d.cts(2,1): error TS2303: Circular definition of import alias 'a'.",
  ]);
});

// A target that legitimately has no declaration: the checker's own globalThis symbol. The final target and the
// immediate target of the namespace import are two separate copies of it, so only the loop's own progress ends the walk.
test("a namespace import of a module whose export = names globalThis, a symbol without declarations, is checked to the end and keeps its members", () => {
  const checked = check({
    "/case/g.d.cts": "export = globalThis;\n",
    "/case/u.mts": "import * as g from \"./g.cjs\";\nexport const v = g;\nexport const n: number = g.default.NaN;\nexport const wrong: string = g.default.NaN;\n",
  });
  assert.deepEqual(checked.errors, ["u.mts(4,14): error TS2322: Type 'number' is not assignable to type 'string'."]);
});

test("the opposite of the unresolved case: a namespace import of a resolving export = keeps the exported value's members and its synthetic default", () => {
  const checked = check({
    "/case/eq.d.cts": "declare const obj: { k: number };\nexport = obj;\n",
    "/case/fn.d.cts": "declare function call(): string;\nexport = call;\n",
    "/case/u.mts": [
      "import * as ns from \"./eq.cjs\";", "import * as fn from \"./fn.cjs\";", "export const a: number = ns.k;",
      "export const b: number = ns.default.k;", "export const c: string = fn.default();", "export const wrong: string = ns.k;", "",
    ].join("\n"),
  });
  assert.deepEqual(checked.errors, ["u.mts(6,14): error TS2322: Type 'number' is not assignable to type 'string'."],
    "only the deliberately wrong line is reported: the namespace still has k, default.k and a callable default");
});

test("the alias walk still reports a deprecated declaration reached through a re-export, by a named import and by a namespace member", () => {
  const checked = check({
    "/case/m.mts": "/** @deprecated use fresh */\nexport const old = 1;\nexport const fresh = 2;\n",
    "/case/r.mts": "export { old as viaOld, fresh as viaFresh } from \"./m.mjs\";\n",
    "/case/u.mts": "import { viaOld, viaFresh } from \"./r.mjs\";\nimport * as all from \"./r.mjs\";\nexport const v = [viaOld, viaFresh, all.viaOld];\n",
  });
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.suggestions, [
    "u.mts(1,10): suggestion TS6385: 'old' is deprecated.",
    "u.mts(3,19): suggestion TS6385: 'viaOld' is deprecated.",
    "u.mts(3,41): suggestion TS6385: 'viaOld' is deprecated.",
  ]);
});

// Rings of symbols that are aliases and namespaces at once. The checker's alias resolution stops at such a symbol, so
// these rings are not always reported as circular, and a walk over them ends only because it remembers where it has been.
test("a ring of namespace imports, each merged with a namespace and exported with export =, is checked to the end", () => {
  for (const extension of ["cts", "d.cts"]) {
    const checked = check({
      [`/case/m1.${extension}`]: "import * as x from \"./m2.cjs\";\ndeclare namespace x {}\nexport = x;\n",
      [`/case/m2.${extension}`]: "import * as y from \"./m1.cjs\";\ndeclare namespace y {}\nexport = y;\n",
      "/case/u.mts": "import * as ns from \"./m1.cjs\";\nexport const v = ns;\nexport type T = typeof ns;\n",
    });
    assert.deepEqual(checked.errors, [
      `m1.${extension}(1,13): error TS2303: Circular definition of import alias 'x'.`,
      `m2.${extension}(1,13): error TS2303: Circular definition of import alias 'y'.`,
    ]);
  }
});

test("a ring of import = require aliases, each merged with a namespace and exported with export =, is checked to the end with TypeScript's diagnostics", () => {
  const ring = {
    "/case/m1.d.cts": "import x = require(\"./m2.cjs\");\ndeclare namespace x {}\nexport = x;\n",
    "/case/m2.d.cts": "import y = require(\"./m1.cjs\");\ndeclare namespace y {}\nexport = y;\n",
  };
  const conflicts = [
    "m1.d.cts(1,1): error TS2440: Import declaration conflicts with local declaration of 'x'.",
    "m2.d.cts(1,1): error TS2440: Import declaration conflicts with local declaration of 'y'.",
  ];
  // The ring is not circular for the checker: each member resolves to the next and stops there. TypeScript 6.0.3
  // reports exactly these four diagnostics for this program.
  assert.deepEqual(check({ ...ring, "/case/u.mts": "import * as ns from \"./m1.cjs\";\nimport d from \"./m1.cjs\";\nexport const v = [ns, d];\n" }).errors, [
    ...conflicts,
    "u.mts(3,19): error TS2708: Cannot use namespace 'ns' as a value.",
    "u.mts(3,23): error TS2708: Cannot use namespace 'd' as a value.",
  ]);
  // The ring alone, with no importer: checking either export assignment ends.
  assert.deepEqual(check({ ...ring, "/case/u.mts": "export {};\n" }).errors, conflicts);
});

test("the opposite of a ring: a chain of twelve re-exports is neither refused nor reported as circular, and the declaration's type reaches the use", () => {
  const files: Record<string, string> = { "/case/m0.mts": "export const v = 1;\n" };
  for (let index = 1; index <= 12; index += 1) {
    files[`/case/m${index}.mts`] = `export { ${index === 1 ? "v" : `a${index - 1}`} as a${index} } from "./m${index - 1}.mjs";\n`;
  }
  files["/case/u.mts"] = "import { a12 } from \"./m12.mjs\";\nimport * as all from \"./m12.mjs\";\nexport const ok: number = a12 + all.a12;\nexport const wrong: string = a12;\n";
  const checked = check(files);
  assert.deepEqual(checked.errors, ["u.mts(4,14): error TS2322: Type 'number' is not assignable to type 'string'."]);
  assert.deepEqual(checked.suggestions, []);
});

// A ring through symbols the checker makes for an import. Each member is an alias and a function at once, so the
// module's exported value has call signatures and the checker makes a module-type symbol for every namespace import of
// it. That symbol is made once per import declaration; when a new one was made on every resolution, no walk that
// remembers symbols could close this ring.
test("a ring of namespace imports, each merged with a function and exported with export =, is checked to the end and reported as circular", () => {
  const circular = (extension: string): string[] => [
    `m1.${extension}(1,13): error TS2303: Circular definition of import alias 'x'.`,
    `m2.${extension}(1,13): error TS2303: Circular definition of import alias 'y'.`,
  ];
  const ring = (extension: string): Record<string, string> => ({
    [`/case/m1.${extension}`]: "import * as x from \"./m2.cjs\";\ndeclare function x(): void;\nexport = x;\n",
    [`/case/m2.${extension}`]: "import * as y from \"./m1.cjs\";\ndeclare function y(): void;\nexport = y;\n",
  });
  // An ECMAScript-format importer, and a CommonJS-format importer (the symbol is made for call signatures in both).
  assert.deepEqual(check({ ...ring("cts"), "/case/u.mts": "import * as ns from \"./m1.cjs\";\nexport const v = ns;\n" }).errors, circular("cts"));
  assert.deepEqual(check({ ...ring("cts"), "/case/u.cts": "import * as ns from \"./m1.cjs\";\nexport const v = ns;\n" }).errors, circular("cts"));
  // The ring alone.
  assert.deepEqual(check({ ...ring("cts"), "/case/u.mts": "export {};\n" }).errors, circular("cts"));
});

// Deprecation through a namespace import. The symbol made for the import stands for the value it was made from: the
// walk goes on from that value, so a deprecated value (or a deprecated alias further on) is reported at the use.
// Reference for each expectation: TypeScript 6.0.3 (node_modules/typescript), its language service's semantic and
// suggestion diagnostics for the same files on disk under module and moduleResolution nodenext, strict, target es2024.
// Pinned TS-Go gives no reference for the ring (it does not return from it). Each expectation is also what this
// checker reported while it made two symbols per import.
const ONE_HOP_REFERENCE = [
  "eq.d.cts(3,10): suggestion TS6385: 'obj' is deprecated.",
  "u.mts(3,19): suggestion TS6385: 'ns' is deprecated.",
  "u.mts(3,19): suggestion TS6385: 'obj' is deprecated.",
  "u.mts(3,23): suggestion TS6385: 'd' is deprecated.",
  "u.mts(3,26): suggestion TS6385: 'ns' is deprecated.",
  "u.mts(3,26): suggestion TS6385: 'obj' is deprecated.",
];
test("a use of a namespace import of a deprecated export = value has the suggestion naming the import and the one naming the value; a default import's use has one", () => {
  const checked = check({
    "/case/m1.d.cts": "import x1 = require(\"./m2.cjs\");\nexport = x1;\n",
    "/case/m2.d.cts": "import x2 = require(\"./m3.cjs\");\nexport = x2;\n",
    "/case/m3.d.cts": "/** @deprecated gone */\ndeclare const end: { k: number };\nexport = end;\n",
    "/case/u.mts": "import * as ns from \"./m1.cjs\";\nimport d from \"./m1.cjs\";\nexport const a = [ns, d];\nexport type T = typeof ns;\n",
  });
  assert.deepEqual(checked.errors, []);
  // These eight lines are exactly TypeScript 6.0.3's suggestions for this program.
  assert.deepEqual(checked.suggestions, [
    "m1.d.cts(2,10): suggestion TS6385: 'x1' is deprecated.",
    "m2.d.cts(2,10): suggestion TS6385: 'x2' is deprecated.",
    "m3.d.cts(3,10): suggestion TS6385: 'end' is deprecated.",
    "u.mts(3,19): suggestion TS6385: 'end' is deprecated.",
    "u.mts(3,19): suggestion TS6385: 'ns' is deprecated.",
    "u.mts(3,23): suggestion TS6385: 'd' is deprecated.",
    "u.mts(4,24): suggestion TS6385: 'end' is deprecated.",
    "u.mts(4,24): suggestion TS6385: 'ns' is deprecated.",
  ]);
});

test("the one-hop form: a namespace import of a module whose export = names a deprecated value", () => {
  const checked = check({
    "/case/eq.d.cts": "/** @deprecated use another */\ndeclare const obj: { k: number };\nexport = obj;\n",
    "/case/u.mts": "import * as ns from \"./eq.cjs\";\nimport d from \"./eq.cjs\";\nexport const v = [ns, d, ns.k];\n",
  });
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.suggestions, ONE_HOP_REFERENCE);
});

test("a deprecated alias in the middle of a chain is reported at the default import's use and not at the namespace import's, and a deprecated member of a ring is still reported at the namespace use", () => {
  const middle = check({
    "/case/m1.d.cts": "import x1 = require(\"./m2.cjs\");\nexport = x1;\n",
    "/case/m2.d.cts": "/** @deprecated gone */\nimport x2 = require(\"./m3.cjs\");\nexport = x2;\n",
    "/case/m3.d.cts": "declare const end: { k: number };\nexport = end;\n",
    "/case/u.mts": "import * as ns from \"./m1.cjs\";\nimport d from \"./m1.cjs\";\nexport const a = [ns, d];\nexport type T = typeof ns;\n",
  });
  assert.deepEqual(middle.errors, []);
  // Here the checker differs from TypeScript 6.0.3, which reports only the second line (the export = of m2). The first
  // and third lines are the pinned checker's own (unchanged by the symbol made once: the same before and after).
  assert.deepEqual(middle.suggestions, [
    "m1.d.cts(2,10): suggestion TS6385: 'x2' is deprecated.",
    "m2.d.cts(3,10): suggestion TS6385: 'x2' is deprecated.",
    "u.mts(3,23): suggestion TS6385: 'x2' is deprecated.",
  ]);
  // A ring of three import = require aliases, each merged with a namespace, the second deprecated: an error program
  // (TS2440 in each file). The walk goes on from the import's made symbol into the ring and meets the deprecated member.
  // TypeScript 6.0.3 returns from this program with exactly these four suggestions and the three TS2440 errors.
  const ring: Record<string, string> = {};
  for (const index of [1, 2, 3]) {
    const mark = index === 2 ? "/** @deprecated gone */\n" : "";
    ring[`/case/m${index}.d.cts`] = `${mark}import x${index} = require("./m${index % 3 + 1}.cjs");\n${mark}declare namespace x${index} { const k${index}: number }\nexport = x${index};\n`;
  }
  const ringed = check({ ...ring, "/case/u.mts": "import * as ns from \"./m1.cjs\";\nimport d from \"./m1.cjs\";\nexport const a = [ns, d];\nexport type T = typeof ns;\n" });
  assert.deepEqual(ringed.errors, [1, 2, 3].map(index => `m${index}.d.cts(${index === 2 ? 2 : 1},1): error TS2440: Import declaration conflicts with local declaration of 'x${index}'.`));
  assert.deepEqual(ringed.suggestions, [
    "m1.d.cts(3,10): suggestion TS6385: 'x1' is deprecated.",
    "m2.d.cts(5,10): suggestion TS6385: 'x2' is deprecated.",
    "u.mts(3,19): suggestion TS6385: 'x2' is deprecated.",
    "u.mts(4,24): suggestion TS6385: 'x2' is deprecated.",
  ]);
});
