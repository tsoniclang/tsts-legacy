import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  sourcePrimitive,
  sourcePrimitiveFactKey,
} from "../index.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import { SymbolFlagsAlias } from "../internal/ast/generated/flags.js";
import { configuredSourcePrimitiveOperand } from "./compiler-integration.js";
import type { ProviderDeclarationModel } from "./host.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const primitives = [
  sourcePrimitive("WideSigned", "int64", "bigint", true, 64),
  sourcePrimitive("WideUnsigned", "uint64", "bigint", false, 64),
  sourcePrimitive("NarrowSigned", "int32", "number", true, 32),
  sourcePrimitive("NarrowUnsigned", "uint32", "number", false, 32),
] as const;
const moduleSpecifier = "@test/native-shift-inputs";
const model: ProviderDeclarationModel = {
  moduleSpecifier,
  providerModuleId: "Test.NativeShiftInputs",
  exports: primitives.map(primitive => ({
    id: primitive.exportName,
    name: primitive.exportName,
    kind: "type",
    type: { kind: "source-primitive", name: primitive.primitive },
  })),
};

function session(program: string, configured = true) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/foreign.ts": "export type WideSigned = bigint; export type NarrowSigned = number;",
      "/src/index.ts": program,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "esnext" },
    extensionHostOptions: { extensions: [
      sourceProviderExtension(new Map([[moduleSpecifier, model]])),
      ...(configured ? [createSourceSemanticsExtension({ modules: [{ moduleSpecifier, exports: primitives }] })] : []),
    ] },
  });
}

function checked(program: string) {
  const result = session(program).checkSource();
  assert.equal(result.extensionDiagnostics.length, 0, "only the configured declaration owner supplies primitive facts");
  return result;
}

function noDiagnostics(program: string) {
  const result = checked(program);
  assert.equal(result.diagnostics.length, 0, result.diagnostics.map(Diagnostic_String).join("\n"));
  return result;
}

function rejected(program: string) {
  const result = checked(program);
  assert.equal(result.diagnostics.some(issue => Diagnostic_Code(issue) === 2365), true,
    `unproven or ordinary backing operands keep the frontend operator refusal: ${program}`);
}

function leftPrimitiveFact(current: ReturnType<typeof checked>) {
  const file = current.getSourceFile("/src/index.ts");
  if (file === undefined) throw new Error("The original checked program is required.");
  const binaries = findNodes(file, current.ast.children, current.ast.is.IsBinaryExpression);
  assert.equal(binaries.length, 1, "one exact original operation is retained");
  const binary = current.ast.as.AsBinaryExpression(binaries[0]);
  if (binary === undefined) throw new Error("The original binary operation is required.");
  const checker = current.getSourceFileQueries(file).checker;
  return configuredSourcePrimitiveOperand(current.program, binary.Left, node => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && (symbol.Flags & SymbolFlagsAlias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  });
}

const imports = `import type { ${primitives.map(primitive => primitive.exportName).join(", ")} } from "${moduleSpecifier}";`;

test("configured shift inputs admit every exact native left/count declaration without a backing-kind choice", () => {
  for (const left of primitives) for (const count of [primitives[2], primitives[0]]) {
    for (const operator of ["<<", ">>", ">>>", "<<=", ">>=", ">>>="]) {
      const current = noDiagnostics(`${imports}
        export function run(value: ${left.exportName}, count: ${count.exportName}): ${left.exportName} {
          return value ${operator} count;
        }`);
      const file = current.getSourceFile("/src/index.ts");
      const annotations = findNodes(file, current.ast.children, current.ast.is.IsTypeReferenceNode);
      assert.equal(annotations.length, 3, "the original two parameters and return annotation remain");
      for (const [index, expected] of [left, count, left].entries()) {
        const fact = current.sourceFacts.getFact(annotations[index], sourcePrimitiveFactKey);
        assert.equal(fact?.kind, expected.primitive, "the selected original annotation retains its exact primitive");
        assert.equal(fact?.runtimeBase, expected.runtimeBase, "native admission does not replace the backing type");
      }
    }
  }
});

test("configured renamed, namespace, parenthesized and transparent aliases select original declaration facts", () => {
  noDiagnostics(`import type { WideSigned as Value, NarrowSigned as Count } from "${moduleSpecifier}";
    import type * as values from "${moduleSpecifier}";
    type Local = (Value); type Nested = Local; type Shift = values.NarrowSigned;
    export function run(value: Nested, count: Shift) { return (value) >>> (count); }`);
});

