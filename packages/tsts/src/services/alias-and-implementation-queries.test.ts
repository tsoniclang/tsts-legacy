import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { SymbolFlagsAlias, createCompilerSessionFromFiles, getDiagnosticRunMembers } from "../index.js";
import type { Node, Symbol, TypeCheckerQueries } from "../index.js";
import { Background } from "../go/context.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { Checker_getTargetOfAliasDeclaration } from "../internal/checker/checker/symbols.js";
import { maxSerializationLevel } from "../internal/checker/checker.js";
import { Checker_resolveExternalModule } from "../internal/checker/checker/modules.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { Node_Text } from "../internal/ast/ast.js";
import { Cannot_find_module_0_or_its_corresponding_type_declarations } from "../internal/diagnostics/generated/messages.js";

const compilerOptions = { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024" };

function open(files: Record<string, string>, options: Record<string, unknown> = {}) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: Object.keys(files), compilerOptions: { ...compilerOptions, ...options } });
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

for (const count of [1, 4]) test(`failed module alias answers retain the emitted original module cause with ${count} checkers`, () => {
  const files = {
    "/case/first.mts": "import { missing, other } from './absent.mjs';",
    "/case/second.mts": "import defaulted from './absent.mjs';",
    "/case/third.mts": "import * as namespace from './absent.mjs';",
    "/case/fourth.mts": "export { missing } from './absent.mjs';",
    "/case/plain.mts": "const local = 1;",
    "/case/fifth.mts": "import { missing } from './plain.mjs';",
    "/case/good.mts": "export const available = 1;",
    "/case/sixth.mts": "import { available } from './good.mjs';",
    "/case/seventh.cts": "import external = require('./absent.cjs');",
    "/case/eighth.mts": "export * as external from './absent.mjs';",
  };
  const program = open(files, { checkers: count });
  const roots = program.session.getDiagnostics("all");
  const members = roots.flatMap(diagnostic => {
    if (diagnostic === undefined) throw new Error("The actual diagnostic root inventory is dense");
    return getDiagnosticRunMembers(diagnostic);
  });
  const selections = [
    ["/case/first.mts", "ImportSpecifier", "missing"],
    ["/case/first.mts", "ImportSpecifier", "other"],
    ["/case/second.mts", "ImportClause", "defaulted"],
    ["/case/third.mts", "NamespaceImport", "* as namespace"],
    ["/case/fourth.mts", "ExportSpecifier", "missing"],
    ["/case/fifth.mts", "ImportSpecifier", "missing"],
    ["/case/seventh.cts", "ImportEqualsDeclaration", "import external = require('./absent.cjs');"],
    ["/case/eighth.mts", "NamespaceExport", "* as external"],
  ] as const;
  const rows = selections.map(([file, kind, text]) => {
    const view = program.queries(file);
    const declaration = program.only(view.sourceFile, kind, text);
    const symbol = view.checker.getSymbolAtLocation(program.nameOf(declaration));
    if (symbol === undefined) throw new Error("The actual module alias retains its binding symbol");
    return { ...view, symbol };
  });
  for (const order of [rows, [...rows].reverse()]) for (const row of order) {
    const answer = row.checker.getAliasStep(row.symbol);
    assert.equal(answer?.kind === "unresolved", true, "a failed module answer retains its actual emitted cause");
    if (answer?.kind !== "unresolved") throw new Error("The module failure requires its original cause");
    assert.equal(answer.cause.file === row.sourceFile && members.includes(answer.cause), true,
      "the cause belongs to this actual file and the already-published run");
    const repeated = row.checker.getAliasStep(row.symbol);
    assert.equal(repeated?.kind === "unresolved" && repeated.cause === answer.cause, true, "repeated module answer identity");
  }
  const first = rows[0];
  const second = rows[1];
  if (first === undefined || second === undefined) throw new Error("Both actual bindings share the same failed module selection");
  const firstAnswer = first.checker.getAliasStep(first.symbol);
  const secondAnswer = second.checker.getAliasStep(second.symbol);
  assert.equal(firstAnswer?.kind === "unresolved" && secondAnswer?.kind === "unresolved"
    && firstAnswer.cause === secondAnswer.cause, true, "two bindings preserve the one actual module producer cause");
  const after = program.session.getDiagnostics("all").flatMap(diagnostic => {
    if (diagnostic === undefined) throw new Error("The actual diagnostic root inventory is dense");
    return getDiagnosticRunMembers(diagnostic);
  });
  assert.equal(after.length === members.length && after.every((diagnostic, index) => diagnostic === members[index]), true,
    "module answer reads never re-emit even a deduplicated diagnostic");
  const good = program.queries("/case/sixth.mts");
  const goodSymbol = good.checker.getSymbolAtLocation(program.nameOf(program.only(good.sourceFile, "ImportSpecifier", "available")));
  assert.equal(good.checker.getAliasStep(goodSymbol)?.kind === "symbol", true, "successful module binding remains a symbol");
  const suppressed = open({ "/case/u.mts": files["/case/first.mts"] }, { noCheck: true, checkers: count });
  const absentRoots = suppressed.session.getDiagnostics("all");
  const view = suppressed.queries("/case/u.mts");
  const symbol = view.checker.getSymbolAtLocation(suppressed.nameOf(suppressed.only(view.sourceFile, "ImportSpecifier", "missing")));
  assert.equal(view.checker.getAliasStep(symbol) === undefined, true, "a missing original module diagnostic stays unavailable");
  assert.equal(view.checker.getAliasStep(symbol) === undefined, true, "an unavailable repeated view cannot acquire a new cause");
  const absentAfter = suppressed.session.getDiagnostics("all");
  assert.equal(absentAfter.length === absentRoots.length && absentAfter.every((root, index) => root === absentRoots[index]), true,
    "a no-check view does not create diagnostics that its original producer never emitted");
  assert.equal(rows[0]?.checker.getAliasStep(symbol) === undefined, true, "a foreign Program cannot supply a module cause");
});

