import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, getDiagnosticRunMembers } from "../index.js";
import type { Node } from "../index.js";
import { Background } from "../go/context.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { Checker_resolveEntityName } from "../internal/checker/checker/symbols.js";
import { getTypeReferenceName } from "../internal/checker/checker/state.js";
import { SymbolFlagsType } from "../internal/ast/generated/flags.js";
import { maxSerializationLevel } from "../internal/checker/checker.js";
import { Node_Text } from "../internal/ast/ast.js";

function open(files: Record<string, string>, checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: Object.keys(files),
    compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024", checkers } });
  const checked = session.checkSource();
  const view = (fileName: string) => {
    const sourceFile = checked.getSourceFile(fileName);
    if (sourceFile === undefined) throw new Error("The actual annotation file must belong to its checked program");
    return checked.getSourceFileQueries(sourceFile);
  };
  const annotation = (fileName: string, variableName: string) => {
    const source = view(fileName);
    const pending: Node[] = [source.sourceFile];
    while (pending.length !== 0) {
      const node = pending.pop();
      if (node === undefined) throw new Error("The syntax worklist is dense");
      if (source.ast.kindName(node) === "KindVariableDeclaration" && Node_Text(source.ast.name(node)) === variableName) {
        const type = source.ast.typeNode(node);
        if (type === undefined) throw new Error("The actual declaration has an authored annotation");
        return type;
      }
      source.ast.forEachChild(node, child => { if (child !== undefined) pending.push(child); });
    }
    throw new Error("The authored variable is present");
  };
  const members = () => session.getDiagnostics("all").flatMap(root => {
    if (root === undefined) throw new Error("The actual diagnostic root inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  return { session, checked, view, annotation, members };
}

for (const checkers of [1, 4]) {
  test(`annotation failures retain the actual name-result and file producer with ${checkers} checkers`, () => {
    const current = open({
      "/case/first.mts": "export let first: Missing; export let second: Missing;",
      "/case/second.mts": "export let third: Missing;",
      "/case/reader.mts": "export const unrelated: number = 'wrong';",
    }, checkers);
    const before = current.members();
    const reader = current.view("/case/reader.mts").checker;
    const rows = [["/case/first.mts", "first"], ["/case/first.mts", "second"], ["/case/second.mts", "third"]]
      .map(([fileName, variableName]) => {
        if (fileName === undefined || variableName === undefined) throw new Error("The authored selection is complete");
        const syntax = current.annotation(fileName, variableName);
        const answer = reader.getTypeFromTypeNode(syntax);
        assert.equal(answer !== undefined && answer.cause !== undefined, true, "the failed original answer has its cause");
        if (answer === undefined || answer.cause === undefined) throw new Error("The original failed answer is retained");
        const source = current.view(fileName);
        assert.equal(answer.cause.file === source.sourceFile && before.includes(answer.cause), true,
          "the cause is the exact file and already-published run member, not a site/code match");
        assert.equal(source.typeShape.isError(answer.type), false, "the per-alias native error is not the singleton errorType");
        assert.equal(answer.type !== answer.type.checker!.unresolvedType, true, "the native unresolved alias is not retagged");
        const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.session.program,
          WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), source.sourceFile);
        try {
          assert.equal(answer.type.checker === owner, true, "the answer uses the actual file producer, not the reader API pool");
          Checker_resolveEntityName(owner, getTypeReferenceName(syntax), SymbolFlagsType, true, false, undefined);
        } finally { release(); }
        return { syntax, answer };
      });
    for (const order of [rows, [...rows].reverse()]) for (const row of order) {
      const repeated = reader.getTypeFromTypeNode(row.syntax);
      assert.equal(repeated?.type === row.answer.type && repeated.cause === row.answer.cause, true,
        "quiet and repeated reads preserve the original type and cause without re-emission");
    }
    assert.equal(rows[0]!.answer.cause !== rows[1]!.answer.cause && rows[0]!.answer.cause !== rows[2]!.answer.cause, true,
      "same native alias/name does not merge distinct original failed occurrences");
    const after = current.members();
    assert.equal(after.length === before.length && after.every((member, index) => member === before[index]), true,
      "annotation reads never replace even a deduplicated published diagnostic");
  });

  test(`annotation answer absence and ungrounded errors remain distinct with ${checkers} checkers`, () => {
    const files = { "/case/use.mts": "class Box<Value> {} export let ordinary: any; export let valid: number; export let invalid: Box;" };
    const current = open(files, checkers);
    const source = current.view("/case/use.mts");
    const before = current.members();
    for (const name of ["ordinary", "valid"]) {
      const answer = source.checker.getTypeFromTypeNode(current.annotation("/case/use.mts", name));
      assert.equal(answer !== undefined && answer.cause === undefined && !source.typeShape.isError(answer.type), true,
        "ordinary native any and valid annotations have no invented error cause");
    }
    const ungrounded = source.checker.getTypeFromTypeNode(current.annotation("/case/use.mts", "invalid"));
    assert.equal(ungrounded !== undefined && source.typeShape.isError(ungrounded.type) && ungrounded.cause === undefined, true,
      "another error producer's missing association remains missing, not borrowed from the global run");
    assert.equal(source.checker.getTypeFromTypeNode(undefined) === undefined, true, "absent input is not an error");
    const foreign = open(files, checkers);
    assert.equal(source.checker.getTypeFromTypeNode(foreign.annotation("/case/use.mts", "invalid")) === undefined, true,
      "foreign same-file syntax is rejected before native links or cause access");
    const after = current.members();
    assert.equal(after.length === before.length && after.every((member, index) => member === before[index]), true,
      "valid and unavailable views never add diagnostic guesses");
  });

  test(`annotation re-evaluation retains only actual emitted errors with ${checkers} checkers`, () => {
    const current = open({ "/case/use.mts": "export let missing: UnknownAnnotation;" }, checkers);
    const source = current.view("/case/use.mts");
    const syntax = current.annotation("/case/use.mts", "missing");
    const original = source.checker.getTypeFromTypeNode(syntax);
    assert.equal(original?.cause !== undefined, true, "the original producing error is retained");
    const before = current.members();
    const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.session.program,
      WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), source.sourceFile);
    if (owner === undefined) throw new Error("The actual checked file owns its checker");
    const previous = owner.serializationLevel;
    try {
      owner.serializationLevel = maxSerializationLevel;
      Checker_resolveEntityName(owner, getTypeReferenceName(syntax), SymbolFlagsType, false, false, undefined);
    } finally { owner.serializationLevel = previous; release(); }
    const suppressed = source.checker.getTypeFromTypeNode(syntax);
    assert.equal(suppressed?.type === original?.type && suppressed?.cause === undefined, true,
      "a new suppressed producer clears its old cause and never retains an un-emitted Diagnostic");
    const after = current.members();
    assert.equal(after.length === before.length && after.every((member, index) => member === before[index]), true,
      "suppressed production leaves the original published inventory unchanged");
  });
}