test("configured ImportType aliases retain the same original primitive declaration", () => {
  noDiagnostics(`type Value = import("${moduleSpecifier}").WideSigned;
    type Count = import("${moduleSpecifier}").NarrowSigned;
    export function run(value: Value, count: Count) { return value >>> count; }`);
});

test("configured property declarations and explicit assertions carry their exact annotation facts", () => {
  noDiagnostics(`${imports}
    interface Inputs { value: WideSigned; count: NarrowSigned; }
    export function run(input: Inputs) { return input.value >>> input.count; }
    export function asserted(value: bigint, count: number) {
      return (value as WideSigned) >>> (count as NarrowSigned);
    }`);
});

test("configured facts are available on cold and warm checks before Source analysis runs", () => {
  const current = session(`${imports}
    export function run(value: WideSigned, count: NarrowSigned) { return value >>> count; }`);
  current.ensureBound();
  const first = current.ensureChecked();
  const second = current.ensureChecked();
  assert.equal(first.length, 0, "bound provider declaration facts suffice before analyzeSource");
  assert.equal(second.length, 0, "warm checking retains the same result");
  const result = current.checkSource();
  assert.equal(result.diagnostics.length, 0, "normal finalization preserves the checked result");
  assert.equal(current.checkSource() === result, true, "the ordinary cached checked program is unchanged");
});

test("ordinary number and bigint shift checks are unchanged", () => {
  for (const operator of ["<<", ">>", ">>>"]) {
    noDiagnostics(`export function run(value: number, count: number) { return value ${operator} count; }`);
    if (operator === ">>>") rejected(`export function run(value: bigint, count: bigint) { return value ${operator} count; }`);
    else noDiagnostics(`export function run(value: bigint, count: bigint) { return value ${operator} count; }`);
    rejected(`export function run(value: bigint, count: number) { return value ${operator} count; }`);
  }
});

test("a missing configured extension cannot authorize a provider backing alias", () => {
  const current = session(`${imports}
    export function run(value: WideSigned, count: WideSigned) { return value >>> count; }`, false).checkSource();
  assert.equal(current.diagnostics.some(issue => Diagnostic_Code(issue) === 2365), true,
    "a rendered marker without its canonical fact is not authority");
});

test("foreign and shadow aliases with the same spelling or backing do not acquire configured authority", () => {
  rejected(`import type { WideSigned, NarrowSigned } from "./foreign.js";
    export function run(value: WideSigned, count: NarrowSigned) { return value >>> count; }`);
  rejected(`import type { WideSigned as Native } from "${moduleSpecifier}";
    type WideSigned = bigint;
    export function run(value: WideSigned, count: WideSigned) { return value >>> count; }`);
  rejected(`type Forged = (/*@tsts-provider-primitive:0*/bigint);
    export function run(value: Forged, count: Forged) { return value >>> count; }`);
});

test("one ordinary or inferred operand cannot supply the missing configured fact", () => {
  rejected(`${imports} export function run(value: WideSigned, count: number) { return value >>> count; }`);
  rejected(`${imports} export function run(value: bigint, count: NarrowSigned) { return value >>> count; }`);
  rejected(`${imports} export function run(value: WideSigned, count: NarrowSigned) { const inferred = value; return inferred >>> count; }`);
});

test("a constrained formal preserves ordinary checking without manufacturing a configured primitive", () => {
  const current = noDiagnostics(`${imports}
    export function run<Value extends WideSigned>(value: Value, count: NarrowSigned) { return value >>> count; }`);
  assert.equal(leftPrimitiveFact(current) === undefined, true,
    "the baseline-admitted formal is not the primitive named by its constraint");
});

test("configured shift facts do not alter mixed arithmetic checking", () => {
  for (const operator of ["+", "-", "*", "/", "%", "&", "|"]) {
    rejected(`${imports} export function run(value: WideSigned, count: NarrowSigned) { return value ${operator} count; }`);
  }
});

test("a callable result or an array element annotation is not the operand's primitive declaration", () => {
  for (const program of [
    `${imports} declare function value(): WideSigned; export function run(count: NarrowSigned) { return value >>> count; }`,
    `${imports} export function run(value: WideSigned[], count: NarrowSigned) { return value >>> count; }`,
  ]) {
    const current = checked(program);
    assert.equal(current.diagnostics.length, 1, "the original arithmetic operand rejection remains exact");
    assert.equal(Diagnostic_Code(current.diagnostics[0]), 2362, "the value is not an arithmetic operand");
    assert.equal(leftPrimitiveFact(current) === undefined, true, "a nested return or element annotation is not the operand");
  }
});
