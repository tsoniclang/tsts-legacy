import type { GoPtr } from "../go/compat.js";
import type { uint } from "../go/scalars.js";
import type { Context } from "../go/context.js";
import type { SourceFile } from "../internal/ast/ast.js";
import { SourceFile_FileName } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Program } from "../internal/compiler/program.js";
import { Program_GetSourceFile, Program_GetTypeCheckerById, Program_GetTypeCheckerForFile, Program_HasUsableCheckerSession, Program_OfChecker, Program_TerminateCheckerSession } from "../internal/compiler/program.js";
import { CheckerLifetimeAPI, CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { getExtensionHost } from "../extensions/host.js";
import { runNativeCheckerAcquisition, type NativeCheckerAdmission, type NativeCheckerResult } from "../internal/checker/resource-admission.js";

export function withSourceFileChecker<Value>(program: GoPtr<Program>, requester: GoPtr<SourceFile>,
  sourceFile: GoPtr<SourceFile>, context: Context, read: (checker: Checker) => Value): Value | undefined {
  if (program === undefined || requester === undefined || sourceFile === undefined || !Program_HasUsableCheckerSession(program) ||
    Program_GetSourceFile(program, SourceFile_FileName(requester)) !== requester ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) return undefined;
  const [checker, release] = Program_GetTypeCheckerForFile(program, WithCheckerLifetime(context, CheckerLifetimeDiagnostics), sourceFile);
  try { return checker === undefined ? undefined : read(checker); }
  finally { release(); }
}

export function withCheckerById<Value>(
  program: GoPtr<Program>, sourceFile: GoPtr<SourceFile>, checkerId: uint, context: Context,
  read: (checker: Checker) => Value,
): Value | undefined {
  if (program === undefined || sourceFile === undefined || !Program_HasUsableCheckerSession(program) ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) return undefined;
  const [checker, release] = Program_GetTypeCheckerById(program,
    WithCheckerLifetime(context, CheckerLifetimeAPI), checkerId);
  try { return checker !== undefined && checker.id === checkerId ? read(checker) : undefined; }
  finally { release(); }
}

export function withOwnedChecker<Value>(
  program: GoPtr<Program>, sourceFile: GoPtr<SourceFile>, owner: GoPtr<Checker>, context: Context,
  read: (checker: Checker) => Value,
): Value | undefined {
  if (program === undefined || sourceFile === undefined || owner === undefined || !Program_HasUsableCheckerSession(program) ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) return undefined;
  const ownerProgram = Program_OfChecker(owner);
  if (ownerProgram === undefined || !Program_HasUsableCheckerSession(ownerProgram)) return undefined;
  if (ownerProgram !== program) {
    const host = getExtensionHost(program);
    if (host === undefined || host !== getExtensionHost(ownerProgram)) return undefined;
  }
  const [selected, release] = Program_GetTypeCheckerById(ownerProgram,
    WithCheckerLifetime(context, CheckerLifetimeAPI), owner.id);
  try { return selected === owner ? read(selected) : undefined; }
  finally { release(); }
}

export function withOwnedCheckerAcquisition<Value, Stop extends object>(
  program: GoPtr<Program>, sourceFile: GoPtr<SourceFile>, owner: GoPtr<Checker>, context: Context,
  admit: NativeCheckerAdmission<Stop>, read: (checker: Checker) => Value,
): NativeCheckerResult<Value, Stop> {
  return withOwnedChecker(program, sourceFile, owner, context, checker =>
    acquireLeasedChecker(checker, context, admit, () => read(checker))) ?? { kind: "unavailable" };
}

export function acquireLeasedChecker<Value, Stop extends object>(checker: Checker, context: Context,
  admit: NativeCheckerAdmission<Stop>, read: () => Value): NativeCheckerResult<Value, Stop> {
  const producer = Program_OfChecker(checker);
  if (producer === undefined) throw new Error("An acquired checker must retain its originating program.");
  return runNativeCheckerAcquisition(checker, context, admit, () => Program_TerminateCheckerSession(producer, checker), read);
}
