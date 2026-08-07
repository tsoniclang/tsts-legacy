import type { bool } from "../go/scalars.js";
import type { GoPtr } from "../go/compat.js";
import type { SourceFileParseOptions } from "../internal/ast/parseoptions.js";
import type { Message } from "../internal/diagnostics/diagnostics.js";
import { LibPath, WrapFS } from "../internal/bundled/bundled.js";
import { LibNames } from "../internal/bundled/libs_generated.js";
import { NewCachedFSCompilerHost, NewCompilerHost } from "../internal/compiler/host.js";
import type { CompilerHost } from "../internal/compiler/host.js";
import { ScriptKindTS } from "../internal/core/scriptkind.js";
import { ParseSourceFile } from "../internal/parser/parser/statements-declarations.js";
import { GetLibFileName } from "../internal/tsoptions/enummaps.js";
import type { ExtendedConfigCache } from "../internal/tsoptions/tsconfigparsing.js";
import type { FS } from "../internal/vfs/vfs.js";
import { FromMap } from "../internal/vfs/vfstest/vfstest.js";

export type CompilerFileSystem = FS;
export type CompilerTraceCallback = (message: GoPtr<Message>, ...args: readonly unknown[]) => void;

export interface CompilerHostOptions {
  readonly currentDirectory: string;
  readonly fileSystem: CompilerFileSystem;
  readonly defaultLibraryPath?: string;
  readonly extendedConfigCache?: GoPtr<ExtendedConfigCache>;
  readonly trace?: CompilerTraceCallback;
  readonly cacheFileSystem?: boolean;
  readonly includeBundledLibraries?: boolean;
}

export interface InMemoryFileSystemOptions {
  readonly files: ReadonlyMap<string, string> | Record<string, string>;
  readonly useCaseSensitiveFileNames?: boolean;
  readonly includeBundledLibraries?: boolean;
}

export interface BundledLibrarySource {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

const bundledLibraryNames = new Set(LibNames);
const bundledLibrarySources = new Map<string, BundledLibrarySource>();
const bundledLibraryDependencies = new Map<string, readonly string[]>();
const bundledLibraryFileSystem = WrapFS(FromMap(new Map(), false));

export function getBundledLibraryPath(): string {
  return LibPath();
}

export function getBundledLibraryClosure(rootNames: readonly string[]): readonly BundledLibrarySource[] {
  const ordered: BundledLibrarySource[] = [];
  const states = new Map<string, "visiting" | "visited">();
  const visit = (name: string): void => {
    const state = states.get(name);
    if (state === "visited") {
      return;
    }
    if (state === "visiting") {
      throw new Error(`Bundled library dependency cycle contains '${name}'.`);
    }
    states.set(name, "visiting");
    const source = getBundledLibrarySource(name);
    for (const dependency of getBundledLibraryDependencies(source)) {
      visit(dependency);
    }
    states.set(name, "visited");
    ordered.push(source);
  };
  for (const rootName of [...new Set(rootNames)].sort()) {
    visit(rootName);
  }
  return Object.freeze(ordered);
}

function getBundledLibrarySource(name: string): BundledLibrarySource {
  if (!bundledLibraryNames.has(name)) {
    throw new Error(`Unknown bundled library '${name}'.`);
  }
  const cached = bundledLibrarySources.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const path = `${LibPath()}/${name}`;
  const [text, available] = bundledLibraryFileSystem.ReadFile(path);
  if (!available) {
    throw new Error(`Bundled library '${name}' is indexed but unavailable at '${path}'.`);
  }
  const source = Object.freeze({ name, path, text });
  bundledLibrarySources.set(name, source);
  return source;
}

function getBundledLibraryDependencies(source: BundledLibrarySource): readonly string[] {
  const cached = bundledLibraryDependencies.get(source.name);
  if (cached !== undefined) {
    return cached;
  }
  const sourceFile = ParseSourceFile({
    FileName: source.path,
    Path: source.path,
  } satisfies SourceFileParseOptions, source.text, ScriptKindTS);
  if (sourceFile === undefined) {
    throw new Error(`Bundled library '${source.name}' could not be parsed.`);
  }
  const dependencies = sourceFile.LibReferenceDirectives.map((reference) => {
    const [fileName, known] = GetLibFileName(reference!.FileName);
    if (!known || !bundledLibraryNames.has(fileName)) {
      throw new Error(`Bundled library '${source.name}' references unknown library '${reference!.FileName}'.`);
    }
    return fileName;
  });
  const result = Object.freeze([...new Set(dependencies)].sort());
  bundledLibraryDependencies.set(source.name, result);
  return result;
}

export function createInMemoryFileSystem(options: InMemoryFileSystemOptions): CompilerFileSystem {
  const files = options.files instanceof Map ? options.files : new Map(Object.entries(options.files));
  const fs = FromMap(files, (options.useCaseSensitiveFileNames ?? false) as bool);
  return options.includeBundledLibraries === false ? fs : WrapFS(fs);
}

export function withBundledLibraries(fileSystem: CompilerFileSystem): CompilerFileSystem {
  return WrapFS(fileSystem);
}

export function createCompilerHost(options: CompilerHostOptions): CompilerHost {
  const defaultLibraryPath = options.defaultLibraryPath ?? getBundledLibraryPath();
  const trace = options.trace === undefined
    ? undefined
    : ((message: GoPtr<Message>, ...args: unknown[]): void => options.trace?.(message, ...args));
  const fs = options.includeBundledLibraries === false ? options.fileSystem : withBundledLibraries(options.fileSystem);
  return options.cacheFileSystem === false
    ? NewCompilerHost(options.currentDirectory, fs, defaultLibraryPath, options.extendedConfigCache, trace)
    : NewCachedFSCompilerHost(options.currentDirectory, fs, defaultLibraryPath, options.extendedConfigCache, trace);
}