test("a suppressed native module failure cannot retain a diagnostic that was not emitted", () => {
  const program = open({ "/case/u.mts": "import { missing } from './absent.mjs';" });
  const view = program.queries("/case/u.mts");
  const declaration = program.only(view.sourceFile, "ImportDeclaration", "import { missing } from './absent.mjs';");
  const specifier = program.only(view.sourceFile, "StringLiteral", "'./absent.mjs'");
  const nativeProgram = program.session.program;
  if (nativeProgram === undefined) throw new Error("The original module failure requires its actual native Program");
  const roots = program.session.getDiagnostics("all");
  const [owner, release] = Program_GetTypeCheckerForFileExclusive(nativeProgram,
    WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), view.sourceFile);
  if (owner === undefined) throw new Error("The actual checker producer must remain available");
  const level = owner.serializationLevel;
  try {
    assert.equal(LinkStore_TryGet(owner.nodeLinks, specifier)?.externalModuleFailure !== undefined, true,
      "the prior actual producer retained its emitted cause");
    owner.serializationLevel = maxSerializationLevel;
    assert.equal(Checker_resolveExternalModule(owner, declaration, Node_Text(specifier),
      Cannot_find_module_0_or_its_corresponding_type_declarations, specifier, false) === undefined, true,
    "the native resolution still has no successful target");
    assert.equal(LinkStore_TryGet(owner.nodeLinks, specifier)?.externalModuleFailure === undefined, true,
      "the new suppressed producer replaces rather than reuses the old original cause");
  } finally {
    owner.serializationLevel = level;
    release();
  }
  const after = program.session.getDiagnostics("all");
  assert.equal(after.length === roots.length && after.every((root, index) => root === roots[index]), true,
    "suppression did not publish or reconstruct a diagnostic");
});

