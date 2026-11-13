import type { FileReference, Node } from "../internal/ast/ast.js";
import { Node_Text, SourceFile_Diagnostics, SourceFile_FileName, SourceFile_GetPositionMap, SourceFile_Imports, SourceFile_JSDiagnostics, SourceFile_JSDocDiagnostics, SourceFile_Path, SourceFile_as_ast_HasFileName } from "../internal/ast/ast.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import { PositionMap_UTF8ToUTF16 } from "../internal/ast/positionmap.js";
import { IsExportDeclaration, IsExternalModuleReference, IsImportDeclaration, IsImportEqualsDeclaration, IsImportTypeNode, IsJSImportDeclaration, IsLiteralTypeNode, IsModuleBlock, IsModuleDeclaration, IsSourceFile } from "../internal/ast/generated/predicates.js";
import { Node_End } from "../internal/ast/spine.js";
import { IsAmbientModule, IsImportCall, IsRequireCall, WalkUpParenthesizedExpressions } from "../internal/ast/utilities.js";
import { getModeForTypeReferenceDirectiveInFile, getModeForUsageLocation, processAllProgramFiles } from "../internal/compiler/fileloader.js";
import type { CompilerHost } from "../internal/compiler/host.js";
import { projectReferenceFileMapper_getCompilerOptionsForFile } from "../internal/compiler/projectreferencefilemapper.js";
import type { ResolutionMode } from "../internal/core/compileroptions.js";
import { ResolutionModeCommonJS, ResolutionModeESM } from "../internal/core/compileroptions.js";
import { TextRange_End, TextRange_Pos } from "../internal/core/text.js";
import { GetTokenPosOfNode } from "../internal/scanner/scanner.js";
import { GetLibFileName } from "../internal/tsoptions/enummaps.js";
import type { ParsedCommandLine } from "../internal/tsoptions/parsedcommandline.js";
import { ParsedCommandLine_FileNames, ParsedCommandLine_GetConfigFileParsingDiagnostics } from "../internal/tsoptions/parsedcommandline.js";
import { ResolveTripleslashReference, ToPath } from "../internal/tspath/path.js";

export interface SourceImportPreparationInput {
  readonly host: CompilerHost;
  readonly config: ParsedCommandLine;
}

type SourceReferenceSyntax =
  | { readonly kind: "import" | "export"; readonly placement: "statement" | "ambient-module" }
  | { readonly kind: "import-type" | "require"; readonly placement: "statement" | "ambient-module" | "expression" }
  | { readonly kind: "dynamic-import"; readonly placement: "expression" }
  | { readonly kind: "reference-path" | "reference-types" | "reference-lib"; readonly placement: "directive" };

export type SourceImportPreparationReference = SourceReferenceSyntax & {
  readonly specifier: string;
  // UTF-16 code-unit offset and length in the source file's text as the SDK parsed it,
  // the same unit and text as AstReader.authoredRange and AstReader.sourceRange. That text is what the
  // file system delivers, which is the original document without its first leading byte-order mark and,
  // if a second one follows, without that one too; a third and later ones stay in the text and are
  // counted. The offset in the original document is therefore larger by the number of units removed:
  // the original's length minus the delivered text's length (0, 1 or 2), not the number of leading marks.
  readonly start: number;
  readonly length: number;
  readonly mode: "import" | "require" | "none";
  readonly resolution:
    | { readonly kind: "resolved"; readonly fileName: string }
    | { readonly kind: "unresolved" };
};

export interface SourceImportPreparationFile {
  readonly fileName: string;
  readonly declarationFile: boolean;
  readonly references: readonly SourceImportPreparationReference[];
}

export interface SourceImportPreparation {
  readonly roots: readonly { readonly fileName: string; readonly state: "loaded" | "missing" }[];
  readonly files: readonly SourceImportPreparationFile[];
  readonly diagnostics: readonly Diagnostic[];
}

