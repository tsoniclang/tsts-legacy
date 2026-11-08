import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createSourceSemanticsExtension, sourcePrimitive } from "../index.js";
import { Diagnostic_Code } from "../internal/ast/diagnostic.js";
import { checkerDiagnosticCoverage } from "../internal/checker/checker/backing-constraint-evidence.js";
import type { ProviderDeclarationModel } from "./host.js";
import { findNodes, sourceProviderExtension } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/backed-components";
const primitive = sourcePrimitive("Wide", "int64", "bigint", true, 64);
const model: ProviderDeclarationModel = {
  moduleSpecifier, providerModuleId: "Test.BackedComponents",
  exports: [{ id: "Wide", name: "Wide", kind: "type", type: { kind: "source-primitive", name: "int64" } }],
};

function checked(program: string) {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src", rootFiles: ["/src/index.ts"],
    files: { "/src/index.ts": `import type { Wide } from "${moduleSpecifier}";\n${program}` },
    compilerOptions: { strict: true, target: "esnext", module: "esnext", moduleResolution: "bundler" },
    extensionHostOptions: { extensions: [
      sourceProviderExtension(new Map([[moduleSpecifier, model]])),
      createSourceSemanticsExtension({ modules: [{ moduleSpecifier, exports: [primitive] }] }),
    ] },
  });
  const diagnostics = session.ensureChecked();
  const source = session.checkSource();
  assert.equal(source.extensionDiagnostics.length, 0);
  assert.equal(source.diagnostics.length === diagnostics.length &&
    source.diagnostics.every((diagnostic, index) => diagnostic === diagnostics[index]), true,
  "factual observation never substitutes or suppresses the checker's original diagnostics");
  const file = source.getSourceFile("/src/index.ts");
  if (file === undefined) throw new Error("The actual original source file is required.");
  return { source, file, queries: source.getSourceFileQueries(file), session };
}

test("operator constraints retain the exact diagnostic and both original operands", () => {
  const { source, file } = checked("export function shift(value: Wide, count: number) { return value >>> count; }");
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2365]);
  const binary = findNodes(file, source.ast.children, source.ast.is.IsBinaryExpression)[0];
  const syntax = source.ast.as.AsBinaryExpression(binary);
  const constraints = source.getBackingConstraints();
  assert.equal(constraints.length, 1);
  const constraint = constraints[0];
  assert.ok(constraint?.kind === "operator" && syntax !== undefined);
  assert.equal(constraint.operation === binary && constraint.site === binary &&
    constraint.left.root.node === syntax.Left && constraint.right.root.node === syntax.Right, true);
  assert.equal(constraint.diagnostic.root === source.diagnostics[0] &&
    constraint.diagnostic.diagnostic === source.diagnostics[0] && constraint.diagnostic.candidate === undefined, true,
  "an operation has no fabricated call candidate or recoded error");
});

test("return and initializer fits retain their actual original annotation slots", () => {
  const { source } = checked(`
    export const initial: Wide = 4;
    export function present(value: Wide | undefined): Wide { return value ?? 0; }
  `);
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2322, 2322]);
  const constraints = source.getBackingConstraints().filter(constraint => constraint.kind === "write-fit");
  assert.equal(constraints.length, 2);
  for (const constraint of constraints) {
    assert.equal(constraint.destination.root.kind, "annotation");
    const annotation = source.ast.as.AsTypeReferenceNode(constraint.destination.root.node);
    assert.equal(annotation !== undefined && source.ast.text(annotation.TypeName) === "Wide", true);
    assert.equal(source.diagnostics.includes(constraint.diagnostic.root), true);
  }
});

test("index constraints retain the original receiver and index without choosing a width", () => {
  const { source, file } = checked("declare const values: string[]; declare const offset: Wide; export const value = values[offset];");
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2538]);
  const access = findNodes(file, source.ast.children, source.ast.is.IsElementAccessExpression)[0];
  const syntax = source.ast.as.AsElementAccessExpression(access);
  const constraint = source.getBackingConstraints().find(constraint => constraint.kind === "index");
  assert.ok(constraint?.kind === "index" && syntax !== undefined);
  assert.equal(constraint.access === access && constraint.receiver.root.node === syntax.Expression &&
    constraint.index.root.node === syntax.ArgumentExpression, true);
  assert.equal(constraint.diagnostic.root === source.diagnostics[0], true);
});

