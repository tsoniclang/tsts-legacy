// Trivia skipping through the Go-signature string entry points. Positions are
// UTF-8 byte offsets, as in TS-Go. Each case runs on a text with non-ASCII
// characters and on its ASCII twin.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceFileParseOptions } from "../ast/parseoptions.js";
import { SourceFile_Diagnostics } from "../ast/ast.js";
import { Diagnostic_Code, Diagnostic_Len, Diagnostic_Pos } from "../ast/diagnostic.js";
import { Node_End, Node_Pos } from "../ast/spine.js";
import { GetScriptKindFromFileName } from "../core/core.js";
import { ParseSourceFile } from "../parser/parser/statements-declarations.js";
import { GetShebang, GetTokenPosOfNode, SkipTrivia, SkipTriviaEx, isConflictMarkerTrivia } from "./scanner.js";

const mixed = [
  "#!/usr/bin/env node é",
  "// line é€",
  "/* block \u{1f600} */ /** doc é */",
  "<<<<<<< ours",
  "export const a = 1;",
  "=======",
  "export const b = 2;",
  ">>>>>>> theirs",
  "export const c = 3; // tail é",
  "",
].join("\n");
const ascii = mixed.replace(/[^\x00-\x7f]/gu, "e");

interface Offsets {
  readonly text: string;
  readonly byteLength: number;
  readonly secondLine: number;
  readonly markers: readonly [number, number, number];
  readonly statementA: number;
  readonly statementAEnd: number;
  readonly statementC: number;
  readonly statementCEnd: number;
  readonly shebang: string;
}

const texts: ReadonlyArray<Offsets> = [
  { text: mixed, byteLength: 175, secondLine: 23, markers: [68, 101, 129], statementA: 81, statementAEnd: 100, statementC: 144, statementCEnd: 163, shebang: "#!/usr/bin/env node é" },
  { text: ascii, byteLength: 166, secondLine: 22, markers: [60, 93, 121], statementA: 73, statementAEnd: 92, statementC: 136, statementCEnd: 155, shebang: "#!/usr/bin/env node e" },
];

test("SkipTrivia skips a shebang, comments, conflict markers and line breaks", () => {
  for (const t of texts) {
    assert.equal(SkipTrivia(t.text, 0), t.statementA, "from the start to the first statement");
    assert.equal(SkipTrivia(t.text, t.statementA), t.statementA, "at a token");
    assert.equal(SkipTrivia(t.text, t.statementAEnd), t.statementC, "over the ======= and >>>>>>> markers");
    assert.equal(SkipTrivia(t.text, t.statementCEnd), t.byteLength, "over a trailing comment to the end");
    assert.equal(SkipTrivia(t.text, t.byteLength), t.byteLength, "at the end");
    assert.equal(SkipTrivia(t.text, -1), -1, "a synthesized position is returned as it is");
  }
});

// A token with multi-byte characters before the trivia, multi-byte characters
// inside it, and a token with one after it. `repeat` 3 keeps the text below the
// 4096 code units from which the UTF-8 byte view of a string is retained;
// 2100 puts it above.
const around = (repeat: number): string =>
  "export const p = \"é€\u{1f600}\";\n" + "// " + "é€".repeat(repeat) + "\n" + "/* \u{1f600} */ export const ñ = 1;\n";

test("SkipTrivia gives the same offsets for a text below and above the byte-view retention length", () => {
  const cases: ReadonlyArray<readonly [number, number, number, number, number]> = [
    // repeat, code units, bytes, block comment start, statement after the trivia
    [3, 64, 81, 49, 60],
    [2100, 4258, 10566, 10534, 10545],
  ];
  for (const [repeat, units, byteLength, blockStart, statement] of cases) {
    const text = around(repeat);
    assert.equal(text.length, units);
    // Twice: the second call of the long text finds its byte view retained.
    for (const pass of [1, 2]) {
      const label = `repeat ${repeat}, pass ${pass}`;
      assert.equal(SkipTrivia(text, 0), 0, label);
      assert.equal(SkipTrivia(text, 29), statement, label);
      assert.equal(SkipTrivia(text, statement), statement, label);
      assert.equal(SkipTrivia(text, byteLength), byteLength, label);
      assert.equal(SkipTriviaEx(text, 29, { StopAfterLineBreak: true, StopAtComments: false, InJSDoc: false }), 30, label);
      assert.equal(SkipTriviaEx(text, 29, { StopAfterLineBreak: false, StopAtComments: true, InJSDoc: false }), 30, label);
      assert.equal(SkipTriviaEx(text, 30, { StopAfterLineBreak: true, StopAtComments: false, InJSDoc: false }), blockStart, label);
    }
  }
});

