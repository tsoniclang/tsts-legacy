import type { GoPtr } from "../go/compat.js";
import type { Context } from "../go/context.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import { Node_ModuleSpecifier } from "../internal/ast/ast.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import type { ResolvedCheckerBackingConstraint } from "../internal/checker/types.js";
import {
  Program_GetDefaultResolutionModeForFile,
  Program_GetResolvedModuleFromModuleSpecifier,
  Program_GetSourceFileForResolvedModule,
  Program_GetSourceFile,
  Program_GetSourceFiles,
  Program_ResolveModuleName,
  type Program,
} from "../internal/compiler/program.js";
import { ResolvedModule_IsResolved, type PackageId } from "../internal/module/types.js";
import { createAstReader, type AstReader } from "../services/ast-reader.js";
import { createTypeCheckerQueries, type TypeCheckerQueries } from "../services/type-checker.js";
import { createTypeShapeQueries, type TypeShapeQueries } from "../services/type-shape.js";
import type { CheckerDiagnosticMembership } from "../internal/checker/checker/source-type-answers.js";
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
  readonly programSourceFiles: readonly SourceFile[];
  readonly containsSourceFile: (sourceFile: GoPtr<SourceFile>) => boolean;
  readonly getSourceFiles: () => readonly GoPtr<SourceFile>[];
  readonly getSourceFile: (fileName: string) => GoPtr<SourceFile>;
  readonly getSourceFileQueries: (sourceFile: GoPtr<SourceFile>) => SourceFileQueries;
  readonly getBackingConstraints: () => readonly ResolvedCheckerBackingConstraint[];
  readonly getCheckedModulePackage: (moduleSpecifier: GoPtr<Node>) => Readonly<PackageId> | undefined;
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
  readonly admitsCheckerDiagnostic?: CheckerDiagnosticMembership;
}

export function createSourceProgramQueries(
  program: GoPtr<Program>,
  options: CreateSourceProgramQueriesOptions = {},
): SourceProgramQueries {
  if (program === undefined) {
    throw new Error("Source program queries require a compiler program.");
  }
  const ast = options.ast ?? createAstReader();
  const programSourceFiles = Object.freeze((Program_GetSourceFiles(program) ?? [])
    .filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined));
  const sourceFileQueries = new WeakMap<SourceFile, SourceFileQueries>();
  const moduleSourceFiles = new WeakMap<Node, SourceFile | null>();
  const included = (sourceFile: SourceFile): boolean => options.includeSourceFile?.(sourceFile) !== false;
  const containsSourceFile = (sourceFile: GoPtr<SourceFile>): boolean =>
    sourceFile !== undefined && Program_GetSourceFile(program, ast.getFileName(sourceFile)) === sourceFile;
  const getSourceFiles = (): readonly GoPtr<SourceFile>[] =>
    programSourceFiles.filter(included);
  const getSourceFile = (fileName: string): GoPtr<SourceFile> => {
    const sourceFile = Program_GetSourceFile(program, fileName);
    return sourceFile !== undefined && included(sourceFile)
      ? sourceFile
      : undefined;
  };
  const getSourceFileQueries = (sourceFile: GoPtr<SourceFile>): SourceFileQueries => {
    if (sourceFile === undefined || !containsSourceFile(sourceFile)) {
      throw new Error("Source-file queries require an exact source file from the checked program.");
    }
    const existing = sourceFileQueries.get(sourceFile);
    if (existing !== undefined) {
      return existing;
    }
    const sourceChecker = createTypeCheckerQueries(program, {
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.admitsCheckerDiagnostic === undefined ? {} : { admitsCheckerDiagnostic: options.admitsCheckerDiagnostic }),
      sourceFile,
    });
    const sourceTypeShape = createTypeShapeQueries(program, {
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.admitsCheckerDiagnostic === undefined ? {} : { admitsCheckerDiagnostic: options.admitsCheckerDiagnostic }),
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
  const getCheckedModulePackage = (moduleSpecifier: GoPtr<Node>): Readonly<PackageId> | undefined => {
    if (moduleSpecifier === undefined) return undefined;
    const kind = ast.kindName(moduleSpecifier);
    const parent = ast.parent(moduleSpecifier);
    const parentKind = ast.kindName(parent);
    const owner = parentKind === "KindLiteralType" ? ast.parent(parent) : undefined;
    const staticReference = (parentKind === "KindImportDeclaration" || parentKind === "KindExportDeclaration")
      ? Node_ModuleSpecifier(parent) === moduleSpecifier
      : parentKind === "KindLiteralType" && ast.as.AsLiteralTypeNode(parent)?.Literal === moduleSpecifier &&
        ast.kindName(owner) === "KindImportType" && ast.as.AsImportTypeNode(owner)?.Argument === parent;
    const file = ast.getSourceFile(moduleSpecifier);
    if (!staticReference || (kind !== "KindStringLiteral" && kind !== "KindNoSubstitutionTemplateLiteral") ||
      file === undefined || !containsSourceFile(file) || !included(file)) return undefined;
    const resolved = Program_GetResolvedModuleFromModuleSpecifier(program, file, moduleSpecifier);
    return resolved?.PackageId.Name ? resolved.PackageId : undefined;
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
    programSourceFiles,
    containsSourceFile,
    getSourceFiles,
    getSourceFile,
    getSourceFileQueries,
    getBackingConstraints() {
      const visited = new Set<readonly ResolvedCheckerBackingConstraint[]>();
      const constraints: ResolvedCheckerBackingConstraint[] = [];
      for (const file of programSourceFiles) {
        const vector = getSourceFileQueries(file).checker.getBackingConstraints();
        if (visited.has(vector)) continue;
        visited.add(vector);
        constraints.push(...vector);
      }
      return Object.freeze(constraints);
    },
    getCheckedModulePackage,
    resolveModuleSourceFile,
  });
}
