import assert from "node:assert/strict";
import { test } from "node:test";
import { Background } from "../go/context.js";
import { createCompilerSessionFromFiles } from "../index.js";
import { Node_Text } from "../internal/ast/ast.js";
import { KindCallExpression, KindVariableDeclaration } from "../internal/ast/generated/kinds.js";
import { Node_Name } from "../internal/ast/spine.js";
import { Checker_GetPropertyOfType, Checker_GetReturnTypeOfSignature } from "../internal/checker/exports.js";
import { Checker_cloneSignature, Checker_getResolvedSignature } from "../internal/checker/checker/signatures.js";
import { CheckModeNormal } from "../internal/checker/checker/state.js";
import { Checker_cloneSymbol, Checker_getTypeOfSymbol, Checker_getWriteTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_GetTypeAtLocation } from "../internal/checker/checker/types.js";
import { Program_GetTypeChecker, Program_GetTypeCheckerForFile } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { findNodesByKind } from "./type-checker-test-support.js";

function fixture() {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/reader.ts", "/src/owner.ts"],
    files: {
      "/src/reader.ts": "export const independent = true;",
      "/src/owner.ts": `
        interface Holder<Value> { value: Value; read(input: Value): Value; }
        declare const holder: Holder<string>;
        export const result = holder.read("ready");
      `,
    },
    compilerOptions: { noLib: true, strict: true, target: "esnext", module: "esnext", checkers: 2 },
  });
  assert.equal(session.ensureChecked().length, 0, "the original two-file program checks normally");
  const source = session.checkSource();
  const ownerFile = source.getSourceFile("/src/owner.ts");
  const readerFile = source.getSourceFile("/src/reader.ts");
  assert.ok(ownerFile !== undefined && readerFile !== undefined);
  const [checker, done] = Program_GetTypeCheckerForFile(session.program,
    WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), ownerFile);
  assert.ok(checker !== undefined);
  return { session, ownerFile, readerFile, checker, done };
}

test("actual signature and transient symbol provenance survives cold query views and reader order", () => {
  const current = fixture();
  try {
    const calls = findNodesByKind(current.ownerFile, KindCallExpression);
    const signature = Checker_getResolvedSignature(current.checker, calls[0], undefined, CheckModeNormal);
    assert.ok(signature !== undefined);
    const parameter = signature.parameters[0];
    assert.ok(parameter !== undefined);
    const returnType = Checker_GetReturnTypeOfSignature(current.checker, signature);
    const parameterType = Checker_getTypeOfSymbol(current.checker, parameter);
    const variables = findNodesByKind(current.ownerFile, KindVariableDeclaration);
    const holder = variables.find(declaration => Node_Text(Node_Name(declaration)) === "holder");
    const holderType = Checker_GetTypeAtLocation(current.checker, Node_Name(holder));
    const property = Checker_GetPropertyOfType(current.checker, holderType, "value");
    assert.ok(property !== undefined);
    const propertyType = Checker_getTypeOfSymbol(current.checker, property);
    const writeType = Checker_getWriteTypeOfSymbol(current.checker, property);
    const [apiChecker, release] = Program_GetTypeChecker(current.session.program, Background());
    try {
      assert.equal(apiChecker !== undefined && apiChecker.id !== current.checker.id, true,
        "the file's actual producer is not the ordinary API checker");
    } finally {
      release();
    }
    assert.equal(signature.checkerId === current.checker.id && parameter.checkerId === current.checker.id &&
      property.checkerId === current.checker.id, true, "all actual native producers publish their checker identity");
    for (const reverse of [false, true]) {
      const queries = createTypeCheckerQueries(current.session.program, { sourceFile: current.readerFile });
      const reads = [
        () => assert.equal(queries.getReturnTypeOfSignature(signature) === returnType, true, "cold signature return identity"),
        () => assert.equal(queries.getInvocationReturnTypeOfSignature(signature) === returnType, true, "cold invocation identity"),
        () => assert.equal(queries.getTypeOfSymbol(parameter) === parameterType, true, "cold instantiated parameter identity"),
        () => assert.equal(queries.getTypeOfSymbol(property) === propertyType, true, "cold instantiated property identity"),
        () => assert.equal(queries.getWriteTypeOfSymbol(property) === writeType, true, "cold physical write identity"),
      ];
      for (const read of reverse ? [...reads].reverse() : reads) read();
    }
    const clone = Checker_cloneSignature(current.checker, signature);
    const propertyClone = Checker_cloneSymbol(current.checker, property);
    assert.ok(clone !== undefined && propertyClone !== undefined);
    assert.equal(clone !== signature && clone.checkerId === current.checker.id &&
      propertyClone !== property && propertyClone.checkerId === current.checker.id, true,
    "clone constructors publish actual producer provenance rather than a query registration");
  } finally {
    current.done();
  }
});

test("foreign or absent signature provenance fails exact pool membership while bound symbols stay shared", () => {
  const current = fixture();
  const foreign = fixture();
  try {
    const signature = Checker_getResolvedSignature(current.checker,
      findNodesByKind(current.ownerFile, KindCallExpression)[0], undefined, CheckModeNormal);
    assert.ok(signature !== undefined);
    const parameter = signature.parameters[0];
    assert.ok(parameter !== undefined);
    const original = signature.target?.parameters[0];
    assert.ok(original !== undefined);
    assert.equal(original.checkerId === undefined, true, "the bound original parameter has no fabricated checker owner");
    const queries = createTypeCheckerQueries(foreign.session.program, { sourceFile: foreign.readerFile });
    assert.equal(queries.getReturnTypeOfSignature(signature) === undefined &&
      queries.getInvocationReturnTypeOfSignature(signature) === undefined &&
      queries.getTypeOfSymbol(parameter) === undefined && queries.getWriteTypeOfSymbol(parameter) === undefined, true,
    "equal filenames and declarations never substitute another program's producer");
    const local = createTypeCheckerQueries(current.session.program, { sourceFile: current.readerFile });
    assert.equal(local.getReturnTypeOfSignature({ ...signature, checkerId: undefined! }) === undefined, true,
      "a missing required signature owner does not select the first checker");
    local.getTypeOfSymbol(original);
    assert.equal(original.checkerId === undefined, true, "ordinary shared-symbol reads never mutate producer metadata");
  } finally {
    foreign.done();
    current.done();
  }
});
