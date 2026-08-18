import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompilerSessionFromFiles,
  type SourceFileQueries,
} from "../index.js";
import {
  findNodes,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "../extensions/source-provider-test-support.js";

test("checked source exposes exact constructor selection through the direct call query", () => {
  const source = checkedQueries(`
    class Box {
      constructor(readonly value: number) {}
    }

    export const box = new Box(1);
  `);
  const constructions = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsNewExpression,
  );
  assert.equal(constructions.length, 1);
  const construction = constructions[0];
  const syntax = source.ast.as.AsNewExpression(construction);
  const selected = source.checker.getResolvedCallInfo(construction);

  assert.equal(selected?.outcome, "applicable");
  assert.equal(selected?.sourceSelectedSignatureKind, "resolved");
  assert.ok(
    selected?.sourceCallee.expression === syntax?.Expression,
    "Constructor evidence must retain the exact authored callee expression.",
  );
  assert.equal(selected?.sourceSelectedSignatureParameters.length, 1);
  assert.equal(selected?.sourceSelectedSignatureParameters[0]?.parameterName, "value");
  assert.equal(
    source.checker.typeToString(selected?.sourceSelectedSignatureParameters[0]?.selectedType),
    "number",
  );
  assert.equal(selected?.sourceArguments.length, 1);
  assert.equal(source.checker.typeToString(selected?.sourceResultType), "Box");
  assert.equal(selected?.sourceReceiver, undefined);
  const repeated = source.checker.getResolvedCallInfo(construction);
  assert.ok(
    repeated === selected,
    "Repeated constructor queries must retain the exact resolved call result.",
  );
  assert.ok(
    repeated?.selectedSignature === selected?.selectedSignature,
    "Repeated constructor queries must retain the exact selected signature.",
  );
  assert.ok(
    repeated?.sourceResultType === selected?.sourceResultType,
    "Repeated constructor queries must retain the exact result type.",
  );
});

test("checked source exposes operator syntax and checker-owned operand and result types directly", () => {
  const source = checkedQueries(`
    declare let count: number;
    declare const flag: boolean;

    export const sum = count + 1;
    export const inverted = !flag;
    count++;
  `);
  const binaries = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsBinaryExpression,
  );
  const prefixes = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsPrefixUnaryExpression,
  );
  const postfixes = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsPostfixUnaryExpression,
  );
  assert.equal(binaries.length, 1);
  assert.equal(prefixes.length, 1);
  assert.equal(postfixes.length, 1);

  const binary = source.ast.as.AsBinaryExpression(binaries[0]);
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(binary?.Left)), "number");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(binary?.Right)), "1");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(binaries[0])), "number");

  const prefix = source.ast.as.AsPrefixUnaryExpression(prefixes[0]);
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(prefix?.Operand)), "boolean");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(prefixes[0])), "boolean");

  const postfix = source.ast.as.AsPostfixUnaryExpression(postfixes[0]);
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(postfix?.Operand)), "number");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(postfixes[0])), "number");
});

test("checked source exposes authored assertion syntax and semantic source and target types", () => {
  const source = checkedQueries(`
    class Animal {}
    class Dog extends Animal {
      bark(): void {}
    }

    declare const animal: Animal;
    export const dog = animal as Dog;
  `);
  const assertions = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsAsExpression,
  );
  assert.equal(assertions.length, 1);
  const assertion = source.ast.as.AsAsExpression(assertions[0]);

  assert.equal(
    source.checker.typeToString(source.checker.getTypeAtLocation(assertion?.Expression)),
    "Animal",
  );
  assert.equal(
    source.checker.typeToString(source.checker.getTypeFromTypeNode(assertion?.Type)),
    "Dog",
  );
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(assertions[0])), "Dog");
  assert.ok(
    source.checker.getTypeFromTypeNode(assertion?.Type)
      === source.checker.getTypeAtLocation(assertions[0]),
    "Assertion target syntax and checked result must retain the same target type.",
  );
});

test("invalid assertions remain ordinary source diagnostics and create no extension recovery path", () => {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "export const invalid = 1 as string;",
    },
    compilerOptions: testNoLibCompilerOptions,
  });
  const checked = session.checkSource();

  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.deepEqual(
    checked.diagnostics.map((diagnostic) => diagnostic?.code),
    [2352],
  );
  assert.deepEqual(checked.sourceFacts.getFacts(checked.getSourceFile("/src/index.ts")), []);
});

