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
