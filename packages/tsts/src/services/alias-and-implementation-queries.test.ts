import assert from "node:assert/strict";
import { test } from "node:test";
import { SymbolFlagsAlias, createCompilerSessionFromFiles } from "../index.js";
import type { Node, Symbol, TypeCheckerQueries } from "../index.js";

const compilerOptions = { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024" };

function open(files: Record<string, string>) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: Object.keys(files), compilerOptions });
  const checked = session.checkSource();
  const ast = checked.ast;
  const queries = (fileName: string) => {
    const sourceFile = checked.getSourceFile(fileName);
    if (sourceFile === undefined) throw new Error(`The session has no ${fileName}.`);
    return { sourceFile, checker: checked.getSourceFileQueries(sourceFile).checker };
  };
  const textOf = (node: Node): string => {
    const range = ast.authoredRange(node);
    if (range.kind !== "authored") throw new Error("The node has no authored range.");
    const sourceFile = ast.getSourceFile(node);
    if (sourceFile === undefined) throw new Error("The node has no source file.");
    return ast.getSourceText(sourceFile).slice(range.start, range.end);
  };
  const nodes = (root: Node, kind: string): Node[] => {
    const found: Node[] = [];
    const visit = (node: Node): void => {
      if (ast.kindName(node) === `Kind${kind}`) found.push(node);
      ast.forEachChild(node, child => { if (child !== undefined) visit(child); });
    };
    visit(root);
    return found;
  };
  const only = (root: Node, kind: string, text: string): Node => {
    const matches = nodes(root, kind).filter(node => textOf(node) === text);
    assert.equal(matches.length, 1, `exactly one ${kind} with text ${JSON.stringify(text)}`);
    const match = matches[0];
    if (match === undefined) throw new Error("unreachable");
    return match;
  };
  const nameOf = (node: Node): Node => {
    const name = ast.name(node);
    if (name === undefined) throw new Error("The declaration has no name node.");
    return name;
  };
  const fileNameOf = (node: Node): string => {
    const sourceFile = ast.getSourceFile(node);
    if (sourceFile === undefined) throw new Error("The node has no source file.");
    return ast.getFileName(sourceFile);
  };
  return { session, checked, ast, queries, textOf, nodes, only, nameOf, fileNameOf };
}

function declarations(symbol: Symbol | undefined): readonly Node[] {
  if (symbol === undefined) throw new Error("A symbol was expected.");
  return (symbol.Declarations ?? []).filter((declaration): declaration is Node => declaration !== undefined);
}

