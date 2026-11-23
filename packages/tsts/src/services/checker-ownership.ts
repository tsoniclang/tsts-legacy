import type { GoPtr } from "../go/compat.js";
import type { uint } from "../go/scalars.js";
import type { Context } from "../go/context.js";
import type { SourceFile } from "../internal/ast/ast.js";
import { SourceFile_FileName } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Program } from "../internal/compiler/program.js";
import { Program_GetSourceFile, Program_GetTypeCheckerById, Program_OfChecker } from "../internal/compiler/program.js";
import { CheckerLifetimeAPI, WithCheckerLifetime } from "../internal/core/context.js";
import { getExtensionHost } from "../extensions/host.js";

export function withCheckerById<Value>(
  program: GoPtr<Program>, sourceFile: GoPtr<SourceFile>, checkerId: uint, context: Context,
  read: (checker: Checker) => Value,
): Value | undefined {
  if (program === undefined || sourceFile === undefined ||
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
  if (program === undefined || sourceFile === undefined || owner === undefined ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) return undefined;
  const ownerProgram = Program_OfChecker(owner);
  if (ownerProgram === undefined) return undefined;
  if (ownerProgram !== program) {
    const host = getExtensionHost(program);
    if (host === undefined || host !== getExtensionHost(ownerProgram)) return undefined;
  }
  const [selected, release] = Program_GetTypeCheckerById(ownerProgram,
    WithCheckerLifetime(context, CheckerLifetimeAPI), owner.id);
  try { return selected === owner ? read(selected) : undefined; }
  finally { release(); }
}
