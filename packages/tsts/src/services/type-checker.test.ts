import { test } from "node:test";
import assert from "node:assert/strict";
import { Background } from "../go/context.js";
import { Node_Expression, Node_Text } from "../internal/ast/ast.js";
import { Diagnostic_Code } from "../internal/ast/diagnostic.js";
import { Node_Name } from "../internal/ast/spine.js";
import {
  KindArrowFunction,
  KindCallExpression,
  KindExpressionStatement,
  KindIdentifier,
  KindTypeAliasDeclaration,
  KindTypeParameter,
  KindTypeReference,
} from "../internal/ast/generated/kinds.js";
import { TypeFlagsAny, TypeFlagsNumber, TypeFlagsString } from "../internal/checker/types.js";
import { Program_GetSemanticDiagnostics } from "../internal/compiler/program.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findFirstNodeByKind,
  findIdentifierByText,
  findNodesByKind,
  findPropertyAccessByName,
} from "./type-checker-test-support.js";

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
