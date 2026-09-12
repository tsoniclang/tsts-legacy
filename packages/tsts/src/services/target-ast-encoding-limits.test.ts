import assert from "node:assert/strict";
import { test } from "node:test";
import { NewNodeFactory } from "../internal/ast/spine.js";
import { ScriptKindTS } from "../internal/core/scriptkind.js";
import { ParseSourceFile } from "../internal/parser/parser/statements-declarations.js";
import {
  HEADER_OFFSET_EXTENDED_DATA,
  HEADER_OFFSET_NODES,
  HEADER_OFFSET_STRING_TABLE,
  HEADER_OFFSET_STRING_TABLE_OFFSETS,
  HEADER_OFFSET_STRUCTURED_DATA,
  NODE_EXTENDED_DATA_MASK,
  NODE_LEN,
  NODE_OFFSET_PARENT,
  NODE_STRING_INDEX_MASK,
} from "../internal/ast/generated/protocol.js";
import {
  AsParenthesizedExpression,
  AsSourceFile,
  defaultTargetAstEncodingLimits,
  encodeTargetSourceFileForPrinting,
  NewEmptyStatement,
  NewExpressionStatement,
  NewNumericLiteral,
  NewParenthesizedExpression,
  NodeFactory_NewNodeList,
  NodeFactory_UpdateSourceFile,
  TargetAstEncodingError,
} from "./target-ast.js";
import type { Node, SourceFile, TargetAstEncodingLimits } from "./target-ast.js";

const sourceText = 'export const greeting = "😀 é"; export const size = 42;';

test("public AST encoder retains byte-identical bounded defaults and isolates calls", () => {
  const source = parse(sourceText);
  const expected = encodeTargetSourceFileForPrinting(source);
  assert.deepEqual(encodeTargetSourceFileForPrinting(source, undefined), expected);
  assert.deepEqual(encodeTargetSourceFileForPrinting(source, defaultTargetAstEncodingLimits), expected);
  const selected = { ...defaultTargetAstEncodingLimits, maximumNodeRows: 2 };
  assert.throws(() => encodeTargetSourceFileForPrinting(source, selected), /node rows 3 exceeds limit 2/u);
  selected.maximumNodeRows = defaultTargetAstEncodingLimits.maximumNodeRows;
  const actual = encodeTargetSourceFileForPrinting(source, selected);
  assert.deepEqual(actual, expected);
  assert.notEqual(actual, expected);
  assert.ok(Object.isFrozen(defaultTargetAstEncodingLimits));
  assert.equal(Reflect.set(defaultTargetAstEncodingLimits, "maximumNodeRows", 2), false);
  assert.deepEqual(encodeTargetSourceFileForPrinting(source), expected);
});

test("one real AST admits exact finite limits and rejects each smaller independent budget", () => {
  const source = parse(sourceText);
  source.ReferencedFiles.push({ pos: 0, end: 1, FileName: "types.ts", ResolutionMode: 0, Preserve: true });
  const expected = encodeTargetSourceFileForPrinting(source);
  const limits = measuredLimits(expected);
  assert.deepEqual(encodeTargetSourceFileForPrinting(source, limits), expected);
  const guards: readonly [keyof TargetAstEncodingLimits, RegExp][] = [
    ["maximumNodeRows", /node rows/u],
    ["maximumDepth", /target AST depth/u],
    ["maximumStringCount", /target AST strings/u],
    ["maximumStringBytes", /target AST string bytes/u],
    ["maximumSingleStringBytes", /per-string limit/u],
    ["maximumExtendedWords", /extended-data words/u],
    ["maximumStructuredBytes", /structured-data bytes/u],
    ["maximumEncodedBytes", /encoded size/u],
  ];
  for (const [name, message] of guards) {
    assert.ok(limits[name] > 1, name);
    assert.throws(() => encodeTargetSourceFileForPrinting(source, { ...limits, [name]: limits[name] - 1 }), message, name);
  }
  assert.deepEqual(encodeTargetSourceFileForPrinting(source, limits), expected);
});

