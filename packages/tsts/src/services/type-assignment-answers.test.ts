import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram, getDiagnosticRunMembers } from "../index.js";
import type { Node } from "../index.js";
import { testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Background } from "../go/context.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { DiagnosticsCollection_GetDiagnostics } from "../internal/ast/diagnostic.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { maxSerializationLevel } from "../internal/checker/checker.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { CheckModeContextual, CheckModeInferential, CheckModeNormal, CheckModeTypeOnly } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionEx } from "../internal/checker/checker/syntax-checking.js";
import { Checker_GetTypeAtLocation, Checker_getContextualType } from "../internal/checker/checker/types.js";
import { ContextFlagsNone } from "../internal/checker/types.js";

function open(checkers: number, source: string, noCheck = false) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/assignment-answers", includeBundledLibraries: false,
    files: { "/assignment-answers/core.d.ts": testCoreDeclarations, "/assignment-answers/use.ts": source,
      "/assignment-answers/other.ts": "export const other=1;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers, noCheck } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/assignment-answers/use.ts");
  if (file === undefined) throw new Error("The actual assignment file belongs to this Program");
  const view = checked.getSourceFileQueries(file);
  const nodes: Node[] = [];
  const pending: Node[] = [file];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined) throw new Error("The actual syntax worklist is dense");
    nodes.push(node);
    view.ast.forEachChild(node, child => { if (child !== undefined) pending.push(child); });
  }
  const assignments = nodes.filter(node => view.ast.kindName(node) === "KindIdentifier"
    && view.ast.kindName(view.ast.parent(node)) === "KindBinaryExpression");
  const returns = nodes.filter(node => view.ast.kindName(node) === "KindIdentifier"
    && view.ast.kindName(view.ast.parent(node)) === "KindReturnStatement");
  const members = () => session.getDiagnostics("all").flatMap(root => {
    if (root === undefined) throw new Error("The original published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  return { session, file, view, nodes, assignments, returns, members };
}

function withOwner<Output>(current: ReturnType<typeof open>, operation: (owner: Checker) => Output): Output {
  const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.session.program,
    WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), current.file);
  try {
    if (owner === undefined) throw new Error("The exact file has its actual assigned checker");
    return operation(owner);
  } finally { release(); }
}

function actualNode(nodes: readonly Node[], index = 0): Node {
  const node = nodes[index];
  if (node === undefined) throw new Error("The selected authored occurrence exists");
  return node;
}