function statementPlacement(statement: Node): "statement" | "ambient-module" {
  const owner = statement.Parent;
  if (owner === undefined) throw new Error("The parser returned a source-import statement without its parent.");
  if (IsSourceFile(owner)) return "statement";
  const declaration = owner.Parent;
  if (IsModuleBlock(owner) && declaration !== undefined && IsModuleDeclaration(declaration) && IsAmbientModule(declaration)) return "ambient-module";
  throw new Error("The parser returned a source-import statement outside its source file or ambient module.");
}

function referenceSyntax(node: Node): SourceReferenceSyntax {
  const parent = node.Parent;
  if (parent === undefined) throw new Error("The parser returned a source-import occurrence without its parent.");
  if (IsImportDeclaration(parent)) return { kind: "import", placement: statementPlacement(parent) };
  if (IsExportDeclaration(parent)) return { kind: "export", placement: statementPlacement(parent) };
  if (IsJSImportDeclaration(parent)) return { kind: "import-type", placement: statementPlacement(parent) };
  if (IsExternalModuleReference(parent)) {
    const declaration = parent.Parent;
    if (declaration === undefined || !IsImportEqualsDeclaration(declaration)) throw new Error("The parser returned a require reference without an import-equals declaration.");
    return { kind: "require", placement: statementPlacement(declaration) };
  }
  if (IsRequireCall(parent, true)) return { kind: "require", placement: "expression" };
  if (IsImportCall(WalkUpParenthesizedExpressions(parent))) return { kind: "dynamic-import", placement: "expression" };
  if (IsLiteralTypeNode(parent) && IsImportTypeNode(parent?.Parent)) return { kind: "import-type", placement: "expression" };
  throw new Error("The parser returned an unsupported source-import parent.");
}

function referenceMode(mode: ResolutionMode): SourceImportPreparationReference["mode"] {
  if (mode === ResolutionModeCommonJS) return "require";
  if (mode === ResolutionModeESM) return "import";
  return "none";
}

function resolution(fileName: string | undefined): SourceImportPreparationReference["resolution"] {
  return fileName === undefined || fileName === ""
    ? Object.freeze({ kind: "unresolved" })
    : Object.freeze({ kind: "resolved", fileName });
}

