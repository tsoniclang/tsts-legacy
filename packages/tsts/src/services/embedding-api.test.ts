import { requireApplicableCallInfo } from "./type-checker-test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoPtr } from "../go/compat.js";
import type { Node } from "../internal/ast/ast.js";
import type { AstReader } from "./ast-reader.js";
import { getExtensionHost } from "../extensions/host.js";
import {
  TstsSourceProviderContractVersion,
  argumentPassingFactKey,
  associatedTypeFactKey,
  attributeFactKey,
  canonicalIdentityFactKey,
  constGenericFactKey,
  createCompilerSessionFromFiles,
  defaultValueFactKey,
  fieldFactKey,
  flowStateFactKey,
  functionPointerFactKey,
  pointerFactKey,
  pointerOperationFactKey,
  rawPointerFactKey,
  rawPointerOperationFactKey,
  providerTypeFamilyFactKey,
  providerVirtualDeclarationFactKey,
  sourcePrimitiveFactKey,
  structFactKey,
  type CompilerExtension,
  type ProviderDeclarationModel,
} from "../index.js";

const core = [
  "interface Object {}",
  "interface Function {}",
  "interface CallableFunction extends Function {}",
  "interface NewableFunction extends Function {}",
  "interface IArguments {}",
  "interface String {}",
  "interface Number {}",
  "interface Boolean {}",
  "interface RegExp {}",
  "interface Array<T> { readonly length: number; [index: number]: T; }",
].join("\n");

test("public root exports the complete source-only fact vocabulary", () => {
  assert.deepEqual(
    [
      argumentPassingFactKey,
      associatedTypeFactKey,
      attributeFactKey,
      canonicalIdentityFactKey,
      constGenericFactKey,
      defaultValueFactKey,
      fieldFactKey,
      flowStateFactKey,
      functionPointerFactKey,
      pointerFactKey,
      pointerOperationFactKey,
      rawPointerFactKey,
      rawPointerOperationFactKey,
      providerTypeFamilyFactKey,
      providerVirtualDeclarationFactKey,
      sourcePrimitiveFactKey,
      structFactKey,
    ].map((key) => [key.extensionId, key.name]),
    [
      ["tsts.source-semantics", "argumentPassing"],
      ["tsts.source-semantics", "associatedType"],
      ["tsts.source-semantics", "attribute"],
      ["tsts.source-semantics", "canonicalIdentity"],
      ["tsts.source-semantics", "constGeneric"],
      ["tsts.source-semantics", "defaultValue"],
      ["tsts.source-semantics", "field"],
      ["tsts.source-semantics", "flowState"],
      ["tsts.source-semantics", "functionPointer"],
      ["tsts.source-semantics", "pointer"],
      ["tsts.source-semantics", "pointerOperation"],
      ["tsts.source-semantics", "rawPointer"],
      ["tsts.source-semantics", "rawPointerOperation"],
      ["tsts.provider", "typeFamily"],
      ["tsts.provider", "virtualDeclaration"],
      ["tsts.source-semantics", "sourcePrimitive"],
      ["tsts.source-semantics", "struct"],
    ],
  );
});

test("public embedding API checks a provider-backed program through direct source queries", () => {
  const moduleSpecifier = "@test/public/runtime.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Public.Runtime",
    exports: [{
      id: "consume",
      name: "consume",
      kind: "function",
      signatures: [{
        id: "consume(number)",
        parameters: [{ name: "value", type: { kind: "number" } }],
        returnType: { kind: "void" },
      }],
    }],
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        `import { consume } from "${moduleSpecifier}";`,
        "consume(1);",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
    extensionHostOptions: { extensions: [providerExtension(model)] },
  });

  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.equal(Object.isFrozen(checked.ast), true);
  assert.equal("extensionHost" in session, false);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile !== undefined);
  const source = checked.getSourceFileQueries(sourceFile);
  assert.equal(Object.isFrozen(source.checker), true);
  assert.equal(Object.isFrozen(source.typeShape), true);
  const call = findNode(sourceFile, checked.ast, (node) => checked.ast.is.IsCallExpression(node));
  const selected = requireApplicableCallInfo(source.checker.getResolvedCallInfo(call));
  assert.equal(selected?.kind, "applicable");
  assert.equal(source.checker.typeToString(selected?.resultType), "void");
  assert.equal(
    checked.sourceFacts?.getFact(
      source.checker.getSignatureDeclaration(selected?.selection.application.instantiatedSignature),
      providerVirtualDeclarationFactKey,
    )?.signatureId,
    "consume(number)",
  );
});

