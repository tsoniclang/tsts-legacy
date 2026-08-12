import { test } from "node:test";
import assert from "node:assert/strict";
import { Node_Text } from "../internal/ast/ast.js";
import { Node_Name } from "../internal/ast/spine.js";
import {
  KindElementAccessExpression,
  KindForOfStatement,
  KindPropertyAccessExpression,
} from "../internal/ast/generated/kinds.js";
import { TypeFlagsNumber, TypeFlagsString } from "../internal/checker/types.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findNodesByKind,
  findPropertyAccessByName,
} from "./type-checker-test-support.js";

test("property selection uses the selected symbol with distinct read and write types", () => {
  const { program, index } = createProgram(`
    class Model {
      get value(): string {
        return "";
      }

      set value(next: number) {}
    }

    declare const model: Model;
    const read = model.value;
    model.value = 1;
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const valueAccesses = findNodesByKind(index, KindPropertyAccessExpression)
    .filter((node) => Node_Text(Node_Name(node)) === "value");
  assert.equal(valueAccesses.length, 2);
  const readAccess = valueAccesses[0];
  const writeAccess = valueAccesses[1];
  const selectedSymbol = queries.getSymbolAtLocation(Node_Name(readAccess));
  const readInfo = queries.getResolvedPropertyAccessInfo(readAccess);
  const writeInfo = queries.getResolvedPropertyAccessInfo(writeAccess);

  assert.equal(queries.getSymbolName(selectedSymbol), "value");
  assert.equal((queries.getTypeOfSymbol(selectedSymbol)?.flags ?? 0) & TypeFlagsString, TypeFlagsString);
  assert.equal((queries.getWriteTypeOfSymbol(selectedSymbol)?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(readInfo?.accessMode, "read");
  assert.equal((readInfo?.sourceReadType?.flags ?? 0) & TypeFlagsString, TypeFlagsString);
  assert.equal(readInfo?.sourceWriteType === undefined, true);
  assert.equal(writeInfo?.accessMode, "write");
  assert.equal(writeInfo?.sourceReadType === undefined, true);
  assert.equal((writeInfo?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(
    readInfo?.selectedSymbol === writeInfo?.selectedSymbol,
    "Read and write access must retain the exact selected property symbol.",
  );
  const repeatedRead = queries.getResolvedPropertyAccessInfo(readAccess);
  assert.ok(
    repeatedRead === readInfo,
    "Repeated property queries must retain the exact resolved access result.",
  );
  assert.equal(repeatedRead?.accessMode, readInfo?.accessMode);
  assert.ok(
    repeatedRead?.selectedSymbol === readInfo?.selectedSymbol,
    "Repeated property queries must retain exact selected-symbol identity.",
  );
  assert.ok(
    repeatedRead?.selectedDeclaration === readInfo?.selectedDeclaration,
    "Repeated property queries must retain exact selected-declaration identity.",
  );
  assert.ok(
    repeatedRead?.sourceReadType === readInfo?.sourceReadType,
    "Repeated property queries must retain exact checker result-type identity.",
  );
  assertCleanSemanticDiagnostics(program, index);
});

test("property access info preserves compound read-write and optional-chain roles", () => {
  const { program, index } = createProgram(`
    class Counter {
      value = 0;
      advance(): void {}
    }

    declare const counter: Counter;
    declare const optionalCounter: Counter | undefined;
    counter.value += 1;
    optionalCounter?.advance();
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const valueAccess = findPropertyAccessByName(index, "value", () => true);
  const advanceAccess = findPropertyAccessByName(index, "advance", () => true);
  const valueInfo = queries.getResolvedPropertyAccessInfo(valueAccess);
  const advanceInfo = queries.getResolvedPropertyAccessInfo(advanceAccess);

  assert.equal(valueInfo?.accessMode, "read-write");
  assert.equal((valueInfo?.sourceReadType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal((valueInfo?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(valueInfo?.optionalChain, false);
  assert.equal(advanceInfo?.optionalChain, true);
  assert.equal(advanceInfo?.callCallee, true);
  assertCleanSemanticDiagnostics(program, index);
});

test("element access info preserves mapped declarations and proven tuple ordinals", () => {
  const { program, index } = createProgram(`
    type Dictionary<Key extends string, Value> = {
      [Property in Key]: Value;
    };

    declare const dictionary: Dictionary<string, number>;
    declare const key: string;
    dictionary[key];

    declare const pair: readonly [string, number];
    const one = 1 as const;
    pair[one];
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindElementAccessExpression);
  assert.equal(accesses.length, 2);

  const mapped = queries.getResolvedElementAccessInfo(accesses[0]);
  assert.ok(mapped?.accessMode === "read", "Mapped element access must be a checked read.");
  assert.equal(mapped?.selectedSymbol === undefined, true);
  assert.ok(mapped?.selectedDeclaration !== undefined);
  assert.equal(mapped?.selectedElementIndex, undefined);
  assert.equal(mapped.sourceReadType.flags & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(mapped.receiver.symbol !== undefined);
  assert.ok(mapped.receiver.declaration !== undefined);
  assert.ok(
    mapped.receiver.symbol ===
      queries.getLexicallyResolvedSymbol(mapped.receiver.expression),
    "Element receiver evidence must retain the exact lexically selected symbol.",
  );

  const tuple = queries.getResolvedElementAccessInfo(accesses[1]);
  assert.ok(tuple?.accessMode === "read", "Tuple element access must be a checked read.");
  assert.equal(tuple?.selectedElementIndex, 1);
  assert.equal(tuple.sourceReadType.flags & TypeFlagsNumber, TypeFlagsNumber);

  assertCleanSemanticDiagnostics(program, index);
  const repeatedMapped = queries.getResolvedElementAccessInfo(accesses[0]);
  assert.ok(
    repeatedMapped === mapped,
    "Repeated mapped-element queries must retain the exact resolved access result.",
  );
  assert.ok(
    repeatedMapped?.selectedDeclaration === mapped?.selectedDeclaration,
    "Repeated mapped-element queries must retain exact selected-declaration identity.",
  );
  assert.ok(
    repeatedMapped?.sourceReadType === mapped?.sourceReadType,
    "Repeated mapped-element queries must retain exact checker read-type identity.",
  );
  assert.equal(repeatedMapped?.selectedElementIndex, mapped?.selectedElementIndex);

  const repeatedTuple = queries.getResolvedElementAccessInfo(accesses[1]);
  assert.ok(
    repeatedTuple === tuple,
    "Repeated tuple-element queries must retain the exact resolved access result.",
  );
  assert.ok(
    repeatedTuple?.selectedDeclaration === tuple?.selectedDeclaration,
    "Repeated tuple-element queries must retain exact selected-declaration identity.",
  );
  assert.ok(
    repeatedTuple?.sourceReadType === tuple?.sourceReadType,
    "Repeated tuple-element queries must retain exact checker read-type identity.",
  );
  assert.equal(repeatedTuple?.selectedElementIndex, tuple?.selectedElementIndex);
});

test("element access exposes no fixed tuple ordinal without one exact checker proof", () => {
  const { program, index } = createProgram(`
    declare const pair: readonly [string, number];
    declare const general: number;
    pair[general];

    declare const ambiguous: 0 | 1;
    pair[ambiguous];

    declare const mixed: readonly [string, number] | readonly string[];
    mixed[general];

    declare const rest: readonly [string, ...number[]];
    rest[2];
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindElementAccessExpression);
  assert.equal(accesses.length, 4);

  for (const access of accesses) {
    const selected = queries.getResolvedElementAccessInfo(access);
    assert.equal(selected?.accessMode, "read");
    assert.equal(selected?.selectedElementIndex, undefined);
  }
  assertCleanSemanticDiagnostics(program, index);
});

test("element access info distinguishes read, write, and read-write index operations", () => {
  const { program, index } = createProgram(`
    interface Values {
      [key: string]: number;
    }

    declare const values: Values;
    declare const key: string;
    const read = values[key];
    values[key] = 1;
    values[key] += 2;
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindElementAccessExpression);
  assert.equal(accesses.length, 3);

  const read = queries.getResolvedElementAccessInfo(accesses[0]);
  const write = queries.getResolvedElementAccessInfo(accesses[1]);
  const readWrite = queries.getResolvedElementAccessInfo(accesses[2]);
  assert.equal(read?.accessMode, "read");
  assert.equal(write?.accessMode, "write");
  assert.equal(readWrite?.accessMode, "read-write");
  assert.equal((read?.sourceReadType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(read?.sourceWriteType, undefined);
  assert.equal(write?.sourceReadType, undefined);
  assert.equal((write?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal((readWrite?.sourceReadType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal((readWrite?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(
    read?.selectedDeclaration === write?.selectedDeclaration
      && write?.selectedDeclaration === readWrite?.selectedDeclaration,
    "Every access mode must retain the exact selected index-signature declaration.",
  );
  assertCleanSemanticDiagnostics(program, index);
});

test("element access info preserves optional-chain source selection", () => {
  const { program, index } = createProgram(`
    interface Values {
      [key: string]: number;
    }

    declare const values: Values | undefined;
    declare const key: string;
    values?.[key];
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const access = findNodesByKind(index, KindElementAccessExpression)[0];
  const selected = queries.getResolvedElementAccessInfo(access);

  assert.equal(selected?.accessMode, "read");
  assert.equal(selected?.optionalChain, true);
  assert.equal(selected?.selectedSymbol, undefined);
  assert.ok(selected?.selectedDeclaration !== undefined);
  assert.equal(queries.typeToString(selected?.sourceReadType), "number | undefined");
  assertCleanSemanticDiagnostics(program, index);
});

test("iteration info preserves declaration and assignment element selection", () => {
  const { program, index } = createProgram(`
    declare const values: readonly number[];
    let existing = 0;

    for (const value of values) {
      value;
    }

    for (existing of values) {
      existing;
    }
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const statements = findNodesByKind(index, KindForOfStatement);
  assert.equal(statements.length, 2);

  const declaration = queries.getResolvedIterationInfo(statements[0]);
  const assignment = queries.getResolvedIterationInfo(statements[1]);
  assert.equal(declaration?.iterationKind, "for-of");
  assert.equal(assignment?.iterationKind, "for-of");
  assert.equal((declaration?.sourceElementType.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(
    assignment?.sourceElementType === declaration?.sourceElementType,
    "Declaration and assignment iteration must retain the same selected element type.",
  );
  assert.equal(Object.isFrozen(declaration), true);
  assert.equal(Object.isFrozen(declaration?.mechanism), true);
  assertCleanSemanticDiagnostics(program, index);
  const repeatedDeclaration = queries.getResolvedIterationInfo(statements[0]);
  assert.ok(
    repeatedDeclaration === declaration,
    "Repeated declaration iteration queries must retain the exact resolved iteration result.",
  );
  assert.equal(repeatedDeclaration?.iterationKind, declaration?.iterationKind);
  assert.ok(
    repeatedDeclaration?.sourceIterableType === declaration?.sourceIterableType,
    "Repeated declaration iteration queries must retain exact iterable-type identity.",
  );
  assert.ok(
    repeatedDeclaration?.sourceElementType === declaration?.sourceElementType,
    "Repeated declaration iteration queries must retain exact element-type identity.",
  );
  assert.equal(repeatedDeclaration?.mechanism.kind, declaration?.mechanism.kind);

  const repeatedAssignment = queries.getResolvedIterationInfo(statements[1]);
  assert.ok(
    repeatedAssignment === assignment,
    "Repeated assignment iteration queries must retain the exact resolved iteration result.",
  );
  assert.equal(repeatedAssignment?.iterationKind, assignment?.iterationKind);
  assert.ok(
    repeatedAssignment?.sourceIterableType === assignment?.sourceIterableType,
    "Repeated assignment iteration queries must retain exact iterable-type identity.",
  );
  assert.ok(
    repeatedAssignment?.sourceElementType === assignment?.sourceElementType,
    "Repeated assignment iteration queries must retain exact element-type identity.",
  );
  assert.equal(repeatedAssignment?.mechanism.kind, assignment?.mechanism.kind);
});

test("iteration info preserves for-await-of element and protocol evidence", () => {
  const { program, index } = createProgram(`
    async function consume(values: AsyncIterable<number>): Promise<void> {
      for await (const value of values) {
        value;
      }
    }
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const statements = findNodesByKind(index, KindForOfStatement);
  assert.equal(statements.length, 1);

  const selection = queries.getResolvedIterationInfo(statements[0]);
  assert.equal(selection?.iterationKind, "for-await-of");
  assert.equal((selection?.sourceElementType.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(selection?.mechanism.kind, "asynchronous-iterator-protocol");
  assertCleanSemanticDiagnostics(program, index);
});