test("utility-projected configured inputs retain factual constraints instead of a second projector", () => {
  const { source, file, queries } = checked(`
    declare function read(path: string, options?: { start?: Wide }): void;
    type Options = Extract<NonNullable<Parameters<typeof read>[1]>, object>;
    type Offset = NonNullable<Options["start"]>;
    export function present(value: Options["start"]): Offset { return value ?? 0; }
    export function quotient(value: Offset): Offset { return (value - value % 10) / 10; }
    read("input", { start: 9007199254740993 });
    declare const values: string[];
    declare const offset: Offset;
    export const value = values[offset];
  `);
  const constraints = source.getBackingConstraints();
  for (const kind of ["operator", "write-fit", "index"] as const) {
    assert.equal(constraints.some(constraint => constraint.kind === kind), true, `the original ${kind} obligation remains available`);
  }
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  assert.equal(selection.candidates.length, 1);
  const candidate = selection.candidates[0]!;
  assert.equal(candidate.application.invocation === call && candidate.application.kind === "call", true);
  assert.equal(candidate.arguments.kind, "available",
    "both arguments were actually checked before the final argument relation failed");
  assert.equal(candidate.constraints.some(constraint => constraint.kind === "write-fit" &&
    constraint.diagnostic.candidate === candidate.application.signature &&
    selection.diagnostics.includes(constraint.diagnostic.root)), true);
  const originalText = source.ast.getSourceText(file);
  const literal = findNodes(file, source.ast.children, source.ast.is.IsNumericLiteral).find(node => {
    const range = source.ast.authoredRange(node);
    return range.kind === "authored" && originalText.slice(range.start, range.end) === "9007199254740993";
  });
  assert.equal(literal !== undefined, true, "the exact original token remains authoritative after checker rounding");
  assert.equal(Object.hasOwn(selection, "selectedSignature") || Object.hasOwn(selection, "resultType"), false,
    "a failed applicability pass never fabricates a selected signature or result");
});

test("conditional overloads retain all observed candidates and the exact aggregate diagnostic root", () => {
  const { source, file, queries } = checked(`
    declare function choose(kind: "wide", value: Wide): void;
    declare function choose(kind: "text", value: string): void;
    choose("wide", 4);
  `);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  assert.equal(selection.candidates.length, 2, "no arbitrary error candidate becomes a winning selection");
  assert.equal(selection.candidates[0]?.application.signature !== selection.candidates[1]?.application.signature, true);
  assert.equal(selection.diagnostics.length > 0 && selection.diagnostics.every(diagnostic => source.diagnostics.includes(diagnostic)), true,
    "the outer call diagnostic is the actual published object, not a span/code reconstruction");
  for (const candidate of selection.candidates) {
    assert.equal(candidate.application.invocation === call && candidate.sourceArguments.length === 2, true);
    for (const constraint of candidate.constraints) {
      assert.equal(constraint.application === candidate.application, true,
        "constraints never cross subtype, assignability or contextual candidate attempts");
      assert.equal(constraint.diagnostic.candidate === candidate.application.signature, true);
      assert.equal(selection.diagnostics.includes(constraint.diagnostic.root), true);
    }
  }
});

test("call diagnostic coverage refuses an unrelated child beneath the same original root", () => {
  const { source, file, queries } = checked(`
    declare function select(value: Wide): void;
    declare function select(value: string): void;
    select(4);
    export const unrelated: string = 5;
  `);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  const constraint = selection.candidates.flatMap(candidate => candidate.constraints)[0];
  assert.ok(constraint !== undefined);
  const root = constraint.diagnostic.root;
  const checker = constraint.kind === "write-fit" ? constraint.source.type.checker : undefined;
  assert.ok(checker !== undefined);
  const coverage = checkerDiagnosticCoverage(checker, root);
  assert.equal(coverage.kind, "complete");
  if (coverage.kind !== "complete") throw new Error("The original call relation must have complete native ownership.");
  assert.equal(coverage.obligations.length > 0 && coverage.obligations.every(obligation =>
    obligation.application?.invocation === call && obligation.diagnostic !== root), true,
  "the exact overload wrapper is distinct from its actually observed relation obligation");
  const unrelated = source.diagnostics.find(diagnostic => diagnostic !== undefined && diagnostic !== root && Diagnostic_Code(diagnostic) === 2322);
  assert.ok(unrelated !== undefined);
  const length = root.messageChain.length;
  root.messageChain.push(unrelated);
  try {
    assert.equal(checkerDiagnosticCoverage(checker, root).kind, "unavailable",
      "proving one candidate cannot authorize an unobserved child under the original aggregate diagnostic");
  } finally {
    root.messageChain.length = length;
  }
});

