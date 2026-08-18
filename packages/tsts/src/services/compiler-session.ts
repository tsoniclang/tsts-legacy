import type { GoPtr, GoSlice } from "../go/compat.js";
import { Background } from "../go/context.js";
import type { Context } from "../go/context.js";
import type { SourceFile } from "../internal/ast/ast.js";
import { SourceFile_FileName } from "../internal/ast/ast.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import type { CompilerOptions } from "../internal/core/compileroptions.js";
import type { CompilerHost } from "../internal/compiler/host.js";
import {
  NewProgram,
  Program_BindSourceFiles,
  Program_GetBindDiagnostics,
  Program_GetConfigFileParsingDiagnostics,
  Program_GetDeclarationDiagnostics,
  Program_GetGlobalDiagnostics,
  Program_GetProgramDiagnostics,
  Program_GetSemanticDiagnostics,
  Program_GetSourceFile,
  Program_GetSuggestionDiagnostics,
  Program_GetSyntacticDiagnostics,
  Program_getSourceFilesToEmit,
} from "../internal/compiler/program.js";
import type { Program, ProgramOptions } from "../internal/compiler/program.js";
import { GetParsedCommandLineOfConfigFile } from "../internal/tsoptions/tsconfigparsing.js";
import type { ParseConfigHost } from "../internal/tsoptions/tsconfigparsing.js";
import type { ParsedCommandLine } from "../internal/tsoptions/parsedcommandline.js";
import {
  snapshotExtensionHostOptionsForCompilerSession,
  type ExtensionHostOptions,
} from "../extensions/host.js";
import { attachExtensionHost, getExtensionHost } from "../extensions/index.js";
import { finalizeExtensionSemantics } from "../extensions/compiler-integration.js";
import {
  ProviderMaterializationCoordinator,
  type ProviderMaterializationRound,
} from "../extensions/provider-materialization.js";
import { createSourceFactQueries } from "../extensions/consumer.js";
import type { CheckedSourceProgram } from "../extensions/source-program.js";
import { getProviderVirtualArtifactForCompiler } from "../extensions/provider-virtual-internal.js";
import { createCompilerHost, createInMemoryFileSystem } from "./embedding-host.js";
import type { CompilerHostOptions } from "./embedding-host.js";
export type CompilerDiagnosticKind =
  | "config"
  | "program"
  | "global"
  | "syntactic"
  | "bind"
  | "semantic"
  | "suggestion"
  | "declaration"
  | "all";

export interface CompilerSessionOptions {
  readonly programOptions: ProgramOptions;
  readonly extensionHostOptions?: ExtensionHostOptions;
  readonly context?: Context;
}

export interface InMemoryCompilerSessionOptions {
  readonly currentDirectory: string;
  readonly files: ReadonlyMap<string, string> | Record<string, string>;
  readonly rootFiles?: readonly string[];
  readonly configFileName?: string;
  readonly compilerOptions?: Record<string, unknown>;
  readonly extensionHostOptions?: ExtensionHostOptions;
  readonly useCaseSensitiveFileNames?: boolean;
  readonly context?: Context;
}

export interface CompilerSession {
  readonly program: GoPtr<Program>;
  readonly host: CompilerHost;
  readonly config: GoPtr<ParsedCommandLine>;
  readonly getSourceFilesToEmit: (targetSourceFile?: GoPtr<SourceFile>, forceDtsEmit?: boolean) => readonly GoPtr<SourceFile>[];
  readonly ensureBound: () => void;
  readonly ensureChecked: (sourceFile?: GoPtr<SourceFile>) => readonly GoPtr<Diagnostic>[];
  readonly getDiagnostics: (kind?: CompilerDiagnosticKind, sourceFile?: GoPtr<SourceFile>) => readonly GoPtr<Diagnostic>[];
  readonly checkSource: () => CheckedSourceProgram;
}

export function createCompilerSession(options: CompilerSessionOptions): CompilerSession {
  const context = options.context ?? Background();
  return createCompilerSessionForProgramOwner(
    createMaterializingProgramOwner(options.programOptions, options.extensionHostOptions ?? {}, context),
    options.programOptions.Host,
    options.programOptions.Config,
    context,
  );
}

