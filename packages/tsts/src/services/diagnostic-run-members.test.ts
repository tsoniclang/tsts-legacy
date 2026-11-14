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

// The one diagnostic a deduplication of one run publishes.
function onlyPublished(diagnostics: readonly (Diagnostic | undefined)[]): Diagnostic {
  const [first] = diagnostics;
  if (diagnostics.length !== 1 || first === undefined) throw new Error(`Expected one published diagnostic, got ${diagnostics.length}.`);
  return first;
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
  const clone = onlyPublished(SortAndDeduplicateDiagnostics([first, second, third]));
  assert.ok(clone !== first && clone !== second && clone !== third, "the published diagnostic is a clone, not an added object");
  assert.ok(clone.code === first.code && clone.loc.pos === first.loc.pos && clone.loc.end === first.loc.end, "the clone has the run's code and range");
  assert.ok(sameMembers(clone, [first, second, third]), "the clone's members are the three added objects in order");
  assert.ok(first.runMembers === undefined && second.runMembers === undefined, "no added object is written");
});

test("a run whose members carry related information merges it on the clone and keeps every member", () => {
  const first = added(0, "a");
  const second = added(0, "a");
  const hint = NewDiagnostic(undefined, NewTextRange(20, 21), Did_you_mean_0, "b");
  Diagnostic_SetRelatedInfo(second, [hint]);
  const clone = onlyPublished(SortAndDeduplicateDiagnostics([first, second]));
  assert.ok(clone !== first && clone !== second, "the published diagnostic is a clone");
  assert.ok(clone.relatedInformation.length === 1 && clone.relatedInformation[0] === hint, "the related information is merged on the clone");
  const members = getDiagnosticRunMembers(clone);
  assert.ok(members.length === 2 && members.includes(first) && members.includes(second), "both added objects are members, in the run's sorted order");
  assert.ok(first.relatedInformation.length === 0, "the first added object is not written");
});

test("deduplicating an already published clone again keeps its members and flattens them with new ones", () => {
  const first = added(0, "a");
  const second = added(0, "a");
  const clone = onlyPublished(SortAndDeduplicateDiagnostics([first, second]));
  const later = added(0, "a");
  const again = onlyPublished(SortAndDeduplicateDiagnostics([clone, later]));
  assert.ok(sameMembers(again, [first, second, later]), "the earlier clone contributes its members, not itself");
  const reread = onlyPublished(SortAndDeduplicateDiagnostics([again]));
  assert.ok(reread === again, "a published clone alone is a run of one and is kept as it is");
  assert.ok(sameMembers(reread, [first, second, later]), "its members survive the second read");
});

test("overlapping published clones contribute each shared member once, in first-seen order, without being written", () => {
  const x = added(0, "a");
  const y = added(0, "a");
  const z = added(0, "a");
  const w = added(0, "a");
  const left = onlyPublished(SortAndDeduplicateDiagnostics([x, y]));
  const right = onlyPublished(SortAndDeduplicateDiagnostics([y, z]));
  const leftMembers = left.runMembers;
  const rightMembers = right.runMembers;
  const merged = onlyPublished(SortAndDeduplicateDiagnostics([left, right, w]));
  assert.ok(sameMembers(merged, [x, y, z, w]), "x, y, z, w: the shared y appears once, where it was first seen");
  assert.ok(left.runMembers === leftMembers && right.runMembers === rightMembers, "the input clones keep their own member lists");
  assert.ok(sameMembers(left, [x, y]) && sameMembers(right, [y, z]), "the input clones' members are unchanged");
  assert.ok([x, y, z, w].every(member => member.runMembers === undefined), "no added diagnostic is written");
});

test("a wide run keeps every member once and in order", () => {
  const width = 20000;
  const run: Diagnostic[] = [];
  for (let index = 0; index < width; index++) run.push(added(0, "a"));
  const clone = onlyPublished(SortAndDeduplicateDiagnostics(run));
  assert.ok(sameMembers(clone, run), "all members, in run order");
  const doubled = onlyPublished(SortAndDeduplicateDiagnostics([clone, clone, ...run]));
  assert.ok(sameMembers(doubled, run), "repeating the clone and every member adds no duplicate");
  assert.ok(run.every(member => member.runMembers === undefined), "no added diagnostic is written");
});

test("reading a published run retains its owned member vector without copying", () => {
  const first = added(0, "a");
  const second = added(0, "a");
  const published = onlyPublished(SortAndDeduplicateDiagnostics([first, second]));
  const members = getDiagnosticRunMembers(published);
  assert.ok(members === published.runMembers, "the readonly result is the actual published member vector");
  assert.ok(getDiagnosticRunMembers(published) === members, "repeated reads retain that same vector");
  assert.ok(sameMembers(published, [first, second]), "the vector retains both actual reports in order");
});

test("undefined and sparse run members are rejected rather than omitted", () => {
  const diagnostic = added(0, "a");
  diagnostic.runMembers = [undefined];
  assert.throws(() => getDiagnosticRunMembers(diagnostic), /run members contain an undefined entry/);
  diagnostic.runMembers = [];
  diagnostic.runMembers.length = 1;
  assert.throws(() => getDiagnosticRunMembers(diagnostic), /run members contain an undefined entry/);
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
    if (checker === undefined) throw new Error("The checked file has no diagnostics checker.");
    raw = DiagnosticsCollection_GetDiagnosticsForFile(checker.diagnostics, "/src/index.ts") ?? [];
  } finally {
    done();
  }
  const reports = raw.filter((report): report is Diagnostic => report !== undefined);
  assert.ok(reports.length === raw.length && reports.length > 0 && published.length > 0, "the file has raw and published diagnostics");
  assert.ok(published.some(diagnostic => diagnostic !== undefined && diagnostic.file === file && getDiagnosticRunMembers(diagnostic).length >= 2),
    "at least one published diagnostic of the file stands for a run of two or more raw reports");
  const owners = reports.map(report => published.filter(diagnostic => diagnostic !== undefined && getDiagnosticRunMembers(diagnostic).includes(report)).length);
  assert.ok(owners.every(count => count === 1), "each raw report is a member of exactly one published diagnostic");
  const readAgain = session.getDiagnostics("all");
  assert.ok(reports.every(report => readAgain.some(diagnostic => diagnostic !== undefined && getDiagnosticRunMembers(diagnostic).includes(report))),
    "a second read keeps the relation for that read's published objects");
});
