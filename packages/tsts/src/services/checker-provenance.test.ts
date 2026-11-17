import assert from "node:assert/strict";
import { test } from "node:test";
import { Background } from "../go/context.js";
import { createCompilerSessionFromFiles } from "../index.js";
import { Node_Symbol, Node_Text } from "../internal/ast/ast.js";
import { KindCallExpression, KindClassDeclaration, KindVariableDeclaration } from "../internal/ast/generated/kinds.js";
import { Node_Name } from "../internal/ast/spine.js";
import { SymbolFlagsFunctionScopedVariable, SymbolFlagsOptional, type SymbolFlags } from "../internal/ast/symbolflags.js";
import { Checker_GetPropertyOfType, Checker_GetReturnTypeOfSignature } from "../internal/checker/exports.js";
import { Checker_cloneSignature, Checker_createSignatureInstantiation, Checker_getResolvedSignature, Checker_getSignaturesOfType, Checker_newParameter, Checker_newSignature } from "../internal/checker/checker/signatures.js";
import { SignatureFlagsHasRestParameter, SignatureKindConstruct } from "../internal/checker/types.js";
import { readOriginalSignature } from "../internal/checker/original-signature-evidence.js";
import { CheckModeNormal } from "../internal/checker/checker/state.js";
import { Checker_cloneSymbol, Checker_getTypeOfSymbol, Checker_getWriteTypeOfSymbol, Checker_newSymbol } from "../internal/checker/checker/symbols.js";
import { Checker_createArrayType, Checker_GetTypeAtLocation } from "../internal/checker/checker/types.js";
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
    const clone = Checker_cloneSignature(current.checker, signature, signature.constructorClass);
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

test("original signature facts preserve declarationless checker parameters without inventing syntax", () => {
  const current = fixture();
  try {
    const required = Checker_newParameter(current.checker, "required", current.checker.stringType);
    const optional = Checker_newSymbol(current.checker,
      (SymbolFlagsFunctionScopedVariable | SymbolFlagsOptional) as SymbolFlags, "optional");
    const rest = Checker_newParameter(current.checker, "rest",
      Checker_createArrayType(current.checker, current.checker.stringType));
    const receiver = Checker_newParameter(current.checker, "this", current.checker.stringType);
    assert.ok(required !== undefined && optional !== undefined && rest !== undefined && receiver !== undefined);
    const parameters = [required, optional, rest];
    const signature = Checker_newSignature(current.checker, SignatureFlagsHasRestParameter,
      undefined, [], receiver, parameters, undefined, undefined, 1, undefined);
    assert.ok(signature !== undefined);
    const original = readOriginalSignature(signature);
    assert.equal(original.parameters.length, parameters.length, "every genuine checker-created parameter is retained");
    for (const [index, parameter] of original.parameters.entries()) {
      assert.equal(parameter.index === index && parameter.declaration === undefined &&
        parameter.optional === (index === 1) && parameter.rest === (index === 2), true,
      `parameter ${index}: genuine absence, optional flag and rest position are independent facts`);
    }
    assert.equal(original.declaration === undefined && original.receiver !== undefined &&
      original.receiver.declaration === undefined, true, "no original parameter, receiver or body declaration is fabricated");
    assert.equal(signature.checkerId === current.checker.id && signature.resolvedReturnType === undefined &&
      signature.parameters.every((parameter, index) => parameter === parameters[index]), true,
    "factual reads do not replace the producer, parameter vector or unobserved result");
    assert.equal(Object.isFrozen(original) && Object.isFrozen(original.parameters) &&
      original.parameters.every(parameter => Object.isFrozen(parameter)), true, "the complete factual snapshot is immutable");
  } finally {
    current.done();
  }
});

