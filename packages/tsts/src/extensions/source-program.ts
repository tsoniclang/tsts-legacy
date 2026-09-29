import type { GoPtr } from "../go/compat.js";
import type { Context } from "../go/context.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import {
  Program_GetDefaultResolutionModeForFile,
  Program_GetSourceFileForResolvedModule,
  Program_GetSourceFile,
  Program_GetSourceFiles,
  Program_ResolveModuleName,
  type Program,
} from "../internal/compiler/program.js";
import { ResolvedModule_IsResolved } from "../internal/module/types.js";
import { createAstReader, type AstReader } from "../services/ast-reader.js";
import { createTypeCheckerQueries, type TypeCheckerQueries } from "../services/type-checker.js";
import { createTypeShapeQueries, type TypeShapeQueries } from "../services/type-shape.js";
import type { ExtensionDiagnostic } from "./host.js";
import type { ReadonlySourceFactResolver } from "./consumer.js";

export interface SourceFileQueries {
  readonly sourceFile: SourceFile;
  readonly ast: AstReader;
  readonly checker: TypeCheckerQueries;
  readonly typeShape: TypeShapeQueries;
}

export interface SourceProgramQueries {
  readonly ast: AstReader;
  readonly getSourceFiles: () => readonly GoPtr<SourceFile>[];
  readonly getSourceFile: (fileName: string) => GoPtr<SourceFile>;
  readonly getSourceFileQueries: (sourceFile: GoPtr<SourceFile>) => SourceFileQueries;
  readonly resolveModuleSourceFile: (moduleSpecifier: GoPtr<Node>) => GoPtr<SourceFile>;
}

export interface CheckedSourceProgram extends SourceProgramQueries {
  readonly program: Program;
  readonly sourceFiles: readonly GoPtr<SourceFile>[];
  readonly sourceFacts: ReadonlySourceFactResolver;
  readonly diagnostics: readonly GoPtr<Diagnostic>[];
  readonly extensionDiagnostics: readonly ExtensionDiagnostic[];
}

export interface CreateSourceProgramQueriesOptions {
  readonly context?: Context;
  readonly includeSourceFile?: (sourceFile: SourceFile) => boolean;
  readonly ast?: AstReader;
}

export function createSourceProgramQueries(
  program: GoPtr<Program>,
  options: CreateSourceProgramQueriesOptions = {},
): SourceProgramQueries {
  if (program === undefined) {
    throw new Error("Source program queries require a compiler program.");
  }
  const ast = options.ast ?? createAstReader();
  const sourceFileQueries = new WeakMap<SourceFile, SourceFileQueries>();
  const moduleSourceFiles = new WeakMap<Node, SourceFile | null>();
  const included = (sourceFile: SourceFile): boolean => options.includeSourceFile?.(sourceFile) !== false;
  const getSourceFiles = (): readonly GoPtr<SourceFile>[] =>
    (Program_GetSourceFiles(program) ?? []).filter((sourceFile) =>
      sourceFile !== undefined && included(sourceFile));
  const getSourceFile = (fileName: string): GoPtr<SourceFile> => {
    const sourceFile = Program_GetSourceFile(program, fileName);
    return sourceFile !== undefined && included(sourceFile)
      ? sourceFile
      : undefined;
  };
  const getSourceFileQueries = (sourceFile: GoPtr<SourceFile>): SourceFileQueries => {
    if (sourceFile === undefined || !included(sourceFile)) {
      throw new Error("Source-file queries require an included source file from the checked program.");
    }
    const existing = sourceFileQueries.get(sourceFile);
    if (existing !== undefined) {
      return existing;
    }
    const sourceChecker = createTypeCheckerQueries(program, {
      ...(options.context === undefined ? {} : { context: options.context }),
      sourceFile,
    });
    const sourceTypeShape = createTypeShapeQueries(program, {
      ...(options.context === undefined ? {} : { context: options.context }),
      sourceFile,
    });
    const created = Object.freeze({
      sourceFile,
      ast,
      checker: sourceChecker,
      typeShape: sourceTypeShape,
    });
    sourceFileQueries.set(sourceFile, created);
    return created;
  };
  const resolveModuleSourceFile = (moduleSpecifier: GoPtr<Node>): GoPtr<SourceFile> => {
    if (moduleSpecifier === undefined) {
      return undefined;
    }
    const kind = ast.kindName(moduleSpecifier);
    const containingSourceFile = ast.getSourceFile(moduleSpecifier);
    if ((kind !== "KindStringLiteral" && kind !== "KindNoSubstitutionTemplateLiteral") ||
      containingSourceFile === undefined || !included(containingSourceFile)) {
      return undefined;
    }
    const cached = moduleSourceFiles.get(moduleSpecifier);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const resolutionMode = Program_GetDefaultResolutionModeForFile(
      program,
      containingSourceFile,
    );
    const resolved = Program_ResolveModuleName(
      program,
      ast.text(moduleSpecifier),
      ast.getFileName(containingSourceFile),
      resolutionMode,
    );
    const sourceFile = ResolvedModule_IsResolved(resolved)
      ? Program_GetSourceFileForResolvedModule(program, resolved!.ResolvedFileName)
      : undefined;
    const selected = sourceFile !== undefined && included(sourceFile)
      ? sourceFile
      : undefined;
    moduleSourceFiles.set(moduleSpecifier, selected ?? null);
    return selected;
  };
  return Object.freeze({
    ast,
    getSourceFiles,
    getSourceFile,
    getSourceFileQueries,
    resolveModuleSourceFile,
  });
}