test("public AST reader distinguishes declaration-list kinds from const enum modifiers", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        "var a = 1;",
        "let b = 2;",
        "const c = 3;",
        "using d = resource;",
        "await using e = asyncResource;",
        "const enum Choice { A }",
        "declare const resource: { [Symbol.dispose](): void };",
        "declare const asyncResource: { [Symbol.asyncDispose](): PromiseLike<void> };",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const lists = collectNodes(sourceFile, checked.ast, (node) => checked.ast.is.IsVariableDeclarationList(node));
  assert.deepEqual(lists.slice(0, 5).map(checked.ast.variableDeclarationKind), [
    "var",
    "let",
    "const",
    "using",
    "await using",
  ]);
  const enumDeclaration = findNode(sourceFile, checked.ast, (node) => checked.ast.is.IsEnumDeclaration(node));
  assert.equal(checked.ast.hasModifierKind(enumDeclaration, "const"), true);
  assert.equal(checked.ast.variableDeclarationKind(enumDeclaration), undefined);
});

test("public AST reader exposes exact regular-expression literal syntax", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        "const simple = /simple/g;",
        String.raw`const escaped = /a\/b[\/]/dgu;`,
        "const unicode = /💚/u;",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
      target: "esnext",
    },
  });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const literals = collectNodes(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsRegularExpressionLiteral(node),
  );
  assert.deepEqual(literals.map(checked.ast.regularExpressionLiteral), [
    { pattern: "simple", flags: "g" },
    { pattern: "a\\/b[\\/]", flags: "dgu" },
    { pattern: "💚", flags: "u" },
  ]);
  assert.equal(
    Object.isFrozen(checked.ast.regularExpressionLiteral(literals[0])),
    true,
  );
  assert.equal(checked.ast.regularExpressionLiteral(sourceFile), undefined);
});

test("public AST reader exposes exact optional-parameter question tokens", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": "export function run(required: string, optional?: number): void {}",
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.equal(checked.ast.isDeclarationFile(checked.getSourceFile("/src/core.d.ts")), true);
  assert.equal(checked.ast.isDeclarationFile(sourceFile), false);
  const parameters = collectNodes(sourceFile, checked.ast, (node) => checked.ast.is.IsParameterDeclaration(node));
  assert.equal(parameters.length, 2);
  assert.equal(checked.ast.questionToken(parameters[0]), undefined);
  assert.equal(checked.ast.kindName(checked.ast.questionToken(parameters[1])), "KindQuestionToken");
  assert.equal(checked.ast.questionToken(sourceFile), undefined);
});

test("public AST reader exposes trivia-free UTF-16 authored ranges", () => {
  const sourceText = [
    "// 😀 before the call",
    "const prefix = \"😀\";",
    "declare function value(): number;",
    "export const result = /* leading */ value(); // trailing",
  ].join("\r\n");
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": sourceText,
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const call = findNode(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsCallExpression(node),
  );
  const range = checked.ast.authoredRange(call);
  const expectedStart = sourceText.indexOf("value();");
  assert.deepEqual(range, {
    kind: "authored",
    start: expectedStart,
    end: expectedStart + "value()".length,
  });
  assert.equal(
    range.kind === "authored" ? sourceText.slice(range.start, range.end) : "",
    "value()",
  );
  assert.deepEqual(checked.ast.authoredRange(undefined), { kind: "synthetic" });
});

