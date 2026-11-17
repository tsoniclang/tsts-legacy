import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { SymbolFlagsAlias, createCompilerSessionFromFiles } from "../index.js";
import type { Node, Symbol } from "../index.js";

// The `default` member the checker makes for the namespace of a CommonJS-format module stands for the module's
// exported value. Two modules whose exported values have one type share that member's symbol, so nothing may be read
// from the symbol: the module is given by the property-access query, and only where the receiver expression proves it.
const files = {
  "/case/shape.d.ts": "export interface Shape { k: number }\n",
  "/case/one.d.cts": "import type { Shape } from \"./shape.js\";\ndeclare const first: Shape;\nexport = first;\n",
  "/case/two.d.cts": "import type { Shape } from \"./shape.js\";\ndeclare const second: Shape;\nexport = second;\n",
  "/case/fn.d.cts": "declare function call(): string;\nexport = call;\n",
  "/case/lib.cts": "export const a = 1;\n",
  "/case/real.mts": "const value = { k: 1 };\nexport default value;\n",
  "/case/u.mts": [
    "import * as n1 from \"./one.cjs\";", "import * as n2 from \"./two.cjs\";", "import * as fn from \"./fn.cjs\";",
    "import * as lib from \"./lib.cjs\";", "import * as real from \"./real.mjs\";",
    "declare const condition: boolean;",
    "export const direct = [n1.default, n2.default, (n2).default, fn.default, lib.default];",
    "export const awaited = (await import(\"./two.cjs\")).default;",
    "let reassigned = n1; reassigned = n2;",
    "const copied = n2;",
    "const chosen = condition ? n1 : n2;",
    "export function pick(typed: typeof n1) { return typed.default; }",
    "export const flowed = [reassigned.default, copied.default, chosen.default, pick(n2)];",
    "export const later = import(\"./two.cjs\").then(resolved => resolved.default);",
    "export const others = [real.default, lib.a, n2[\"default\"]];",
    "export const { default: destructured } = n2;", "",
  ].join("\n"),
};

function open() {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/case", files, rootFiles: Object.keys(files),
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024", esModuleInterop: true },
  });
  const checked = session.checkSource();
  const ast = checked.ast;
  const sourceFile = checked.getSourceFile("/case/u.mts");
  if (sourceFile === undefined) throw new Error("The session has no /case/u.mts.");
  const checker = checked.getSourceFileQueries(sourceFile).checker;
  const textOf = (node: Node): string => {
    const range = ast.authoredRange(node);
    if (range.kind !== "authored") throw new Error("The node has no authored range.");
    return ast.getSourceText(sourceFile).slice(range.start, range.end);
  };
  const nodes = (kind: string, text: string): Node[] => {
    const found: Node[] = [];
    const visit = (node: Node): void => {
      if (ast.kindName(node) === `Kind${kind}` && textOf(node) === text) found.push(node);
      ast.forEachChild(node, child => { if (child !== undefined) visit(child); });
    };
    visit(sourceFile);
    return found;
  };
  const only = (kind: string, text: string): Node => {
    const found = nodes(kind, text);
    assert.equal(found.length, 1, `exactly one ${kind} ${JSON.stringify(text)}`);
    const node = found[0];
    if (node === undefined) throw new Error("unreachable");
    return node;
  };
  const nameOf = (node: Node): Node => {
    const name = ast.name(node);
    if (name === undefined) throw new Error("The node has no name.");
    return name;
  };
  const declarationsOf = (symbol: Symbol | undefined): string[] =>
    (symbol?.Declarations ?? []).flatMap(declaration => declaration === undefined ? [] : [`${ast.getFileName(ast.getSourceFile(declaration))}:${ast.kindName(declaration)}`]);
  const stepOfBinding = (text: string): Symbol => {
    const step = checker.getAliasStep(checker.getSymbolAtLocation(nameOf(only("NamespaceImport", text))));
    if (step?.kind !== "symbol") throw new Error(`The namespace import ${text} has no symbol step.`);
    return step.symbol;
  };
  return { session, checker, ast, only, nameOf, declarationsOf, stepOfBinding, diagnostics: session.getDiagnostics("all").length };
}

