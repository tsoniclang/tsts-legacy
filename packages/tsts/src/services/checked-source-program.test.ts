import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoPtr } from "../go/compat.js";
import type { Node } from "../internal/ast/ast.js";
import {
  createCompilerSessionFromFiles,
  defineExtensionFactKey,
  type CompilerExtension,
} from "../index.js";
import {
  findNodes,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "../extensions/source-provider-test-support.js";

test("checked source program exposes one exact AST and direct checker decision surface", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        "interface Box { value: number; [key: string]: number; }",
        "declare function identity<T>(value: T): T;",
        "declare const box: Box;",
        "declare const maybeBox: Box | undefined;",
        "const callResult = identity<number>(box.value);",
        "const explicitElementResult = box['value'];",
        "const indexSignatureResult = box['other'];",
        "const optionalResult = maybeBox?.value;",
        "for (const item of [callResult]) { identity(item); }",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
  });

  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.sourceFiles), true);
  assert.equal(Object.isFrozen(checked.sourceFacts), true);
  assert.ok(checked.program === session.program);
  assert.ok(session.checkSource() === checked, "Checked source program must be retained exactly per session.");

  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile !== undefined);
  const source = checked.getSourceFileQueries(sourceFile);
  assert.ok(source.ast === checked.ast);
  assert.ok(checked.getSourceFileQueries(sourceFile) === source);
  assert.equal(Object.isFrozen(source.checker), true);
  assert.equal(Object.isFrozen(source.typeShape), true);
  const calls = findNodes(sourceFile, source.ast.children, source.ast.is.IsCallExpression);
  const properties = findNodes(sourceFile, source.ast.children, source.ast.is.IsPropertyAccessExpression);
  const elements = findNodes(sourceFile, source.ast.children, source.ast.is.IsElementAccessExpression);
  const iterations = findNodes(sourceFile, source.ast.children, source.ast.is.IsForOfStatement);
  assert.equal(calls.length, 2);
  assert.equal(properties.length, 2);
  assert.equal(elements.length, 2);
  assert.equal(iterations.length, 1);

  const explicitCall = calls.find((call) => source.ast.typeArguments(call).length === 1);
  assert.ok(explicitCall !== undefined);
  const call = source.checker.getResolvedCallInfo(explicitCall);
  assert.equal(call?.outcome, "applicable");
  assert.ok(call?.call === explicitCall, "Resolved call evidence must retain the exact call node.");
  assert.equal(call?.sourceSelectedMethodTypeArguments?.length, 1);
  assert.equal(call?.sourceSelectedMethodTypeArguments?.[0]?.typeParameterName, "T");
  assert.ok(
    call?.sourceSelectedMethodTypeArguments?.[0]?.explicitTypeNode
      === source.ast.typeArguments(explicitCall)[0],
    "Explicit method type-argument evidence must retain the exact authored type node.",
  );
  assert.equal(call?.sourceArguments.length, 1);
  assert.equal(call?.sourceArgumentBindings.length, 1);
  assert.equal(call?.sourceSelectedSignatureParameters.length, 1);
  assert.ok(
    source.checker.getResolvedCallInfo(explicitCall) === call,
    "Repeated direct call queries must retain the exact resolved call result.",
  );

  const propertyInfos = properties.map((property) => ({
    property,
    info: source.checker.getResolvedPropertyAccessInfo(property),
  }));
  const ordinaryProperty = propertyInfos.find(({ info }) => info?.optionalChain === false);
  const optionalProperty = propertyInfos.find(({ info }) => info?.optionalChain === true);
  assert.ok(ordinaryProperty !== undefined);
  assert.ok(optionalProperty !== undefined);
  const ordinaryPropertyInfo = ordinaryProperty.info;
  const optionalPropertyInfo = optionalProperty.info;
  assert.equal(ordinaryPropertyInfo?.accessMode, "read");
  assert.equal(ordinaryPropertyInfo?.optionalChain, false);
  assert.equal(ordinaryPropertyInfo?.selectedDeclaration !== undefined, true);
  assert.equal(optionalPropertyInfo?.optionalChain, true);
  assert.ok(
    optionalPropertyInfo?.selectedDeclaration === ordinaryPropertyInfo?.selectedDeclaration,
    "Optional and ordinary access must select the same declared property.",
  );

  const explicitElementInfo = source.checker.getResolvedElementAccessInfo(elements[0]);
  assert.equal(explicitElementInfo?.accessMode, "read");
  assert.equal(explicitElementInfo?.selectedSymbol !== undefined, true);
  assert.equal(explicitElementInfo?.selectedDeclaration !== undefined, true);
  assert.equal(source.checker.typeToString(explicitElementInfo?.sourceReadType), "number");

  const indexSignatureInfo = source.checker.getResolvedElementAccessInfo(elements[1]);
  assert.equal(indexSignatureInfo?.accessMode, "read");
  assert.equal(indexSignatureInfo?.selectedSymbol === undefined, true);
  assert.equal(indexSignatureInfo?.selectedDeclaration !== undefined, true);
  assert.equal(source.checker.typeToString(indexSignatureInfo?.sourceReadType), "number");

  const iteration = source.checker.getResolvedIterationInfo(iterations[0]);
  assert.equal(iteration?.iterationKind, "for-of");
  assert.equal(source.checker.typeToString(iteration?.sourceElementType), "number");
});

