import assert from "node:assert/strict";
import type { bool } from "../go/scalars.js";
import type { GoPtr } from "../go/compat.js";
import { Background } from "../go/context.js";
import { Node_Text } from "../internal/ast/ast.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import { Node_ForEachChild, Node_Name } from "../internal/ast/spine.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import { KindIdentifier, KindPropertyAccessExpression } from "../internal/ast/generated/kinds.js";
import { LibPath, WrapFS } from "../internal/bundled/bundled.js";
import type { CompilerOptions } from "../internal/core/compileroptions.js";
import { NewCompilerHost } from "../internal/compiler/host.js";
import { NewProgram, Program_GetSemanticDiagnostics, Program_GetSourceFile } from "../internal/compiler/program.js";
import type { Program, ProgramOptions } from "../internal/compiler/program.js";
import type { ParseConfigHost } from "../internal/tsoptions/tsconfigparsing.js";
import { GetParsedCommandLineOfConfigFile } from "../internal/tsoptions/tsconfigparsing.js";
import { FromMap } from "../internal/vfs/vfstest/vfstest.js";

export function createProgram(
  sourceText: string,
  settings: { readonly noLib?: boolean; readonly fileName?: "index.ts" | "index.js"; readonly checkJs?: boolean } = {},
): { readonly program: GoPtr<Program>; readonly index: GoPtr<SourceFile> } {
  const fileName = settings.fileName ?? "index.ts";
  const sourcePath = `/src/${fileName}`;
  let fs = FromMap(new Map<string, string>([
    [sourcePath, sourceText],
    ["/src/tsconfig.json", JSON.stringify({
      compilerOptions: {
        noLib: settings.noLib ?? true,
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        ...(settings.checkJs === true ? { allowJs: true, checkJs: true, noEmit: true } : {}),
      },
      files: [fileName],
    })],
  ]), false as bool);
  fs = WrapFS(fs);

  const host = NewCompilerHost("/src", fs, LibPath(), undefined, undefined);
  const [parsed, configErrors] = GetParsedCommandLineOfConfigFile(
    "/src/tsconfig.json",
    {} as CompilerOptions,
    undefined,
    host as ParseConfigHost,
    undefined,
  );
  assert.equal((configErrors ?? []).length, 0);

  const options = {
    Config: parsed,
    Host: host,
  } satisfies ProgramOptions;
  const program = NewProgram(options);
  const index = Program_GetSourceFile(program, sourcePath);
  assert.ok(index !== undefined, `Expected source file ${sourcePath}.`);
  return { program, index };
}

export function assertCleanSemanticDiagnostics(
  program: GoPtr<Program>,
  sourceFile: GoPtr<SourceFile>,
): void {
  const diagnostics = Program_GetSemanticDiagnostics(program, Background(), sourceFile);
  assert.equal(diagnostics.length, 0, diagnostics.map(Diagnostic_String).join("\n"));
}

export function findIdentifierByText(
  root: GoPtr<Node>,
  text: string,
  predicate: (node: GoPtr<Node>) => boolean,
): GoPtr<Node> {
  let found: GoPtr<Node>;
  visitNodes(root, (node) => {
    if (found === undefined && node?.Kind === KindIdentifier && Node_Text(node) === text && predicate(node)) {
      found = node;
    }
  });
  assert.ok(found !== undefined, `Expected identifier ${text}.`);
  return found;
}

export function findFirstNodeByKind(root: GoPtr<Node>, kind: number): GoPtr<Node> {
  let found: GoPtr<Node>;
  visitNodes(root, (node) => {
    if (found === undefined && node?.Kind === kind) {
      found = node;
    }
  });
  assert.ok(found !== undefined, `Expected node kind ${kind}.`);
  return found;
}

export function findNodesByKind(root: GoPtr<Node>, kind: number): readonly Node[] {
  const found: Node[] = [];
  visitNodes(root, (node) => {
    if (node?.Kind === kind) {
      found.push(node);
    }
  });
  return found;
}

export function findPropertyAccessByName(
  root: GoPtr<Node>,
  name: string,
  predicate: (node: GoPtr<Node>) => boolean,
): GoPtr<Node> {
  let found: GoPtr<Node>;
  visitNodes(root, (node) => {
    if (
      found === undefined
      && node?.Kind === KindPropertyAccessExpression
      && Node_Text(Node_Name(node)) === name
      && predicate(node)
    ) {
      found = node;
    }
  });
  assert.ok(found !== undefined, `Expected property access ${name}.`);
  return found;
}

function visitNodes(root: GoPtr<Node>, visit: (node: GoPtr<Node>) => void): void {
  if (root === undefined) {
    return;
  }
  visit(root);
  Node_ForEachChild(root, (child) => {
    visitNodes(child, visit);
    return false as bool;
  });
}
