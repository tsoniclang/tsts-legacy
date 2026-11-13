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

test("getImmediateAliasedSymbol steps one alias at a time, and returns nothing without throwing for a non-alias and for an unresolved alias", () => {
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

  // An alias inside a circular re-export: nothing.
  const cyclic = program.queries("/case/e.mts");
  const x = cyclic.checker.getSymbolAtLocation(program.nameOf(program.only(cyclic.sourceFile, "ImportSpecifier", "x")));
  assert.equal(isAlias(x), true);
  assert.equal(cyclic.checker.getImmediateAliasedSymbol(x), undefined);

  assert.equal(checker.getImmediateAliasedSymbol(undefined), undefined);
  assert.equal(program.session.getDiagnostics("all").length, diagnosticsBefore, "the query reports no diagnostic");
});

test("getImplementingMember selects the class member under the contract member's own key: own, inherited, absent, and by unique symbol", () => {
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
    const found = checker.getImplementingMember(classSymbol(className), member.symbol);
    return found === undefined ? null : declarations(found).map(owner);
  });
  // C inherits m and [key] from B and declares p; its own [other] has another unique symbol and is never selected.
  assert.deepEqual(selected("C"), [["B.m"], ["C.p"], ["B.[key]"]]);
  // D declares all three.
  assert.deepEqual(selected("D"), [["D.m"], ["D.p"], ["D.[key]"]]);
  // E declares only p; the checker reports that it does not implement I.
  assert.deepEqual(selected("E"), [null, ["E.p"], null]);
  // B implements nothing but has two of the keys: the query answers by key and does not judge conformance.
  assert.deepEqual(selected("B"), [["B.m"], null, ["B.[key]"]]);
  // The opposite of a class: an interface symbol. Nothing.
  const interfaceSymbol = checker.getSymbolAtLocation(program.nameOf(contract));
  assert.equal(checker.getImplementingMember(interfaceSymbol, contractMembers[0]?.symbol), undefined);
  assert.equal(checker.getImplementingMember(classSymbol("C"), undefined), undefined);
  assert.equal(checker.getImplementingMember(undefined, contractMembers[0]?.symbol), undefined);
});
