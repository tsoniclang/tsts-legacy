import type { GoPtr } from "../go/compat.js";
import type { Context } from "../go/context.js";
import type { SourceFile } from "../internal/ast/ast.js";
import { SourceFile_FileName } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Program } from "../internal/compiler/program.js";
import { Program_GetSourceFile, Program_GetTypeCheckerById } from "../internal/compiler/program.js";
import { CheckerLifetimeAPI, WithCheckerLifetime } from "../internal/core/context.js";
import { getExtensionHost } from "../extensions/host.js";

export function withOwnedChecker<Value>(
  program: GoPtr<Program>, sourceFile: GoPtr<SourceFile>, owner: GoPtr<Checker>, context: Context,
  read: (checker: Checker) => Value,
): Value | undefined {
  if (program === undefined || sourceFile === undefined || owner === undefined ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) return undefined;
  const [selected, release] = Program_GetTypeCheckerById(program,
    WithCheckerLifetime(context, CheckerLifetimeAPI), owner.id);
  try {
    if (selected !== owner) {
      const host = getExtensionHost(program);
      if (host === undefined || host !== getExtensionHost(owner.program)) return undefined;
    }
    return read(owner);
  } finally { release(); }
}
