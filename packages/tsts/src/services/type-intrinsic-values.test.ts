import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import type { Node, ResolvedSourceIntrinsicValueInfo, SourceFile } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Background } from "../go/context.js";
import { Node_Expression } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { CheckModeNormal } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionEx } from "../internal/checker/checker/syntax-checking.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";

const paths = ["first", "second", "third", "fourth"].map(name => `/intrinsic-value/${name}.ts`);
const source = `
  export function choose(flag: undefined = undefined): undefined { return flag; }
  export function call() { return choose(undefined); }
  export function local() { const undefined: undefined = choose(); return undefined; }
  export function parameter(undefined: undefined) { return undefined; }
  export type TypeOnly = typeof undefined;
  export function property() { return globalThis.undefined; }
`;

function present<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message);
  return value;
}

function open(checkers: number, text = source, noCheck = false) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/intrinsic-value", includeBundledLibraries: false,
    files: { "/intrinsic-value/core.d.ts": testCoreDeclarations, ...Object.fromEntries(paths.map(path => [path, text])) },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers, noCheck } });
  const checked = session.checkSource();
  const program = present(session.program, "The actual Program exists");
  assert.equal(program.compilerCheckerPool?.checkers.length, checkers);
  const files = paths.map(path => {
    const file = present(checked.getSourceFile(path), "The file belongs to the actual Program");
    const { ast, checker } = checked.getSourceFileQueries(file);
    const functions = findNodes(file, ast.children, ast.is.IsFunctionDeclaration);
    function returned(name: string): Node {
      const declaration = present(functions.find(node => ast.text(ast.name(node)) === name), "The actual authored function exists");
      const statement = present(findNodes(declaration, ast.children, ast.is.IsReturnStatement)[0], "The actual return exists");
      return present(Node_Expression(statement), "The return has an actual value expression");
    }
    return { file, ast, checker, returned };
  });
  return { session, program, checked, files };
}

function withOwner<Output>(current: ReturnType<typeof open>, file: SourceFile, operation: (checker: Checker) => Output): Output {
  const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.program,
    WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), file);
  try { return operation(present(owner, "The file's original checker exists")); }
  finally { release(); }
}

