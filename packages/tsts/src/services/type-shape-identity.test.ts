import assert from "node:assert/strict";
import test from "node:test";
import { createCompilerSessionFromFiles, type SourceFileQueries, type Type } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";

function identityFixture() {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/contracts.ts": `
        export class Box<Value> { value!: Value; read(): Value { return this.value; } }
        export class First { private value!: number; }
        export class Second { private value!: number; }
        export type Fields<Value> = { readonly [Name in keyof Value]?: Value[Name] };
        export function local<Value>(input: Value) {
          return class Entry { readValue(): Value { return input; } };
        }
      `,
      "/src/left.ts": `
        import { Box, First, Fields, local } from "./contracts.js";
        export declare const numeric: Box<number>;
        export declare const first: First;
        export declare const mapped: Fields<{ count: number; label: string }>;
        const Entry = local(1);
        export const entry = new Entry();
      `,
      "/src/right.ts": `
        import { Box, First, Second, Fields, local } from "./contracts.js";
        export declare const numeric: Box<number>;
        export declare const textual: Box<string>;
        export declare const first: First;
        export declare const second: Second;
        export declare const mapped: Fields<{ count: number; label: string }>;
        export declare const differentMapped: Fields<{ count: string; label: string }>;
        const Entry = local(1);
        const TextEntry = local("text");
        export const entry = new Entry();
        export const textEntry = new TextEntry();
      `,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  }).checkSource();
  assert.equal(checked.diagnostics.length, 0, "the exact identity fixture is checked successfully");
  assert.equal(checked.extensionDiagnostics.length, 0, "the fixture requires no extension diagnostic");
  const queriesFor = (path: string): SourceFileQueries => {
    const file = checked.getSourceFile(path);
    assert.equal(file !== undefined, true, `${path}: original checked source file`);
    return checked.getSourceFileQueries(file!);
  };
  const left = queriesFor("/src/left.ts");
  const right = queriesFor("/src/right.ts");
  const typeFor = (queries: SourceFileQueries, name: string): Type => {
    const declarations = findNodes(queries.sourceFile, queries.ast.children, queries.ast.is.IsVariableDeclaration);
    const declaration = declarations.find(node => queries.ast.text(queries.ast.name(node)) === name);
    assert.equal(declaration !== undefined, true, `${name}: original authored variable`);
    const type = queries.checker.getTypeAtLocation(queries.ast.name(declaration));
    assert.equal(type !== undefined, true, `${name}: actual checked type`);
    return type!;
  };
  return { checked, left, right, typeFor };
}

function assertIdentityInBothOrders(
  queries: SourceFileQueries,
  left: Type,
  right: Type,
  expected: boolean,
  label: string,
): void {
  assert.equal(queries.typeShape.isTypeIdenticalTo(left, right), expected, `${label}: forward identity`);
  assert.equal(queries.typeShape.isTypeIdenticalTo(right, left), expected, `${label}: reverse identity`);
}

test("public identity preserves exact generic instances obtained from different checked files", () => {
  const { left, right, typeFor } = identityFixture();
  const numericLeft = typeFor(left, "numeric");
  const numericRight = typeFor(right, "numeric");
  assert.equal(numericLeft.checker === numericRight.checker, true, "the public queries use the same native API semantic owner");
  left.typeShape.getPropertyInfos(numericLeft);
  right.typeShape.getPropertyInfos(numericRight);
  assertIdentityInBothOrders(left, numericLeft, numericRight, true, "identical Box<number> instances");
  assertIdentityInBothOrders(right, numericLeft, typeFor(right, "textual"), false, "Box<number> versus Box<string>");
});

test("public identity keeps declaration-private identities across checker owners", () => {
  const { left, right, typeFor } = identityFixture();
  const first = typeFor(left, "first");
  assertIdentityInBothOrders(right, first, typeFor(right, "first"), true, "the identical private declaration");
  assertIdentityInBothOrders(left, first, typeFor(right, "second"), false, "distinct private declarations");
});

test("public identity preserves mapped optional readonly member instantiations", () => {
  const { left, right, typeFor } = identityFixture();
  const mappedLeft = typeFor(left, "mapped");
  const mappedRight = typeFor(right, "mapped");
  for (const [queries, type] of [[left, mappedLeft], [right, mappedRight]] as const) {
    const fields = queries.typeShape.getPropertyInfos(type);
    assert.equal(fields.length, 2, "the actual mapped member inventory is complete");
    assert.equal(fields.every(field => field.optional && field.readonly), true, "optional and readonly flags are preserved");
  }
  assertIdentityInBothOrders(right, mappedLeft, mappedRight, true, "identical mapped members");
  assertIdentityInBothOrders(left, mappedLeft, typeFor(right, "differentMapped"), false, "unequal mapped payloads");
});

test("public identity preserves local-class outer instantiations across imports", () => {
  const { left, right, typeFor } = identityFixture();
  const entry = typeFor(left, "entry");
  assertIdentityInBothOrders(right, entry, typeFor(right, "entry"), true, "the same local class and outer value type");
  assertIdentityInBothOrders(left, entry, typeFor(right, "textEntry"), false, "different outer value types");
});

test("public identity rejects separate checked programs with identical file and declaration spellings", () => {
  const original = identityFixture();
  const foreign = identityFixture();
  const originalType = original.typeFor(original.left, "numeric");
  const foreignType = foreign.typeFor(foreign.left, "numeric");
  assertIdentityInBothOrders(original.left, originalType, foreignType, false, "different checked programs");
  assert.equal(original.left.typeShape.isTypeIdenticalTo(foreignType, foreignType), false,
    "an identical foreign object is not admitted by the original query owner");
  assert.throws(() => original.checked.getSourceFileQueries(foreign.left.sourceFile),
    (error: unknown) => error instanceof Error &&
      error.message === "Source-file queries require an exact source file from the checked program.",
    "foreign file identity is rejected before creating a query owner");
  assertIdentityInBothOrders(foreign.right, foreignType, foreign.typeFor(foreign.right, "numeric"), true,
    "the separate program retains its own coherent identity");
});

test("public identity is independent of file query and member inspection order", () => {
  for (const reverse of [false, true]) {
    const { left, right, typeFor } = identityFixture();
    const first = reverse ? right : left;
    const second = reverse ? left : right;
    const firstType = typeFor(first, "mapped");
    first.typeShape.getPropertyInfos(firstType);
    const secondType = typeFor(second, "mapped");
    second.typeShape.getPropertyInfos(secondType);
    assert.equal(firstType.checker === secondType.checker, true, "query order preserves the native API owner");
    assertIdentityInBothOrders(first, firstType, secondType, true, "member inspection order");
  }
});