export function createCompilerSessionFromProgram(
  program: GoPtr<Program>,
  host: CompilerHost,
  config: GoPtr<ParsedCommandLine>,
  context: Context = Background(),
): CompilerSession {
  if (program === undefined) {
    throw new Error("Compiler sessions require a compiler program.");
  }
  return createCompilerSessionForProgramOwner(
    createFixedProgramOwner(program, context),
    host,
    config,
    context,
  );
}

interface PreparedCompilerProgram {
  readonly program: Program;
  readonly diagnostics: readonly GoPtr<Diagnostic>[];
  readonly finalizedHost: ReturnType<typeof finalizeExtensionSemantics>;
}

interface CompilerSessionProgramOwner {
  readonly program: Program;
  prepareForSemanticQueries(): void;
  prepareFinalizedProgram(): PreparedCompilerProgram;
}

function createCompilerSessionForProgramOwner(
  owner: CompilerSessionProgramOwner,
  host: CompilerHost,
  config: GoPtr<ParsedCommandLine>,
  context: Context,
): CompilerSession {
  let checkedSourceProgram: CheckedSourceProgram | undefined;
  return {
    get program() {
      return owner.program;
    },
    host,
    config,
    getSourceFilesToEmit: (targetSourceFile, forceDtsEmit = false) => {
      const targetFileName = targetSourceFile === undefined ? undefined : SourceFile_FileName(targetSourceFile);
      owner.prepareForSemanticQueries();
      const currentTargetSourceFile = targetFileName === undefined
        ? undefined
        : requireCurrentSourceFile(owner.program, targetFileName);
      return (Program_getSourceFilesToEmit(owner.program, currentTargetSourceFile, forceDtsEmit) ?? [])
        .filter((file) =>
          getProviderVirtualArtifactForCompiler(requireExtensionHost(owner.program).providers, SourceFile_FileName(file))?.kind
          !== "canonical-export-owner");
    },
    ensureBound: () => Program_BindSourceFiles(owner.program),
    ensureChecked: (sourceFile) => {
      const fileName = sourceFile === undefined ? undefined : SourceFile_FileName(sourceFile);
      owner.prepareForSemanticQueries();
      return diagnosticsOrEmpty(Program_GetSemanticDiagnostics(
        owner.program,
        context,
        fileName === undefined ? undefined : requireCurrentSourceFile(owner.program, fileName),
      ));
    },
    getDiagnostics: (kind = "all", sourceFile) => {
      const fileName = sourceFile === undefined ? undefined : SourceFile_FileName(sourceFile);
      if (diagnosticKindRequiresSemanticProgram(kind)) {
        owner.prepareForSemanticQueries();
      }
      return getDiagnostics(
        owner.program,
        context,
        kind,
        fileName === undefined ? undefined : requireCurrentSourceFile(owner.program, fileName),
      );
    },
    checkSource: () => {
      if (checkedSourceProgram !== undefined) {
        return checkedSourceProgram;
      }
      const prepared = owner.prepareFinalizedProgram();
      const finalizedHost = prepared.finalizedHost;
      if (finalizedHost === undefined) {
        throw new Error("Checked source requires an attached source-extension host.");
      }
      const source = finalizedHost.getCompilerQueryContext(context);
      const checked = Object.freeze({
        ...source,
        program: prepared.program,
        sourceFiles: Object.freeze([...source.getSourceFiles()]),
        sourceFacts: createSourceFactQueries(finalizedHost),
        diagnostics: prepared.diagnostics,
        extensionDiagnostics: finalizedHost.diagnostics.all(),
      });
      checkedSourceProgram = checked;
      return checked;
    },
  };
}

function createFixedProgramOwner(program: Program, context: Context): CompilerSessionProgramOwner {
  if (getExtensionHost(program) === undefined) {
    attachExtensionHost(program!);
  }
  return {
    program,
    prepareForSemanticQueries(): void {},
    prepareFinalizedProgram(): PreparedCompilerProgram {
      const diagnostics = Object.freeze([...getDiagnostics(program, context, "all", undefined)]);
      return Object.freeze({
        program,
        diagnostics,
        finalizedHost: finalizeExtensionSemantics(program!),
      });
    },
  };
}

