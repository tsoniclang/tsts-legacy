import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import type { SourceFileQueries, Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function checkedSource(sourceText: string, extraFiles: Readonly<Record<string, string>> = {}) {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": sourceText, ...extraFiles },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  });
  const checked = session.checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile !== undefined);
  return { session, checked, source: checked.getSourceFileQueries(sourceFile) };
}

function aliasType(source: SourceFileQueries, name: string): Type {
  const declaration = findNodes(source.sourceFile, source.ast.children, source.ast.is.IsTypeAliasDeclaration)
    .find(node => source.ast.text(source.ast.name(node)) === name);
  const node = source.ast.as.AsTypeAliasDeclaration(declaration)?.Type;
  assert.ok(node !== undefined, `Expected type alias ${name}.`);
  const type = source.checker.getTypeFromTypeNode(node);
  assert.ok(type !== undefined, `Expected resolved type for ${name}.`);
  return type;
}

test("numeric literal type values preserve exact checker numbers and signed bigint values", () => {
  const { source } = checkedSource(`
    type Small = 2;
    type NumericZero = 0;
    type Negative = -2;
    type Fractional = 1.5;
    type Unsafe = 9007199254740993;
    type NumericAlias = Small;
    type BigZero = 0n;
    type Huge = 9007199254740993n;
    type Adjacent = 9007199254740992n;
    type NegativeHuge = -9007199254740993n;
    type HexHuge = 0x20000000000001n;
    type SeparatedHuge = 9_007_199_254_740_993n;
    type BigAlias = Huge;
  `);
  const expected: Readonly<Record<string, number | bigint>> = {
    Small: 2,
    NumericZero: 0,
    Negative: -2,
    Fractional: 1.5,
    Unsafe: 9007199254740992,
    NumericAlias: 2,
    BigZero: 0n,
    Huge: 9007199254740993n,
    Adjacent: 9007199254740992n,
    NegativeHuge: -9007199254740993n,
    HexHuge: 9007199254740993n,
    SeparatedHuge: 9007199254740993n,
    BigAlias: 9007199254740993n,
  };
  for (const [name, value] of Object.entries(expected)) {
    const type = aliasType(source, name);
    assert.equal(source.typeShape.getNumericLiteralTypeValue(type), value, name);
    assert.equal(source.typeShape.getNumericLiteralTypeValue(type), value, `${name} repeated`);
  }
});

test("numeric literal type values do not guess open, union, intersection or nonnumeric types", () => {
  const { source } = checkedSource(`
    type OpenNumber = number;
    type OpenBigInt = bigint;
    type OpenEither = number | bigint;
    type NumericUnion = 1 | 2;
    type BigIntUnion = 1n | 2n;
    type MixedUnion = 2 | 2n;
    type Branded = 2 & { readonly brand: "count" };
    type Unbound<Count extends number> = Count;
    type Anything = any;
    type Nothing = never;
    type Uncertain = unknown;
    type Text = "2";
    type Truth = true;
    type RecordCount = { readonly count: 2 };
  `);
  for (const name of ["OpenNumber", "OpenBigInt", "OpenEither", "NumericUnion", "BigIntUnion",
    "MixedUnion", "Branded", "Unbound", "Anything", "Nothing", "Uncertain", "Text", "Truth", "RecordCount"]) {
    assert.equal(source.typeShape.getNumericLiteralTypeValue(aliasType(source, name)), undefined, name);
  }
  assert.equal(source.typeShape.getNumericLiteralTypeValue(undefined), undefined);
});

test("numeric literal queries retain imported aliases and selected generic arguments across source owners", () => {
  const { session, checked, source } = checkedSource(`
    import { identity, huge } from "./counts.js";
    import type { Huge as ImportedHuge } from "./counts.js";
    type LocalHuge = ImportedHuge;
    const fresh = 2;
    let openNumber: number = 2;
    let openBigInt: bigint = 2n;
    identity(fresh);
    identity(huge);
    identity(openNumber);
    identity(openBigInt);
  `, {
    "/src/counts.ts": `
      export type Huge = 9007199254740993n;
      export declare const huge: Huge;
      export function identity<Count extends number | bigint>(count: Count): Count { return count; }
    `,
  });
  const foreignFile = checked.getSourceFile("/src/counts.ts");
  assert.ok(foreignFile !== undefined);
  const foreign = checked.getSourceFileQueries(foreignFile);
  const localType = aliasType(source, "LocalHuge");
  const foreignType = aliasType(foreign, "Huge");
  for (const queries of [source.typeShape, foreign.typeShape]) {
    for (const type of [localType, foreignType]) {
      assert.equal(queries.getNumericLiteralTypeValue(type), 9007199254740993n);
    }
  }
  const calls = findNodes(source.sourceFile, source.ast.children, source.ast.is.IsCallExpression);
  assert.equal(calls.length, 4);
  const expected = [2, 9007199254740993n, undefined, undefined];
  for (const [index, call] of calls.entries()) {
    const selected = source.checker.getResolvedCallInfo(call);
    assert.equal(selected?.outcome, "applicable");
    assert.ok(selected?.outcome === "applicable");
    const argument = selected.sourceSelectedMethodTypeArguments?.[0];
    assert.ok(argument !== undefined);
    assert.equal(source.typeShape.getNumericLiteralTypeValue(argument.selectedType), expected[index]);
    assert.equal(source.typeShape.getNumericLiteralTypeValue(selected.sourceResultType), expected[index]);
  }
  assert.deepEqual(session.checkSource().diagnostics, checked.diagnostics);
  assert.deepEqual(session.checkSource().extensionDiagnostics, checked.extensionDiagnostics);
});
