import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  findNodes,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "../extensions/source-provider-test-support.js";
import { createCompilerSessionFromFiles } from "./compiler-session.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { createTypeShapeQueries } from "./type-shape.js";

function source() {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/model.ts", "/src/main.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/model.ts": "export function identity(value: { count: number }): { count: number } { return value; }",
      "/src/main.ts": 'import { identity } from "./model.js"; export const value = identity({ count: 42 });',
    },
    compilerOptions: testNoLibCompilerOptions,
  }).checkSource();
  assert.deepEqual(checked.diagnostics, [], checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(checked.extensionDiagnostics, []);
  const sourceFile = checked.getSourceFile("/src/main.ts");
  const model = checked.getSourceFile("/src/model.ts");
  assert.ok(sourceFile);
  assert.ok(model);
  const query = checked.getSourceFileQueries(sourceFile);
  const modelQuery = checked.getSourceFileQueries(model);
  const call = findNodes(sourceFile, query.ast.children, query.ast.is.IsCallExpression)[0];
  const declaration = findNodes(model, query.ast.children, query.ast.is.IsFunctionDeclaration)[0];
  assert.ok(call);
  assert.ok(declaration);
  const type = query.checker.getTypeAtLocation(call);
  const symbol = modelQuery.checker.getSymbolAtLocation(modelQuery.ast.name(declaration));
  const signature = query.checker.getResolvedSignature(call);
  assert.ok(type);
  assert.ok(symbol);
  assert.ok(signature);
  return { checked, sourceFile, model, query, modelQuery, call, declaration, type, symbol, signature };
}

test("semantic query ownership retains exact cross-file queries within one program", () => {
  const current = source();
  assert.equal(current.modelQuery.checker.typeToString(current.type), "{ count: number; }");
  assert.equal(current.modelQuery.typeShape.getPropertyInfos(current.type)[0]?.name, "count");
  assert.equal(current.query.checker.getTypeAtLocation(current.declaration),
    current.modelQuery.checker.getTypeAtLocation(current.declaration));
  assert.equal(current.query.checker.getTypeOfSymbol(current.symbol),
    current.modelQuery.checker.getTypeOfSymbol(current.symbol));
  assert.equal(current.modelQuery.checker.getReturnTypeOfSignature(current.signature), current.type);
});

test("semantic queries reject foreign same-path syntax, types, symbols and signatures", () => {
  const current = source();
  const foreign = source();
  const rejected = /different compiler program or epoch/u;
  const operations = [
    () => current.query.checker.getTypeAtLocation(foreign.call),
    () => current.query.checker.getResolvedCallInfo(foreign.call),
    () => current.query.checker.getTypeOfSymbol(foreign.symbol),
    () => current.query.checker.getSymbolDeclarations(foreign.symbol),
    () => current.query.checker.typeToString(foreign.type),
    () => current.query.checker.getReturnTypeOfSignature(foreign.signature),
    () => current.query.checker.getSignatureParameters(foreign.signature),
    () => current.query.typeShape.getTypeFromTypeNode(foreign.declaration),
    () => current.query.typeShape.getPropertyInfos(foreign.type),
    () => current.query.typeShape.isNumberLike(foreign.type),
    () => current.query.typeShape.getTypeReferenceTarget(foreign.type),
    () => current.query.typeShape.isTypeIdenticalTo(current.type, foreign.type),
    () => current.query.typeShape.getReturnTypeOfSignature(foreign.signature),
    () => createTypeCheckerQueries(current.checked.program, { sourceFile: foreign.sourceFile }),
    () => createTypeShapeQueries(current.checked.program, { sourceFile: foreign.sourceFile }),
  ];
  for (const operation of operations) assert.throws(operation, rejected);
  assert.equal(current.query.typeShape.getPropertyInfos(current.type)[0]?.name, "count");
});
