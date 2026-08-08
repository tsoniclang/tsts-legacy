import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceFileParseOptions } from "../internal/ast/parseoptions.js";
import { ScriptKindTS } from "../internal/core/scriptkind.js";
import { ParseSourceFile } from "../internal/parser/parser/statements-declarations.js";
import {
  HEADER_OFFSET_NODES,
  KIND_NODE_LIST,
  NODE_LEN,
} from "../internal/ast/generated/protocol.js";
import {
  AsIdentifier,
  AsPropertyAssignment,
  AsPropertySignatureDeclaration,
  AsShorthandPropertyAssignment,
  encodeTargetSourceFileForPrinting,
  IsIdentifier,
  IsImportDeclaration,
  IsPropertyAssignment,
  IsPropertySignatureDeclaration,
  IsShorthandPropertyAssignment,
  IsSourceFile,
  NewIdentifier,
  transformTargetSourceFile,
} from "./target-ast.js";

const sourceText = `import { original } from "./dependency.js";
export const value: number = original + 2;
`;

test("target AST rewrite transforms exact nodes without a second parser", () => {
  const sourceFile = parse(sourceText);
  let rewritten = 0;
  const transformed = transformTargetSourceFile(sourceFile, (original, updated, factory) => {
    if (!IsIdentifier(original)) return updated;
    const identifier = AsIdentifier(original);
    if (identifier?.Text !== "original") return updated;
    rewritten += 1;
    return NewIdentifier(factory, "replacement")!;
  });

  assert.equal(rewritten, 2);
  const payload = encodeTargetSourceFileForPrinting(transformed);
  assert.ok(payload.length > sourceText.length);
});

test("target AST rewrite removes list elements without a text patch", () => {
  const transformed = transformTargetSourceFile(parse(sourceText), (original, updated) =>
    IsImportDeclaration(original) ? undefined : updated,
  );

  assert.equal(transformed.Statements?.Nodes.length, 1);
  assert.equal(IsImportDeclaration(transformed.Statements?.Nodes[0]), false);
});

test("target AST rewrite cannot remove the source-file root", () => {
  assert.throws(
    () => transformTargetSourceFile(parse(sourceText), (original, updated) =>
      IsSourceFile(original) ? undefined : updated,
    ),
    /target AST rewrite removed the source file/u,
  );
});

test("target AST print encoding preserves parsed node-list ranges", () => {
  const sourceFile = parse(sourceText);
  const payload = encodeTargetSourceFileForPrinting(sourceFile);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const nodesOffset = view.getUint32(HEADER_OFFSET_NODES, true);
  const rows = (payload.byteLength - nodesOffset) / NODE_LEN;
  let lists = 0;
  let rangedLists = 0;
  for (let row = 1; row < rows; row += 1) {
    const offset = nodesOffset + row * NODE_LEN;
    if (view.getUint32(offset, true) !== KIND_NODE_LIST) continue;
    lists += 1;
    if (view.getUint32(offset + 8, true) > view.getUint32(offset + 4, true)) {
      rangedLists += 1;
    }
  }
  assert.ok(lists > 0);
  assert.equal(rangedLists, lists);
});

test("target AST print encoding completes parser-optional wire metadata", () => {
  const sourceFile = parse(`interface Shape { value: number }
const shorthand = 2;
export const shape = { value: 1, shorthand };
`);
  let propertyAssignments = 0;
  let propertySignatures = 0;
  let shorthandAssignments = 0;
  let propertyAssignment: ReturnType<typeof AsPropertyAssignment>;
  let propertySignature: ReturnType<typeof AsPropertySignatureDeclaration>;
  let shorthandAssignment: ReturnType<typeof AsShorthandPropertyAssignment>;
  transformTargetSourceFile(sourceFile, (original, updated) => {
    if (IsPropertyAssignment(original)) {
      propertyAssignments += 1;
      propertyAssignment = AsPropertyAssignment(original);
      assert.equal(propertyAssignment?.Type, undefined);
    }
    if (IsPropertySignatureDeclaration(original)) {
      propertySignatures += 1;
      propertySignature = AsPropertySignatureDeclaration(original);
      assert.equal(propertySignature?.Initializer, undefined);
    }
    if (IsShorthandPropertyAssignment(original)) {
      shorthandAssignments += 1;
      shorthandAssignment = AsShorthandPropertyAssignment(original);
      assert.equal(shorthandAssignment?.Type, undefined);
    }
    return updated;
  });

  assert.equal(propertyAssignments, 1);
  assert.equal(propertySignatures, 1);
  assert.equal(shorthandAssignments, 1);
  assert.ok(encodeTargetSourceFileForPrinting(sourceFile).length > sourceText.length);
  assert.equal(propertyAssignment?.Type, undefined);
  assert.equal(propertySignature?.Initializer, undefined);
  assert.equal(shorthandAssignment?.Type, undefined);
});

function parse(text: string) {
  const sourceFile = ParseSourceFile(
    { FileName: "/src/index.ts", Path: "/src/index.ts" } satisfies SourceFileParseOptions,
    text,
    ScriptKindTS,
  );
  assert.ok(sourceFile !== undefined);
  return sourceFile;
}