test("compiler sessions normalize nil Go diagnostic slices at the public boundary", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: [
      "/src/core.d.ts",
      "/src/api.ts",
      "/src/direct.ts",
      "/src/namespace.ts",
    ],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/api.ts":
        "export const transform = (value: number): number => value + 1;",
      "/src/direct.ts": [
        'import { transform as apply } from "./api.js";',
        "export const direct = apply(1);",
      ].join("\n"),
      "/src/namespace.ts": [
        'import * as api from "./api.js";',
        "export const namespaced = api.transform(2);",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
  });

  assert.deepEqual(session.getDiagnostics("global"), []);
  assert.deepEqual(session.getDiagnostics("all"), []);
  assert.deepEqual(session.ensureChecked(), []);
  assert.deepEqual(session.checkSource().diagnostics, []);
});

test("checked source facts are immutable consumer capabilities over exact source subjects", () => {
  const extensionId = "test.checked-source-facts";
  const factKey = defineExtensionFactKey<string>({
    extensionId,
    name: "call",
    snapshot: (value) => value,
  });
  let selectedCall: GoPtr<Node>;
  const extension: CompilerExtension = {
    identity: {
      id: extensionId,
      version: "1.0.0",
    },
    analyzeSource(context): void {
      const sourceFile = context.source.getSourceFile("/src/index.ts");
      const source = context.source.getSourceFileQueries(sourceFile);
      selectedCall = findNodes(sourceFile, source.ast.children, source.ast.is.IsCallExpression)[0];
      assert.ok(selectedCall !== undefined);
      assert.equal(source.checker.getResolvedCallInfo(selectedCall)?.outcome, "applicable");
      assert.equal(context.facts.set(selectedCall, factKey, "identity(1)"), "inserted");
    },
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        "declare function identity(value: number): number;",
        "export const value = identity(1);",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [extension] },
  });

  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.equal(checked.sourceFacts?.getFact(selectedCall, factKey), "identity(1)");
  assert.deepEqual(checked.sourceFacts?.getFacts(selectedCall).map((entry) => entry.key.id), [factKey.id]);
});

test("checked query capabilities preserve checker ownership independently for every source file", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/left.ts", "/src/right.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/left.ts": 'export const value = "left";',
      "/src/right.ts": "export const value = 1;",
    },
    compilerOptions: testNoLibCompilerOptions,
  });

  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const leftFile = checked.getSourceFile("/src/left.ts");
  const rightFile = checked.getSourceFile("/src/right.ts");
  assert.ok(leftFile !== undefined);
  assert.ok(rightFile !== undefined);
  const leftDeclaration = findNodes(
    leftFile,
    checked.ast.children,
    checked.ast.is.IsVariableDeclaration,
  )[0];
  const rightDeclaration = findNodes(
    rightFile,
    checked.ast.children,
    checked.ast.is.IsVariableDeclaration,
  )[0];
  const leftName = checked.ast.name(leftDeclaration);
  const rightName = checked.ast.name(rightDeclaration);
  const leftQueries = checked.getSourceFileQueries(leftFile);
  const rightQueries = checked.getSourceFileQueries(rightFile);
  const leftSymbol = leftQueries.checker.getSymbolAtLocation(leftName);
  const rightSymbol = rightQueries.checker.getSymbolAtLocation(rightName);

  assert.notEqual(leftQueries.checker, rightQueries.checker);
  assert.notEqual(leftQueries.typeShape, rightQueries.typeShape);
  assert.ok(leftQueries.checker.getSymbolSourceFile(leftSymbol) === leftFile);
  assert.ok(rightQueries.checker.getSymbolSourceFile(rightSymbol) === rightFile);
  assert.equal(leftQueries.checker.typeToString(leftQueries.checker.getTypeAtLocation(leftName)), '"left"');
  assert.equal(rightQueries.checker.typeToString(rightQueries.checker.getTypeAtLocation(rightName)), "1");
});
