// A case file, not a test: no suite runs it, and it must not be given a name ending in .test.
//
// Program: a namespace import, in an ECMAScript-format file, of a CommonJS-format file whose `export =` names an
// alias that does not resolve, with one use of the binding.
//
// Present behaviour: `session.checkSource()` does not return. The loop is in the checker's own identifier check,
// Checker_resolveAliasWithDeprecationCheck (internal/checker/checker/symbols.ts), before any query is asked:
// the alias's final target and its immediate target are two different copies of the unknown symbol
// (Checker_cloneTypeAsModuleType, reached from Checker_resolveESModuleSymbol), neither is the unknown symbol
// itself, and the immediate one has no declaration, so the loop never advances.
//
// Run it only under a time limit, from the repository root, after a source-test build:
//
//   timeout 20 node packages/tsts/src/services/alias-and-implementation-queries.unresolved-export-equals.case.mjs \
//     <built>/dist/src/index.js [cts|dcts|dts|type-use|unused]
//
// Present result: the last line printed is "checking" and `timeout` ends the process with exit code 124, for the
// variants cts, dcts, dts and type-use. The variant unused (the binding is never used) prints "checked" and exits 0.
// When the checker is corrected every variant prints "checked" and exits 0, and this file becomes a test.
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sdkIndex, variant = "cts"] = process.argv.slice(2);
if (sdkIndex === undefined) {
  writeSync(2, "usage: timeout 20 node <this file> <built>/dist/src/index.js [cts|dcts|dts|type-use|unused]\n");
  process.exit(2);
}
const module = "import inner = require(\"./missing.cjs\");\nexport = inner;\n";
const variants = {
  "cts": { "/case/eqm.cts": module, "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport const v = nsm;\n" },
  "dcts": { "/case/eqm.d.cts": module, "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport const v = nsm;\n" },
  "dts": { "/case/eqm.d.ts": module, "/case/u.mts": "import * as nsm from \"./eqm.js\";\nexport const v = nsm;\n" },
  "type-use": { "/case/eqm.d.cts": module, "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport type V = typeof nsm;\n" },
  "unused": { "/case/eqm.cts": module, "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nexport {};\n" },
};
const files = variants[variant];
if (files === undefined) {
  writeSync(2, `unknown variant ${variant}\n`);
  process.exit(2);
}
const { createCompilerSessionFromFiles, formatDiagnostics } = await import(pathToFileURL(resolve(sdkIndex)).href);
const say = text => writeSync(1, `${text}\n`);
say(`${variant}: opening`);
const session = createCompilerSessionFromFiles({
  currentDirectory: "/case", files, rootFiles: Object.keys(files),
  compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024" },
});
say(`${variant}: checking`);
session.checkSource();
say(`${variant}: checked`);
say(formatDiagnostics(session.getDiagnostics("all"), "/case"));