test("a partial failed applicability pass cannot claim a complete observed argument map", () => {
  const { source, file, queries } = checked(`
    declare function need(first: Wide, last: string): void;
    need(4, "value");
  `);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  const candidate = selection.candidates[0]!;
  assert.equal(candidate.sourceArguments.length, 2);
  assert.equal(candidate.arguments.kind, "unavailable");
  assert.equal(candidate.constraints.length > 0 && candidate.constraints.every(constraint =>
    constraint.application === candidate.application && source.diagnostics.includes(constraint.diagnostic.root)), true,
  "the exact failed attempt owns its original diagnostic without inventing an unvisited final argument");
});

test("a rejected generic candidate keeps its original inferred producer receipt pending", () => {
  const { source, file, queries } = checked(`
    declare function accept<Value>(value: { start: Wide; data: Value }): Value;
    accept({ start: 4, data: "value" });
  `);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  const candidate = selection.candidates[0];
  assert.ok(candidate !== undefined && candidate.inferenceContributions.kind === "available");
  const parameter = candidate.application.signature.typeParameters[0];
  assert.equal(candidate.inferenceContributions.contributions.length > 0 &&
    candidate.inferenceContributions.contributions.every(entry => entry.typeParameter === parameter), true,
  "the pending candidate retains its own original binder, never winning authority");
  assert.equal(source.diagnostics.length > 0 && Object.hasOwn(selection, "resultType") === false, true);
});

test("same diagnostic codes never merge independent configured and ordinary obligations", () => {
  const { source, session } = checked("export const configured: Wide = 4; export const ordinary: number = 'invalid';");
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2322, 2322]);
  const constraints = source.getBackingConstraints().filter(constraint => constraint.kind === "write-fit");
  assert.equal(constraints.length, 2);
  assert.equal(constraints[0]?.diagnostic.root !== constraints[1]?.diagnostic.root, true);
  const repeated = source.getBackingConstraints();
  assert.equal(constraints.every(constraint => repeated.includes(constraint)), true,
    "query order retains exact immutable obligation identities");
  assert.equal(session.checkSource() === source, true);
});

test("an explicit bound failure retains original arguments without a fake instantiated candidate", () => {
  const { source, file, queries } = checked(`
    declare function only<Value extends number>(value: Value): void;
    declare const value: Wide;
    only<Wide>(value);
  `);
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2344]);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  assert.equal(selection.candidates.length, 1);
  const candidate = selection.candidates[0]!;
  assert.equal(candidate.application.instantiatedSignature === undefined, true,
    "the checker rejected the original constraint before any applicable instantiation existed");
  assert.equal(candidate.application.signatureTypeArguments[0]?.explicitTypeNode === source.ast.typeArguments(call)[0], true);
  assert.equal(candidate.application.signatureShape.parameters.length, 1);
  assert.equal(candidate.constraints.some(constraint => constraint.kind === "write-fit" &&
    constraint.source.root.kind === "annotation" && constraint.destination.root.kind === "annotation" &&
    constraint.diagnostic.candidate === candidate.application.signature &&
    constraint.diagnostic.root === source.diagnostics[0]), true,
  "only the actual checked type-argument-to-bound relation owns this exact diagnostic");
  assert.equal(queries.checker.getResolvedCallInfo(call) === selection, true);
});

test("wrong arity retains its actual diagnostic with no made-up conditional application", () => {
  const { source, file, queries } = checked("declare function need(first: Wide, second: Wide): void; need(4);");
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2554]);
  const call = findNodes(file, source.ast.children, source.ast.is.IsCallExpression)[0];
  const selection = queries.checker.getResolvedCallInfo(call);
  assert.ok(selection?.kind === "conditional-candidates");
  assert.equal(selection.candidates.length, 0);
  assert.equal(selection.diagnostics.length === source.diagnostics.length &&
    selection.diagnostics[0] === source.diagnostics[0], true);
});

test("a type-reference bound fit retains its original annotation relation without a call candidate", () => {
  const { source } = checked(`
    interface Only<Value extends number> { value: Value; }
    export type Selected = Only<Wide>;
  `);
  assert.deepEqual(source.diagnostics.map(Diagnostic_Code), [2344]);
  const constraints = source.getBackingConstraints();
  assert.equal(constraints.some(constraint => constraint.kind === "write-fit" &&
    constraint.application === undefined && constraint.diagnostic.candidate === undefined &&
    constraint.source.root.kind === "annotation" && constraint.destination.root.kind === "annotation" &&
    constraint.diagnostic.root === source.diagnostics[0]), true,
  "a type-reference bound is not fabricated as a failed invocation");
});
