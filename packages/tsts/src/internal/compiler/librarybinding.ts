import { Set_Has } from "../collections/set.js";
import { LibFilesSet, Libs } from "../tsoptions/enummaps.js";
import { CombinePaths, DirectorySeparator, GetNormalizedAbsolutePath, RemoveTrailingDirectorySeparator, ToPath } from "../tspath/path.js";
import type { Path } from "../tspath/path.js";
import type { ProgramOptions } from "./program.js";

/**
 * Which file of a program is the library of a given library file name (as GetLibFileName gives it). One binding is
 * derived per program, when its file loader is made, and the loader, the library sort, the library records and the
 * source import preparation all ask it.
 *
 * - `directory`: ordinary input. The library file of a name is that name in the host's default library directory,
 *   as the loader has always taken it.
 * - `explicit`: the caller selected the library files (ProgramOptions.SelectedLibraries). The map is authoritative,
 *   an empty one included: a name with no entry has no file, and the default directory is not consulted. `names`
 *   is the inverse, by the canonical path of each bound file, holding every name bound to it in ascending order.
 */
export type LibraryBinding =
  | { readonly kind: "directory"; readonly directory: string }
  | {
      readonly kind: "explicit";
      readonly files: ReadonlyMap<string, string>;
      readonly names: ReadonlyMap<Path, readonly string[]>;
    };

/** The one derivation of a program's library binding. */
export function libraryBindingOf(opts: ProgramOptions): LibraryBinding {
  const currentDirectory = opts.Host.GetCurrentDirectory();
  const selected = opts.SelectedLibraries;
  if (selected === undefined) {
    return { kind: "directory", directory: GetNormalizedAbsolutePath(opts.Host.DefaultLibraryPath(), currentDirectory) };
  }
  const useCaseSensitiveFileNames = opts.Host.FS().UseCaseSensitiveFileNames();
  const files = new Map<string, string>();
  const names = new Map<Path, string[]>();
  const entries = [...selected].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  for (const [name, selectedFileName] of entries) {
    // Only GetLibFileName's results are ever looked up, so any other key could never take effect.
    if (!Set_Has(LibFilesSet, name)) {
      throw new TypeError(`Selected library '${name}' is not a library file name of the compiler.`);
    }
    const fileName = GetNormalizedAbsolutePath(selectedFileName, currentDirectory);
    files.set(name, fileName);
    const path = ToPath(fileName, currentDirectory, useCaseSensitiveFileNames);
    const bound = names.get(path);
    if (bound === undefined) {
      names.set(path, [name]);
    } else {
      bound.push(name);
    }
  }
  return { kind: "explicit", files, names };
}

/** The one resolver: the file that is the library of `name`, or undefined when the binding has none. */
export function selectedLibraryFile(binding: LibraryBinding, name: string): string | undefined {
  return binding.kind === "directory" ? CombinePaths(binding.directory, name) : binding.files.get(name);
}

/** In the explicit kind, the names bound to the file at `path`, in ascending order; undefined when none is. */
export function boundLibraryNames(binding: LibraryBinding, path: Path): readonly string[] | undefined {
  return binding.kind === "explicit" ? binding.names.get(path) : undefined;
}

/**
 * The order of a library file in the program's file list, by its library file name: the rule of
 * fileLoader.getDefaultLibFilePriority (lib.d.ts and lib.es6.d.ts first, then the order of Libs, then the rest).
 */
export function libraryNamePriority(name: string): number {
  if (name === "lib.d.ts" || name === "lib.es6.d.ts") {
    return 0;
  }
  const withoutPrefix = name.startsWith("lib.") ? name.slice(4) : name;
  const libraryName = withoutPrefix.endsWith(".d.ts") ? withoutPrefix.slice(0, -5) : withoutPrefix;
  const index = Libs.indexOf(libraryName);
  return index !== -1 ? index + 1 : Libs.length + 2;
}

/** Of several names bound to one file (given in ascending order), the one that orders first; a tie keeps the earlier. */
export function firstLibraryName(names: readonly string[]): string {
  const initial = names[0];
  if (initial === undefined) {
    throw new Error("Invariant: a file in the library binding's inverse has at least one bound name.");
  }
  let first = initial;
  for (const name of names) {
    if (libraryNamePriority(name) < libraryNamePriority(first)) {
      first = name;
    }
  }
  return first;
}

/**
 * The order of a file among the program's library files, by the program's library binding. Directory kind: the
 * file directly in the default library directory is ordered by its base name (the rule of
 * fileLoader.getDefaultLibFilePriority); selected library files: by the names bound to the file's path. Any other
 * file orders after every library.
 */
export function boundLibraryPriority(binding: LibraryBinding, fileName: string, path: Path): number {
  if (binding.kind === "explicit") {
    const names = binding.names.get(path);
    return names === undefined ? Libs.length + 2 : libraryNamePriority(firstLibraryName(names));
  }
  // The directory and the file name are absolute and normalized; a prefix check suffices.
  const directory = RemoveTrailingDirectorySeparator(binding.directory);
  if (fileName.startsWith(directory) && fileName.length > directory.length && fileName.charCodeAt(directory.length) === DirectorySeparator) {
    return libraryNamePriority(fileName.slice(fileName.lastIndexOf("/") + 1));
  }
  return Libs.length + 2;
}
