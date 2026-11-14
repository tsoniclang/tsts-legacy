import assert from "node:assert/strict";
import test from "node:test";
import { createCompilerSessionFromFiles, getDiagnosticRunMembers } from "../index.js";
import { Background } from "../go/context.js";
import { DiagnosticsCollection_GetDiagnosticsForFile, Diagnostic_SetRelatedInfo, NewDiagnostic } from "../internal/ast/diagnostic.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import { Program_GetSourceFile, Program_GetTypeCheckerForFileExclusive, SortAndDeduplicateDiagnostics } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { NewTextRange } from "../internal/core/text.js";
import { Cannot_find_name_0, Did_you_mean_0 } from "../internal/diagnostics/generated/messages.js";

function added(pos: number, name: string): Diagnostic {
  const diagnostic = NewDiagnostic(undefined, NewTextRange(pos, pos + name.length), Cannot_find_name_0, name);
  if (diagnostic === undefined) throw new Error("NewDiagnostic returned nothing.");
  return diagnostic;
}

function sameMembers(published: Diagnostic, expected: readonly Diagnostic[]): boolean {
  const members = getDiagnosticRunMembers(published);
  return members.length === expected.length && members.every((member, index) => member === expected[index]);
}

test("a run of one is published unchanged and stands for itself", () => {
  const only = added(0, "a");
  const other = added(10, "b");
  const published = SortAndDeduplicateDiagnostics([only, other]);
  assert.ok(published.length === 2 && published[0] === only && published[1] === other, "both added diagnostics are published as they are");
  assert.ok(only.runMembers === undefined, "a run of one carries no member list");
  assert.ok(sameMembers(only, [only]), "a run of one is its own only member");
});

test("a run of equal diagnostics without related information is published as a clone carrying every added member", () => {
  const first = added(0, "a");
  const second = added(0, "a");
  const third = added(0, "a");
  const published = SortAndDeduplicateDiagnostics([first, second, third]);
  assert.ok(published.length === 1, "one published diagnostic for the run");
  const [clone] = published;
  assert.ok(clone !== undefined && clone !== first && clone !== second && clone !== third, "the published diagnostic is a clone, not an added object");
  assert.ok(clone!.code === first.code && clone!.loc.pos === first.loc.pos && clone!.loc.end === first.loc.end, "the clone has the run's code and range");
  assert.ok(sameMembers(clone!, [first, second, third]), "the clone's members are the three added objects in order");
  assert.ok(first.runMembers === undefined && second.runMembers === undefined, "no added object is written");
});

test("a run whose members carry related information merges it on the clone and keeps every member", () => {
  const first = added(0, "a");
  const second = added(0, "a");
  const hint = NewDiagnostic(undefined, NewTextRange(20, 21), Did_you_mean_0, "b");
  Diagnostic_SetRelatedInfo(second, [hint]);
  const published = SortAndDeduplicateDiagnostics([first, second]);
  assert.ok(published.length === 1, "one published diagnostic for the run");
  const [clone] = published;
  assert.ok(clone !== first && clone !== second, "the published diagnostic is a clone");
  assert.ok(clone!.relatedInformation.length === 1 && clone!.relatedInformation[0] === hint, "the related information is merged on the clone");
  const members = getDiagnosticRunMembers(clone!);
  assert.ok(members.length === 2 && members.includes(first) && members.includes(second), "both added objects are members, in the run's sorted order");
  assert.ok(first.relatedInformation.length === 0, "the first added object is not written");
});

test("deduplicating an already published clone again keeps its members and flattens them with new ones", () => {
  const first = added(0, "a");
  const second = added(0, "a");
  const [clone] = SortAndDeduplicateDiagnostics([first, second]);
  const later = added(0, "a");
  const again = SortAndDeduplicateDiagnostics([clone!, later]);
  assert.ok(again.length === 1, "one published diagnostic");
  assert.ok(sameMembers(again[0]!, [first, second, later]), "the earlier clone contributes its members, not itself");
  const reread = SortAndDeduplicateDiagnostics([again[0]!]);
  assert.ok(reread.length === 1 && reread[0] === again[0], "a published clone alone is a run of one and is kept as it is");
  assert.ok(sameMembers(reread[0]!, [first, second, later]), "its members survive the second read");
});

test("every raw report of a checked file belongs to exactly one published diagnostic of that file", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: { "/src/index.ts": "import first, { second } from './missing.js';\nexport const use = [first, second, unknownName, unknownName];\n" },
    compilerOptions: { noLib: true, strict: true, module: "esnext", target: "es2022" },
  });
  const published = session.getDiagnostics("all");
  const file = Program_GetSourceFile(session.program, "/src/index.ts");
  assert.ok(file !== undefined, "the checked file is in the program");
  const [checker, done] = Program_GetTypeCheckerForFileExclusive(session.program, WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), file);
  let raw: readonly (Diagnostic | undefined)[];
  try {
    raw = DiagnosticsCollection_GetDiagnosticsForFile(checker!.diagnostics, "/src/index.ts") ?? [];
  } finally {
    done();
  }
  assert.ok(raw.length > 0 && published.length > 0, "the file has raw and published diagnostics");
  const owners = raw.map(report => published.filter(diagnostic => diagnostic !== undefined && getDiagnosticRunMembers(diagnostic).includes(report!)).length);
  assert.ok(owners.every(count => count === 1), "each raw report is a member of exactly one published diagnostic");
  const readAgain = session.getDiagnostics("all");
  assert.ok(raw.every(report => readAgain.some(diagnostic => diagnostic !== undefined && getDiagnosticRunMembers(diagnostic).includes(report!))),
    "a second read keeps the relation for that read's published objects");
});
