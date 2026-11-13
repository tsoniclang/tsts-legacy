import assert from "node:assert/strict";
import { test } from "node:test";
import type { bool } from "../go/scalars.js";
import { createCompilerSessionFromFiles, createInMemoryFileSystem, getBundledLibraryClosure } from "../index.js";
import { FromMap } from "../internal/vfs/vfstest/vfstest.js";

// The text of a file as the SDK delivers it to the parser, for the paths that carry source files, declaration files,
// session documents and bundled declarations. Contract of a file read, from the Go original (decodeBytes): input with
// a UTF-16 mark is decoded as UTF-16; otherwise exactly one leading UTF-8 byte-order mark is removed and the rest is
// the text. Nothing else is removed.
const mark = "﻿";
// One-, two-, three- and four-byte characters in UTF-8; the last is a surrogate pair in UTF-16.
const body = "const s = \"Aé€\u{1f600}\";\nexport const a = 1;\n";
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let index = 0; index < text.length; index += 1) view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
  return bytes;
}

function readBytes(bytes: Uint8Array): string {
  const [text, available] = FromMap(new Map([["/src/a.ts", bytes]]), true as bool).ReadFile("/src/a.ts");
  assert.equal(available, true);
  return text;
}

test("a file read removes exactly one leading UTF-8 byte-order mark and keeps every other unit: zero to four marks before non-ASCII text", () => {
  for (const [marks, removed] of [[0, 0], [1, 1], [2, 1], [3, 1], [4, 1]] as const) {
    const original = mark.repeat(marks) + body;
    const delivered = readBytes(utf8(original));
    assert.equal(delivered, original.slice(removed), `${marks} leading mark(s): ${removed} removed`);
    assert.equal(delivered.endsWith(body), true, "the non-ASCII text is delivered unchanged");
  }
  assert.equal(readBytes(utf8(mark + mark + body)).charCodeAt(0), 0xfeff, "the second of two marks is the first unit of the delivered text");
  assert.equal(readBytes(new Uint8Array()), "", "an empty file is empty text");
  assert.equal(readBytes(utf8(mark)), "", "a file of one mark is empty text");
});

test("a file read decodes UTF-16 input by its mark, in both byte orders, and removes that mark only", () => {
  for (const littleEndian of [true, false]) {
    assert.equal(readBytes(utf16(body, littleEndian)), body, "non-ASCII text and the surrogate pair are delivered unchanged");
    assert.equal(readBytes(utf16(mark + body, littleEndian)), mark + body, "a U+FEFF after the mark stays in the text");
  }
});

test("a string document given to the in-memory file system is delivered by the same rule as a file's bytes", () => {
  for (const [marks, removed] of [[0, 0], [1, 1], [2, 1], [3, 1]] as const) {
    const original = mark.repeat(marks) + body;
    const fileSystem = createInMemoryFileSystem({ files: { "/src/a.ts": original }, includeBundledLibraries: false, useCaseSensitiveFileNames: true });
    assert.deepEqual(fileSystem.ReadFile("/src/a.ts"), [original.slice(removed), true], `${marks} leading mark(s): ${removed} removed`);
  }
});

test("a session document is parsed from the delivered text: one mark removed, a remaining U+FEFF is leading trivia of the first statement, and positions are offsets of the delivered text", () => {
  for (const [marks, removed] of [[0, 0], [1, 1], [2, 1], [3, 1]] as const) {
    const original = mark.repeat(marks) + body;
    const session = createCompilerSessionFromFiles({
      currentDirectory: "/case", files: { "/case/a.mts": original }, rootFiles: ["/case/a.mts"],
      compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024" },
    });
    const checked = session.checkSource();
    const sourceFile = checked.getSourceFile("/case/a.mts");
    if (sourceFile === undefined) throw new Error("The session has no /case/a.mts.");
    const delivered = checked.ast.getSourceText(sourceFile);
    assert.equal(delivered, original.slice(removed), `${marks} leading mark(s): ${removed} removed`);
    assert.equal(session.getDiagnostics("all").length, 0, `${marks} leading mark(s): the remaining marks are not an error`);
    const statements: { start: number; end: number }[] = [];
    checked.ast.forEachChild(sourceFile, child => {
      if (child === undefined) return;
      const range = checked.ast.authoredRange(child);
      if (range.kind === "authored" && range.end > range.start) statements.push({ start: range.start, end: range.end });
    });
    const first = statements[0];
    if (first === undefined) throw new Error("The file has no statement.");
    // The scanner skips a U+FEFF as white space: the first statement starts after the marks that remain.
    assert.equal(first.start, marks - removed);
    assert.equal(delivered.slice(first.start, first.end), "const s = \"Aé€\u{1f600}\";");
    assert.equal(original.slice(first.start + (original.length - delivered.length), first.end + (original.length - delivered.length)),
      "const s = \"Aé€\u{1f600}\";", "the offset in the original is larger by the difference of the two lengths");
  }
});

test("bundled declarations are delivered without a leading mark and with their non-ASCII text", () => {
  const names = ["lib.dom.d.ts", "lib.es2015.core.d.ts", "lib.es2015.symbol.wellknown.d.ts", "lib.es2020.bigint.d.ts", "lib.webworker.d.ts"];
  const sources = getBundledLibraryClosure(names);
  for (const name of names) {
    const source = sources.find(candidate => candidate.name === name);
    if (source === undefined) throw new Error(`The closure omits ${name}.`);
    assert.notEqual(source.text.charCodeAt(0), 0xfeff, `${name} does not start with a mark`);
    assert.equal(/[^\u0000-\u007f]/u.test(source.text), true, `${name} keeps its non-ASCII text`);
  }
  const core = sources.find(candidate => candidate.name === "lib.es2015.core.d.ts");
  assert.equal(core?.text.includes("either +0 or −0, the result is +0."), true, "U+2212 in a comment of lib.es2015.core.d.ts is delivered as written");
});
