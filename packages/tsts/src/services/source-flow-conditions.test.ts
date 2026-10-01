import assert from "node:assert/strict";
import { test } from "node:test";
import { KindCallExpression, KindPropertyAccessExpression } from "../internal/ast/generated/kinds.js";
import type { Node } from "../internal/ast/spine.js";
import { createAstReader } from "./ast-reader.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { assertCleanSemanticDiagnostics, createProgram, findNodesByKind } from "./type-checker-test-support.js";

function checkedConditions(source: string) {
  const { program, index } = createProgram(source, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const ast = createAstReader();
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const properties = findNodesByKind(index, KindPropertyAccessExpression)
    .filter(node => ast.text(ast.name(node)) === "length");
  const calls = findNodesByKind(index, KindCallExpression);
  const read = (property: Node) => {
    const reference = ast.as.AsPropertyAccessExpression(property)?.Expression;
    assert.ok(reference);
    const selected = queries.getResolvedFlowConditionInfo(reference);
    assert.ok(selected);
    assert.equal(selected.reference, reference);
    assert.equal(queries.getResolvedFlowConditionInfo(reference), selected);
    assert.ok(Object.isFrozen(selected));
    assert.ok(Object.isFrozen(selected.conditions));
    assert.ok(selected.conditions.every(Object.isFrozen));
    assert.ok(selected.conditions.every(condition => Object.isFrozen(condition.assignments)));
    return selected.conditions;
  };
  return { ast, queries, properties, calls, read };
}

const globals = "type Value = { length: number } | readonly number[];";

test("checked flow conditions retain exact branch and early-return provenance", () => {
  const source = checkedConditions(`${globals}
    function early(value: Value): number {
      if (Array.isArray(value)) return value.length;
      return value.length;
    }
    function branches(value: Value): number {
      if (Array.isArray(value)) { return value.length; }
      else { return value.length; }
    }
  `);
  assert.equal(source.properties.length, 4);
  for (const [position, assumed] of [[0, true], [1, false], [2, true], [3, false]] as const) {
    assert.deepEqual(source.read(source.properties[position]!), [
      { expression: source.calls[Math.floor(position / 2)]!, assumed, assignments: [] },
    ]);
  }
});

test("joined flow paths do not invent a condition from one returning branch", () => {
  const source = checkedConditions(`${globals}
    function joined(value: Value, enabled: boolean): number {
      if (enabled) { if (Array.isArray(value)) return value.length; }
      return value.length;
    }
  `);
  const call = source.calls[0]!;
  assert.ok(source.read(source.properties[0]!).some(condition => condition.expression === call && condition.assumed));
  assert.ok(source.read(source.properties[1]!).every(condition => condition.expression !== call));
});

test("short-circuit and conditional-expression flows retain only dominating outcomes", () => {
  const source = checkedConditions(`${globals}
    function conjunction(value: Value, enabled: boolean): number {
      if (enabled && Array.isArray(value)) return value.length;
      return value.length;
    }
    function alternative(value: Value, enabled: boolean): number {
      if (enabled || Array.isArray(value)) return value.length;
      return value.length;
    }
    function conditional(value: Value): number {
      return Array.isArray(value) ? value.length : value.length;
    }
  `);
  const outcomes = source.properties.map(property => source.read(property)
    .filter(condition => source.calls.includes(condition.expression))
    .map(({ expression, assumed }) => ({ expression, assumed })));
  assert.deepEqual(outcomes, [
    [{ expression: source.calls[0]!, assumed: true }], [],
    [], [{ expression: source.calls[1]!, assumed: false }],
    [{ expression: source.calls[2]!, assumed: true }],
    [{ expression: source.calls[2]!, assumed: false }],
  ]);
});

test("loop and finally flows use existing checked labels without mutating them", () => {
  const source = checkedConditions(`${globals}
    function looping(value: Value, enabled: boolean): number {
      let result = 0;
      while (enabled) {
        if (Array.isArray(value)) result = value.length;
        enabled = false;
      }
      return result;
    }
    function finalizing(value: Value, enabled: boolean): number {
      let result = 0;
      if (Array.isArray(value)) {
        try { if (enabled) return 0; }
        finally { result = value.length; }
        result += value.length;
      }
      return result;
    }
  `);
  for (const [position, call] of [[0, source.calls[0]!], [1, source.calls[1]!], [2, source.calls[1]!]] as const) {
    assert.ok(source.read(source.properties[position]!).some(condition => condition.expression === call && condition.assumed));
  }
});

test("flow condition provenance does not assert unchanged value identity after assignment", () => {
  const source = checkedConditions(`${globals}
    function changed(value: Value): number {
      if (Array.isArray(value)) { value = { length: 9 }; return value.length; }
      return 0;
    }
  `);
  assert.ok(source.read(source.properties[0]!).some(condition => condition.expression === source.calls[0]! && condition.assumed));
  assert.equal(source.read(source.properties[0]!)[0]!.assignments.length, 1);
  assert.equal(source.queries.getResolvedFlowConditionInfo(undefined), undefined);
});