export function prepareSourceImports(input: SourceImportPreparationInput): SourceImportPreparation {
  const processed = processAllProgramFiles({ Host: input.host, Config: input.config }, true);
  const files: SourceImportPreparationFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const diagnosticIdentities = new Set<Diagnostic>();
  const addDiagnostic = (diagnostic: Diagnostic | undefined): void => {
    if (diagnostic !== undefined && !diagnosticIdentities.has(diagnostic)) {
      diagnosticIdentities.add(diagnostic);
      diagnostics.push(diagnostic);
    }
  };
  for (const diagnostic of ParsedCommandLine_GetConfigFileParsingDiagnostics(input.config)) addDiagnostic(diagnostic);
  for (const resolutions of processed.resolvedModules.values()) {
    for (const resolved of resolutions?.values() ?? []) {
      for (const diagnostic of resolved?.ResolutionDiagnostics ?? []) addDiagnostic(diagnostic);
    }
  }
  for (const resolutions of processed.typeResolutionsInFile.values()) {
    for (const resolved of resolutions?.values() ?? []) {
      for (const diagnostic of resolved?.ResolutionDiagnostics ?? []) addDiagnostic(diagnostic);
    }
  }
  const canonicalPath = (fileName: string): string => ToPath(fileName,
    input.host.GetCurrentDirectory(), input.host.FS().UseCaseSensitiveFileNames());
  const roots = ParsedCommandLine_FileNames(input.config).map(fileName => Object.freeze({
    fileName,
    state: processed.filesByPath.get(canonicalPath(fileName)) === undefined ? "missing" : "loaded",
  } satisfies SourceImportPreparation["roots"][number]));
  for (const sourceFile of processed.files) {
    if (sourceFile === undefined) throw new Error("The syntax-only file loader returned an absent source file.");
    const fileName = SourceFile_FileName(sourceFile);
    const path = SourceFile_Path(sourceFile);
    const metadata = processed.sourceFileMetaDatas.get(path);
    if (metadata === undefined) throw new Error("The syntax-only file loader omitted source metadata.");
    const options = projectReferenceFileMapper_getCompilerOptionsForFile(
      processed.projectReferenceFileMapper, SourceFile_as_ast_HasFileName(sourceFile));
    const references: SourceImportPreparationReference[] = [];
    const referenceNodes = new Set<Node>();
    // The parser's positions are UTF-8 byte offsets. Both ends of every range are converted
    // through the source file's own position map; a byte length is never used as a length.
    const positionMap = SourceFile_GetPositionMap(sourceFile);
    if (positionMap === undefined) throw new Error("The syntax-only file loader returned a source file without a position map.");
    const utf16Range = (startByte: number, endByte: number): { readonly start: number; readonly length: number } => {
      const start = PositionMap_UTF8ToUTF16(positionMap, startByte);
      return { start, length: PositionMap_UTF8ToUTF16(positionMap, endByte) - start };
    };
    for (const diagnostic of SourceFile_Diagnostics(sourceFile)) addDiagnostic(diagnostic);
    for (const diagnostic of SourceFile_JSDiagnostics(sourceFile) ?? []) addDiagnostic(diagnostic);
    for (const diagnostic of SourceFile_JSDocDiagnostics(sourceFile) ?? []) addDiagnostic(diagnostic);
    for (const node of SourceFile_Imports(sourceFile) ?? []) {
      if (node === undefined) throw new Error("The parser returned an absent source-import occurrence.");
      if (referenceNodes.has(node)) continue;
      referenceNodes.add(node);
      const specifier = Node_Text(node);
      const mode = getModeForUsageLocation(fileName, metadata, node, options);
      const resolved = processed.resolvedModules.get(path)?.get({ Name: specifier, Mode: mode });
      const range = utf16Range(GetTokenPosOfNode(node, sourceFile, false), Node_End(node));
      references.push(Object.freeze({ ...referenceSyntax(node), specifier, start: range.start,
        length: range.length, mode: referenceMode(mode), resolution: resolution(resolved?.ResolvedFileName) }));
    }
    const addReference = (reference: FileReference | undefined,
      kind: "reference-path" | "reference-types" | "reference-lib"): void => {
      if (reference === undefined) throw new Error("The parser returned an absent triple-slash occurrence.");
      let resolvedFileName: string | undefined;
      let mode: SourceImportPreparationReference["mode"] = "none";
      if (kind === "reference-path") {
        const target = ResolveTripleslashReference(reference.FileName, fileName);
        const targetFile = processed.filesByPath.get(canonicalPath(target));
        if (targetFile !== undefined) resolvedFileName = SourceFile_FileName(targetFile);
      } else if (kind === "reference-types") {
        const actualMode = getModeForTypeReferenceDirectiveInFile(reference, sourceFile, metadata, options);
        mode = referenceMode(actualMode);
        const resolutions = processed.typeResolutionsInFile.get(path);
        resolvedFileName = resolutions?.get({ Name: reference.FileName, Mode: actualMode })?.ResolvedFileName;
      } else {
        const [name, known] = GetLibFileName(reference.FileName);
        if (known) {
          for (const library of processed.libFiles.values()) {
            if (library?.Name === name) {
              const targetFile = processed.filesByPath.get(canonicalPath(library.path));
              if (targetFile !== undefined) resolvedFileName = SourceFile_FileName(targetFile);
              break;
            }
          }
        }
      }
      const range = utf16Range(TextRange_Pos(reference), TextRange_End(reference));
      references.push(Object.freeze({ kind, placement: "directive", specifier: reference.FileName,
        start: range.start, length: range.length,
        mode, resolution: resolution(resolvedFileName) }));
    };
    for (const reference of sourceFile.ReferencedFiles) addReference(reference, "reference-path");
    for (const reference of sourceFile.TypeReferenceDirectives) addReference(reference, "reference-types");
    for (const reference of sourceFile.LibReferenceDirectives) addReference(reference, "reference-lib");
    references.sort((left, right) => left.start - right.start || left.length - right.length);
    files.push(Object.freeze({ fileName, declarationFile: sourceFile.IsDeclarationFile, references: Object.freeze(references) }));
  }
  return Object.freeze({ roots: Object.freeze(roots), files: Object.freeze(files), diagnostics: Object.freeze(diagnostics) });
}