for (const checkers of [1, 4]) {
  test(`standalone intrinsic values retain actual lexical identity with ${checkers} checkers`, () => {
    const current = open(checkers);
    assert.equal(current.checked.diagnostics.length, 0);
    const borrowed = createCompilerSessionFromProgram(current.program, current.session.host, current.session.config).checkSource();
    const owners = new Set<Checker>();
    const symbols = new Set<ResolvedSourceIntrinsicValueInfo["symbol"]>();
    for (const { ast, checker, file, returned } of current.files) withOwner(current, file, owner => {
      owners.add(owner);
      const argument = present(ast.arguments(returned("call"))[0], "The call has its authored argument");
      const links = present(LinkStore_TryGet(owner.symbolNodeLinks, argument), "Native checking completed the argument resolution");
      const answer = checker.getResolvedIntrinsicValueInfo(argument);
      assert.equal(answer?.kind, "undefined");
      assert.equal(answer !== undefined && answer.symbol === owner.undefinedSymbol && answer.symbol === links.resolvedSymbol, true);
      assert.equal(answer !== undefined && answer.symbol === checker.getSymbolAtLocation(argument), true);
      assert.equal(checker.getTypeAtLocation(argument)?.type === owner.undefinedType, true);
      symbols.add(present(answer, "The authenticated intrinsic read is available").symbol);
      assert.equal(checker.getSymbolDeclarations(answer?.symbol).length, 0);
      assert.equal(borrowed.getSourceFileQueries(file).checker.getResolvedIntrinsicValueInfo(argument)?.symbol === answer?.symbol, true);
      for (const name of ["local", "parameter"]) {
        const node = returned(name);
        const selected = checker.getResolvedSymbol(node);
        assert.equal(ast.text(node), "undefined");
        assert.equal(selected !== undefined && selected !== owner.undefinedSymbol && selected.ValueDeclaration !== undefined, true, name);
        assert.equal(checker.getTypeAtLocation(node)?.type === owner.undefinedType, true, name);
        assert.equal(checker.getResolvedIntrinsicValueInfo(node) === undefined, true, name);
      }
      const property = present(ast.name(returned("property")), "The real property name exists");
      const typeQuery = present(findNodes(file, ast.children, node => ast.kindName(node) === "KindTypeQuery")[0], "The authored type query exists");
      const typeName = present(ast.children(typeQuery).find(node => ast.is.IsIdentifier(node)), "The type query names a real identifier");
      assert.equal(checker.getSymbolAtLocation(property) === owner.undefinedSymbol, true);
      assert.equal(checker.getSymbolAtLocation(typeName) === owner.undefinedSymbol, true);
      for (const node of [property, typeName, returned("property")]) {
        assert.equal(checker.getResolvedIntrinsicValueInfo(node) === undefined, true, ast.kindName(ast.parent(node)));
      }
      assert.equal(LinkStore_TryGet(owner.symbolNodeLinks, argument) === links, true);
    });
    assert.equal(owners.size, checkers, "all actual checker owners performed the public read");
    assert.equal(symbols.size, checkers, "standalone intrinsic symbols belong to their own checker");
  });

  test(`cold, unresolved and foreign resolutions give no intrinsic answer with ${checkers} checkers`, () => {
    const text = "export function found() { return undefined; } export function missing() { return missingName; }";
    const current = open(checkers, text, true);
    const foreign = open(checkers, text);
    assert.equal(foreign.checked.diagnostics.some(root => root?.code === 2304), true,
      "the checked unresolved opposite has its actual missing-name diagnostic");
    const foreignFile = present(foreign.files[0], "The foreign Program has the same file path");
    const foreignNode = foreignFile.returned("found");
    const foreignAnswer = present(foreignFile.checker.getResolvedIntrinsicValueInfo(foreignNode), "The foreign occurrence is genuinely intrinsic there");
    for (const { file, checker, returned } of current.files) withOwner(current, file, owner => {
      const found = returned("found");
      const missing = returned("missing");
      assert.equal(LinkStore_TryGet(owner.symbolNodeLinks, found) === undefined, true, "the no-check source starts genuinely cold");
      assert.equal(checker.getResolvedIntrinsicValueInfo(found) === undefined
        && LinkStore_TryGet(owner.symbolNodeLinks, found) === undefined, true, "a public read never completes the cache");
      assert.equal(checker.getResolvedIntrinsicValueInfo(foreignNode) === undefined, true,
        "an actual foreign AST under the identical path is not admitted");
      assert.equal(Checker_checkExpressionEx(owner, found, CheckModeNormal) === owner.undefinedType, true);
      assert.equal(Checker_checkExpressionEx(owner, missing, CheckModeNormal) === owner.errorType, true);
      assert.equal(LinkStore_TryGet(owner.symbolNodeLinks, missing)?.resolvedSymbol === owner.unknownSymbol
        && checker.getResolvedIntrinsicValueInfo(missing) === undefined, true);
      const links = present(LinkStore_TryGet(owner.symbolNodeLinks, found), "The native producer retained its exact load");
      const actual = links.resolvedSymbol;
      const answer = present(checker.getResolvedIntrinsicValueInfo(found), "A later completed native value is visible");
      assert.equal(answer.symbol === actual && actual === owner.undefinedSymbol, true);
      const sibling = current.program.compilerCheckerPool?.checkers.find(candidate => candidate !== undefined && candidate !== owner);
      assert.equal(sibling?.undefinedSymbol !== undefined, checkers === 4);
      const crossedSymbols = [undefined, owner.unknownSymbol, foreignAnswer.symbol];
      if (sibling !== undefined) crossedSymbols.push(sibling.undefinedSymbol);
      for (const crossed of crossedSymbols) {
        try {
          links.resolvedSymbol = crossed;
          assert.equal(checker.getResolvedIntrinsicValueInfo(found) === undefined && links.resolvedSymbol === crossed, true,
            "absent or wrong native cache membership cannot borrow an earlier positive answer");
        } finally { links.resolvedSymbol = actual; }
      }
      assert.equal(checker.getResolvedIntrinsicValueInfo(found)?.symbol === actual, true);
    });
  });
}