test("type-shape tuple queries are total for primitive and tuple source types", () => {
  const source = checkedQueries(`
    export const primitive = 1;
    export const tuple = [1, "one"] as const;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const primitive = identifiers.find((node) => source.ast.text(node) === "primitive");
  const tuple = identifiers.find((node) => source.ast.text(node) === "tuple");
  assert.ok(primitive !== undefined);
  assert.ok(tuple !== undefined);

  const primitiveType = source.checker.getTypeAtLocation(primitive);
  const tupleType = source.checker.getTypeAtLocation(tuple);
  assert.equal(source.typeShape.isTuple(primitiveType), false);
  assert.deepEqual(source.typeShape.getTupleElementTypes(primitiveType), []);
  assert.equal(source.typeShape.isTuple(tupleType), true);
  assert.deepEqual(
    source.typeShape.getTupleElementTypes(tupleType).map((type) => source.checker.typeToString(type)),
    ["1", "\"one\""],
  );
});

test("type-shape tuple evidence retains exact authored parameter declarations", () => {
  const source = checkedQueries(`
    type ArgumentTuple<T> = T extends (...args: infer P) => unknown ? P : never;
    function format(value: number, suffix?: string): string { return suffix ?? ""; }
    declare const arguments_: ArgumentTuple<typeof format>;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const arguments_ = identifiers.find((node) =>
    source.ast.text(node) === "arguments_"
  );
  assert.ok(arguments_ !== undefined);

  const tuple = source.typeShape.getTupleElementInfos(
    source.checker.getTypeAtLocation(arguments_),
  );
  assert.deepEqual(
    tuple.map((element) => ({
      type: source.checker.typeToString(element.type),
      elementKind: element.elementKind,
      declarationKind: source.ast.kindName(element.declaration),
      declarationName: source.ast.text(source.ast.name(element.declaration)),
    })),
    [
      {
        type: "number",
        elementKind: "required",
        declarationKind: "KindParameter",
        declarationName: "value",
      },
      {
        type: "string | undefined",
        elementKind: "optional",
        declarationKind: "KindParameter",
        declarationName: "suffix",
      },
    ],
  );
});

test("type-shape substitution evidence exposes the exact compiler-owned base type", () => {
  const source = checkedQueries(`
    type NoInfer<T> = intrinsic;
    function choose<T>(value: T, fallback: NoInfer<T>): T { return value; }
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const fallback = identifiers.find((node) => source.ast.text(node) === "fallback");
  assert.ok(fallback !== undefined);

  const substitution = source.checker.getTypeAtLocation(fallback);
  const baseType = source.typeShape.getSubstitutionBaseType(substitution);
  assert.ok(baseType !== undefined);
  assert.equal(source.typeShape.typeToString(baseType), "T");
  assert.equal(source.typeShape.getSubstitutionBaseType(baseType), undefined);
});

test("type-shape signature evidence expands inferred tuple-rest parameters exactly", () => {
  const source = checkedQueries(`
    type ThisParameterType<T> = T extends (this: infer U, ...args: never) => any ? U : unknown;
    type OmitThisParameter<T> = unknown extends ThisParameterType<T>
      ? T
      : T extends (...args: infer A) => infer R
        ? (...args: A) => R
        : T;
    interface Receiver { value: number }
    type Bound = (this: Receiver, delta: number) => number;
    declare const detached: OmitThisParameter<Bound>;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const detached = identifiers.find((node) => source.ast.text(node) === "detached");
  assert.ok(detached !== undefined);
  const signatures = source.typeShape.getCallSignatures(
    source.checker.getTypeAtLocation(detached),
  );
  assert.equal(signatures.length, 1);
  const parameters = source.typeShape.getSignatureParameterInfos(signatures[0]);
  assert.deepEqual(parameters.map((parameter) => ({
    sourceName: source.checker.getSymbolName(parameter.sourceSymbol),
    type: source.typeShape.typeToString(parameter.type),
    parameterKind: parameter.parameterKind,
    declarationName: source.ast.text(source.ast.name(parameter.declaration)),
  })), [{
    sourceName: "args",
    type: "number",
    parameterKind: "required",
    declarationName: "delta",
  }]);
});

test("type-shape signature evidence preserves unexpanded array-rest ownership", () => {
  const source = checkedQueries(`
    type Rest = (prefix: string, ...flags: boolean[]) => boolean;
    declare const rest: Rest;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const rest = identifiers.find((node) => source.ast.text(node) === "rest");
  assert.ok(rest !== undefined);
  const signatures = source.typeShape.getCallSignatures(
    source.checker.getTypeAtLocation(rest),
  );
  assert.equal(signatures.length, 1);
  const parameters = source.typeShape.getSignatureParameterInfos(signatures[0]);
  assert.deepEqual(parameters.map((parameter) => ({
    sourceName: source.checker.getSymbolName(parameter.sourceSymbol),
    type: source.typeShape.typeToString(parameter.type),
    parameterKind: parameter.parameterKind,
    declarationName: source.ast.text(source.ast.name(parameter.declaration)),
  })), [{
    sourceName: "prefix",
    type: "string",
    parameterKind: "required",
    declarationName: "prefix",
  }, {
    sourceName: "flags",
    type: "boolean[]",
    parameterKind: "rest",
    declarationName: "flags",
  }]);
});

test("type-shape signature evidence preserves checker-selected optionality", () => {
  const source = checkedQueries(`
    type Optional = (required: number, optional?: string) => void;
    declare const optionalCallable: Optional;
    function defaultedCallable(required: number, initialized = "value"): void {}
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const callableNames = ["optionalCallable", "defaultedCallable"] as const;
  const parameterKinds = callableNames.map((name) => {
    const callable = identifiers.find((node) => source.ast.text(node) === name);
    assert.ok(callable !== undefined);
    const signatures = source.typeShape.getCallSignatures(
      source.checker.getTypeAtLocation(callable),
    );
    assert.equal(signatures.length, 1);
    return source.typeShape.getSignatureParameterInfos(signatures[0]).map(
      (parameter) => parameter.parameterKind,
    );
  });
  assert.deepEqual(parameterKinds, [
    ["required", "optional"],
    ["required", "optional"],
  ]);
});

test("type-shape property information preserves effective mapped modifiers", () => {
  const source = checkedQueries(`
    type Source = { readonly id?: number; name: string };
    type Normalized<T> = { -readonly [K in keyof T]-?: T[K] };
    declare function acceptOpen<T>(openValue: Normalized<T>): void;
    declare const sourceValue: Source;
    declare const normalizedValue: Normalized<Source>;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const sourceValue = identifiers.find((node) => source.ast.text(node) === "sourceValue");
  const openValue = identifiers.find((node) => source.ast.text(node) === "openValue");
  const normalizedValue = identifiers.find((node) => source.ast.text(node) === "normalizedValue");
  assert.ok(sourceValue !== undefined);
  assert.ok(openValue !== undefined);
  assert.ok(normalizedValue !== undefined);

  const sourceProperties = source.typeShape.getPropertyInfos(
    source.checker.getTypeAtLocation(sourceValue),
  );
  const normalizedProperties = source.typeShape.getPropertyInfos(
    source.checker.getTypeAtLocation(normalizedValue),
  );
  assert.equal(
    source.typeShape.couldContainTypeVariables(
      source.checker.getTypeAtLocation(openValue),
    ),
    true,
  );
  assert.deepEqual(
    normalizedProperties.map((property) =>
      property.rootSymbols.map((symbol) => source.checker.getSymbolName(symbol))
    ),
    [["id"], ["name"]],
  );
  assert.equal(
    source.typeShape.couldContainTypeVariables(
      source.checker.getTypeAtLocation(normalizedValue),
    ),
    false,
  );
  assert.deepEqual(
    sourceProperties.map(({ name, optional, readonly, type }) => ({
      name,
      optional,
      readonly,
      type: source.checker.typeToString(type),
    })),
    [
      { name: "id", optional: true, readonly: true, type: "number | undefined" },
      { name: "name", optional: false, readonly: false, type: "string" },
    ],
  );
  assert.deepEqual(
    normalizedProperties.map(({ name, optional, readonly, type }) => ({
      name,
      optional,
      readonly,
      type: source.checker.typeToString(type),
    })),
    [
      { name: "id", optional: false, readonly: false, type: "number" },
      { name: "name", optional: false, readonly: false, type: "string" },
    ],
  );
});

test("type-shape property information preserves private display names and instantiated types", () => {
  const source = checkedQueries(`
    class Box<T> {
      #value!: T;
      value!: T;
    }
    declare const box: Box<string>;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const box = identifiers.find((node) => source.ast.text(node) === "box");
  assert.ok(box !== undefined);

  const properties = source.typeShape.getPropertyInfos(
    source.checker.getTypeAtLocation(box),
  );
  assert.deepEqual(
    properties.map(({ name, type }) => ({
      name,
      type: source.checker.typeToString(type),
    })),
    [
      { name: "#value", type: "string" },
      { name: "value", type: "string" },
    ],
  );
});

function checkedQueries(sourceText: string): SourceFileQueries {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": sourceText,
    },
    compilerOptions: testNoLibCompilerOptions,
  });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  assert.ok(sourceFile !== undefined, "Expected checked source file /src/index.ts.");
  return checked.getSourceFileQueries(sourceFile);
}