test("public AST capacity can exceed the unchanged default node-row ceiling", () => {
  const factory = NewNodeFactory({});
  const statement = NewEmptyStatement(factory);
  assert.ok(statement);
  const statementCount = defaultTargetAstEncodingLimits.maximumNodeRows;
  const source = withStatements(new Array<Node>(statementCount).fill(statement));
  assert.throws(() => encodeTargetSourceFileForPrinting(source), /node rows 2097153 exceeds limit 2097152/u);
  const selected = { ...defaultTargetAstEncodingLimits, maximumNodeRows: statementCount + 8 };
  const payload = encodeTargetSourceFileForPrinting(source, selected);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const rows = (payload.length - view.getUint32(HEADER_OFFSET_NODES, true)) / NODE_LEN;
  assert.equal(rows, statementCount + 4);
  assert.ok(payload.length < selected.maximumEncodedBytes);
});

test("public AST limits reject malformed records and every invalid numeric field", () => {
  const source = parse(sourceText);
  const encode = (limits: unknown) => Reflect.apply(encodeTargetSourceFileForPrinting, undefined, [source, limits]);
  for (const malformed of [null, false, 2, "limits", [], {}, { maximumNodeRows: 10 }, Object.create(defaultTargetAstEncodingLimits),
    { ...defaultTargetAstEncodingLimits, maximumNodes: 10 }, { ...defaultTargetAstEncodingLimits, [Symbol("extra")]: 1 }]) {
    assert.throws(() => encode(malformed), TargetAstEncodingError);
  }
  const invalidValues = [0, -0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, true, "8", 8n];
  for (const name of Object.keys(defaultTargetAstEncodingLimits)) {
    const missing = { ...defaultTargetAstEncodingLimits };
    Reflect.deleteProperty(missing, name);
    assert.throws(() => encode(missing), TargetAstEncodingError, name);
    for (const value of invalidValues) {
      assert.throws(() => encode({ ...defaultTargetAstEncodingLimits, [name]: value }), TargetAstEncodingError, name);
    }
    const hidden = Object.defineProperty({ ...defaultTargetAstEncodingLimits }, name, { enumerable: false });
    assert.throws(() => encode(hidden), /own enumerable data field/u);
    let reads = 0;
    const getter = Object.defineProperty({ ...defaultTargetAstEncodingLimits }, name, {
      get() { reads += 1; return 1; },
    });
    assert.throws(() => encode(getter), /own enumerable data field/u);
    assert.equal(reads, 0);
  }
  const nullPrototype = Object.assign(Object.create(null), defaultTargetAstEncodingLimits);
  assert.deepEqual(encode(nullPrototype), encodeTargetSourceFileForPrinting(source));
});

test("public AST selections retain supported stack, wire and string-consistency ceilings", () => {
  const source = parse(sourceText);
  const cases: readonly [keyof TargetAstEncodingLimits, number, RegExp][] = [
    ["maximumNodeRows", Math.floor(0xffff_ffff / NODE_LEN) + 1, /node-table byte range/u],
    ["maximumDepth", defaultTargetAstEncodingLimits.maximumDepth + 1, /supported recursive depth/u],
    ["maximumStringCount", Math.floor((NODE_STRING_INDEX_MASK + 1) / 2) + 1, /wire string-index range/u],
    ["maximumStringBytes", 0x1_0000_0000, /string-table byte range/u],
    ["maximumSingleStringBytes", defaultTargetAstEncodingLimits.maximumStringBytes + 1, /exceeds maximumStringBytes/u],
    ["maximumExtendedWords", Math.floor((NODE_EXTENDED_DATA_MASK + 1) / 4) + 1, /wire extended-data offset range/u],
    ["maximumStructuredBytes", 0x1_0000_0000, /structured-data byte range/u],
    ["maximumEncodedBytes", 0x1_0000_0000, /uint32 wire-offset range/u],
  ];
  for (const [name, value, message] of cases) {
    assert.throws(() => encodeTargetSourceFileForPrinting(source, { ...defaultTargetAstEncodingLimits, [name]: value }), message);
  }
});