function createMaterializingProgramOwner(
  baseProgramOptions: ProgramOptions,
  baseExtensionHostOptions: ExtensionHostOptions,
  context: Context,
): CompilerSessionProgramOwner {
  const coordinator = new ProviderMaterializationCoordinator();
  const extensionHostOptionsSnapshot = snapshotExtensionHostOptionsForCompilerSession(
    baseExtensionHostOptions,
  );
  let state = createProgramMaterializationRound(
    coordinator,
    baseProgramOptions,
    extensionHostOptionsSnapshot,
  );
  let finalized: PreparedCompilerProgram | undefined;
  const rebuildForPendingDemands = (): boolean => {
    if (!state.round.hasPendingDemands()) {
      return false;
    }
    if (!coordinator.finishRound(state.round)) {
      throw new Error("Provider materialization recorded demands without monotonic progress.");
    }
    state = createProgramMaterializationRound(
      coordinator,
      baseProgramOptions,
      extensionHostOptionsSnapshot,
    );
    return true;
  };
  const prepareForSemanticQueries = (): void => {
    if (finalized !== undefined || !state.round.hasIncrementalProvider()) {
      return;
    }
    while (true) {
      getDiagnostics(state.program, context, "all", undefined);
      if (!rebuildForPendingDemands()) {
        return;
      }
    }
  };
  const owner: CompilerSessionProgramOwner = {
    get program() {
      return state.program;
    },
    prepareForSemanticQueries,
    prepareFinalizedProgram(): PreparedCompilerProgram {
      if (finalized !== undefined) {
        return finalized;
      }
      while (true) {
        const diagnostics = Object.freeze([...getDiagnostics(state.program, context, "all", undefined)]);
        if (rebuildForPendingDemands()) {
          continue;
        }
        const finalizedHost = finalizeExtensionSemantics(state.program!);
        if (rebuildForPendingDemands()) {
          continue;
        }
        coordinator.seal(state.round);
        finalized = Object.freeze({
          program: state.program,
          diagnostics,
          finalizedHost,
        });
        return finalized;
      }
    },
  };
  return owner;
}

interface ProgramMaterializationRoundState {
  readonly program: Program;
  readonly round: ProviderMaterializationRound;
}

function createProgramMaterializationRound(
  coordinator: ProviderMaterializationCoordinator,
  baseProgramOptions: ProgramOptions,
  baseExtensionHostOptions: ExtensionHostOptions,
): ProgramMaterializationRoundState {
  const extensionHostOptions = Object.freeze({ ...baseExtensionHostOptions });
  const round = coordinator.beginRound(extensionHostOptions);
  const programOptions = { ...baseProgramOptions };
  attachExtensionHost(programOptions, extensionHostOptions);
  const program = NewProgram(programOptions);
  if (program === undefined) {
    throw new Error("Compiler sessions require a compiler program.");
  }
  return Object.freeze({ program, round });
}

function requireExtensionHost(program: Program) {
  const extensionHost = getExtensionHost(program);
  if (extensionHost === undefined) {
    throw new Error("Compiler session lost its attached source-extension host.");
  }
  return extensionHost;
}

function requireCurrentSourceFile(program: Program, fileName: string): GoPtr<SourceFile> {
  const sourceFile = Program_GetSourceFile(program, fileName);
  if (sourceFile === undefined) {
    throw new Error(`Compiler session rebuild removed requested source file '${fileName}'.`);
  }
  return sourceFile;
}

function diagnosticKindRequiresSemanticProgram(kind: CompilerDiagnosticKind): boolean {
  return kind === "semantic"
    || kind === "suggestion"
    || kind === "declaration"
    || kind === "all";
}