test("an access to the made default member through the import's own namespace binding gives the module's boundary: the step of that binding, for each module although the member symbol is shared", () => {
  const program = open();
  assert.equal(program.diagnostics, 0);
  const access = (text: string) => program.checker.getResolvedPropertyAccessInfo(program.only("PropertyAccessExpression", text));
  for (const [text, binding] of [["n1.default", "* as n1"], ["n2.default", "* as n2"], ["(n2).default", "* as n2"], ["fn.default", "* as fn"], ["lib.default", "* as lib"]] as const) {
    const info = access(text);
    assert.equal(info?.kind, "module-exported-value", text);
    assert.ok(info?.kind === "module-exported-value" && info.target === program.stepOfBinding(binding), `${text} has the step of ${binding}`);
  }
  // The two modules of one exported type: one shared member symbol, two different boundaries, each its own module's.
  const one = access("n1.default");
  const two = access("n2.default");
  assert.ok(program.checker.getSymbolAtLocation(program.nameOf(program.only("PropertyAccessExpression", "n1.default"))) ===
    program.checker.getSymbolAtLocation(program.nameOf(program.only("PropertyAccessExpression", "n2.default"))), "the member symbol is one object");
  assert.deepEqual(program.declarationsOf(one?.kind === "module-exported-value" ? one.target : undefined), ["/case/one.d.cts:KindExportAssignment"]);
  assert.deepEqual(program.declarationsOf(two?.kind === "module-exported-value" ? two.target : undefined), ["/case/two.d.cts:KindExportAssignment"]);
  // A module without export =: the boundary is the module itself.
  const lib = access("lib.default");
  assert.deepEqual(program.declarationsOf(lib?.kind === "module-exported-value" ? lib.target : undefined), ["/case/lib.cts:KindSourceFile"]);
  // await import("literal") as the receiver itself names its module too.
  const awaited = access("(await import(\"./two.cjs\")).default");
  assert.equal(awaited?.kind, "module-exported-value");
  assert.deepEqual(program.declarationsOf(awaited?.kind === "module-exported-value" ? awaited.target : undefined), ["/case/two.d.cts:KindExportAssignment"]);
});

test("an access to the made default member through any other receiver says that it is a module's exported value and names no module", () => {
  const program = open();
  // In each of these the value may be the namespace of two.cjs while the receiver's static type is the one of one.cjs.
  for (const text of ["reassigned.default", "copied.default", "chosen.default", "typed.default", "resolved.default"]) {
    const info = program.checker.getResolvedPropertyAccessInfo(program.only("PropertyAccessExpression", text));
    assert.ok(info?.kind === "module-exported-value" && info.target === undefined, `${text}: a module's exported value, no module`);
    assert.ok(isDeepStrictEqual(info, { kind: "module-exported-value", target: undefined }), `${text}: the closed record { kind: module-exported-value, target: undefined }`);
  }
});

test("a really declared default export and an ordinary member are members; the made default member is handed out by no other query", () => {
  const program = open();
  const real = program.checker.getResolvedPropertyAccessInfo(program.only("PropertyAccessExpression", "real.default"));
  assert.equal(real?.kind, "member");
  const ordinary = program.checker.getResolvedPropertyAccessInfo(program.only("PropertyAccessExpression", "lib.a"));
  assert.equal(ordinary?.kind, "member");
  assert.deepEqual(program.declarationsOf(ordinary?.kind === "member" ? ordinary.selectedSymbol : undefined), ["/case/lib.cts:KindVariableDeclaration"]);

  // The shared member symbol: an alias by its flags, with no declaration. Neither alias query answers for it; before,
  // getAliasedSymbol gave the first module's value (`first` in one.d.cts) also when the member was read from two.cjs.
  const member = program.checker.getSymbolAtLocation(program.nameOf(program.only("PropertyAccessExpression", "n2.default")));
  assert.equal(member !== undefined && (member.Flags & SymbolFlagsAlias) !== 0, true);
  assert.deepEqual(program.declarationsOf(member), []);
  assert.ok(program.checker.getAliasedSymbol(member) === undefined, "the made member has no final target");
  assert.ok(program.checker.getAliasStep(member) === undefined, "the made member has no alias step");
  // The element access that reads it: nothing. Before, its record's selected symbol was `first` in one.d.cts.
  assert.ok(program.checker.getResolvedElementAccessInfo(program.only("ElementAccessExpression", "n2[\"default\"]")) === undefined, "the element access that reads the made member gives nothing");
  // The destructured property name denotes the same member symbol, and the alias queries give nothing for it.
  const binding = program.only("BindingElement", "default: destructured");
  let propertyName: Node | undefined;
  program.ast.forEachChild(binding, child => { if (propertyName === undefined && child !== undefined && program.ast.kindName(child) === "KindIdentifier") propertyName = child; });
  if (propertyName === undefined) throw new Error("The binding element has no property name.");
  const destructuredProperty = program.checker.getSymbolAtLocation(propertyName);
  assert.ok(destructuredProperty === member, "the destructured property name denotes the shared member symbol");
  assert.ok(program.checker.getAliasedSymbol(destructuredProperty) === undefined, "the destructured property name has no final target");
  assert.equal(program.session.getDiagnostics("all").length, program.diagnostics, "the queries report no diagnostic");
});