test("public AST reader converts UTF-8 byte ranges of the checked text to UTF-16 and refuses misuse", () => {
  const ascii = "export const a = 1;\n";
  const mixed = "// é€\u{1f600}\r\nexport const b = \"﻿\";\r\n";
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/ascii.ts", "/src/mixed.ts", "/src/empty.ts"],
    files: { "/src/core.d.ts": core, "/src/ascii.ts": ascii, "/src/mixed.ts": mixed, "/src/empty.ts": "" },
    compilerOptions: { noLib: true, module: "esnext", moduleResolution: "bundler" },
  });
  const checked = session.checkSource();
  const asciiFile = checked.getSourceFile("/src/ascii.ts");
  const mixedFile = checked.getSourceFile("/src/mixed.ts");
  assert.equal(checked.ast.getSourceText(asciiFile), ascii);
  assert.equal(checked.ast.getSourceText(mixedFile), mixed);
  assert.equal(ascii.length, 20);
  assert.equal(mixed.length, 32);
  const emptyFile = checked.getSourceFile("/src/empty.ts");
  assert.equal(emptyFile === undefined, false);
  assert.equal(checked.ast.getSourceText(emptyFile), "");

  const source = (file: typeof asciiFile, text: string, startByte: number, endByte: number, start: number, end: number, slice: string): void => {
    const label = `${startByte},${endByte}`;
    assert.deepEqual(checked.ast.sourceRange(file, startByte, endByte), { kind: "source", start, end }, label);
    assert.equal(text.slice(start, end), slice, label);
  };
  source(asciiFile, ascii, 0, 20, 0, 20, ascii);
  source(asciiFile, ascii, 7, 12, 7, 12, "const");
  source(asciiFile, ascii, 5, 5, 5, 5, "");
  source(asciiFile, ascii, 20, 20, 20, 20, "");
  source(mixedFile, mixed, 0, 39, 0, 32, mixed);
  source(mixedFile, mixed, 3, 5, 3, 4, "é");
  source(mixedFile, mixed, 5, 8, 4, 5, "€");
  source(mixedFile, mixed, 8, 12, 5, 7, "\u{1f600}");
  source(mixedFile, mixed, 12, 14, 7, 9, "\r\n");
  source(mixedFile, mixed, 14, 20, 9, 15, "export");
  source(mixedFile, mixed, 32, 35, 27, 28, "﻿");
  source(mixedFile, mixed, 39, 39, 32, 32, "");
  source(emptyFile, "", 0, 0, 0, 0, "");

  const startNumber = "sourceRange startByte must be a non-negative safe integer";
  const endNumber = "sourceRange endByte must be a non-negative safe integer";
  const order = "sourceRange startByte is greater than endByte";
  const past = "sourceRange endByte is past the end of the source text";
  const startInside = "sourceRange startByte is inside a UTF-8 character";
  const endInside = "sourceRange endByte is inside a UTF-8 character";
  const misuse: readonly (readonly [typeof asciiFile, number, number, string])[] = [
    [mixedFile, -1, 3, startNumber], [mixedFile, 1.5, 3, startNumber], [mixedFile, Number.NaN, 3, startNumber],
    [mixedFile, -0, 3, startNumber], [mixedFile, 0, Number.POSITIVE_INFINITY, endNumber], [mixedFile, 0, 2 ** 53, endNumber],
    [mixedFile, 5, 3, order], [mixedFile, 0, 40, past], [asciiFile, 0, 21, past],
    [mixedFile, 4, 5, startInside], [mixedFile, 6, 8, startInside], [mixedFile, 7, 8, startInside],
    [mixedFile, 9, 12, startInside], [mixedFile, 10, 12, startInside], [mixedFile, 11, 12, startInside],
    [mixedFile, 8, 9, endInside], [mixedFile, 8, 10, endInside], [mixedFile, 8, 11, endInside],
    [mixedFile, 33, 35, startInside], [mixedFile, 32, 34, endInside],
    [undefined, -1, 0, startNumber], [undefined, 5, 3, order],
    [emptyFile, 0, 1, past],
  ];
  for (const [file, startByte, endByte, message] of misuse) {
    assert.throws(() => checked.ast.sourceRange(file, startByte, endByte),
      (error: unknown) => error instanceof RangeError && error.message === message, `${startByte},${endByte}`);
  }
  assert.deepEqual(checked.ast.sourceRange(undefined, 0, 0), { kind: "unavailable" });
  assert.deepEqual(checked.ast.sourceRange(undefined, 3, 9), { kind: "unavailable" });
});