export function createCompilerSessionFromFiles(options: InMemoryCompilerSessionOptions): CompilerSession {
  const configFileName = options.configFileName ?? `${options.currentDirectory}/tsconfig.json`;
  const files = options.files instanceof Map ? new Map(options.files) : new Map(Object.entries(options.files));
  if (!files.has(configFileName)) {
    files.set(configFileName, JSON.stringify({
      compilerOptions: options.compilerOptions ?? {},
      files: options.rootFiles ?? inferRootFiles(options.currentDirectory, files),
    }));
  }
  const fileSystem = createInMemoryFileSystem({
    files,
    ...(options.useCaseSensitiveFileNames !== undefined ? { useCaseSensitiveFileNames: options.useCaseSensitiveFileNames } : {}),
  });
  const host = createCompilerHost({
    currentDirectory: options.currentDirectory,
    fileSystem,
  } satisfies CompilerHostOptions);
  const defaultOptions = {} as CompilerOptions;
  const [config, configErrors] = GetParsedCommandLineOfConfigFile(configFileName, defaultOptions, undefined, host as ParseConfigHost, undefined);
  if ((configErrors ?? []).length !== 0) {
    const programOptions = { Config: config, Host: host } satisfies ProgramOptions;
    return createCompilerSession({
      programOptions,
      ...(options.extensionHostOptions !== undefined ? { extensionHostOptions: options.extensionHostOptions } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    });
  }
  return createCompilerSession({
    programOptions: {
      Config: config,
      Host: host,
    },
    ...(options.extensionHostOptions !== undefined ? { extensionHostOptions: options.extensionHostOptions } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
  });
}

function getDiagnostics(program: GoPtr<Program>, context: Context, kind: CompilerDiagnosticKind, sourceFile: GoPtr<SourceFile>): GoSlice<GoPtr<Diagnostic>> {
  switch (kind) {
    case "config":
      return diagnosticsOrEmpty(Program_GetConfigFileParsingDiagnostics(program));
    case "program":
      return diagnosticsOrEmpty(Program_GetProgramDiagnostics(program));
    case "global":
      return diagnosticsOrEmpty(Program_GetGlobalDiagnostics(program, context));
    case "syntactic":
      return diagnosticsOrEmpty(Program_GetSyntacticDiagnostics(program, context, sourceFile));
    case "bind":
      return diagnosticsOrEmpty(Program_GetBindDiagnostics(program, context, sourceFile));
    case "semantic":
      return diagnosticsOrEmpty(Program_GetSemanticDiagnostics(program, context, sourceFile));
    case "suggestion":
      return diagnosticsOrEmpty(Program_GetSuggestionDiagnostics(program, context, sourceFile));
    case "declaration":
      return diagnosticsOrEmpty(Program_GetDeclarationDiagnostics(program, context, sourceFile));
    case "all":
      return [
        ...diagnosticsOrEmpty(Program_GetConfigFileParsingDiagnostics(program)),
        ...diagnosticsOrEmpty(Program_GetProgramDiagnostics(program)),
        ...diagnosticsOrEmpty(Program_GetGlobalDiagnostics(program, context)),
        ...diagnosticsOrEmpty(Program_GetSyntacticDiagnostics(program, context, sourceFile)),
        ...diagnosticsOrEmpty(Program_GetBindDiagnostics(program, context, sourceFile)),
        ...diagnosticsOrEmpty(Program_GetSemanticDiagnostics(program, context, sourceFile)),
      ];
  }
}

function diagnosticsOrEmpty(
  diagnostics: GoSlice<GoPtr<Diagnostic>> | undefined,
): GoSlice<GoPtr<Diagnostic>> {
  return diagnostics ?? [];
}

function inferRootFiles(currentDirectory: string, files: ReadonlyMap<string, string>): readonly string[] {
  const rootFiles: string[] = [];
  const prefix = currentDirectory.endsWith("/") ? currentDirectory : `${currentDirectory}/`;
  for (const fileName of files.keys()) {
    if (fileName === `${currentDirectory}/tsconfig.json`) {
      continue;
    }
    if (fileName.startsWith(prefix) && /\.(?:ts|tsx|js|jsx|mts|cts)$/.test(fileName)) {
      rootFiles.push(fileName.slice(prefix.length));
    }
  }
  return rootFiles.sort();
}
