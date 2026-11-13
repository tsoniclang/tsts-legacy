import assert from "node:assert/strict";
import { test } from "node:test";
import { SymbolFlagsAlias, createCompilerSessionFromFiles } from "../index.js";
import type { Node, Symbol } from "../index.js";

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

test("getImmediateAliasedSymbol steps one alias at a time, closes a circular chain, and returns nothing without throwing for a non-alias and for a step that did not resolve", () => {
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
  const step1 = checker.getImmediateAliasedSymbol(z);
  assert.deepEqual(describe(step1), ["/case/s.mts:KindExportSpecifier:b as c"]);
  assert.equal(isAlias(step1), true);
  const step2 = checker.getImmediateAliasedSymbol(step1);
  assert.deepEqual(describe(step2), ["/case/r.mts:KindExportSpecifier:a as b"]);
  assert.equal(isAlias(step2), true);
  const step3 = checker.getImmediateAliasedSymbol(step2);
  assert.deepEqual(describe(step3), ["/case/m.mts:KindVariableDeclaration:a = 1"]);
  assert.equal(isAlias(step3), false);
  assert.equal(step3, checker.getAliasedSymbol(z), "the last step is the final target the existing query returns");
  // The opposite of an alias: a variable. Nothing, and no throw.
  assert.equal(checker.getImmediateAliasedSymbol(step3), undefined);

  // A local re-export steps to the local declaration; a re-export of an import steps to that import binding, not past it.
  const viaLocal = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ExportSpecifier", "local as viaLocal")));
  assert.deepEqual(describe(checker.getImmediateAliasedSymbol(viaLocal)), ["/case/u.mts:KindVariableDeclaration:local = 1"]);
  const viaZ = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ExportSpecifier", "z as viaZ")));
  assert.equal(checker.getImmediateAliasedSymbol(viaZ), z);

  // An alias whose member does not exist: flagged as an alias, and both queries return nothing.
  const nope = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ImportSpecifier", "nope")));
  assert.equal(isAlias(nope), true);
  assert.equal(checker.getAliasedSymbol(nope), undefined);
  assert.equal(checker.getImmediateAliasedSymbol(nope), undefined);

  // An import through a circular re-export: its final target is unresolved, and its steps lead into the cycle and
  // return to a symbol already visited. The cycle's members are the two export specifiers; the importer is not one.
  const cyclic = program.queries("/case/e.mts");
  const x = cyclic.checker.getSymbolAtLocation(program.nameOf(program.only(cyclic.sourceFile, "ImportSpecifier", "x")));
  assert.equal(isAlias(x), true);
  assert.equal(cyclic.checker.getAliasedSymbol(x), undefined);
  const inC1 = cyclic.checker.getImmediateAliasedSymbol(x);
  assert.deepEqual(describe(inC1), ["/case/c1.mts:KindExportSpecifier:x"]);
  const inC2 = cyclic.checker.getImmediateAliasedSymbol(inC1);
  assert.deepEqual(describe(inC2), ["/case/c2.mts:KindExportSpecifier:x"]);
  assert.equal(cyclic.checker.getImmediateAliasedSymbol(inC2), inC1, "the walk returns to the first member: the cycle is c1.x, c2.x");

  // Through a star re-export there is no alias in the re-exporting module: one step reaches the declaration.
  const star = program.queries("/case/v.mts");
  const viaStar = star.checker.getSymbolAtLocation(program.nameOf(program.only(star.sourceFile, "ImportSpecifier", "a as viaStar")));
  assert.deepEqual(describe(star.checker.getImmediateAliasedSymbol(viaStar)), ["/case/m.mts:KindVariableDeclaration:a = 1"]);

  assert.equal(checker.getImmediateAliasedSymbol(undefined), undefined);
  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

// One row per step from a binding: "alias " or "final " (whether the step is itself flagged as an alias), then the
// step's declarations. The walk ends at nothing or at a symbol already visited.
function walker(program: ReturnType<typeof open>) {
  const describe = (symbol: Symbol | undefined): string =>
    declarations(symbol).map(declaration => `${program.fileNameOf(declaration)}:${program.ast.kindName(declaration)}:${program.textOf(declaration)}`).join(" | ");
  const isAlias = (symbol: Symbol | undefined): boolean => symbol !== undefined && (symbol.Flags & SymbolFlagsAlias) !== 0;
  const bindingOf = (fileName: string, kind: string, text: string) => {
    const { checker, sourceFile } = program.queries(fileName);
    const symbol = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, kind, text)));
    assert.equal(isAlias(symbol), true, `${text} is an alias binding`);
    const steps: string[] = [];
    const seen = new Set<Symbol>();
    let current = symbol;
    for (let count = 0; count < 12; count += 1) {
      const next = checker.getImmediateAliasedSymbol(current);
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      steps.push(`${isAlias(next) ? "alias" : "final"} ${describe(next)}`);
      current = next;
    }
    return { checker, symbol, steps, first: checker.getImmediateAliasedSymbol(symbol), target: checker.getAliasedSymbol(symbol) };
  };
  return { describe, isAlias, bindingOf };
}