test("public AST reader maps every character boundary of non-ASCII source texts", () => {
  // `mixed` has its non-ASCII characters in a comment. `literals` has them only
  // inside a string literal and a template literal, with ASCII statements after.
  const mixed = "// é€\u{1f600}\r\nexport const b = 1;\r\n";
  const literals = "export const s = \"é\";\nexport const u = `€\u{1f600}`;\nexport const t = 1;\n";
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/mixed.ts", "/src/literals.ts"],
    files: { "/src/core.d.ts": core, "/src/mixed.ts": mixed, "/src/literals.ts": literals },
    compilerOptions: { noLib: true, module: "esnext", moduleResolution: "bundler" },
  });
  const checked = session.checkSource();
  const mixedFile = checked.getSourceFile("/src/mixed.ts");
  const literalsFile = checked.getSourceFile("/src/literals.ts");
  const encoder = new globalThis.TextEncoder();
  const decoder = new globalThis.TextDecoder("utf-8", { fatal: true });

  const cases: ReadonlyArray<readonly [typeof mixedFile, string, number, number]> = [
    [mixedFile, mixed, 35, 30],
    [literalsFile, literals, 71, 66],
  ];
  for (const [file, text, byteLength, boundaryCount] of cases) {
    assert.equal(checked.ast.getSourceText(file), text);
    const bytes = encoder.encode(text);
    assert.equal(bytes.length, byteLength);
    let boundaries = 0;
    for (let startByte = 0; startByte <= bytes.length; startByte++) {
      if (startByte < bytes.length && (bytes[startByte]! & 0xc0) === 0x80) {
        continue;
      }
      boundaries++;
      const range = checked.ast.sourceRange(file, startByte, bytes.length);
      assert.equal(
        range.kind === "source" ? text.slice(range.start, range.end) : undefined,
        decoder.decode(bytes.subarray(startByte)),
        `${startByte},${bytes.length}`,
      );
    }
    assert.equal(boundaries, boundaryCount);
  }

  // The statement after the literals: bytes 51..70 are UTF-16 units 46..65.
  const lastStatement = checked.ast.sourceRange(literalsFile, 51, 70);
  assert.deepEqual(lastStatement, { kind: "source", start: 46, end: 65 });
  assert.equal(literals.slice(46, 65), "export const t = 1;");
  const one = findNode(literalsFile, checked.ast, (node) => checked.ast.is.IsNumericLiteral(node));
  assert.deepEqual(checked.ast.authoredRange(one), { kind: "authored", start: 63, end: 64 });
  assert.equal(literals.slice(63, 64), "1");
});

test("public AST reader skips a shebang, comments and conflict markers to the token start", () => {
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
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/mixed.ts", "/src/ascii.ts"],
    files: { "/src/core.d.ts": core, "/src/mixed.ts": mixed, "/src/ascii.ts": ascii },
    compilerOptions: { noLib: true, module: "esnext", moduleResolution: "bundler" },
  });
  const checked = session.checkSource();
  // UTF-16 offsets of the two statements that are not inside a conflict section.
  const cases: ReadonlyArray<readonly [string, string, number, number]> = [
    ["/src/mixed.ts", mixed, 74, 137],
    ["/src/ascii.ts", ascii, 73, 136],
  ];
  for (const [fileName, text, startA, startC] of cases) {
    const file = checked.getSourceFile(fileName);
    assert.equal(checked.ast.getSourceText(file), text);
    assert.equal(text.indexOf("export const a = 1;"), startA, fileName);
    assert.equal(text.indexOf("export const c = 3;"), startC, fileName);
    const statements = collectNodes(file, checked.ast, (node) => checked.ast.is.IsVariableStatement(node));
    assert.equal(statements.length, 2, `${fileName}: the statement between ======= and >>>>>>> is trivia`);
    assert.deepEqual(checked.ast.authoredRange(statements[0]), { kind: "authored", start: startA, end: startA + 19 }, fileName);
    assert.deepEqual(checked.ast.authoredRange(statements[1]), { kind: "authored", start: startC, end: startC + 19 }, fileName);
  }
});