test("SkipTriviaEx honours its options", () => {
  for (const t of texts) {
    assert.equal(
      SkipTriviaEx(t.text, 0, { StopAfterLineBreak: true, StopAtComments: false, InJSDoc: false }),
      t.secondLine,
      "StopAfterLineBreak stops after the shebang's line break",
    );
    assert.equal(
      SkipTriviaEx(t.text, 0, { StopAfterLineBreak: false, StopAtComments: true, InJSDoc: false }),
      t.secondLine,
      "StopAtComments stops at the first comment",
    );
    assert.equal(
      SkipTriviaEx(t.text, t.secondLine, { StopAfterLineBreak: false, StopAtComments: true, InJSDoc: false }),
      t.secondLine,
      "StopAtComments at a comment",
    );
  }
  assert.equal(SkipTriviaEx("\n * x", 0, { StopAfterLineBreak: false, StopAtComments: false, InJSDoc: true }), 4, "InJSDoc consumes a leading asterisk");
  assert.equal(SkipTriviaEx("\n * x", 0, { StopAfterLineBreak: false, StopAtComments: false, InJSDoc: false }), 2, "an asterisk is a token outside JSDoc");
  assert.equal(SkipTriviaEx("\r\n\r\nx", 0, { StopAfterLineBreak: true, StopAtComments: false, InJSDoc: false }), 2, "CRLF is one line break");
  assert.equal(SkipTriviaEx(mixed, -1, { StopAfterLineBreak: true, StopAtComments: true, InJSDoc: true }), -1, "a synthesized position is returned as it is");
});

test("SkipTrivia applies the shebang, conflict-marker and white-space rules at their edges", () => {
  assert.equal(SkipTrivia("\r\nx", 0), 2);
  assert.equal(SkipTrivia("  #!x", 0), 2, "a shebang is trivia only at offset 0");
  assert.equal(SkipTrivia("a <<<<<<< b", 2), 2, "a conflict marker must start a line");
  assert.throws(() => isConflictMarkerTrivia("<<<<<<< x\n", -1),
    (error: unknown) => error instanceof Error && error.message === "pos < 0", "a negative position is refused");
  assert.equal(SkipTrivia("  <<<<<<< x\ny", 0), 2, "a marker after white space on its line is not a marker");
  assert.equal(SkipTrivia("\u2028<<<<<<< x\ny", 0), 3, "a marker directly after U+2028 is not a marker");
  assert.equal(SkipTrivia("é\n<<<<<<< x\ny", 2), 13, "a marker after a line break that follows a multi-byte character");
  assert.equal(SkipTrivia("||||||| base\nxx\n=======\nyy\n>>>>>>> t\nz", 0), 37, "||||||| and ======= sections are skipped");
  assert.equal(SkipTrivia("  x", 0), 5, "non-ASCII white space is skipped by its byte length");
  assert.equal(SkipTrivia("/* é", 0), 5, "an unterminated block comment runs to the end");
});

test("GetShebang returns the shebang line without its line break", () => {
  for (const t of texts) {
    assert.equal(GetShebang(t.text), t.shebang);
  }
  assert.equal(GetShebang("x"), "");
  assert.equal(GetShebang("// #!x"), "");
});

// The Scanner's own path calls the same conflict-marker functions with its text.
test("parsing reports each conflict marker and places the statements around them", () => {
  for (const t of texts) {
    const file = ParseSourceFile({ FileName: "/main.ts", Path: "/main.ts" } satisfies SourceFileParseOptions, t.text, GetScriptKindFromFileName("/main.ts"));
    const markers = SourceFile_Diagnostics(file)
      .filter((diagnostic) => Diagnostic_Code(diagnostic) === 1185)
      .map((diagnostic) => [Diagnostic_Pos(diagnostic), Diagnostic_Len(diagnostic)]);
    assert.deepEqual(markers, t.markers.map((pos) => [pos, 7]));
    const statements = file!.Statements!.Nodes;
    assert.deepEqual(
      statements.map((statement) => [Node_Pos(statement), GetTokenPosOfNode(statement, file, false), Node_End(statement)]),
      [
        [0, t.statementA, t.statementAEnd],
        [t.statementAEnd, t.statementC, t.statementCEnd],
      ],
    );
  }
});
