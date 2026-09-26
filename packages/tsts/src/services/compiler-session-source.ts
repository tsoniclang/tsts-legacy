import {
  SourceFile_IsBound,
  SourceFile_Text,
  type SourceFile,
} from "../internal/ast/ast.js";
import type { CompilerHost } from "../internal/compiler/host.js";
import { ParseSourceFile } from "../internal/parser/parser/statements-declarations.js";

export function createCompilerSessionHost(host: CompilerHost): CompilerHost {
  const acquired = new WeakSet<SourceFile>();
  return Object.freeze({
    FS: () => host.FS(),
    DefaultLibraryPath: () => host.DefaultLibraryPath(),
    GetCurrentDirectory: () => host.GetCurrentDirectory(),
    Trace: (message, ...arguments_) => host.Trace(message, ...arguments_),
    GetResolvedProjectReference: (fileName, path) => host.GetResolvedProjectReference(fileName, path),
    GetSourceFile(options) {
      const sourceFile = host.GetSourceFile(options);
      if (sourceFile === undefined) {
        return undefined;
      }
      const reused = acquired.has(sourceFile) || SourceFile_IsBound(sourceFile);
      acquired.add(sourceFile);
      return reused
        ? ParseSourceFile(options, SourceFile_Text(sourceFile), sourceFile.ScriptKind)
        : sourceFile;
    },
  } satisfies CompilerHost);
}