test("public AST reader exposes exact authored type nodes", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        "type Mapper<T, U> = (value: T) => U;",
        "function map<T, U>(value: T, mapper: Mapper<T, U>): U {",
        "  return mapper(value);",
        "}",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const call = findNode(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsCallExpression(node),
  );
  const selected = checked.getSourceFileQueries(sourceFile).checker
    .getResolvedCallInfo(call);
  assert.equal(selected?.kind, "applicable");
  const declaration = checked.getSourceFileQueries(sourceFile).checker
    .getSignatureDeclaration(selected?.selection.application.instantiatedSignature);
  assert.equal(checked.ast.kindName(declaration), "KindFunctionType");
  const returnType = checked.ast.typeNode(declaration);
  assert.equal(checked.ast.is.IsTypeReferenceNode(returnType), true);
  assert.equal(
    checked.ast.text(checked.ast.as.AsTypeReferenceNode(returnType)?.TypeName),
    "U",
  );
  assert.equal(checked.ast.typeNode(sourceFile), undefined);
});

test("public AST reader exposes TS-Go's exact const-assertion classification", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        "const asConst = 1 as const;",
        "const angleConst = <const>2;",
        "const ordinary = 3 as number;",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const assertions = collectNodes(
    sourceFile,
    checked.ast,
    (node) =>
      checked.ast.is.IsAsExpression(node) ||
      checked.ast.is.IsTypeAssertion(node),
  );
  assert.equal(assertions.length, 3);
  assert.deepEqual(assertions.map(checked.ast.isConstAssertion), [
    true,
    true,
    false,
  ]);
  assert.equal(checked.ast.isConstAssertion(sourceFile), false);
});

test("public AST reader exposes exact expression and type operator kinds", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        "let left = 1;",
        "let right = 2;",
        "left + right;",
        "++left;",
        "right--;",
        "type Keys = keyof { value: number };",
        "type Values = readonly number[];",
        "declare const identity: unique symbol;",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const binary = findNode(sourceFile, checked.ast, (node) => checked.ast.is.IsBinaryExpression(node));
  const prefix = findNode(sourceFile, checked.ast, (node) => checked.ast.is.IsPrefixUnaryExpression(node));
  const postfix = findNode(sourceFile, checked.ast, (node) => checked.ast.is.IsPostfixUnaryExpression(node));
  const typeOperators = collectNodes(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsTypeOperatorNode(node),
  );
  assert.equal(checked.ast.operatorKindName(binary), "KindPlusToken");
  assert.equal(checked.ast.operatorKindName(prefix), "KindPlusPlusToken");
  assert.equal(checked.ast.operatorKindName(postfix), "KindMinusMinusToken");
  assert.deepEqual(typeOperators.map(checked.ast.operatorKindName), [
    "KindKeyOfKeyword",
    "KindReadonlyKeyword",
    "KindUniqueKeyword",
  ]);
  assert.equal(checked.ast.operatorKindName(sourceFile), undefined);
});

test("public AST reader classifies import and export type-only syntax without speculative casts", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        'import "./setup.js";',
        'import type { Shape as FullType } from "./types.js";',
        'import { type Shape as InlineType } from "./types.js";',
        'import { type Shape as MixedType, value } from "./types.js";',
        'import DefaultValue, { type Shape as DefaultType } from "./types.js";',
        'import DefaultOnly from "./types.js";',
        'import * as namespaceValue from "./types.js";',
        'import type * as namespaceType from "./types.js";',
        'import {} from "./types.js";',
        'export type { Shape as ExportType } from "./types.js";',
        'export { type Shape as InlineExportType } from "./types.js";',
        'export { type Shape as MixedExportType, value as exportedValue } from "./types.js";',
      ].join("\n"),
      "/src/setup.ts": "export {};",
      "/src/types.ts": [
        "export interface Shape {}",
        "export const value = 1;",
        "export default value;",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
  });
  const checked = session.checkSource();
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const imports = collectNodes(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsImportDeclaration(node),
  );
  assert.deepEqual(
    imports.map(checked.ast.isTypeOnlyImportDeclaration),
    [false, true, false, false, false, false, false, true, false],
  );

  const importSpecifiers = collectNodes(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsImportSpecifier(node),
  );
  assert.deepEqual(
    importSpecifiers.map(checked.ast.isTypeOnlyImportOrExportDeclaration),
    [true, true, true, false, true],
  );

  const exportSpecifiers = collectNodes(
    sourceFile,
    checked.ast,
    (node) => checked.ast.is.IsExportSpecifier(node),
  );
  assert.deepEqual(
    exportSpecifiers.map(checked.ast.isTypeOnlyImportOrExportDeclaration),
    [true, true, true, false],
  );
  assert.equal(checked.ast.isTypeOnlyImportDeclaration(sourceFile), false);
  assert.equal(checked.ast.isTypeOnlyImportOrExportDeclaration(sourceFile), false);
});