// The same declaration nodes in the same order, by identity.
function sameNodes(left: readonly Node[], right: readonly Node[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

// Two steps of the same kind whose symbols are one object.
function stepsToSameSymbol(left: ReturnType<TypeCheckerQueries["getAliasStep"]>, right: ReturnType<TypeCheckerQueries["getAliasStep"]>): boolean {
  return left?.kind === "symbol" && right?.kind === "symbol" && left.symbol === right.symbol;
}

// The step of a binding whose step is a symbol. A step of the other kind fails the case.
function symbolStep(checker: TypeCheckerQueries, symbol: Symbol | undefined): Symbol | undefined {
  const step = checker.getAliasStep(symbol);
  if (step === undefined) return undefined;
  if (step.kind !== "symbol") throw new Error("A step that is a symbol was expected.");
  return step.symbol;
}

test("getAliasStep steps one alias at a time, closes a circular chain, and returns nothing without throwing for a non-alias and for a step that did not resolve", () => {
  const program = open({
    "/case/m.mts": "export const a = 1;\n",
    "/case/r.mts": "export { a as b } from \"./m.mjs\";\n",
    "/case/s.mts": "export { b as c } from \"./r.mjs\";\n",
    "/case/u.mts": [
      "import { c as z } from \"./s.mjs\";", "import { nope } from \"./m.mjs\";", "const local = 1;",
      "export { local as viaLocal, z as viaZ };", "export const use = z;", "export const bad = nope;", "",
    ].join("\n"),
    "/case/c1.mts": "export { x } from \"./c2.mjs\";\n",
    "/case/c2.mts": "export { x } from \"./c1.mjs\";\n",
    "/case/e.mts": "import { x } from \"./c1.mjs\";\nexport const w = x;\n",
    "/case/star.mts": "export * from \"./m.mjs\";\n",
    "/case/v.mts": "import { a as viaStar } from \"./star.mjs\";\nexport const y = viaStar;\n",
  });
  const { checker, sourceFile } = program.queries("/case/u.mts");
  const diagnosticsBefore = program.session.getDiagnostics("all").length;
  const isAlias = (symbol: Symbol | undefined): boolean => symbol !== undefined && (symbol.Flags & SymbolFlagsAlias) !== 0;
  const describe = (symbol: Symbol | undefined): string[] =>
    declarations(symbol).map(declaration => `${program.fileNameOf(declaration)}:${program.ast.kindName(declaration)}:${program.textOf(declaration)}`);

  // z -> c (export specifier in s) -> b (export specifier in r) -> a (variable in m): three steps, each one alias further.
  const z = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ImportSpecifier", "c as z")));
  assert.equal(isAlias(z), true);
  const step1 = symbolStep(checker, z);
  assert.deepEqual(describe(step1), ["/case/s.mts:KindExportSpecifier:b as c"]);
  assert.equal(isAlias(step1), true);
  const step2 = symbolStep(checker, step1);
  assert.deepEqual(describe(step2), ["/case/r.mts:KindExportSpecifier:a as b"]);
  assert.equal(isAlias(step2), true);
  const step3 = symbolStep(checker, step2);
  assert.deepEqual(describe(step3), ["/case/m.mts:KindVariableDeclaration:a = 1"]);
  assert.equal(isAlias(step3), false);
  assert.ok(step3 === checker.getAliasedSymbol(z), "the last step is the final target the existing query returns");
  // The opposite of an alias: a variable. Nothing, and no throw.
  assert.ok(symbolStep(checker, step3) === undefined, "a variable, not an alias, has no step");

  // A local re-export steps to the local declaration; a re-export of an import steps to that import binding, not past it.
  const viaLocal = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ExportSpecifier", "local as viaLocal")));
  assert.deepEqual(describe(symbolStep(checker, viaLocal)), ["/case/u.mts:KindVariableDeclaration:local = 1"]);
  const viaZ = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ExportSpecifier", "z as viaZ")));
  assert.ok(symbolStep(checker, viaZ) === z, "a re-export of an import steps to that import binding");

  // An alias whose member does not exist: flagged as an alias, and both queries return nothing.
  const nope = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ImportSpecifier", "nope")));
  assert.equal(isAlias(nope), true);
  assert.ok(checker.getAliasedSymbol(nope) === undefined, "a missing member has no final target");
  assert.ok(symbolStep(checker, nope) === undefined, "a missing member has no step");

  // An import through a circular re-export: its final target is unresolved, and its steps lead into the cycle and
  // return to a symbol already visited. The cycle's members are the two export specifiers; the importer is not one.
  const cyclic = program.queries("/case/e.mts");
  const x = cyclic.checker.getSymbolAtLocation(program.nameOf(program.only(cyclic.sourceFile, "ImportSpecifier", "x")));
  assert.equal(isAlias(x), true);
  assert.ok(cyclic.checker.getAliasedSymbol(x) === undefined, "an import through a circular re-export has no final target");
  const inC1 = symbolStep(cyclic.checker, x);
  assert.deepEqual(describe(inC1), ["/case/c1.mts:KindExportSpecifier:x"]);
  const inC2 = symbolStep(cyclic.checker, inC1);
  assert.deepEqual(describe(inC2), ["/case/c2.mts:KindExportSpecifier:x"]);
  assert.ok(symbolStep(cyclic.checker, inC2) === inC1, "the walk returns to the first member: the cycle is c1.x, c2.x");

  // Through a star re-export there is no alias in the re-exporting module: one step reaches the declaration.
  const star = program.queries("/case/v.mts");
  const viaStar = star.checker.getSymbolAtLocation(program.nameOf(program.only(star.sourceFile, "ImportSpecifier", "a as viaStar")));
  assert.deepEqual(describe(symbolStep(star.checker, viaStar)), ["/case/m.mts:KindVariableDeclaration:a = 1"]);

  assert.ok(symbolStep(checker, undefined) === undefined, "no symbol has no step");
  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

// One row per step from a binding. A symbol step: "alias " or "final " (whether the step is itself flagged as an
// alias), then the step's declarations. A member of an exported value: "member of [<the export = assignment>]: " and
// the member in the same form, or "nothing". The walk ends at nothing or at a symbol already visited.
function walker(program: ReturnType<typeof open>) {
  const describe = (symbol: Symbol | undefined): string =>
    declarations(symbol).map(declaration => `${program.fileNameOf(declaration)}:${program.ast.kindName(declaration)}:${program.textOf(declaration)}`).join(" | ");
  const isAlias = (symbol: Symbol | undefined): boolean => symbol !== undefined && (symbol.Flags & SymbolFlagsAlias) !== 0;
  const row = (symbol: Symbol): string => `${isAlias(symbol) ? "alias" : "final"} ${describe(symbol)}`;
  const bindingOf = (fileName: string, kind: string, text: string) => {
    const { checker, sourceFile } = program.queries(fileName);
    const symbol = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, kind, text)));
    assert.equal(isAlias(symbol), true, `${text} is an alias binding`);
    const steps: string[] = [];
    const seen = new Set<Symbol>();
    let current = symbol;
    for (let count = 0; count < 12; count += 1) {
      const step = checker.getAliasStep(current);
      if (step === undefined) break;
      const next = step.kind === "symbol" ? step.symbol : step.member;
      if (step.kind === "exported-value-member") {
        steps.push(`member of [${describe(step.exportAssignment)}]: ${next === undefined ? "nothing" : row(next)}`);
      } else {
        if (seen.has(step.symbol)) break;
        steps.push(row(step.symbol));
      }
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return { checker, symbol, steps, first: checker.getAliasStep(symbol), target: checker.getAliasedSymbol(symbol) };
  };
  return { describe, isAlias, bindingOf };
}

test("getAliasStep by binding form: a namespace import, a default import, export * as, import = require and import = N.v each give one step", () => {
  const program = open({
    "/case/m.mts": "export const a = 1;\n",
    "/case/dm.mts": "export default 1 + 2;\n",
    "/case/xns.mts": "export * as plainNs from \"./m.mjs\";\n",
    "/case/eq.cts": "const obj = { k: 1 };\nexport = obj;\n",
    "/case/u.mts": [
      "import * as pm from \"./m.mjs\";", "import dm from \"./dm.mjs\";", "import { plainNs } from \"./xns.mjs\";",
      "namespace N { export const v = 1; }", "import x = N.v;", "export const use = [pm, dm, plainNs, x];", "",
    ].join("\n"),
    "/case/r.cts": "import r = require(\"./eq.cjs\");\nexport const use = r;\n",
  });
  const { bindingOf } = walker(program);
  const diagnosticsBefore = program.session.getDiagnostics("all").length;

  // A namespace import of a module without export = steps to the module itself, which is not an alias and is the final target.
  const pm = bindingOf("/case/u.mts", "NamespaceImport", "* as pm");
  assert.deepEqual(pm.steps, ["final /case/m.mts:KindSourceFile:export const a = 1;\n"]);
  assert.ok(pm.first?.kind === "symbol" && pm.first.symbol === pm.target, "the namespace import's step is its final target, the module");

  // A default import steps to the module's default export; for an expression that is the export assignment, not an alias.
  const dm = bindingOf("/case/u.mts", "ImportClause", "dm");
  assert.deepEqual(dm.steps, ["final /case/dm.mts:KindExportAssignment:export default 1 + 2;"]);
  assert.ok(dm.first?.kind === "symbol" && dm.first.symbol === dm.target, "the default import's step is its final target, the export assignment");

  // export * as: the importer's binding steps to the namespace export, an alias; that steps to the module.
  const plainNs = bindingOf("/case/u.mts", "ImportSpecifier", "plainNs");
  assert.deepEqual(plainNs.steps, ["alias /case/xns.mts:KindNamespaceExport:* as plainNs", "final /case/m.mts:KindSourceFile:export const a = 1;\n"]);
  assert.deepEqual(bindingOf("/case/xns.mts", "NamespaceExport", "* as plainNs").steps, ["final /case/m.mts:KindSourceFile:export const a = 1;\n"]);

  // import = require of a module with export =: one step is that assignment, an alias; the next is what it names.
  const r = bindingOf("/case/r.cts", "ImportEqualsDeclaration", "import r = require(\"./eq.cjs\");");
  assert.deepEqual(r.steps, ["alias /case/eq.cts:KindExportAssignment:export = obj;", "final /case/eq.cts:KindVariableDeclaration:obj = { k: 1 }"]);

  // import = of an entity name: one step is the named entity.
  const x = bindingOf("/case/u.mts", "ImportEqualsDeclaration", "import x = N.v;");
  assert.deepEqual(x.steps, ["final /case/u.mts:KindVariableDeclaration:v = 1"]);

  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

// A namespace import, in an ECMAScript-format file, of a CommonJS-format file: the checker's own target is a symbol it
// makes for that import declaration (it carries the synthetic default). The step is the module itself, as for every
// other form; the made symbol is what getAliasedSymbol returns, and it has the module's declarations.
test("getAliasStep over a CommonJS-format module without export =: a namespace import from each of two files, import = require, a default import and export * as all step to the module", () => {
  const program = open({
    "/case/lib.cts": "export const a = 1;\n",
    "/case/one.mts": "import * as n1 from \"./lib.cjs\";\nimport d1 from \"./lib.cjs\";\nexport const use = [n1, d1];\n",
    "/case/two.mts": "import * as n2 from \"./lib.cjs\";\nexport * as boxed from \"./lib.cjs\";\nexport const use = n2;\n",
    "/case/three.cts": "import r = require(\"./lib.cjs\");\nimport * as n3 from \"./lib.cjs\";\nexport const use = [r, n3];\n",
  });
  const { bindingOf, describe } = walker(program);
  const diagnosticsBefore = program.session.getDiagnostics("all").length;
  const module = ["final /case/lib.cts:KindSourceFile:export const a = 1;\n"];
  const bindings = [
    bindingOf("/case/one.mts", "NamespaceImport", "* as n1"), bindingOf("/case/two.mts", "NamespaceImport", "* as n2"),
    bindingOf("/case/three.cts", "NamespaceImport", "* as n3"), bindingOf("/case/one.mts", "ImportClause", "d1"),
    bindingOf("/case/two.mts", "NamespaceExport", "* as boxed"), bindingOf("/case/three.cts", "ImportEqualsDeclaration", "import r = require(\"./lib.cjs\");"),
  ];
  for (const binding of bindings) assert.deepEqual(binding.steps, module);

  // The final targets of the two ECMAScript-format namespace imports are the symbols made for those two imports:
  // the module's declarations, two different objects, neither of them the step. The comparison that holds for every
  // form is by declaration.
  const [n1, n2, n3] = bindings;
  if (n1 === undefined || n2 === undefined || n3 === undefined) throw new Error("unreachable");
  assert.equal(describe(n1.target), describe(n3.target));
  assert.equal(describe(n1.target), describe(n2.target));
  assert.ok(n1.target !== n2.target, "two ECMAScript-format namespace imports of one module have two final targets");
  assert.equal(n1.first?.kind === "symbol" && n1.first.symbol !== n1.target, true);
  assert.ok(n1.checker.getAliasedSymbol(n1.symbol) === n1.target, "the symbol made for one import is made once");

  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

// The export = assignment is the nearest boundary of every binding over such a module and is never skipped. The
// checker's own immediate target lands past it for a namespace import, export * as and a named member (it resolves the
// chain behind the assignment before it answers); the query answers with the assignment instead.
test("getAliasStep over a module with export =: every binding form steps to the assignment's symbol; a named import or re-export is a member of the exported value with the assignment as its boundary", () => {
  const program = open({
    "/case/eq.cts": "const obj = { k: 1 };\nexport = obj;\n",
    "/case/eqa.cts": "import inner = require(\"./eq.cjs\");\nexport = inner;\n",
    "/case/lit.cts": "export = { k: 1 };\n",
    "/case/xeq.mts": "export * as box from \"./eq.cjs\";\n",
    "/case/xk.mts": "export { k as viaK } from \"./eq.cjs\";\n",
    "/case/u.mts": [
      "import * as ns from \"./eq.cjs\";", "import d from \"./eq.cjs\";", "import { k } from \"./eq.cjs\";",
      "import { default as viaDefault } from \"./eq.cjs\";", "import { absent } from \"./eq.cjs\";",
      "import * as nsa from \"./eqa.cjs\";", "import da from \"./eqa.cjs\";", "import { k as ka } from \"./eqa.cjs\";",
      "import * as nsl from \"./lit.cjs\";", "import { k as kl } from \"./lit.cjs\";",
      "export const use = [ns, d, k, viaDefault, absent, nsa, da, ka, nsl, kl];", "",
    ].join("\n"),
    "/case/r.cts": "import ra = require(\"./eqa.cjs\");\nexport const use = ra;\n",
  });
  const { bindingOf } = walker(program);
  const diagnosticsBefore = program.session.getDiagnostics("all").length;
  const assignment = "alias /case/eq.cts:KindExportAssignment:export = obj;";
  const value = "final /case/eq.cts:KindVariableDeclaration:obj = { k: 1 }";
  const chain = ["alias /case/eqa.cts:KindExportAssignment:export = inner;", "alias /case/eqa.cts:KindImportEqualsDeclaration:import inner = require(\"./eq.cjs\");", assignment, value];

  // Default import, a specifier named default, import = require, namespace import and export * as: the same first
  // step, the assignment's symbol, and the same object for all of them.
  const d = bindingOf("/case/u.mts", "ImportClause", "d");
  const ns = bindingOf("/case/u.mts", "NamespaceImport", "* as ns");
  assert.deepEqual(d.steps, [assignment, value]);
  assert.deepEqual(ns.steps, [assignment, value]);
  assert.deepEqual(bindingOf("/case/u.mts", "ImportSpecifier", "default as viaDefault").steps, [assignment, value]);
  assert.deepEqual(bindingOf("/case/xeq.mts", "NamespaceExport", "* as box").steps, [assignment, value]);
  assert.ok(ns.first?.kind === "symbol" && d.first?.kind === "symbol" && ns.first.symbol === d.first.symbol, "the namespace import and the default import step to one symbol");
  assert.equal(ns.first?.kind === "symbol" && d.first?.kind === "symbol" && ns.first.symbol === d.first.symbol, true);
  assert.ok(stepsToSameSymbol(ns.checker.getAliasStep(ns.symbol), ns.first), "the step repeats to the same symbol");

  // A chain of two assignments: every hop is a step, for the namespace import as for the others.
  assert.deepEqual(bindingOf("/case/u.mts", "ImportClause", "da").steps, chain);
  assert.deepEqual(bindingOf("/case/r.cts", "ImportEqualsDeclaration", "import ra = require(\"./eqa.cjs\");").steps, chain);
  assert.deepEqual(bindingOf("/case/u.mts", "NamespaceImport", "* as nsa").steps, chain);

  // An assignment of an expression: its symbol is not an alias and is declared by the assignment; the chain ends there.
  const literal = "/case/lit.cts:KindExportAssignment:export = { k: 1 };";
  assert.deepEqual(bindingOf("/case/u.mts", "NamespaceImport", "* as nsl").steps, [`final ${literal}`]);

  // A named import or re-export: a member of the exported value. The boundary is the module's own assignment, also
  // when the value lies further assignments away; the member is the one the checker finds on the final value.
  const member = "final /case/eq.cts:KindPropertyAssignment:k: 1";
  assert.deepEqual(bindingOf("/case/u.mts", "ImportSpecifier", "k").steps, [`member of [/case/eq.cts:KindExportAssignment:export = obj;]: ${member}`]);
  assert.deepEqual(bindingOf("/case/xk.mts", "ExportSpecifier", "k as viaK").steps, [`member of [/case/eq.cts:KindExportAssignment:export = obj;]: ${member}`]);
  assert.deepEqual(bindingOf("/case/u.mts", "ImportSpecifier", "k as ka").steps, [`member of [/case/eqa.cts:KindExportAssignment:export = inner;]: ${member}`]);
  assert.deepEqual(bindingOf("/case/u.mts", "ImportSpecifier", "k as kl").steps, [`member of [${literal}]: final /case/lit.cts:KindPropertyAssignment:k: 1`]);

  // A member the exported value does not have: the boundary with no member. The steps from the boundary resolve
  // (assignment, then the value), which tells this from an assignment whose own chain fails.
  const absent = bindingOf("/case/u.mts", "ImportSpecifier", "absent");
  assert.deepEqual(absent.steps, ["member of [/case/eq.cts:KindExportAssignment:export = obj;]: nothing"]);
  assert.equal(absent.first?.kind === "exported-value-member" && absent.first.exportAssignment === (d.first?.kind === "symbol" ? d.first.symbol : undefined), true,
    "the boundary is the same assignment symbol the other forms step to");
  assert.equal(absent.target, undefined);

  // The final target of a namespace import, in an ECMAScript-format file, of a CommonJS-format file is a symbol the
  // checker makes for that import declaration: the value's declarations, not the value's own symbol. What the two
  // queries return is compared by declaration.
  assert.ok(sameNodes(declarations(ns.target), declarations(d.target)), "the namespace import's final target has the default import's target's declarations, in order");
  assert.ok(ns.target !== d.target, "the namespace import's final target is the symbol made for it, not the value's own symbol");
  assert.ok(ns.checker.getAliasedSymbol(ns.symbol) === ns.target, "the symbol made for one import is made once");

  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

// The namespace import below is never used in this in-process case. Programs that use it are checked under a time
// limit in namespace-import-of-export-equals.test.ts, because a use once made the checker's check not return.
test("getAliasStep over a module whose export = does not resolve: every binding form steps to the assignment and on to the failing alias; a named member has the boundary and no member", () => {
  const program = open({
    "/case/eqm.cts": "import inner = require(\"./missing.cjs\");\nexport = inner;\n",
    "/case/xm.mts": "export * as boxm from \"./eqm.cjs\";\n",
    "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nimport dm from \"./eqm.cjs\";\nimport { km } from \"./eqm.cjs\";\nimport { gone } from \"./nowhere.mjs\";\nexport const use = [dm, km, gone];\n",
    "/case/r.cts": "import rm = require(\"./eqm.cjs\");\nexport const use = rm;\n",
  });
  const { bindingOf } = walker(program);
  const diagnosticsBefore = program.session.getDiagnostics("all").length;

  // The failing alias itself: nothing from either query.
  const inner = bindingOf("/case/eqm.cts", "ImportEqualsDeclaration", "import inner = require(\"./missing.cjs\");");
  assert.deepEqual(inner.steps, []);
  assert.ok(inner.first === undefined, "the failing alias itself has no step");
  assert.ok(inner.target === undefined, "the failing alias itself has no final target");

  // Every form reaches the failing alias by steps: the assignment, then the import that does not resolve. The final
  // target of each is nothing. The causal unit of the failure is the last step, the same binding for all forms.
  const chain = ["alias /case/eqm.cts:KindExportAssignment:export = inner;", "alias /case/eqm.cts:KindImportEqualsDeclaration:import inner = require(\"./missing.cjs\");"];
  for (const [fileName, kind, text] of [
    ["/case/r.cts", "ImportEqualsDeclaration", "import rm = require(\"./eqm.cjs\");"], ["/case/u.mts", "ImportClause", "dm"],
    ["/case/u.mts", "NamespaceImport", "* as nsm"], ["/case/xm.mts", "NamespaceExport", "* as boxm"],
  ] as const) {
    const binding = bindingOf(fileName, kind, text);
    assert.deepEqual(binding.steps, chain, text);
    assert.ok(binding.target === undefined, `${text}: no final target`);
  }

  // A named member: the boundary is known, the member is not, and the steps from the boundary end at the failing alias.
  const km = bindingOf("/case/u.mts", "ImportSpecifier", "km");
  assert.deepEqual(km.steps, ["member of [/case/eqm.cts:KindExportAssignment:export = inner;]: nothing"]);
  assert.ok(km.target === undefined, "a named member of an unresolved export = has no final target");

  // The opposite: a module that does not resolve at all has no boundary; the step is nothing.
  const gone = bindingOf("/case/u.mts", "ImportSpecifier", "gone");
  assert.ok(gone.first === undefined, "a module that does not resolve gives no step");
  assert.ok(gone.target === undefined, "a module that does not resolve gives no final target");

  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

test("the existing property lookup on a class's declared type, asked with the contract member symbol's own key, selects the implementing member: own, inherited, absent, and by unique symbol", () => {
  const program = open({
    "/case/impl.mts": [
      "const key: unique symbol = Symbol();", "const other: unique symbol = Symbol();",
      "interface I { m(): number; p: string; [key](): void; }",
      "class B { m(): number { return 1; } [key](): void {} }",
      "class C extends B implements I { p = \"c\"; [other](): void {} }",
      "class D implements I { m(): number { return 2; } p = \"d\"; [key](): void {} }",
      "class E implements I { p = \"e\"; }",
      "export { C, D, E };", "",
    ].join("\n"),
  });
  const { checker, sourceFile } = program.queries("/case/impl.mts");
  const classSymbol = (name: string): Symbol | undefined =>
    checker.getSymbolAtLocation(program.nameOf(program.nodes(sourceFile, "ClassDeclaration").filter(node => program.textOf(program.nameOf(node)) === name)[0]!));
  const contract = program.nodes(sourceFile, "InterfaceDeclaration")[0];
  if (contract === undefined) throw new Error("The interface is absent.");
  const contractMembers = program.ast.members(contract).map(member => {
    if (member === undefined) throw new Error("An interface member is absent.");
    return { text: program.textOf(program.nameOf(member)), symbol: checker.getSymbolAtLocation(program.nameOf(member)) };
  });
  assert.deepEqual(contractMembers.map(member => member.text), ["m", "p", "[key]"]);
  for (const member of contractMembers) assert.notEqual(member.symbol, undefined, `the contract member ${member.text} has a symbol`);
  const owner = (declaration: Node): string => {
    const parent = program.ast.parent(declaration);
    if (parent === undefined) throw new Error("The member declaration has no parent.");
    return `${program.textOf(program.nameOf(parent))}.${program.textOf(program.nameOf(declaration))}`;
  };
  const selected = (className: string): (string[] | null)[] => contractMembers.map(member => {
    const classType = checker.getDeclaredTypeOfSymbol(classSymbol(className));
    if (member.symbol === undefined) throw new Error("The contract member has no symbol.");
    const found = checker.getPropertyOfType(classType, member.symbol.Name);
    return found === undefined ? null : declarations(found).map(owner);
  });
  // C inherits m and [key] from B and declares p; its own [other] has another unique symbol and is never selected.
  assert.deepEqual(selected("C"), [["B.m"], ["C.p"], ["B.[key]"]]);
  // D declares all three.
  assert.deepEqual(selected("D"), [["D.m"], ["D.p"], ["D.[key]"]]);
  // E declares only p; the checker reports that it does not implement I.
  assert.deepEqual(selected("E"), [null, ["E.p"], null]);
  // B implements nothing but has two of the keys: the lookup answers by key and does not judge conformance.
  assert.deepEqual(selected("B"), [["B.m"], null, ["B.[key]"]]);
});
