import { requireApplicableCallInfo } from "./type-checker-test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Type_AsConditionalType } from "../internal/checker/types.js";
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
  const selected = requireApplicableCallInfo(source.checker.getResolvedCallInfo(construction));

  assert.equal(selected?.kind, "applicable");
  assert.equal(selected?.kind, "applicable");
  assert.ok(
    selected?.selection.callee.expression === syntax?.Expression,
    "Constructor evidence must retain the exact authored callee expression.",
  );
  assert.equal(selected?.selection.parameters.length, 1);
  assert.equal(selected?.selection.parameters[0]?.parameterName, "value");
  assert.equal(
    source.checker.typeToString(selected?.selection.parameters[0]?.selectedType),
    "number",
  );
  assert.equal(selected?.selection.argumentValues.length, 1);
  assert.equal(source.checker.typeToString(selected?.resultType), "Box");
  assert.equal(selected?.selection.application.receiver === undefined, true);
  const repeated = requireApplicableCallInfo(source.checker.getResolvedCallInfo(construction));
  assert.ok(
    repeated === selected,
    "Repeated constructor queries must retain the exact resolved call result.",
  );
  assert.ok(
    repeated?.selection.application.instantiatedSignature === selected?.selection.application.instantiatedSignature,
    "Repeated constructor queries must retain the exact selected signature.",
  );
  assert.ok(
    repeated?.resultType === selected?.resultType,
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
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(binary?.Left)?.type), "number");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(binary?.Right)?.type), "1");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(binaries[0])?.type), "number");

  const prefix = source.ast.as.AsPrefixUnaryExpression(prefixes[0]);
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(prefix?.Operand)?.type), "boolean");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(prefixes[0])?.type), "boolean");

  const postfix = source.ast.as.AsPostfixUnaryExpression(postfixes[0]);
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(postfix?.Operand)?.type), "number");
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(postfixes[0])?.type), "number");
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
    source.checker.typeToString(source.checker.getTypeAtLocation(assertion?.Expression)?.type),
    "Animal",
  );
  assert.equal(
    source.checker.typeToString(source.checker.getTypeFromTypeNode(assertion?.Type)?.type),
    "Dog",
  );
  assert.equal(source.checker.typeToString(source.checker.getTypeAtLocation(assertions[0])?.type), "Dog");
  assert.ok(
    source.checker.getTypeFromTypeNode(assertion?.Type)?.type
      === source.checker.getTypeAtLocation(assertions[0])?.type,
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

test("the single type-shape tuple query separates absent, empty, readonly and mutable tuples", () => {
  const source = checkedQueries(`
    export const primitive = 1;
    export const tuple = [1, "one"] as const;
    export const empty = [] as const;
    export const mutable: [number, string] = [1, "one"];
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

  const primitiveType = source.checker.getTypeAtLocation(primitive)?.type;
  const tupleType = source.checker.getTypeAtLocation(tuple)?.type;
  assert.equal(source.typeShape.isTuple(primitiveType), false);
  assert.equal(source.typeShape.getTupleInfo(primitiveType), undefined);
  assert.equal(source.typeShape.isTuple(tupleType), true);
  assert.equal(source.typeShape.getTupleInfo(tupleType)?.readonly, true);
  assert.deepEqual(
    source.typeShape.getTupleInfo(tupleType)?.elements.map(element => source.checker.typeToString(element.type)),
    ["1", "\"one\""],
  );
  const values = (name: string) => source.typeShape.getTupleInfo(source.checker.getTypeAtLocation(
    identifiers.find(node => source.ast.text(node) === name))?.type);
  assert.deepEqual(values("empty"), { readonly: true, elements: [] });
  assert.equal(values("mutable")?.readonly, false);
  const foreign = checkedQueries("export const tuple = [1, \"one\"] as const;");
  assert.equal(foreign.typeShape.getTupleInfo(tupleType), undefined);
  assert.equal(Object.hasOwn(source.typeShape, "getTupleElementInfos") || Object.hasOwn(source.typeShape, "getTupleElementTypes"), false);
});

for (const checkers of [1, 4]) test(`inferred destructuring tuple questions retain their own slots with ${checkers} checkers`, () => {
  const files = { "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": "declare const a:number; declare const c:number; export const [e, { f: selected }] = [a + 1, { f: c }];",
    "/src/other.ts": "export const other=true;", "/src/third.ts": "export const third=false;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files, rootFiles: Object.keys(files),
    compilerOptions: { ...testNoLibCompilerOptions, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const [initializer] = findNodes(file, ast.children, ast.is.IsArrayLiteralExpression);
  assert.ok(initializer);
  const read = checker.getTypeAtLocation(initializer)?.type;
  const context = checker.getContextualType(initializer)?.type;
  const actual = typeShape.getTupleInfo(read);
  const contextual = typeShape.getTupleInfo(context);
  assert.equal(read !== undefined && context !== undefined && read !== context
    && typeShape.getTypeReferenceTarget(read) === typeShape.getTypeReferenceTarget(context), true);
  assert.equal(actual?.readonly, false);
  assert.equal(contextual?.readonly, false);
  assert.deepEqual(actual?.elements.map(slot => [slot.elementKind, checker.typeToString(slot.type), slot.declaration === undefined]),
    [["required", "number", true], ["required", "{ f: number; }", true]]);
  assert.deepEqual(contextual?.elements.map(slot => [slot.elementKind, checker.typeToString(slot.type), slot.declaration === undefined]),
    [["required", "any", true], ["required", "{ f: any; }", true]]);
  const [pattern] = findNodes(file, ast.children, ast.is.IsObjectBindingPattern);
  assert.ok(pattern);
  const [element] = ast.children(pattern);
  assert.ok(ast.is.IsBindingElement(element));
  const [synthetic] = typeShape.getPropertyInfos(contextual?.elements[1]?.type);
  assert.ok(synthetic);
  assert.equal(checker.getSymbolValueDeclaration(synthetic.symbol), undefined);
  assert.equal(synthetic.rootSymbols.length, 1);
  assert.equal(synthetic.rootSymbols[0] === synthetic.symbol, true);
  assert.deepEqual(checker.getSymbolDeclarations(synthetic.symbol), []);
  assert.equal(synthetic.bindingPattern?.element === element, true);
  assert.equal(typeShape.getStringLiteralTypeValue(synthetic.bindingPattern?.keyType), "f");
  assert.equal(typeShape.getPropertyInfos(contextual?.elements[1]?.type)[0]?.bindingPattern === synthetic.bindingPattern, true);
  const [authored] = typeShape.getPropertyInfos(actual?.elements[1]?.type);
  assert.ok(authored);
  assert.equal(ast.is.IsPropertyAssignment(checker.getSymbolValueDeclaration(authored.symbol)), true);
  assert.equal(authored.bindingPattern, undefined);
});

for (const checkers of [1, 4]) test(`the conditional query reads only owned native operands and branches with ${checkers} checkers`, () => {
  const files = { "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": 'export type Choose<T> = T extends false ? "done" : "next";'
      + "export type Unwrap<T> = T extends readonly (infer Item)[] ? Item : never;"
      + "export type Closed = true extends true ? true : false;"
      + 'export type Indexed<Depth extends number> = { done: false; recur: true }[Depth extends -1 ? "done" : "recur"];',
    "/src/one.ts": "export const other=true;", "/src/two.ts": "export const other=false;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files, rootFiles: Object.keys(files),
    compilerOptions: { ...testNoLibCompilerOptions, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const [choose, unwrap, closed, indexed] = findNodes(file, ast.children, ast.is.IsConditionalTypeNode);
  assert.ok(choose && unwrap && closed && indexed);
  const syntax = ast.as.AsConditionalTypeNode(choose);
  assert.ok(syntax);
  const chosen = checker.getTypeFromTypeNode(choose)?.type;
  assert.ok(chosen);
  const native = Type_AsConditionalType(chosen);
  assert.ok(native);
  assert.equal(native.resolvedTrueType, undefined);
  assert.equal(native.resolvedFalseType, undefined);
  const authoredTrue = checker.getTypeFromTypeNode(syntax.TrueType)?.type;
  const authoredFalse = checker.getTypeFromTypeNode(syntax.FalseType)?.type;
  assert.ok(authoredTrue && authoredFalse);
  const answer = typeShape.getConditionalComponents(chosen);
  assert.ok(answer);
  assert.equal(answer.declaration === choose, true);
  assert.equal(answer.checkType === checker.getTypeFromTypeNode(syntax.CheckType)?.type, true);
  assert.equal(answer.extendsType === checker.getTypeFromTypeNode(syntax.ExtendsType)?.type, true);
  assert.equal(answer.distributive, true);
  assert.equal(answer.inferParameters.length, 0);
  assert.equal(answer.application, null);
  assert.equal(answer.trueBranch?.kind, "invariant-atom");
  assert.equal(answer.falseBranch?.kind, "invariant-atom");
  assert.equal(answer.trueBranch?.type === authoredTrue, true);
  assert.equal(answer.falseBranch?.type === authoredFalse, true);
  assert.equal(typeShape.getConditionalComponents({ ...chosen }) === undefined, true);
  assert.equal(native.resolvedTrueType, undefined);
  assert.equal(native.resolvedFalseType, undefined);

  const indexedType = checker.getTypeFromTypeNode(ast.parent(indexed))?.type;
  const installed = typeShape.getIndexedAccessComponents(indexedType);
  assert.ok(installed);
  assert.equal(typeShape.getTypeReferenceTarget(indexedType), undefined);
  assert.equal(typeShape.getTypeReferenceTarget(chosen), undefined);
  const ready = typeShape.getConditionalComponents(installed?.indexType);
  assert.ok(ready);
  assert.equal(ready.declaration === indexed, true);
  assert.equal(ready.trueBranch?.kind, "completed");
  assert.equal(ready.falseBranch?.kind, "completed");
  assert.equal(typeShape.getStringLiteralTypeValue(ready.trueBranch?.type), "done");
  assert.equal(typeShape.getStringLiteralTypeValue(ready.falseBranch?.type), "recur");

  const unwrapped = typeShape.getConditionalComponents(checker.getTypeFromTypeNode(unwrap)?.type);
  assert.ok(unwrapped);
  assert.equal(unwrapped.declaration === unwrap, true);
  assert.notEqual(unwrapped.trueBranch?.kind, "invariant-atom");
  const [inference] = findNodes(unwrap, ast.children, ast.is.IsInferTypeNode);
  const parameter = ast.as.AsInferTypeNode(inference)?.TypeParameter;
  assert.ok(parameter);
  const [binder] = unwrapped.inferParameters;
  assert.equal(unwrapped.inferParameters.length, 1);
  assert.equal(checker.getSymbolDeclarations(checker.getTypeSymbol(binder))[0] === parameter, true);
  assert.equal(typeShape.getConditionalComponents(checker.getTypeFromTypeNode(closed)?.type), undefined);
  assert.equal(checkedQueries("export const ready = 1;").typeShape.getConditionalComponents(chosen), undefined);
});

for (const checkers of [1, 4]) test(`selected conditional components retain the original outer arguments with ${checkers} checkers`, () => {
  const files = { "/src/core.d.ts": testCoreDeclarations,
    "/src/index.ts": `type Select<Item, Depth> = {
      done: Item;
      recur: Item extends readonly (infer Inner)[] ? Inner : Depth;
    }[Depth extends false ? "done" : "recur"];
    export type Chosen<Actual, Count> = Select<Actual, Count>;`,
    "/src/one.ts": "export const other=true;", "/src/two.ts": "export const other=false;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files, rootFiles: Object.keys(files),
    compilerOptions: { ...testNoLibCompilerOptions, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const [select, chosen] = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration);
  const source = checker.getTypeFromTypeNode(ast.typeNode(select))?.type;
  const applied = checker.getTypeFromTypeNode(ast.typeNode(chosen))?.type;
  const indexed = typeShape.getIndexedAccessComponents(applied);
  assert.ok(indexed);
  const selected = typeShape.getPropertyInfos(indexed.objectType).find(property => property.name === "recur")?.type;
  const data = Type_AsConditionalType(selected);
  const original = typeShape.getPropertyInfos(typeShape.getIndexedAccessComponents(source)?.objectType)
    .find(property => property.name === "recur")?.type;
  assert.ok(selected && data && original);
  assert.equal(selected === original, false);
  const trueType = data.resolvedTrueType;
  const falseType = data.resolvedFalseType;
  const answer = typeShape.getConditionalComponents(selected);
  const binding = answer?.application;
  assert.ok(binding);
  const [actual, count] = binding;
  assert.ok(actual && count);
  assert.equal(binding.length, 2);
  assert.equal(actual.argument === answer.checkType, true);
  assert.deepEqual(binding.map(row => [ast.text(ast.name(row.declaration)), checker.typeToString(row.argument)]),
    [["Item", "Actual"], ["Depth", "Count"]]);
  assert.equal(binding.some(row => row.parameter === answer.inferParameters[0]), false);
  assert.equal(typeShape.getConditionalComponents(original)?.application, null);
  assert.equal(typeShape.getConditionalComponents({ ...selected }) === undefined, true);
  assert.equal(data.resolvedTrueType === trueType && data.resolvedFalseType === falseType, true);
});

test("type-shape symbol query distinguishes exact symbol-like source types", () => {
  const source = checkedQueries(`
    declare const ordinary: symbol;
    declare const unique: unique symbol;
    declare const text: string;
  `);
  const identifiers = findNodes(
    source.sourceFile,
    source.ast.children,
    source.ast.is.IsIdentifier,
  );
  const typeOf = (name: string) => {
    const identifier = identifiers.find((node) => source.ast.text(node) === name);
    assert.ok(identifier !== undefined);
    return source.checker.getTypeAtLocation(identifier)?.type;
  };

  assert.equal(source.typeShape.isSymbolLike(typeOf("ordinary")), true);
  assert.equal(source.typeShape.isSymbolLike(typeOf("unique")), true);
  assert.equal(source.typeShape.isSymbolLike(typeOf("text")), false);
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

  const tuple = source.typeShape.getTupleInfo(
    source.checker.getTypeAtLocation(arguments_)?.type,
  );
  assert.deepEqual(
    tuple?.elements.map((element) => ({
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

  const substitution = source.checker.getTypeAtLocation(fallback)?.type;
  const baseType = source.typeShape.getSubstitutionBaseType(substitution);
  assert.ok(baseType !== undefined);
  assert.equal(source.typeShape.typeToString(baseType), "T");
  assert.equal(source.typeShape.getSubstitutionBaseType(baseType) === undefined, true);
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
    source.checker.getTypeAtLocation(detached)?.type,
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
    source.checker.getTypeAtLocation(rest)?.type,
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
      source.checker.getTypeAtLocation(callable)?.type,
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
    source.checker.getTypeAtLocation(sourceValue)?.type,
  );
  const normalizedProperties = source.typeShape.getPropertyInfos(
    source.checker.getTypeAtLocation(normalizedValue)?.type,
  );
  assert.equal(
    source.typeShape.couldContainTypeVariables(
      source.checker.getTypeAtLocation(openValue)?.type,
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
      source.checker.getTypeAtLocation(normalizedValue)?.type,
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
    source.checker.getTypeAtLocation(box)?.type,
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

test("a synthetic class prototype retains its actual class, never an authored property of the same spelling", () => {
  const { sourceFile, ast, checker, typeShape } = checkedQueries(`
    interface Box { field: boolean; }
    class Box { field = true; }
    const constructorValue = Box;
    const objectValue = { prototype: false };
  `);
  const [declaration] = findNodes(sourceFile, ast.children, ast.is.IsClassDeclaration);
  assert.ok(declaration);
  const nodes = findNodes(sourceFile, ast.children, ast.is.IsIdentifier);
  const prototypeOf = (name: string) => {
    const use = nodes.find(node => ast.text(node) === name);
    assert.ok(use);
    const type = checker.getTypeAtLocation(use)?.type;
    assert.ok(type);
    return typeShape.getPropertyInfos(type).find(row => row.name === "prototype");
  };
  const synthetic = prototypeOf("constructorValue");
  assert.ok(synthetic);
  assert.equal(synthetic.classPrototype === declaration, true);
  assert.equal(checker.getSymbolValueDeclaration(synthetic.symbol), undefined);
  const authored = prototypeOf("objectValue");
  assert.ok(authored);
  assert.equal(authored.classPrototype, undefined);
  assert.equal(ast.is.IsPropertyAssignment(checker.getSymbolValueDeclaration(authored.symbol)), true);
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