for (const count of [1, 4]) test(`failed immediate alias answers retain only their original member causes with ${count} checkers`, () => {
  const program = open({
    "/case/m.mts": "export const known = 1; const hidden = 2; export default 3;",
    "/case/plain.mts": "export const known = 1;",
    "/case/first.mts": "import { missing, knwon, hidden } from './m.mjs'; export { missing, knwon, hidden };",
    "/case/second.mts": "import { missing } from './m.mjs'; export { missing };",
    "/case/reexport.mts": "export { missing as forwarded } from './plain.mjs';",
    "/case/use.mts": "import { forwarded } from './reexport.mjs'; export { forwarded };",
    "/case/good.mts": "import { known } from './m.mjs'; export { known };",
  }, { checkers: count });
  const before = program.session.getDiagnostics("all");
  const originalMembers = before.flatMap(diagnostic => {
    if (diagnostic === undefined) throw new Error("The actual published diagnostic inventory must be dense");
    return getDiagnosticRunMembers(diagnostic);
  });
  const read = (file: string, kind: string, text: string) => {
    const { sourceFile, checker } = program.queries(file);
    const declaration = program.only(sourceFile, kind, text);
    const symbol = checker.getSymbolAtLocation(program.nameOf(declaration));
    if (symbol === undefined) throw new Error("An actual alias declaration requires its binding symbol");
    return { checker, symbol, sourceFile, declaration, answer: checker.getAliasStep(symbol) };
  };
  const first = read("/case/first.mts", "ImportSpecifier", "missing");
  const second = read("/case/second.mts", "ImportSpecifier", "missing");
  const typo = read("/case/first.mts", "ImportSpecifier", "knwon");
  const hidden = read("/case/first.mts", "ImportSpecifier", "hidden");
  const reexport = read("/case/reexport.mts", "ExportSpecifier", "missing as forwarded");
  const rows = [first, second, typo, hidden, reexport];
  for (const order of [rows, [...rows].reverse()]) for (const row of order) {
    if (row.answer?.kind !== "unresolved") throw new Error("The failed native immediate answer must retain its actual cause");
    const cause = row.answer.cause;
    assert.equal(cause.file === row.sourceFile, true, "the actual producer retains its original source object");
    assert.equal(before.some(diagnostic => diagnostic !== undefined && getDiagnosticRunMembers(diagnostic).includes(cause)), true,
      "the cause is in the actual published run, without code/span reconstruction");
    const repeated = row.checker.getAliasStep(row.symbol);
    assert.equal(repeated?.kind === "unresolved" && repeated.cause === cause, true, "repeated answer identity");
    assert.equal(row.checker.getAliasedSymbol(row.symbol) === undefined, true, "no fabricated successful target");
  }
  assert.equal(first.answer?.kind === "unresolved" && second.answer?.kind === "unresolved"
    && first.answer.cause !== second.answer.cause, true, "equal names/messages do not merge producing lifetimes");
  const use = read("/case/use.mts", "ImportSpecifier", "forwarded");
  assert.equal(use.answer?.kind === "symbol" && use.answer.symbol === reexport.symbol, true,
    "a retained intermediate binding edge is not replaced by the downstream error");
  assert.equal(read("/case/good.mts", "ImportSpecifier", "known").answer?.kind, "symbol", "ordinary success remains a symbol");
  assert.equal(first.checker.getAliasStep(undefined) === undefined, true, "absent input is not an error");
  assert.equal(program.session.getDiagnostics("all").length, before.length, "answer reads do not re-emit diagnostics");
  const afterMembers = program.session.getDiagnostics("all").flatMap(diagnostic => {
    if (diagnostic === undefined) throw new Error("The actual published diagnostic inventory must remain dense");
    return getDiagnosticRunMembers(diagnostic);
  });
  assert.equal(afterMembers.length === originalMembers.length
    && afterMembers.every((diagnostic, index) => diagnostic === originalMembers[index]), true,
    "forward and reverse view reads do not create even deduplicated replacement diagnostics");
  const suppressed = open({
    "/case/m.mts": "export const known = 1;",
    "/case/u.mts": "import { missing } from './m.mjs'; export { missing };",
  }, { noCheck: true });
  const suppressedView = suppressed.queries("/case/u.mts");
  const absentSymbol = suppressedView.checker.getSymbolAtLocation(suppressed.nameOf(suppressed.only(suppressedView.sourceFile, "ImportSpecifier", "missing")));
  assert.equal(suppressedView.checker.getAliasStep(absentSymbol) === undefined, true,
    "no emitted original diagnostic remains missing evidence, not an invented error");
  const foreign = open({ "/case/m.mts": "export const known = 1;", "/case/u.mts": "import { missing } from './m.mjs'; export { missing };" });
  const foreignView = foreign.queries("/case/u.mts");
  const foreignSymbol = foreignView.checker.getSymbolAtLocation(foreign.nameOf(foreign.only(foreignView.sourceFile, "ImportSpecifier", "missing")));
  assert.equal(first.checker.getAliasStep(foreignSymbol) === undefined, true, "a foreign Program cannot lend an original alias answer");
  const nativeProgram = program.session.program;
  if (nativeProgram === undefined) throw new Error("The fixture requires its actual native Program");
  const [owner, release] = Program_GetTypeCheckerForFileExclusive(nativeProgram,
    WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), first.sourceFile);
  try {
    if (owner === undefined) throw new Error("The actual diagnostic producer must remain available");
    assert.equal(Checker_getTargetOfAliasDeclaration(owner, first.declaration) === undefined, true,
      "a genuine native re-evaluation still has no fabricated successful target");
  } finally {
    release();
  }
  const renewed = first.checker.getAliasStep(first.symbol);
  assert.equal(renewed?.kind === "unresolved" && first.answer?.kind === "unresolved"
    && renewed.cause !== first.answer.cause, true, "a new actual producer lifetime replaces the old failure, not first-record-wins");
  if (renewed?.kind !== "unresolved") throw new Error("The renewed actual answer requires its own original cause");
  assert.equal(program.session.getDiagnostics("all").some(diagnostic => diagnostic !== undefined
    && getDiagnosticRunMembers(diagnostic).includes(renewed.cause)), true, "the renewed original appears in the actual published run");
});