test("getImmediateAliasedSymbol by binding form: a namespace import, a default import, export * as, import = require and import = N.v each give one step", () => {
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

  // A namespace import steps to the module itself, which is not an alias and is the final target.
  const pm = bindingOf("/case/u.mts", "NamespaceImport", "* as pm");
  assert.deepEqual(pm.steps, ["final /case/m.mts:KindSourceFile:export const a = 1;\n"]);
  assert.equal(pm.first, pm.target);

  // A default import steps to the module's default export; for an expression that is the export assignment, not an alias.
  const dm = bindingOf("/case/u.mts", "ImportClause", "dm");
  assert.deepEqual(dm.steps, ["final /case/dm.mts:KindExportAssignment:export default 1 + 2;"]);
  assert.equal(dm.first, dm.target);

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

// PRESENT BEHAVIOUR, pinned so that a change is seen. For a module with export =, a namespace import, export * as and
// a named import or re-export do not give one step: the checker resolves the whole chain behind export = before it
// answers (Checker_resolveESModuleSymbol), so the assignment and every alias behind it are skipped. A default import
// and import = require do give one step, to the assignment.
test("getImmediateAliasedSymbol over a module with export =: default import and import = require step to the assignment; namespace import, export * as and named members land past it (present behaviour)", () => {
  const program = open({
    "/case/eq.cts": "const obj = { k: 1 };\nexport = obj;\n",
    "/case/eqa.cts": "import inner = require(\"./eq.cjs\");\nexport = inner;\n",
    "/case/xeq.mts": "export * as box from \"./eq.cjs\";\n",
    "/case/xk.mts": "export { k as viaK } from \"./eq.cjs\";\n",
    "/case/u.mts": [
      "import * as ns from \"./eq.cjs\";", "import d from \"./eq.cjs\";", "import { k } from \"./eq.cjs\";",
      "import * as nsa from \"./eqa.cjs\";", "import da from \"./eqa.cjs\";", "export const use = [ns, d, k, nsa, da];", "",
    ].join("\n"),
    "/case/r.cts": "import ra = require(\"./eqa.cjs\");\nexport const use = ra;\n",
  });
  const { bindingOf, describe } = walker(program);
  const diagnosticsBefore = program.session.getDiagnostics("all").length;
  const assignment = "alias /case/eq.cts:KindExportAssignment:export = obj;";
  const value = "final /case/eq.cts:KindVariableDeclaration:obj = { k: 1 }";

  // One step: the assignment.
  assert.deepEqual(bindingOf("/case/u.mts", "ImportClause", "d").steps, [assignment, value]);
  const chain = ["alias /case/eqa.cts:KindExportAssignment:export = inner;", "alias /case/eqa.cts:KindImportEqualsDeclaration:import inner = require(\"./eq.cjs\");", assignment, value];
  assert.deepEqual(bindingOf("/case/u.mts", "ImportClause", "da").steps, chain);
  assert.deepEqual(bindingOf("/case/r.cts", "ImportEqualsDeclaration", "import ra = require(\"./eqa.cjs\");").steps, chain);

  // Past the assignment: the namespace forms land on the final value, the named forms on its member.
  assert.deepEqual(bindingOf("/case/u.mts", "NamespaceImport", "* as ns").steps, [value]);
  assert.deepEqual(bindingOf("/case/u.mts", "NamespaceImport", "* as nsa").steps, [value], "export = inner, inner and export = obj are all skipped");
  assert.deepEqual(bindingOf("/case/xeq.mts", "NamespaceExport", "* as box").steps, [value]);
  assert.deepEqual(bindingOf("/case/u.mts", "ImportSpecifier", "k").steps, ["final /case/eq.cts:KindPropertyAssignment:k: 1"]);
  assert.deepEqual(bindingOf("/case/xk.mts", "ExportSpecifier", "k as viaK").steps, ["final /case/eq.cts:KindPropertyAssignment:k: 1"]);

  // A namespace import in an ECMAScript-format file of a CommonJS-format file: the checker makes a new symbol for each
  // of the two queries (Checker_cloneTypeAsModuleType). Same declarations, not the same object. Compare by declaration.
  const ns = bindingOf("/case/u.mts", "NamespaceImport", "* as ns");
  assert.equal(describe(ns.first), describe(ns.target));
  assert.notEqual(ns.first, ns.target, "DEPENDS ON THE SDK CORRECTION: two clones with one declaration");
  assert.equal(ns.checker.getImmediateAliasedSymbol(ns.symbol), ns.first, "each query repeats to its own object");

  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

// The namespace import below is never used in this in-process case. Programs that use it are checked under a time
// limit in namespace-import-of-export-equals.test.ts, because a use once made the checker's check not return.
test("getImmediateAliasedSymbol over a module whose export = does not resolve: import = require and default import step to the assignment and on to the failing alias; a namespace import gives nothing", () => {
  const program = open({
    "/case/eqm.cts": "import inner = require(\"./missing.cjs\");\nexport = inner;\n",
    "/case/u.mts": "import * as nsm from \"./eqm.cjs\";\nimport dm from \"./eqm.cjs\";\nexport const use = dm;\n",
    "/case/r.cts": "import rm = require(\"./eqm.cjs\");\nexport const use = rm;\n",
  });
  const { bindingOf } = walker(program);
  const diagnosticsBefore = program.session.getDiagnostics("all").length;

  // The failing alias itself: nothing from either query.
  const inner = bindingOf("/case/eqm.cts", "ImportEqualsDeclaration", "import inner = require(\"./missing.cjs\");");
  assert.deepEqual(inner.steps, []);
  assert.equal(inner.target, undefined);

  // One step still resolves for the two forms that stop at the assignment; the final target does not.
  const chain = ["alias /case/eqm.cts:KindExportAssignment:export = inner;", "alias /case/eqm.cts:KindImportEqualsDeclaration:import inner = require(\"./missing.cjs\");"];
  const rm = bindingOf("/case/r.cts", "ImportEqualsDeclaration", "import rm = require(\"./eqm.cjs\");");
  assert.deepEqual(rm.steps, chain);
  assert.equal(rm.target, undefined);
  const dm = bindingOf("/case/u.mts", "ImportClause", "dm");
  assert.deepEqual(dm.steps, chain);
  assert.equal(dm.target, undefined);

  // The namespace import: the unknown symbol stays the unknown symbol, so both queries give nothing. No symbol
  // without declarations is returned in its place.
  const nsm = bindingOf("/case/u.mts", "NamespaceImport", "* as nsm");
  assert.equal(nsm.first, undefined);
  assert.equal(nsm.target, undefined);
  assert.deepEqual(nsm.steps, []);

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