for (const checkers of [1, 4]) {
  test(`completed assignment failures retain the original paired answer with ${checkers} checkers`, () => {
    const current = open(checkers, "export function store():boolean{const a:boolean=true;a=false;a=true;return a;} export const unrelated:Missing=1;");
    assert.equal(current.assignments.length, 2);
    const published = current.members();
    const causes = withOwner(current, owner => {
      const before = DiagnosticsCollection_GetDiagnostics(owner.diagnostics);
      const results = current.assignments.map(node => {
        const links = LinkStore_TryGet(owner.typeNodeLinks, node);
        const symbol = LinkStore_TryGet(owner.symbolNodeLinks, node)?.resolvedSymbol;
        assert.equal(links !== undefined && links.resolvedType === owner.errorType && links.resolutionFailure !== undefined, true,
          "the normal check stores the exact failed answer and its actual emission together");
        if (links?.resolutionFailure === undefined) throw new Error("The actual failure has its original Diagnostic");
        assert.equal(links.resolutionFailure.file === current.file && published.includes(links.resolutionFailure), true,
          "the cause is the exact already-published member, not a diagnostic-site match");
        assert.equal(symbol !== undefined && symbol !== owner.unknownSymbol
          && LinkStore_TryGet(owner.symbolNodeLinks, node)?.resolutionFailure === undefined, true,
        "a failed assignment does not corrupt the genuinely successful name resolution");
        return { node, links, symbol, cause: links.resolutionFailure };
      });
      assert.equal(results[0]?.cause !== results[1]?.cause, true,
        "different assignments sharing errorType keep distinct actual original diagnostics");
      for (const order of [results, [...results].reverse()]) for (const result of order) {
        assert.equal(Checker_GetTypeAtLocation(owner, result.node) === result.links.resolvedType, true);
        assert.equal(LinkStore_TryGet(owner.typeNodeLinks, result.node) === result.links
          && result.links.resolutionFailure === result.cause
          && LinkStore_TryGet(owner.symbolNodeLinks, result.node)?.resolvedSymbol === result.symbol, true);
        const binary = current.view.ast.parent(result.node);
        const right = current.view.ast.children(binary).find(child => current.view.ast.kindName(child) === "KindFalseKeyword"
          || current.view.ast.kindName(child) === "KindTrueKeyword");
        if (right === undefined) throw new Error("The actual assignment has its authored boolean operand");
        assert.equal(Checker_getContextualType(owner, right, ContextFlagsNone) === owner.errorType, true,
          "the real contextual producer delegates to this left operand");
        assert.equal(Checker_GetTypeAtLocation(owner, right) !== owner.errorType
          && Checker_GetTypeAtLocation(owner, binary) !== owner.errorType, true,
        "ordinary RHS and Binary answers do not inherit the assignment's error or cause");
        assert.equal(LinkStore_TryGet(owner.typeNodeLinks, right)?.resolutionFailure === undefined
          && LinkStore_TryGet(owner.typeNodeLinks, binary)?.resolutionFailure === undefined, true);
      }
      const saved = owner.serializationLevel;
      try {
        owner.serializationLevel = maxSerializationLevel;
        for (const result of results) {
          assert.equal(Checker_GetTypeAtLocation(owner, result.node) === result.links.resolvedType
            && result.links.resolutionFailure === result.cause, true,
          "a suppressed later read preserves the already-completed pair");
        }
      } finally { owner.serializationLevel = saved; }
      const returned = actualNode(current.returns);
      assert.equal(Checker_GetTypeAtLocation(owner, returned) !== owner.errorType
        && LinkStore_TryGet(owner.typeNodeLinks, returned)?.resolutionFailure === undefined, true);
      const after = DiagnosticsCollection_GetDiagnostics(owner.diagnostics);
      assert.equal(after.length === before.length && after.every((diagnostic, index) => diagnostic === before[index]), true,
        "repeated paired reads do not emit replacement diagnostics");
      return results.map(result => result.cause);
    });
    const borrowed = createCompilerSessionFromProgram(current.session.program, current.session.host, current.session.config);
    assert.equal(borrowed.program === current.session.program, true);
    borrowed.checkSource();
    const after = current.members();
    assert.equal(after.length === published.length && after.every((member, index) => member === published[index])
      && causes.every(cause => after.includes(cause)), true,
    "FromProgram retains the actual completed answers and original publication identities");
  });

  test(`nonvariable failures and writable reads remain distinct with ${checkers} checkers`, () => {
    const current = open(checkers, "export function fixed():boolean{return true;} fixed=()=>false; export function change():boolean{let value:boolean=true;value=false;return value;}");
    assert.equal(current.assignments.length, 2);
    const published = current.members();
    withOwner(current, owner => {
      for (const node of current.assignments) {
        const type = Checker_GetTypeAtLocation(owner, node);
        const links = LinkStore_TryGet(owner.typeNodeLinks, node);
        if (current.view.ast.text(node) === "fixed") {
          assert.equal(links !== undefined && type === owner.errorType && links.resolvedType === type && links.resolutionFailure !== undefined
            && published.includes(links.resolutionFailure), true, "the nonvariable arm shares the same actual paired owner");
        } else {
          assert.equal(type !== owner.errorType && links?.resolutionFailure === undefined, true,
            "a writable assignment never acquires an error answer from its syntax role");
        }
        assert.equal(LinkStore_TryGet(owner.symbolNodeLinks, node)?.resolvedSymbol !== owner.unknownSymbol, true);
      }
      assert.equal(Checker_GetTypeAtLocation(owner, actualNode(current.returns)) !== owner.errorType, true);
    });
    assert.equal(current.members().length === published.length, true);
  });

  test(`speculative and suppressed first failures do not store with ${checkers} checkers`, () => {
    for (const mode of [CheckModeTypeOnly, CheckModeContextual, CheckModeInferential, CheckModeNormal]) {
      const current = open(checkers, "export function store():boolean{const a:boolean=true;a=false;return a;}", true);
      const node = actualNode(current.assignments);
      withOwner(current, owner => {
        const before = DiagnosticsCollection_GetDiagnostics(owner.diagnostics).length;
        const saved = owner.serializationLevel;
        try {
          if (mode === CheckModeNormal) owner.serializationLevel = maxSerializationLevel;
          assert.equal(Checker_checkExpressionEx(owner, node, mode) === owner.errorType, true);
          const links = LinkStore_TryGet(owner.typeNodeLinks, node);
          assert.equal(links?.resolvedType === undefined && links?.resolutionFailure === undefined, true,
            "an uncompleted evaluation stores neither an answer nor an original cause");
          if (mode === CheckModeNormal) assert.equal(DiagnosticsCollection_GetDiagnostics(owner.diagnostics).length === before, true);
        } finally { owner.serializationLevel = saved; }
        assert.equal(Checker_checkExpressionEx(owner, node, CheckModeNormal) === owner.errorType, true);
        const completed = LinkStore_TryGet(owner.typeNodeLinks, node);
        assert.equal(completed !== undefined && completed.resolvedType === owner.errorType && completed.resolutionFailure !== undefined, true,
          "a later actual Normal evaluation may establish its own complete pair");
        const count = DiagnosticsCollection_GetDiagnostics(owner.diagnostics).length;
        assert.equal(Checker_GetTypeAtLocation(owner, node) === completed?.resolvedType
          && DiagnosticsCollection_GetDiagnostics(owner.diagnostics).length === count, true);
      });
    }
  });

  test(`actual transient loop evaluation cannot publish a stored failure with ${checkers} checkers`, () => {
    const current = open(checkers, "export function store(flag:boolean):boolean{const a:boolean=true;let value:boolean=false;while(flag){value=!value;}a=false;return value;}", true);
    const node = actualNode(current.assignments.filter(candidate => current.view.ast.text(candidate) === "a"));
    withOwner(current, owner => {
      const stack = owner.flowLoopStack;
      const original = stack.push;
      assert.equal(Object.hasOwn(stack, "push"), false);
      let observed = 0;
      stack.push = function (...entries) {
        const length = original.apply(this, entries);
        observed++;
        assert.equal(owner.flowLoopStack === this && this.length !== 0 && entries.length !== 0, true,
          "the native flow engine supplies the actual in-progress loop state");
        assert.equal(Checker_checkExpressionEx(owner, node, CheckModeNormal) === owner.errorType, true);
        const links = LinkStore_TryGet(owner.typeNodeLinks, node);
        assert.equal(links?.resolvedType === undefined && links?.resolutionFailure === undefined, true,
          "a real transient loop does not supply a completed failure lifetime");
        return length;
      };
      try { Checker_GetTypeAtLocation(owner, actualNode(current.returns)); }
      finally { Reflect.deleteProperty(stack, "push"); }
      assert.equal(stack.push === original, true);
      assert.equal(observed > 0 && owner.flowLoopStack.length === 0, true,
        "the actual loop was exercised and its native stack drained");
      assert.equal(Checker_checkExpressionEx(owner, node, CheckModeNormal) === owner.errorType, true);
      const completed = LinkStore_TryGet(owner.typeNodeLinks, node);
      assert.equal(completed !== undefined && completed.resolvedType === owner.errorType && completed.resolutionFailure !== undefined, true);
    });
  });
}
