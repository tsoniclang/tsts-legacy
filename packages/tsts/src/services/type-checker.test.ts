import { test } from "node:test";
import assert from "node:assert/strict";
import { Background } from "../go/context.js";
import { Node_Expression, Node_Parameters, Node_Text } from "../internal/ast/ast.js";
import { Diagnostic_Code } from "../internal/ast/diagnostic.js";
import { Node_Name } from "../internal/ast/spine.js";
import {
  KindArrowFunction,
  KindCallExpression,
  KindConstructor,
  KindExpressionStatement,
  KindFunctionDeclaration,
  KindFunctionExpression,
  KindFunctionType,
  KindGetAccessor,
  KindIdentifier,
  KindMethodDeclaration,
  KindMethodSignature,
  KindPropertyAssignment,
  KindPropertySignature,
  KindShorthandPropertyAssignment,
  KindSetAccessor,
  KindTypeAliasDeclaration,
  KindTypeParameter,
  KindTypeReference,
} from "../internal/ast/generated/kinds.js";
import { TypeFlagsAny, TypeFlagsNumber, TypeFlagsString } from "../internal/checker/types.js";
import { Program_GetSemanticDiagnostics, Program_GetSourceFile } from "../internal/compiler/program.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { createCompilerSessionFromFiles } from "./compiler-session.js";
import { sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions, testProviderModel } from "../extensions/source-provider-test-support.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findFirstNodeByKind,
  findIdentifierByText,
  findNodesByKind,
  findPropertyAccessByName,
} from "./type-checker-test-support.js";

for (const [label, source, kind, count] of [
  ["declaration", "function step(value: number) { return value; }", KindFunctionDeclaration, 1],
  ["arrow", "const step = (value: number) => value;", KindArrowFunction, 1],
  ["function expression", "const step = function(value: number) { return value; };", KindFunctionExpression, 1],
  ["destructuring/default/rest", "function step({ value }: { value: number }, count = 1, ...rest: number[]) { return value + count; }", KindFunctionDeclaration, 3],
  ["optional", "function step(value?: number) { return value; }", KindFunctionDeclaration, 1],
  ["empty", "function step() { return 1; }", KindFunctionDeclaration, 0],
  ["pseudo-this", "function step(this: void, thisValue: number) { return thisValue; }", KindFunctionDeclaration, 1],
  ["tuple rest", "function step(...values: [number, string]) { return values[0]; }", KindFunctionDeclaration, 1],
  ["constructor", "class Owner { constructor(value: number) {} }", KindConstructor, 1],
  ["method", "class Owner { step(value: number) { return value; } }", KindMethodDeclaration, 1],
  ["method signature", "interface Owner { step(value: number): number; }", KindMethodSignature, 1],
  ["function type", "type Read = (value: number) => number;", KindFunctionType, 1],
  ["getter", "class Owner { get value() { return 1; } }", KindGetAccessor, 0],
  ["setter", "class Owner { set value(value: number) {} }", KindSetAccessor, 1],
] as const) {
  test(`raw declaration signatures retain ${label} inputs without resolving the result`, () => {
    const { program, index } = createProgram(source);
    const queries = createTypeCheckerQueries(program, { sourceFile: index });
    const declaration = findFirstNodeByKind(index, kind);
    const signature = queries.getSignatureFromDeclaration(declaration);
    assert.equal(signature !== undefined, true, `${label}: exact checked declaration signature`);
    assert.equal(queries.getSignatureDeclaration(signature) === declaration, true, `${label}: original declaration owner`);
    assert.equal(signature?.resolvedReturnType === undefined, true, `${label}: result remains unresolved`);
    const parameters = queries.getSignatureParameters(signature);
    const receiver = queries.getPrimarySymbolDeclaration(queries.getSignatureThisParameter(signature));
    const original = (Node_Parameters(declaration) ?? []).filter(parameter => parameter !== receiver);
    assert.equal(parameters.length, count, `${label}: original unexpanded value count`);
    assert.equal(parameters.length === original.length && parameters.every((parameter, position) =>
      parameter !== undefined && queries.getPrimarySymbolDeclaration(parameter) === original[position]), true,
    `${label}: original parameter identities and order`);
    if (label === "pseudo-this") {
      assert.equal(receiver !== undefined, true, "the actual checked receiver is separated");
      assert.equal(queries.getSymbolName(parameters[0]), "thisValue", "an ordinary thisValue input is retained");
    }
    assert.equal(queries.getSignatureFromDeclaration(declaration) === signature, true, `${label}: canonical cached signature`);
    assert.equal(signature?.resolvedReturnType === undefined, true, `${label}: repeated input read leaves result unresolved`);
    assert.equal(queries.getSignatureFromDeclaration(index) === undefined, true, `${label}: noncallable does not invent a signature`);
    assert.equal(queries.getSignatureFromDeclaration(undefined) === undefined, true, `${label}: absence does not invent an empty signature`);
  });
}

