import assert from "node:assert/strict";
import { test } from "node:test";
import { Node_Expression } from "../internal/ast/ast.js";
import { Diagnostic_Code } from "../internal/ast/diagnostic.js";
import { Program_GetTypeCheckerForFile } from "../internal/compiler/program.js";
import { LinkStore_Get } from "../internal/core/linkstore.js";
import { Background } from "../go/context.js";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { createSourceProgramQueries } from "./source-program.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

const moduleSpecifier = "@test/native/call-selection.js";

function sessionFor(source: string) {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": source },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[moduleSpecifier, {
      moduleSpecifier,
      providerModuleId: "Native.CallSelection",
      exports: [
        { id: "Native.Expand", name: "expand", kind: "intrinsic" },
        { id: "Native.Ordinary", intrinsicId: "Native.Mixed", name: "mixed", kind: "function",
          signatures: [{ id: "Native.Ordinary.call", parameters: [{ name: "value", type: { kind: "number" } }],
            returnType: { kind: "number" } }] },
      ],
    }]]))] },
  });
  session.ensureBound();
  const sourceProgram = createSourceProgramQueries(session.program);
  const file = sourceProgram.getSourceFile("/src/index.ts");
  assert.ok(file);
  const queries = sourceProgram.getSourceFileQueries(file);
  return { session, sourceProgram, file, queries };
}

for (const invocation of [
  "expand(undeclared());",
  "alias(undeclared());",
  "native.expand(undeclared());",
  'native["expand"](undeclared());',
  "new expand(undeclared());",
  "expand?.(undeclared());",
]) {
  test(`intrinsic call selection does not resolve an ordinary signature: ${invocation}`, () => {
    const { session, sourceProgram, file, queries } = sessionFor([
      `import { expand } from "${moduleSpecifier}";`,
      `import * as native from "${moduleSpecifier}";`,
      "const alias = expand;",
      invocation,
    ].join("\n"));
    const calls = findNodes(file, sourceProgram.ast.children,
      node => sourceProgram.ast.is.IsCallExpression(node) || sourceProgram.ast.is.IsNewExpression(node));
    const call = calls[0];
    const operand = calls[1];
    assert.ok(call);
    assert.ok(operand);
    const result = queries.checker.getResolvedCallInfo(call);
    assert.equal(result?.outcome, "intrinsic");
    if (result?.outcome !== "intrinsic") return;
    assert.equal(result.reference.intrinsic.exportId, "Native.Expand");
    assert.equal(result.reference.expression, Node_Expression(call));
    assert.equal(result.reference.ordinary, undefined);
    assert.equal("selectedSignature" in result, false);
    assert.equal("sourceResultType" in result, false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.reference), true);
    assert.equal(queries.checker.getResolvedCallInfo(call), result);
    const [checker, release] = Program_GetTypeCheckerForFile(session.program, Background(), file);
    try {
      assert.ok(checker);
      assert.equal(LinkStore_Get(checker.signatureLinks, call)?.resolvedSignature, undefined);
      assert.equal(LinkStore_Get(checker.signatureLinks, operand)?.resolvedSignature, undefined);
    } finally {
      release();
    }
    const diagnostics = session.getDiagnostics("semantic").map(Diagnostic_Code);
    assert.ok(diagnostics.includes(2304), "Selection alone must not suppress operand checking.");
    assert.ok(diagnostics.includes(invocation.startsWith("new ") ? 2351 : 2349),
      "Selection is not native elaboration or proof of a valid invocation.");
  });
}

test("ordinary facets retain real overload rejection rather than being treated as intrinsic-only", () => {
  const { session, sourceProgram, file, queries } = sessionFor([
    `import { mixed } from "${moduleSpecifier}";`,
    'mixed("wrong");',
    "mixed(4);",
  ].join("\n"));
  const calls = findNodes(file, sourceProgram.ast.children, sourceProgram.ast.is.IsCallExpression);
  assert.notEqual(queries.checker.getResolvedCallInfo(calls[0])?.outcome, "intrinsic");
  assert.equal(queries.checker.getResolvedCallInfo(calls[1])?.outcome, "applicable");
  assert.deepEqual(session.getDiagnostics("semantic").map(Diagnostic_Code), [2345]);
});

test("source lookalikes and mutable aliases do not gain intrinsic call selection", () => {
  const { session, sourceProgram, file, queries } = sessionFor([
    `import { expand as native } from "${moduleSpecifier}";`,
    "function expand(): number { return 3; }",
    "let alias = native;",
    "expand();",
    "alias();",
  ].join("\n"));
  const calls = findNodes(file, sourceProgram.ast.children, sourceProgram.ast.is.IsCallExpression);
  assert.equal(queries.checker.getResolvedCallInfo(calls[0])?.outcome, "applicable");
  assert.notEqual(queries.checker.getResolvedCallInfo(calls[1])?.outcome, "intrinsic");
  assert.deepEqual(session.getDiagnostics("semantic").map(Diagnostic_Code), [2349]);
});

test("intrinsic call selection rejects a node from a different source epoch", () => {
  const text = `import { expand } from "${moduleSpecifier}"; expand();`;
  const first = sessionFor(text);
  const second = sessionFor(text);
  const call = findNodes(first.file, first.sourceProgram.ast.children, first.sourceProgram.ast.is.IsCallExpression)[0];
  assert.ok(call);
  assert.throws(() => second.queries.checker.getResolvedCallInfo(call),
    /Source semantic queries cannot use a source file from a different compiler program or epoch\./u);
});
