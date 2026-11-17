import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { getDiagnosticRunMembers } from "./diagnostic-run-members.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Background } from "../go/context.js";
import { AsBinaryExpression } from "../internal/ast/generated/casts.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", includeBundledLibraries: false,
    files: { "/answers/core.d.ts": testCoreDeclarations,
      "/answers/use.ts": "export function store():boolean{const fixed:boolean=true;fixed=false;fixed=true;return fixed;}"
        + "export function writable(value:boolean):boolean{value=false;return value;}export const unrelated:Missing=1;",
      "/answers/reader.ts": "export const reader=1;", "/answers/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/use.ts");
  const readerFile = checked.getSourceFile("/answers/reader.ts");
  const program = session.program;
  if (file === undefined || readerFile === undefined || program === undefined)
    throw new Error("The real original source and reader belong to the same checked Program");
  assert.equal(program.compilerCheckerPool?.checkers.length, checkers);
  const source = checked.getSourceFileQueries(file);
  const reader = checked.getSourceFileQueries(readerFile);
  const binaries = findNodes(file, source.ast.children, source.ast.is.IsBinaryExpression);
  assert.equal(binaries.length, 3);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    if (root === undefined) throw new Error("The actual published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  assert.equal(createCompilerSessionFromProgram(program, session.host, session.config).program === program, true);
  return { session, source, reader, program, file, binaries, members };
}

for (const checkers of [1, 4]) test(`public node, storage and delegated contextual answers keep one original owner with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const published = current.members();
  const causes = [];
  for (const queries of [current.source, current.reader]) for (const node of current.binaries) {
    const binary = AsBinaryExpression(node);
    if (binary?.Left === undefined || binary.Right === undefined) throw new Error("The actual assignment has both operands");
    const answer = queries.checker.getTypeAtLocation(binary.Left);
    const storage = queries.checker.getResolvedStorageInfo(binary.Left);
    const contextual = queries.checker.getContextualType(binary.Right);
    if (answer === undefined || storage === undefined || contextual === undefined)
      throw new Error("The same checked assignment supplies all three native answers");
    assert.equal("flags" in answer, false, "The naked Type API is replaced, not retained as an overload");
    const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.program,
      WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), current.file);
    try { assert.equal(answer.type.checker === owner && contextual.type.checker === owner, true); }
    finally { release(); }
    assert.equal(storage.type.type === answer.type && storage.type.cause === answer.cause, true,
      "Storage consumes the same actual type/cause pair, not an independent error resolver");
    if (current.source.ast.text(binary.Left) === "fixed") {
      assert.equal(current.source.typeShape.isError(answer.type) && answer.cause !== undefined, true);
      assert.equal(answer.cause !== undefined && published.includes(answer.cause), true,
        "The cause is the original published native diagnostic object");
      assert.equal(contextual.type === answer.type && contextual.cause === answer.cause, true,
        "Only the actual delegated contextual branch transports its input's original cause");
      causes.push(answer.cause);
      const right = queries.checker.getTypeAtLocation(binary.Right);
      const whole = queries.checker.getTypeAtLocation(node);
      assert.equal(right !== undefined && !queries.typeShape.isError(right.type) && right.cause === undefined, true);
      assert.equal(whole !== undefined && !queries.typeShape.isError(whole.type) && whole.cause === undefined, true,
        "The ordinary RHS and Binary answer cannot borrow the failed LHS's cause");
    } else {
      assert.equal(answer.cause === undefined && contextual.cause === undefined && storage.writable, true);
    }
  }
  assert.equal(causes.length, 4);
  assert.equal(causes[0] !== causes[1] && causes[0] === causes[2] && causes[1] === causes[3], true,
    "Distinct authored failures remain distinct and each wrapper borrows the identical original");
  const after = current.members();
  assert.equal(after.length === published.length && after.every((value, index) => value === published[index]), true,
    "Repeated public reads do not add or replace native diagnostics");
  const foreign = fixture(checkers);
  const foreignNode = foreign.binaries[0];
  assert.equal(current.reader.checker.getTypeAtLocation(foreignNode) === undefined, true);
  assert.equal(current.reader.checker.getContextualType(foreignNode) === undefined, true);
  assert.equal(current.reader.checker.getResolvedStorageInfo(foreignNode) === undefined, true);
});