test("public provider contract keeps package subpaths as independent source modules", () => {
  const left: ProviderDeclarationModel = {
    moduleSpecifier: "@test/package/left.js",
    providerModuleId: "Test.Package.Left",
    exports: [{ id: "Left", name: "Left", kind: "class" }],
  };
  const right: ProviderDeclarationModel = {
    moduleSpecifier: "@test/package/right.js",
    providerModuleId: "Test.Package.Right",
    exports: [{ id: "Right", name: "Right", kind: "class" }],
  };
  const models = new Map([
    [left.moduleSpecifier, left],
    [right.moduleSpecifier, right],
  ]);
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": core,
      "/src/index.ts": [
        `import type { Left } from "${left.moduleSpecifier}";`,
        `import type { Right } from "${right.moduleSpecifier}";`,
        "export type Pair = [Left, Right];",
      ].join("\n"),
    },
    compilerOptions: {
      noLib: true,
      module: "esnext",
      moduleResolution: "bundler",
    },
    extensionHostOptions: {
      extensions: [providerExtension(left, models)],
    },
  });

  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const documents = getExtensionHost(session.program!)?.providers.getVirtualDeclarationDocuments() ?? [];
  assert.equal(documents.some((document) => document.moduleSpecifier === left.moduleSpecifier), true);
  assert.equal(documents.some((document) => document.moduleSpecifier === right.moduleSpecifier), true);
  assert.notEqual(
    documents.find((document) => document.moduleSpecifier === left.moduleSpecifier)?.fileName,
    documents.find((document) => document.moduleSpecifier === right.moduleSpecifier)?.fileName,
  );
});

function providerExtension(
  firstModel: ProviderDeclarationModel,
  suppliedModels = new Map([[firstModel.moduleSpecifier, firstModel]]),
): CompilerExtension {
  return {
    identity: {
      id: "test.public-provider-extension",
      version: "1.0.0",
    },
    initialize(context): void {
      context.registerSourceDeclarationProvider({
        identity: {
          id: "test.public-provider",
          version: "1.0.0",
          extensionContractVersion: TstsSourceProviderContractVersion,
        },
        declarationMaterialization: "complete",
        ownsModule: (specifier) => suppliedModels.has(specifier)
          ? { kind: "owned" }
          : { kind: "unowned" },
        resolveModule(specifier) {
          const model = suppliedModels.get(specifier);
          if (model === undefined) {
            throw new Error(`Provider resolved unowned module '${specifier}'.`);
          }
          return {
            kind: "virtual",
            moduleSpecifier: specifier,
            virtualFileName: `/provider/${model.providerModuleId}.d.ts`,
            providerModuleId: model.providerModuleId,
            packageName: "@test/package",
            packageVersion: "1.0.0",
          };
        },
        getDeclarationModel(resolution) {
          const model = suppliedModels.get(resolution.moduleSpecifier);
          if (model === undefined) {
            throw new Error(`Provider model missing for '${resolution.moduleSpecifier}'.`);
          }
          return model;
        },
      });
    },
  };
}

function findNode(
  root: GoPtr<Node>,
  ast: AstReader,
  predicate: (node: GoPtr<Node>) => boolean,
): GoPtr<Node> {
  const matches = collectNodes(root, ast, predicate);
  assert.ok(matches.length > 0);
  return matches[0];
}

function collectNodes(
  root: GoPtr<Node>,
  ast: AstReader,
  predicate: (node: GoPtr<Node>) => boolean,
): Node[] {
  const matches: Node[] = [];
  const visit = (node: GoPtr<Node>): void => {
    if (node === undefined) {
      return;
    }
    if (predicate(node)) {
      matches.push(node);
    }
    for (const child of ast.children(node)) {
      visit(child);
    }
  };
  visit(root);
  return matches;
}