// Two steps of the same kind whose symbols are one object.
function stepsToSameSymbol(left: ReturnType<TypeCheckerQueries["getAliasStep"]>, right: ReturnType<TypeCheckerQueries["getAliasStep"]>): boolean {
  return left?.kind === "symbol" && right?.kind === "symbol" && left.symbol === right.symbol;
}

// The step of a binding whose step is a symbol. A step of the other kind fails the case.
function symbolStep(checker: TypeCheckerQueries, symbol: Symbol | undefined): Symbol | undefined {
  const step = checker.getAliasStep(symbol);
  if (step === undefined || step.kind === "unresolved") return undefined;
  if (step.kind !== "symbol") throw new Error("A step that is a symbol was expected.");
  return step.symbol;
}

test("getAliasStep steps one alias at a time, closes a circular chain, and retains the original failed immediate answer", () => {
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

  const nope = checker.getSymbolAtLocation(program.nameOf(program.only(sourceFile, "ImportSpecifier", "nope")));
  assert.equal(isAlias(nope), true);
  assert.ok(checker.getAliasedSymbol(nope) === undefined, "a missing member has no final target");
  const missing = checker.getAliasStep(nope);
  assert.equal(missing?.kind, "unresolved", "a failed member retains its actual producing diagnostic");
  if (missing?.kind !== "unresolved") throw new Error("The actual failed alias answer must carry its original cause");
  assert.equal(program.checked.diagnostics.some(diagnostic => diagnostic !== undefined && getDiagnosticRunMembers(diagnostic).includes(missing.cause)), true,
    "the cause is an original member of an actual published diagnostic, never a code or span match");
  const repeatedMissing = checker.getAliasStep(nope);
  assert.equal(repeatedMissing?.kind === "unresolved" && repeatedMissing.cause === missing.cause, true,
    "a repeated read borrows the same actual failure without emitting another diagnostic");

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
      if (step === undefined || step.kind === "unresolved") break;
      const next = step.kind === "symbol" ? step.symbol : step.member?.kind === "symbol" ? step.member.symbol : undefined;
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
  assert.ok(isDeepStrictEqual(pm.first, { kind: "symbol", symbol: pm.target }), "the namespace import's step is the closed record { kind: symbol, symbol: the module }");

  // A default import steps to the module's default export; for an expression that is the export assignment, not an alias.
  const dm = bindingOf("/case/u.mts", "ImportClause", "dm");
  assert.deepEqual(dm.steps, ["final /case/dm.mts:KindExportAssignment:export default 1 + 2;"]);
  assert.ok(dm.first?.kind === "symbol" && dm.first.symbol === dm.target, "the default import's step is its final target, the export assignment");
  assert.ok(isDeepStrictEqual(dm.first, { kind: "symbol", symbol: dm.target }), "the default import's step is the closed record { kind: symbol, symbol: the export assignment }");

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
  assert.ok(stepsToSameSymbol(ns.first, d.first), "the namespace import and the default import step to one symbol");
  assert.ok(ns.first?.kind === "symbol" && isDeepStrictEqual(ns.first, { kind: "symbol", symbol: ns.first.symbol }) && isDeepStrictEqual(d.first, { kind: "symbol", symbol: ns.first.symbol }) && isDeepStrictEqual(ns.first, d.first),
    "the namespace and default imports' steps are the same closed record { kind: symbol, symbol }");
  const repeated = ns.checker.getAliasStep(ns.symbol);
  assert.ok(stepsToSameSymbol(repeated, ns.first), "the step repeats to the same symbol");
  assert.ok(ns.first?.kind === "symbol" && isDeepStrictEqual(repeated, { kind: "symbol", symbol: ns.first.symbol }) && isDeepStrictEqual(ns.first, { kind: "symbol", symbol: ns.first.symbol }) && isDeepStrictEqual(repeated, ns.first),
    "the repeated step is the same closed record { kind: symbol, symbol }");

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
  assert.equal(absent.first?.kind === "exported-value-member" && absent.first.member?.kind === "unresolved", true,
    "the failed member retains its original failure without erasing the exported-value boundary");
  if (absent.first?.kind !== "exported-value-member" || absent.first.member?.kind !== "unresolved") throw new Error("A failed exported-value member requires its actual cause");
  const absentCause = absent.first.member.cause;
  assert.equal(program.checked.diagnostics.some(diagnostic => diagnostic !== undefined
    && getDiagnosticRunMembers(diagnostic).includes(absentCause)), true, "the boundary's failed member retains an actual published original");
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

  const inner = bindingOf("/case/eqm.cts", "ImportEqualsDeclaration", "import inner = require(\"./missing.cjs\");");
  assert.deepEqual(inner.steps, []);
  assert.equal(inner.first?.kind === "unresolved", true, "the failing alias retains its original module cause");
  if (inner.first?.kind !== "unresolved") throw new Error("The failing native alias requires its original cause");
  const innerCause = inner.first.cause;
  assert.equal(program.session.getDiagnostics("all").some(diagnostic => diagnostic !== undefined
    && getDiagnosticRunMembers(diagnostic).includes(innerCause)), true,
    "the failed assignment dependency retains its actual published root");
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

  const gone = bindingOf("/case/u.mts", "ImportSpecifier", "gone");
  assert.equal(gone.first?.kind === "unresolved", true, "an unresolved module has its original cause, not an export boundary");
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