test("raw declaration signatures retain implementation inputs separately from a selected public overload", () => {
  const { program, index } = createProgram(`
    function read(value: number): number;
    function read(value: number, delta?: number): number { return value + (delta ?? 0); }
    read(1);
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const declaration = findNodesByKind(index, KindFunctionDeclaration).at(-1);
  const implementation = queries.getSignatureFromDeclaration(declaration);
  assert.equal(implementation !== undefined && queries.getSignatureDeclaration(implementation) === declaration, true,
    "the exact implementation, not a public overload, owns the definition signature");
  assert.equal(queries.getSignatureParameters(implementation).length, 2, "the implementation retains its optional native input");
  assert.equal(implementation?.resolvedReturnType === undefined, true, "definition enumeration does not infer a result");
  const selected = queries.getResolvedSignature(findFirstNodeByKind(index, KindCallExpression));
  assert.equal(selected !== undefined && selected !== implementation, true, "the actual invocation has its separate public selection");
  assert.equal(queries.getSignatureParameters(selected).length, 1, "the selected overload has its own logical input count");
});

test("raw declaration queries retain original source-file ownership across query contexts", () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/api.ts": "export function read(value: number) { return value; }",
    "/src/bridge.ts": "export { read } from './api.js';",
  }, compilerOptions: { noLib: true, strict: true, module: "esnext", target: "es2022" } });
  session.ensureBound();
  const apiFile = Program_GetSourceFile(session.program, "/src/api.ts");
  const bridgeFile = Program_GetSourceFile(session.program, "/src/bridge.ts");
  assert.equal(apiFile !== undefined && bridgeFile !== undefined, true, "both original files belong to the same program");
  const declaration = findFirstNodeByKind(apiFile, KindFunctionDeclaration);
  const local = createTypeCheckerQueries(session.program, { sourceFile: apiFile });
  const bridge = createTypeCheckerQueries(session.program, { sourceFile: bridgeFile });
  const original = local.getSignatureFromDeclaration(declaration);
  const transported = bridge.getSignatureFromDeclaration(declaration);
  assert.equal(original !== undefined && transported === original, true, "the authored declaration keeps its canonical signature");
  assert.equal(bridge.getSignatureDeclaration(transported) === declaration, true, "the requesting file never replaces the authored owner");
  assert.equal(bridge.getPrimarySymbolDeclaration(bridge.getSignatureParameters(transported)[0]) === Node_Parameters(declaration)?.[0], true,
    "cross-file input reads retain the original Parameter node");
  assert.equal(transported?.resolvedReturnType === undefined, true, "transport does not force the owner result");
  const foreign = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/api.ts": "export function read(value: number) { return value; }",
    "/src/bridge.ts": "export { read } from './api.js';",
  }, compilerOptions: { noLib: true, strict: true, module: "esnext", target: "es2022" } });
  foreign.ensureBound();
  const foreignFile = Program_GetSourceFile(foreign.program, "/src/api.ts");
  const foreignDeclaration = findFirstNodeByKind(foreignFile, KindFunctionDeclaration);
  assert.equal(foreignFile !== undefined && foreignFile !== apiFile, true, "the same file name does not identify the same checked source file");
  assert.equal(createTypeCheckerQueries(foreign.program, { sourceFile: foreignFile }).getSignatureFromDeclaration(foreignDeclaration) !== undefined, true,
    "the foreign program owns its own callable definition");
  assert.equal(bridge.getSignatureFromDeclaration(foreignDeclaration) === undefined, true,
    "a raw declaration query refuses another program's same-name source file");
});

test("raw declaration queries admit checked provider owners excluded from traversal and refuse foreign provider identities", () => {
  const specifier = "@test/raw-callable-owner.js";
  const model = testProviderModel(specifier, "Test.RawCallableOwner", [{ id: "Native", name: "Native", kind: "class",
    members: [{ id: "Native::read", name: "read", kind: "method", signatures: [{ id: "Native::read(number)",
      parameters: [{ name: "value", type: { kind: "number" } }], returnType: { kind: "number" } }] }] }]);
  const create = () => createCompilerSessionFromFiles({ currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": `import type { Native } from "${specifier}"; declare const value: Native; export const result = value.read(1);` },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[specifier, model]]))] },
  }).checkSource();
  const checked = create();
  assert.equal(checked.diagnostics.length, 0, "the provider callable checks against the exact native declaration");
  assert.equal(checked.extensionDiagnostics.length, 0, "the actual provider model is admitted");
  const index = checked.getSourceFile("/src/index.ts");
  const queries = checked.getSourceFileQueries(index).checker;
  const call = findFirstNodeByKind(index, KindCallExpression);
  const declaration = queries.getSignatureDeclaration(queries.getResolvedSignature(call));
  const owner = checked.ast.getSourceFile(declaration);
  assert.equal(owner !== undefined && checked.containsSourceFile(owner), true, "the provider declaration is an original node of this checked program");
  assert.equal(checked.sourceFiles.includes(owner), false, "the canonical provider owner is not an emitted traversal source");
  const signature = queries.getSignatureFromDeclaration(declaration);
  assert.equal(signature !== undefined && queries.getSignatureDeclaration(signature) === declaration, true,
    "the included call-site query retains the excluded provider's original definition");
  assert.equal(queries.getSignatureParameters(signature).length, 1, "the original native definition retains its value slot");
  assert.equal(queries.getPrimarySymbolDeclaration(queries.getSignatureParameters(signature)[0]) === Node_Parameters(declaration)?.[0], true,
    "the provider's actual checked parameter node is retained without parsing or copying");
  const foreign = create();
  const foreignIndex = foreign.getSourceFile("/src/index.ts");
  const foreignQueries = foreign.getSourceFileQueries(foreignIndex).checker;
  const foreignDeclaration = foreignQueries.getSignatureDeclaration(foreignQueries.getResolvedSignature(findFirstNodeByKind(foreignIndex, KindCallExpression)));
  const foreignOwner = foreign.ast.getSourceFile(foreignDeclaration);
  assert.equal(foreignOwner !== undefined && foreign.containsSourceFile(foreignOwner), true, "the other program owns its provider declaration");
  assert.equal(foreign.ast.getFileName(foreignOwner), checked.ast.getFileName(owner), "the foreign provider deliberately has the same canonical URI");
  assert.equal(checked.containsSourceFile(foreignOwner), false, "matching provider URIs do not prove program membership");
  assert.equal(queries.getSignatureFromDeclaration(foreignDeclaration) === undefined, true, "a foreign same-URI provider AST is refused");
});

test("public type-checker queries expose TS-Go checker facts without emitter re-analysis", () => {
  const { program, index } = createProgram(`
    function id<T>(x: T): T { return x; }
    declare function takes(callback: (value: number) => void): void;
    declare let value: string | number;

    if (typeof value === "string") {
      value;
    }

    id(1);
    takes(parameter => parameter);
  `);
  assertCleanSemanticDiagnostics(program, index);

  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const narrowedValue = findIdentifierByText(
    index,
    "value",
    (node) => node?.Parent?.Kind === KindExpressionStatement,
  );
  const narrowedType = queries.getTypeAtLocation(narrowedValue);
  assert.equal((narrowedType?.flags ?? 0) & TypeFlagsString, TypeFlagsString);

  const valueSymbol = queries.getSymbolAtLocation(narrowedValue);
  assert.equal(queries.getSymbolName(valueSymbol), "value");
  const resolvedValueSymbol = queries.getResolvedSymbol(narrowedValue);
  assert.equal(resolvedValueSymbol?.Name, "value");
  assert.ok(
    queries.getResolvedSymbolOrNil(narrowedValue) === resolvedValueSymbol,
    "Resolved-symbol queries must retain exact checker symbol identity.",
  );
  assert.ok(queries.getTypeOfSymbol(valueSymbol) !== undefined);
  assert.ok(queries.getDeclaredTypeOfSymbol(valueSymbol) !== undefined);
  assert.equal(queries.getSymbolDeclarations(valueSymbol).length, 1);
  assert.ok(
    queries.getSymbolValueDeclaration(valueSymbol) === queries.getPrimarySymbolDeclaration(valueSymbol),
    "The selected symbol must retain its exact value declaration.",
  );
  assert.ok(
    queries.getSymbolSourceFile(valueSymbol) === index,
    "The selected symbol must retain its exact source file.",
  );

  const call = findFirstNodeByKind(index, KindCallExpression);
  const signature = queries.getResolvedSignature(call);
  assert.equal(queries.getSignatureParameters(signature)[0]?.Name, "x");
  assert.equal(
    queries.getSignatureDeclaration(signature)?.Kind,
    call === undefined
      ? undefined
      : queries.getPrimarySymbolDeclaration(queries.getResolvedSymbol(Node_Expression(call)))?.Kind,
  );

  const arrow = findFirstNodeByKind(index, KindArrowFunction);
  assert.ok(queries.getContextualType(arrow) !== undefined);
  const idIdentifier = findIdentifierByText(
    index,
    "id",
    (node) => node?.Parent?.Kind === KindCallExpression,
  );
  const idType = queries.getTypeAtLocation(idIdentifier);
  assert.equal(queries.getCallSignaturesOfType(idType).length, 1);
  assert.equal(queries.getConstructSignaturesOfType(idType).length, 0);
  assertCleanSemanticDiagnostics(program, index);
});

for (const contextualType of ["unknown", "object", "{}"] as const) {
  test(`object-literal elements retain original evidence under ${contextualType} without a selected member`, () => {
    const { program, index } = createProgram(`
      const value: ${contextualType} = { item: { nested: 1 } };
    `);
    assertCleanSemanticDiagnostics(program, index);
    const queries = createTypeCheckerQueries(program, { sourceFile: index });
    const properties = findNodesByKind(index, KindPropertyAssignment);
    assert.equal(properties.length, 2, "outer and nested properties are actual checked occurrences");
    for (const [position, property] of properties.entries()) {
      const info = queries.getResolvedObjectLiteralElementInfo(property);
      assert.equal(info !== undefined, true, `property ${position} retains its source evidence`);
      assert.equal(info?.element === property, true, `property ${position} keeps original node identity`);
      assert.equal(info?.sourceElementSymbol !== undefined, true, `property ${position} has its actual source symbol`);
      assert.equal(info?.sourceSelectedSymbol === info?.sourceElementSymbol, true,
        `property ${position} selects its own declaration, not an invented contextual member`);
      assert.equal(info?.sourceSelectedDeclaration === property, true, `property ${position} keeps its original declaration`);
      assert.equal(info?.sourceSelectedDeclarations.length, 1, `property ${position} has one exact selected declaration`);
      assert.equal(info?.sourceSelectedType === queries.getTypeOfSymbol(info?.sourceElementSymbol), true,
        `property ${position} keeps its selected source symbol type`);
      assert.equal(queries.getResolvedObjectLiteralElementInfo(property) === info, true,
        `property ${position} retains its one immutable query result`);
      assert.equal(Object.isFrozen(info), true, `property ${position} evidence is immutable`);
    }
    assert.equal(properties[0] !== undefined && queries.getResolvedObjectLiteralElementInfo(properties[0])?.contextualType !== undefined,
      true, "the outer contextual type remains present without inventing a contextual property");
  });
}

test("resolved object-literal elements retain exact contextual member identity", () => {
  const { program, index } = createProgram(`
    interface Counter {
      value: number;
      label: string;
      next(delta: number): number;
    }

    const value = 2;
    const counter: Counter = {
      value,
      label: "counter",
      next(delta) { return this.value + delta; },
    };
    const inferred = {
      ping() { return 1; },
    };
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const methodSignature = findFirstNodeByKind(index, KindMethodSignature);
  const propertySignatures = findNodesByKind(index, KindPropertySignature);
  const shorthand = findFirstNodeByKind(index, KindShorthandPropertyAssignment);
  const assignment = findFirstNodeByKind(index, KindPropertyAssignment);
  const methods = findNodesByKind(index, KindMethodDeclaration);
  const contextualMethod = methods[0];
  const inferredMethod = methods[1];

  const methodInfo = queries.getResolvedObjectLiteralElementInfo(contextualMethod);
  assert.equal(methodInfo?.elementKind, "method");
  assert.ok(methodInfo?.element === contextualMethod);
  assert.ok(methodInfo?.sourceSelectedDeclaration === methodSignature);
  assert.deepEqual(methodInfo?.sourceSelectedDeclarations, [methodSignature]);
  assert.ok(methodInfo?.sourceElementSymbol !== methodInfo?.sourceSelectedSymbol);
  assert.equal(queries.typeToString(methodInfo?.contextualType), "Counter");
  assert.equal(queries.typeToString(methodInfo?.sourceSelectedType), "(delta: number) => number");
  assert.ok(
    queries.getResolvedObjectLiteralElementInfo(contextualMethod) === methodInfo,
    "Repeated object-literal element queries must retain one immutable evidence object.",
  );

  const shorthandInfo = queries.getResolvedObjectLiteralElementInfo(shorthand);
  assert.equal(shorthandInfo?.elementKind, "shorthand");
  assert.ok(shorthandInfo?.sourceSelectedDeclaration === propertySignatures[0]);
  assert.equal(queries.typeToString(shorthandInfo?.sourceSelectedType), "number");

  const assignmentInfo = queries.getResolvedObjectLiteralElementInfo(assignment);
  assert.equal(assignmentInfo?.elementKind, "property");
  assert.ok(assignmentInfo?.sourceSelectedDeclaration === propertySignatures[1]);
  assert.equal(queries.typeToString(assignmentInfo?.sourceSelectedType), "string");

  const inferredInfo = queries.getResolvedObjectLiteralElementInfo(inferredMethod);
  assert.equal(inferredInfo?.elementKind, "method");
  assert.equal(inferredInfo?.contextualType, undefined);
  assert.ok(inferredInfo?.sourceSelectedDeclaration === inferredMethod);
  assert.equal(queries.typeToString(inferredInfo?.sourceSelectedType), "() => number");
  assert.equal(queries.getResolvedObjectLiteralElementInfo(methodSignature), undefined);
});

test("object-literal member evidence distinguishes same-spelled contextual contracts", () => {
  const { program, index } = createProgram(`
    interface NumericContract { run(): number; }
    interface StringContract { run(): string; }
    interface CallbackTable { [name: string]: () => number; }

    const selectedName = "run" as const;
    const numeric: NumericContract = { run() { return 1; } };
    const string: StringContract = { [selectedName]() { return "one"; } };
    const indexed: CallbackTable = { run() { return 2; } };
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const signatures = findNodesByKind(index, KindMethodSignature);
  const methods = findNodesByKind(index, KindMethodDeclaration);
  assert.equal(signatures.length, 2);
  assert.equal(methods.length, 3);

  const numeric = queries.getResolvedObjectLiteralElementInfo(methods[0]);
  const string = queries.getResolvedObjectLiteralElementInfo(methods[1]);
  const indexed = queries.getResolvedObjectLiteralElementInfo(methods[2]);
  assert.ok(numeric?.sourceSelectedDeclaration === signatures[0]);
  assert.ok(string?.sourceSelectedDeclaration === signatures[1]);
  assert.ok(numeric?.sourceSelectedSymbol !== string?.sourceSelectedSymbol);
  assert.equal(queries.typeToString(numeric?.sourceSelectedType), "() => number");
  assert.equal(queries.typeToString(string?.sourceSelectedType), "() => string");

  assert.equal(indexed?.sourceSelectedSymbol, undefined);
  assert.equal(indexed?.sourceSelectedDeclaration, undefined);
  assert.deepEqual(indexed?.sourceSelectedDeclarations, []);
  assert.equal(queries.typeToString(indexed?.sourceSelectedType), "() => number");
});

test("lexical symbol queries preserve exact scoped declaration identity", () => {
  const { program, index } = createProgram(`
    type scope = number;
    type Canonical = scope;
    function shadowed<scope>(value: scope): scope { return value; }
  `);
  assertCleanSemanticDiagnostics(program, index);

  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const references = findNodesByKind(index, KindIdentifier).filter(
    (node) => Node_Text(node) === "scope" && node.Parent?.Kind === KindTypeReference,
  );
  assert.equal(references.length, 3);
  assert.equal(
    queries.getSymbolDeclarations(
      queries.getLexicallyResolvedSymbol(references[0]),
    )[0]?.Kind,
    KindTypeAliasDeclaration,
  );
  for (const reference of references.slice(1)) {
    assert.equal(
      queries.getSymbolDeclarations(
        queries.getLexicallyResolvedSymbol(reference),
      )[0]?.Kind,
      KindTypeParameter,
    );
  }
});

test("resolved call info exposes one canonical checker-owned selected decision", () => {
  const { program, index } = createProgram(`
    class Box<T> {
      run<U>(value: U, ...rest: U[]): U {
        return value;
      }
    }

    declare const box: Box<string>;
    box.run<number>(1, 2);
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findFirstNodeByKind(index, KindCallExpression);

  const queryFirst = queries.getResolvedCallInfo(call);
  assert.equal(queryFirst?.outcome, "applicable");
  assert.ok(queryFirst?.call === call, "Resolved call evidence must retain the exact call node.");
  assert.ok(
    queryFirst?.selectedSignature === queries.getResolvedSignature(call),
    "Resolved call evidence must retain the checker-selected signature.",
  );
  assert.equal(queryFirst?.sourceSelectedMethodTypeArguments?.length, 1);
  assert.equal(
    (queryFirst?.sourceSelectedMethodTypeArguments?.[0]?.selectedType.flags ?? 0) & TypeFlagsNumber,
    TypeFlagsNumber,
  );
  assert.ok(queryFirst?.sourceSelectedMethodTypeArguments?.[0]?.explicitTypeNode !== undefined);
  assert.deepEqual(
    queryFirst?.sourceSelectedSignatureParameters.map((parameter) => [
      parameter.parameterIndex,
      parameter.parameterName,
      parameter.acceptsOmission,
      parameter.rest,
    ]),
    [
      [0, "value", false, false],
      [1, "rest", true, true],
    ],
  );
  assert.equal(queryFirst?.sourceArguments.length, 2);
  assert.equal(queryFirst?.sourceArgumentBindings.length, 2);
  assert.equal(queryFirst?.sourceArgumentBindings[1]?.sourceParameterForm, "rest-element");
  assert.ok(queryFirst?.sourceReceiver !== undefined);
  assert.equal(queryFirst?.sourceCalleeAccess?.kind, "property");
  assert.ok(queryFirst?.sourceCalleeAccess?.selectedDeclaration !== undefined);
  assert.equal((queryFirst?.sourceResultType.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);

  assertCleanSemanticDiagnostics(program, index);
  const repeated = queries.getResolvedCallInfo(call);
  assert.ok(repeated === queryFirst, "Repeated call queries must retain the exact evidence object.");
  assert.ok(
    repeated?.selectedSignature === queryFirst?.selectedSignature,
    "Repeated call queries must retain exact signature identity.",
  );
  assert.ok(
    repeated?.sourceResultType === queryFirst?.sourceResultType,
    "Repeated call queries must retain exact result-type identity.",
  );
});

test("resolved call info retains the final contextual callee observation", () => {
  const { program, index } = createProgram(`
    interface Array<T> {
      concat(items: T[]): T[];
    }
    interface ValidationError {
      message: string;
    }
    function append(result: ValidationError[] | null, inner: ValidationError[]): ValidationError[] {
      return (result || []).concat(inner);
    }
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findFirstNodeByKind(index, KindCallExpression);

  const selected = queries.getResolvedCallInfo(call);
  assert.equal(selected?.outcome, "applicable");
  assert.ok(selected?.sourceReceiver !== undefined);
  assert.equal(queries.typeToString(selected.sourceReceiver.type), "ValidationError[]");
  assert.ok(
    queries.getResolvedCallInfo(call) === selected,
    "The finalized call must retain one immutable contextual selection.",
  );
});

test("resolved tuple-rest arguments retain their declared rest parameter identity", () => {
  const { program, index } = createProgram(`
    declare function consume(...values: [number, string, boolean]): void;
    declare const values: [number, string, boolean];
    consume(...values);
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findFirstNodeByKind(index, KindCallExpression);

  const selected = queries.getResolvedCallInfo(call);
  assert.equal(selected?.outcome, "applicable");
  assert.deepEqual(
    selected?.sourceSelectedSignatureParameters.map((parameter) => [parameter.parameterIndex, parameter.rest]),
    [[0, true]],
  );
  assert.equal(selected?.sourceArgumentBindings.length, 3);
  assert.deepEqual(
    selected?.sourceArgumentBindings.map((binding) => binding.sourceParameterIndex),
    [0, 0, 0],
  );
});

test("invalid super calls preserve TS-Go diagnostics without selected call evidence", () => {
  const { program, index } = createProgram(`
    class C {
      method(): void {
        super<Missing>(0);
      }
    }
  `);
  const diagnostics = Program_GetSemanticDiagnostics(program, Background(), index);
  assert.deepEqual(diagnostics.map(Diagnostic_Code), [2337]);

  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findFirstNodeByKind(index, KindCallExpression);
  assert.equal(queries.getResolvedCallInfo(call), undefined);
});

test("resolved call info preserves exact optional-chain result semantics", () => {
  const { program, index } = createProgram(`
    class Box {
      read(): number { return 1; }
    }

    declare const box: Box;
    box.read();
    box?.read();
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const calls = findNodesByKind(index, KindCallExpression);
  assert.equal(calls.length, 2);
  assert.equal(queries.getResolvedCallInfo(calls[0])?.optionalChain, false);
  assert.equal(queries.getResolvedCallInfo(calls[1])?.optionalChain, true);
  assertCleanSemanticDiagnostics(program, index);
});

test("resolved call info retains exact dynamic property and element callee access", () => {
  const { program, index } = createProgram(`
    declare const value: any;
    declare const key: string;

    value.create(1);
    value[key](2);
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const calls = findNodesByKind(index, KindCallExpression);
  assert.equal(calls.length, 2);

  const propertyCall = queries.getResolvedCallInfo(calls[0]);
  assert.equal(propertyCall?.outcome, "untyped");
  assert.equal(propertyCall?.sourceCalleeAccess?.kind, "property");
  assert.equal(propertyCall?.sourceCalleeAccess?.selectedSymbol, undefined);
  assert.equal(propertyCall?.sourceCalleeAccess?.selectedDeclaration, undefined);
  assert.equal(
    (propertyCall?.sourceCalleeAccess?.receiver.type.flags ?? 0) & TypeFlagsAny,
    TypeFlagsAny,
  );
  assert.equal(
    (propertyCall?.sourceCalleeAccess?.resultType.flags ?? 0) & TypeFlagsAny,
    TypeFlagsAny,
  );

  const elementCall = queries.getResolvedCallInfo(calls[1]);
  assert.equal(elementCall?.outcome, "untyped");
  assert.equal(elementCall?.sourceCalleeAccess?.kind, "element");
  assert.equal(elementCall?.sourceCalleeAccess?.selectedSymbol, undefined);
  assert.equal(elementCall?.sourceCalleeAccess?.selectedDeclaration, undefined);
  assert.equal(
    (elementCall?.sourceCalleeAccess?.receiver.type.flags ?? 0) & TypeFlagsAny,
    TypeFlagsAny,
  );
  assert.equal(
    (elementCall?.sourceCalleeAccess?.resultType.flags ?? 0) & TypeFlagsAny,
    TypeFlagsAny,
  );
  assert.equal(
    queries.typeToString(
      elementCall?.sourceCalleeAccess?.kind === "element"
        ? elementCall.sourceCalleeAccess.argument.type
        : undefined,
    ),
    "string",
  );
  assert.ok(queries.getResolvedCallInfo(calls[0]) === propertyCall);
  assert.ok(queries.getResolvedCallInfo(calls[1]) === elementCall);
  assertCleanSemanticDiagnostics(program, index);
});

test("resolved call info retains only the winning overload candidate", () => {
  const { program, index } = createProgram(`
    class Box {
      run(value: string): string;
      run(value: number): number;
      run(value: string | number): string | number {
        return value;
      }
    }

    declare const box: Box;
    box.run(1);
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findFirstNodeByKind(index, KindCallExpression);

  const selected = queries.getResolvedCallInfo(call);
  assert.equal(selected?.outcome, "applicable");
  assert.equal(selected?.sourceSelectedSignatureParameters.length, 1);
  assert.equal(
    (selected?.sourceSelectedSignatureParameters[0]?.selectedType.flags ?? 0) & TypeFlagsNumber,
    TypeFlagsNumber,
  );
  assert.equal((selected?.sourceResultType.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);

  assertCleanSemanticDiagnostics(program, index);
  assert.ok(
    queries.getResolvedCallInfo(call) === selected,
    "Repeated overload selection must retain the exact winning evidence.",
  );
});

test("resolved call info preserves omission semantics without inventing effective arguments", () => {
  const { program, index } = createProgram(`
    declare function consume(value: number, state?: object): void;
    consume(1);
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const call = findFirstNodeByKind(index, KindCallExpression);
  queries.getTypeAtLocation(call);
  const selected = queries.getResolvedCallInfo(call);

  assert.equal(selected?.outcome, "applicable");
  assert.deepEqual(
    selected?.sourceSelectedSignatureParameters.map((parameter) => [
      parameter.parameterIndex,
      parameter.parameterName,
      parameter.acceptsOmission,
      parameter.rest,
    ]),
    [
      [0, "value", false, false],
      [1, "state", true, false],
    ],
  );
  assert.equal(selected?.sourceArguments.length, 1);
  assert.equal(selected?.sourceArgumentBindings.length, 1);
  assert.equal(selected?.sourceArgumentBindings[0]?.sourceParameterIndex, 0);
  assertCleanSemanticDiagnostics(program, index);
});

test("resolved call info preserves an applicable zero-argument decision", () => {
  const { program, index } = createProgram(`
    declare function clear(): void;
    clear();
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const calls = findNodesByKind(index, KindCallExpression);
  assert.equal(calls.length, 1);
  assert.equal(queries.getResolvedCallInfo(index), undefined);

  const selected = queries.getResolvedCallInfo(calls[0]);
  assert.equal(selected?.outcome, "applicable");
  assert.deepEqual(selected?.sourceSelectedSignatureParameters, []);
  assert.deepEqual(selected?.sourceArguments, []);
  assert.deepEqual(selected?.sourceArgumentBindings, []);
  assertCleanSemanticDiagnostics(program, index);
});

test("public type-checker queries expose instantiated generic member types", () => {
  const { program, index } = createProgram(`
    type int = number;
    class Box<T> { value!: T; }
    declare const nested: Box<Box<int>>;

    nested.value.value;
  `);
  assertCleanSemanticDiagnostics(program, index);

  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const finalValueAccess = findPropertyAccessByName(
    index,
    "value",
    (node) => node?.Parent?.Kind === KindExpressionStatement,
  );
  const finalValueType = queries.getTypeAtLocation(finalValueAccess);
  assert.equal((finalValueType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);

  const finalValueSymbol = queries.getSymbolAtLocation(Node_Name(finalValueAccess));
  assert.equal(finalValueSymbol?.Name, "value");
  assertCleanSemanticDiagnostics(program, index);
});