test("larger row capacity never disables cycle, depth or actual wire-value validation", () => {
  const selected = { ...defaultTargetAstEncodingLimits, maximumNodeRows: defaultTargetAstEncodingLimits.maximumNodeRows * 2 };
  const factory = NewNodeFactory({});
  let expression = NewNumericLiteral(factory, "0", 0);
  assert.ok(expression);
  for (let depth = 0; depth < defaultTargetAstEncodingLimits.maximumDepth; depth += 1) {
    expression = NewParenthesizedExpression(factory, expression);
    assert.ok(expression);
  }
  const statement = NewExpressionStatement(factory, expression);
  assert.ok(statement);
  const source = withStatements([statement]);
  assert.throws(() => encodeTargetSourceFileForPrinting(source, selected), /target AST depth 1025 exceeds limit 1024/u);
  const cyclic = AsParenthesizedExpression(expression);
  assert.ok(cyclic);
  cyclic.Expression = expression;
  assert.throws(() => encodeTargetSourceFileForPrinting(source, selected), /cycle in target AST/u);

  const invalidPosition = parse(sourceText);
  const root = invalidPosition.data.AsNode();
  assert.ok(root);
  root.Loc.end = 0x1_0000_0000;
  assert.throws(() => encodeTargetSourceFileForPrinting(invalidPosition, selected), /source position exceeds uint32 range/u);
  const invalidReference = parse(sourceText);
  invalidReference.ReferencedFiles.push({ pos: 0, end: 0x1_0000_0000, FileName: "types.ts", ResolutionMode: 0, Preserve: false });
  assert.throws(() => encodeTargetSourceFileForPrinting(invalidReference, selected), /structured unsigned integer exceeds uint32 range/u);
});

function parse(text: string): SourceFile {
  const source = ParseSourceFile({ FileName: "/src/index.ts", Path: "/src/index.ts" }, text, ScriptKindTS);
  assert.ok(source);
  return source;
}

function withStatements(statements: Node[]): SourceFile {
  const original = parse("");
  const factory = NewNodeFactory({});
  const source = AsSourceFile(NodeFactory_UpdateSourceFile(factory, original,
    NodeFactory_NewNodeList(factory, statements), original.EndOfFileToken));
  assert.ok(source);
  return source;
}

function measuredLimits(payload: Uint8Array): TargetAstEncodingLimits {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const offsets = view.getUint32(HEADER_OFFSET_STRING_TABLE_OFFSETS, true);
  const strings = view.getUint32(HEADER_OFFSET_STRING_TABLE, true);
  const extended = view.getUint32(HEADER_OFFSET_EXTENDED_DATA, true);
  const structured = view.getUint32(HEADER_OFFSET_STRUCTURED_DATA, true);
  const nodes = view.getUint32(HEADER_OFFSET_NODES, true);
  let maximumSingleStringBytes = 0;
  for (let offset = offsets; offset < strings; offset += 8) {
    maximumSingleStringBytes = Math.max(maximumSingleStringBytes, view.getUint32(offset + 4, true) - view.getUint32(offset, true));
  }
  const maximumNodeRows = (payload.length - nodes) / NODE_LEN;
  const depths = [0];
  for (let row = 1; row < maximumNodeRows; row += 1) {
    const parent = view.getUint32(nodes + row * NODE_LEN + NODE_OFFSET_PARENT, true);
    depths.push(depths[parent]! + 1);
  }
  return {
    maximumNodeRows,
    maximumDepth: Math.max(...depths),
    maximumStringCount: (strings - offsets) / 8,
    maximumStringBytes: extended - strings,
    maximumSingleStringBytes,
    maximumExtendedWords: (structured - extended) / 4,
    maximumStructuredBytes: nodes - structured,
    maximumEncodedBytes: payload.length,
  };
}
