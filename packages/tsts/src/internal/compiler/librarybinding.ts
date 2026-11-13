import { Set_Has } from "../collections/set.js";
import { LibFilesSet, Libs } from "../tsoptions/enummaps.js";
import { CombinePaths, GetNormalizedAbsolutePath, ToPath } from "../tspath/path.js";
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
  for (const name of [...selected.keys()].sort()) {
    // Only GetLibFileName's results are ever looked up, so any other key could never take effect.
    if (!Set_Has(LibFilesSet, name)) {
      throw new TypeError(`Selected library '${name}' is not a library file name of the compiler.`);
    }
    const fileName = GetNormalizedAbsolutePath(selected.get(name)!, currentDirectory);
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
  let first = names[0]!;
  for (const name of names) {
    if (libraryNamePriority(name) < libraryNamePriority(first)) {
      first = name;
    }
  }
  return first;
}