test("original constructor class provenance precedes calls and survives derived clones and composites", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/constructors.ts", "/src/reader.ts"],
    files: {
      "/src/reader.ts": "export const untouched = true;",
      "/src/constructors.ts": `
        class Base<Value> { constructor(readonly value: Value) {} }
        class Derived<Value> extends Base<Value> {}
        class Empty {}
        class Explicit { constructor(readonly value: number) {} }
        class Left { readonly left = true; constructor(value: number) {} }
        class Right { readonly right = true; constructor(value: number) {} }
        declare const nonclass: new(value: number) => { value: number };
        declare const mixed: typeof Left | typeof Right;
      `,
    },
    compilerOptions: { noLib: true, strict: true, target: "esnext", module: "esnext", checkers: 2 },
  });
  assert.equal(session.ensureChecked().length, 0);
  const source = session.checkSource();
  const file = source.getSourceFile("/src/constructors.ts");
  const reader = source.getSourceFile("/src/reader.ts");
  assert.ok(file !== undefined && reader !== undefined);
  assert.equal(findNodesByKind(file, KindCallExpression).length, 0, "no invocation seeds constructor ownership");
  const [checker, done] = Program_GetTypeCheckerForFile(session.program,
    WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), file);
  assert.ok(checker !== undefined);
  try {
    const declarations = findNodesByKind(file, KindClassDeclaration);
    const classes = new Map(declarations.map(declaration => [Node_Text(Node_Name(declaration)), declaration]));
    for (const name of ["Base", "Derived", "Empty", "Explicit"]) {
      const declaration = classes.get(name);
      assert.ok(declaration !== undefined);
      const type = Checker_getTypeOfSymbol(checker, Node_Symbol(declaration));
      const signatures = Checker_getSignaturesOfType(checker, type, SignatureKindConstruct);
      assert.equal(signatures.length > 0, true, name);
      for (const signature of signatures) {
        assert.ok(signature !== undefined);
        const cold = createTypeCheckerQueries(session.program, { sourceFile: reader });
        const original = readOriginalSignature(signature);
        cold.getReturnTypeOfSignature(signature);
        assert.equal(readOriginalSignature(signature).constructorClass === original.constructorClass, true,
          "a cold foreign view does not seed or replace original constructor provenance");
        assert.equal(original?.constructorClass === declaration, true, name + ": actual class producer, not caller/declaration guess");
        assert.equal(original?.composite === undefined, true);
        const clone = Checker_cloneSignature(checker, signature, signature.constructorClass);
        assert.equal(clone !== undefined && readOriginalSignature(clone).constructorClass === declaration, true);
        if (signature.typeParameters.length !== 0) {
          const instantiated = Checker_createSignatureInstantiation(checker, signature,
            signature.typeParameters.map(() => checker.stringType), signature.constructorClass);
          assert.equal(instantiated !== undefined && readOriginalSignature(instantiated).constructorClass === declaration, true);
        }
        if (name === "Derived") {
          assert.equal(original?.declaration?.Parent === classes.get("Base"), true, "inherited declaration remains Base");
          assert.equal(original?.target !== undefined && original.target.constructorClass === classes.get("Base"), true);
        }
      }
    }
    const variables = findNodesByKind(file, KindVariableDeclaration);
    const nonclass = variables.find(declaration => Node_Text(Node_Name(declaration)) === "nonclass");
    const nonclassSignatures = Checker_getSignaturesOfType(checker, Checker_getTypeOfSymbol(checker, Node_Symbol(nonclass)), SignatureKindConstruct);
    assert.equal(nonclassSignatures.length > 0 && nonclassSignatures.every(signature =>
      signature !== undefined && readOriginalSignature(signature).constructorClass === undefined), true);
    const mixed = variables.find(declaration => Node_Text(Node_Name(declaration)) === "mixed");
    const composites = Checker_getSignaturesOfType(checker, Checker_getTypeOfSymbol(checker, Node_Symbol(mixed)), SignatureKindConstruct);
    assert.equal(composites.length > 0, true);
    for (const signature of composites) {
      assert.ok(signature !== undefined);
      const original = readOriginalSignature(signature);
      assert.equal(original.constructorClass === undefined && original.composite?.isUnion === true, true);
      assert.equal(original.composite?.signatures.length, 2);
      const owners = original.composite?.signatures.map(part => readOriginalSignature(part).constructorClass);
      assert.equal(owners?.includes(classes.get("Left")) && owners.includes(classes.get("Right")), true,
        "a composite retains actual per-arm constructors, never its first class as a singular owner");
    }
  } finally {
    done();
  }
});
