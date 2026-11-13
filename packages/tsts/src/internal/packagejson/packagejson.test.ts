import { test } from "node:test";
import assert from "node:assert/strict";
import type { byte } from "../../go/scalars.js";
import { Parse } from "./packagejson.js";
import { Expected_GetValue } from "./expected.js";

const textEncoder = new TextEncoder();

function bytes(text: string): byte[] {
  return Array.from(textEncoder.encode(text)) as byte[];
}

test("Parse mirrors upstream duplicate-name package.json behavior", () => {
  const [fields, error] = Parse(bytes(`{
    "name": "test-package",
    "name": "test-package",
    "version": "1.0.0"
  }`));

  assert.equal(error, undefined);
  assert.equal(fields.__tsgoEmbedded0!.Name.Valid, true);
  assert.equal(fields.__tsgoEmbedded0!.Name.Value, "test-package");
  assert.equal(fields.__tsgoEmbedded0!.Version.Valid, true);
  assert.equal(fields.__tsgoEmbedded0!.Version.Value, "1.0.0");

  const [name, nameOk] = Expected_GetValue(fields.__tsgoEmbedded0!.Name);
  assert.equal(nameOk, true);
  assert.equal(name, "test-package");
});

// Expected values are the pinned TS-Go packagejson.Parse's OBSERVED results on the same bytes, not derived here:
// "R3" and "R3-2": R3's first and second sets (claude/packages/W3-2.step-and-marks.review.R3.evidence, go-parse.out
// and second-set/go-parse.out); "W7-3", "W7-4" and "W7-5": W7's runs 21, 22 and 24 (SDK .temp/w7/manifest-probe,
// go-parse.out, go-parse4.out and go-parse5.out). Each row: id, label, input bytes in hexadecimal, whether Parse reports an error, and the name and
// types fields read back as [Valid, Null, Value].
type PinnedRow = readonly [string, string, string, boolean, readonly [boolean, boolean, string], readonly [boolean, boolean, string]];
const pinnedRows: readonly PinnedRow[] = [
  ["R3 1", "plain", "7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"café"], [true,false,"./lib/main.d.ts"]],
  ["R3 2", "1 leading mark", "efbbbf7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 3", "2 leading marks", "efbbbfefbbbf7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 4", "3 leading marks", "efbbbfefbbbfefbbbf7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 5", "empty", "", true, [false,false,""], [false,false,""]],
  ["R3 6", "whitespace only", "200a", true, [false,false,""], [false,false,""]],
  ["R3 7", "truncated", "7b226e616d65223a", true, [false,false,""], [false,false,""]],
  ["R3 8", "leading and trailing JSON whitespace", "20090d0a7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d0a20", false, [true,false,"café"], [true,false,"./lib/main.d.ts"]],
  ["R3 9", "ill-formed: FF inside a string", "7b226e616d65223a22ff222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 10", "ill-formed: truncated two-byte sequence inside a string", "7b226e616d65223a22c3222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 11", "ill-formed: overlong C0 AF inside a string", "7b226e616d65223a22c0af222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 12", "ill-formed: encoded surrogate ED A0 80 inside a string", "7b226e616d65223a22eda080222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 13", "ill-formed: FF inside a member name", "7b226e61ff6d65223a2278222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 14", "ill-formed: FF after the value", "7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227dff", true, [false,false,""], [false,false,""]],
  ["R3 15", "mark inside a string value", "7b226e616d65223a22efbbbf222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"﻿"], [true,false,"./lib/main.d.ts"]],
  ["R3 16", "mark between tokens, after the opening brace", "7befbbbf226e616d65223a2278227d", true, [false,false,""], [false,false,""]],
  ["R3 17", "mark after the value", "7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227defbbbf", true, [false,false,""], [false,false,""]],
  ["R3 18", "mark before a member value", "7b226e616d65223aefbbbf2278227d", true, [false,false,""], [false,false,""]],
  ["R3 19", "trailing text after the value", "7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d2078", true, [false,false,""], [false,false,""]],
  ["R3 20", "two values", "7b7d7b7d", true, [false,false,""], [false,false,""]],
  ["R3 21", "duplicate name", "7b226e616d65223a2261222c226e616d65223a2262227d", false, [true,false,"b"], [false,false,""]],
  ["R3 22", "duplicate name in a nested object", "7b226e616d65223a2261222c226578706f727473223a7b222e223a222e2f612e6a73222c222e223a222e2f622e6a73227d7d", false, [true,false,"a"], [false,false,""]],
  ["R3 23", "top-level array", "5b5d", true, [false,false,""], [false,false,""]],
  ["R3 24", "top-level string", "227322", true, [false,false,""], [false,false,""]],
  ["R3 25", "top-level number", "31", true, [false,false,""], [false,false,""]],
  ["R3 26", "top-level null", "6e756c6c", false, [false,false,""], [false,false,""]],
  ["R3 27", "name is a number, types is an array", "7b226e616d65223a352c227479706573223a5b2278225d7d", false, [false,false,""], [false,false,""]],
  ["R3 28", "name is null", "7b226e616d65223a6e756c6c2c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [false,true,""], [true,false,"./lib/main.d.ts"]],
  ["R3 29", "escaped lone high surrogate in a string", "7b226e616d65223a225c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 30", "escaped surrogate pair in a string", "7b226e616d65223a225c75643833645c7564653030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"😀"], [true,false,"./lib/main.d.ts"]],
  ["R3 31", "member name in another case", "7b224e414d45223a2278222c225479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [false,false,""], [false,false,""]],
  ["R3 32", "raw tab inside a string", "7b226e616d65223a22610962227d", true, [false,false,""], [false,false,""]],
  ["R3 33", "trailing comma", "7b226e616d65223a2261222c7d", true, [false,false,""], [false,false,""]],
  ["R3 34", "line comment", "2f2f20630a7b226e616d65223a2261227d", true, [false,false,""], [false,false,""]],
  ["R3 35", "number with leading zero in an unread member", "7b226e616d65223a2261222c2278223a30317d", true, [false,false,""], [false,false,""]],
  ["R3 36", "U+00A0 before the value", "c2a07b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3 37", "NUL after the value", "7b226e616d65223a22636166c3a9222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d00", true, [false,false,""], [false,false,""]],
  ["R3-2 1", "lone high surrogate escape in a READ field (name)", "7b226e616d65223a225c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 2", "lone high surrogate escape in an IGNORED member's value", "7b226465736372697074696f6e223a225c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 3", "lone high surrogate escape in a member NAME", "7b225c7564383030223a312c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 4", "lone high surrogate escape nested in an ignored object", "7b2278223a7b2279223a5b225c7564383030225d7d2c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 5", "lone high surrogate escape nested in a read field (exports)", "7b226578706f727473223a7b222e223a225c7564383030227d2c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 6", "lone LOW surrogate escape in name", "7b226e616d65223a225c7564633030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 7", "low then high (reversed pair) in name", "7b226e616d65223a225c75646330305c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 8", "high followed by a non-surrogate escape", "7b226e616d65223a225c75643830305c7530303431222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 9", "high followed by a plain character", "7b226e616d65223a225c756438303041222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["R3-2 10", "valid pair in an ignored member and in a member name", "7b225c75643833645c7564653030223a225c75643833645c7564653030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [false,false,""], [true,false,"./lib/main.d.ts"]],
  ["R3-2 11", "U+FFFD written as a character in name (legitimate)", "7b226e616d65223a22efbfbd222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"�"], [true,false,"./lib/main.d.ts"]],
  ["R3-2 12", "U+FFFD written as an escape in name (legitimate)", "7b226e616d65223a225c7566666664222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"�"], [true,false,"./lib/main.d.ts"]],
  ["R3-2 13", "root: object with fields (the valid opposite)", "7b226e616d65223a2278222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"x"], [true,false,"./lib/main.d.ts"]],
  ["R3-2 14", "root: empty object", "7b7d", false, [false,false,""], [false,false,""]],
  ["R3-2 15", "root: array", "5b5d", true, [false,false,""], [false,false,""]],
  ["R3-2 16", "root: array holding an object with fields", "5b7b226e616d65223a2278222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d5d", true, [false,false,""], [false,false,""]],
  ["R3-2 17", "root: string", "227322", true, [false,false,""], [false,false,""]],
  ["R3-2 18", "root: number", "31", true, [false,false,""], [false,false,""]],
  ["R3-2 19", "root: true", "74727565", true, [false,false,""], [false,false,""]],
  ["R3-2 20", "root: null", "6e756c6c", false, [false,false,""], [false,false,""]],
  ["W7-3 1", "D1 duplicate read member: bad first, valid second", "7b226e616d65223a225c7564383030222c226e616d65223a2276616c6964222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-3 2", "D2 duplicate read member: valid first, bad second", "7b226e616d65223a2276616c6964222c226e616d65223a225c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-3 3", "D3 duplicate in an ignored nested object: bad first, valid second", "7b2278223a7b2279223a225c7564383030222c2279223a226f6b227d2c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-3 4", "D4 duplicate ignored top-level member: bad first, valid second", "7b226465736372697074696f6e223a225c7564383030222c226465736372697074696f6e223a226f6b222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-3 5", "D5 duplicate member whose first value is an object holding a bad string", "7b2278223a7b227a223a5b225c7564383030225d7d2c2278223a312c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-3 6", "D6 duplicate read member, both valid (last wins)", "7b226e616d65223a226669727374222c226e616d65223a227365636f6e64222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"second"], [true,false,"./lib/main.d.ts"]],
  ["W7-3 7", "O1 escaped backslash then ud800 (a literal backslash: valid)", "7b226e616d65223a225c5c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"\\ud800"], [true,false,"./lib/main.d.ts"]],
  ["W7-3 8", "O2 valid surrogate pair in a read member", "7b226e616d65223a225c75643833645c7564653030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"😀"], [true,false,"./lib/main.d.ts"]],
  ["W7-3 9", "O3 valid surrogate pair in a duplicate discarded value", "7b226e616d65223a225c75643833645c7564653030222c226e616d65223a2276616c6964222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"valid"], [true,false,"./lib/main.d.ts"]],
  ["W7-4 1", "E1 root: false", "66616c7365", true, [false,false,""], [false,false,""]],
  ["W7-4 2", "E2 escaped quote inside a value", "7b226e616d65223a22615c2262222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"a\"b"], [true,false,"./lib/main.d.ts"]],
  ["W7-4 3", "E3 escaped quote inside a member name", "7b22615c2262223a312c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [false,false,""], [true,false,"./lib/main.d.ts"]],
  ["W7-4 4", "E4 escaped backslash at the end of a value", "7b226e616d65223a22615c5c222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"a\\"], [true,false,"./lib/main.d.ts"]],
  ["W7-4 5", "E5 escaped backslash then a lone high escape", "7b226e616d65223a225c5c5c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-4 6", "E6 high escape followed by a high-low pair", "7b226e616d65223a225c75643830305c75643833645c7564653030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-4 7", "E7 escaped quote then a lone low escape in an ignored member", "7b2264223a225c225c7564633030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-4 8", "E8 valid pair with uppercase hex", "7b226e616d65223a225c75443833445c7544453030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"😀"], [true,false,"./lib/main.d.ts"]],
  ["W7-4 9", "E9 lone high escape with uppercase hex", "7b226e616d65223a225c7544383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-4 10", "E10 two separate valid pairs", "7b226e616d65223a225c75643833645c7564653030785c75643833645c7564653031222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"😀x😁"], [true,false,"./lib/main.d.ts"]],
  ["W7-4 11", "E11 high escape at the very end of a value", "7b226e616d65223a22785c7564383030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-4 12", "E12 slash and other simple escapes", "7b226e616d65223a225c2f5c625c665c6e5c725c74222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"/\b\f\n\r\t"], [true,false,"./lib/main.d.ts"]],
  ["W7-5 1", "F1 high escape followed by an escaped backslash", "7b226e616d65223a225c75643830305c5c222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-5 2", "F2 high escape followed by an escaped quote", "7b226e616d65223a225c75643830305c22222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-5 3", "F3 high escape followed by an escaped newline", "7b226e616d65223a225c75643830305c6e222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-5 4", "F4 two high escapes then a low escape", "7b226e616d65223a225c75643830305c75643830305c7564633030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", true, [false,false,""], [false,false,""]],
  ["W7-5 5", "F5 valid pair U+10000 in upper case", "7b226e616d65223a225c75443830305c7544433030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"𐀀"], [true,false,"./lib/main.d.ts"]],
  ["W7-5 6", "F6 valid pair U+10000 in lower case", "7b226e616d65223a225c75643830305c7564633030222c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [true,false,"𐀀"], [true,false,"./lib/main.d.ts"]],
  ["W7-5 7", "F7 valid pair in a member name of an ignored nested object", "7b2278223a7b225c75643833645c7564653030223a317d2c227479706573223a222e2f6c69622f6d61696e2e642e7473227d", false, [false,false,""], [true,false,"./lib/main.d.ts"]],
  ["W7-5 8", "F8 root array holding a lone high escape", "5b225c7564383030225d", true, [false,false,""], [false,false,""]],
  ["W7-5 9", "F9 root string that is a lone high escape", "225c756438303022", true, [false,false,""], [false,false,""]],
  ["W7-5 10", "F10 root array holding a valid string", "5b226f6b225d", true, [false,false,""], [false,false,""]],
];

function field(value: { readonly Valid: boolean; readonly Null: boolean; readonly Value: string } | undefined): readonly [boolean, boolean, string] {
  return value === undefined ? [false, false, ""] : [value.Valid, value.Null, value.Value];
}

test("Parse gives the pinned library's result for every byte input of the four observed sets", () => {
  for (const [id, label, hex, error, name, types] of pinnedRows) {
    const data = Array.from(Buffer.from(hex, "hex")) as byte[];
    const [fields, parseError] = Parse(data);
    const observed = [parseError !== undefined, field(fields.__tsgoEmbedded0?.Name), field(fields.__tsgoEmbedded1?.Types)];
    assert.deepEqual(observed, [error, name, types], `${id}: ${label}`);
  }
});

test("a discarded duplicate value is checked, and the retained value is still the last one", () => {
  const [kept, keptError] = Parse(bytes('{"name":"first","name":"second"}'));
  assert.equal(keptError, undefined);
  assert.equal(kept.__tsgoEmbedded0!.Name.Value, "second");
  const [refused, refusedError] = Parse(bytes('{"name":"\\ud800","name":"second"}'));
  assert.notEqual(refusedError, undefined);
  assert.deepEqual(refused, {});
});

test("the string tokens are checked before the root's kind", () => {
  // A root array holding a lone high escape has both errors. Parse checks the string tokens first, so the error is the
  // token one, at the offset of the escape's backslash (2). (The pinned library, observed in run 24 row F8, names the root kind for this input: it refuses the
  // array at its first token, before it reads the string. Only whether there is an error is read by Parse's callers.)
  const [fields, error] = Parse(bytes('["\\ud800"]'));
  assert.deepEqual(fields, {});
  assert.match(String(error?.message), /^invalid surrogate pair in a string at offset 2$/);
  const [, rootError] = Parse(bytes('["ok"]'));
  assert.match(String(rootError?.message), /^cannot unmarshal a JSON array into package\.json fields$/);
});

test("a root that is not an object or null is refused with no fields", () => {
  for (const [root, refused] of [["null", false], ["{}", false], ['{"name":"x"}', false], ["[]", true], ['"s"', true], ["1", true], ["true", true], ["false", true]] as const) {
    const [fields, error] = Parse(bytes(root));
    assert.equal(error !== undefined, refused, root);
    if (refused) assert.deepEqual(fields, {}, root);
  }
});
