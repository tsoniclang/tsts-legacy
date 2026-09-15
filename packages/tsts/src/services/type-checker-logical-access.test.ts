import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KindElementAccessExpression,
  KindGetAccessor,
  KindPropertyAccessExpression,
  KindSetAccessor,
} from "../internal/ast/generated/kinds.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findNodesByKind,
} from "./type-checker-test-support.js";

for (const operator of ["??=", "||=", "&&=", "+=", "="]) {
  for (const bracket of [false, true]) {
    test(`${operator} retains exact ${bracket ? "indexed" : "property"} accessor lanes`, () => {
      const access = bracket ? `value["count"]` : "value.count";
      const { program, index } = createProgram(`
        class Value {
          get count(): number { return 0; }
          set count(next: number | undefined) {}
        }
        declare const value: Value;
        (${access}) ${operator} 7;
      `);
      assertCleanSemanticDiagnostics(program, index);
      const queries = createTypeCheckerQueries(program, { sourceFile: index });
      const nodes = findNodesByKind(index, bracket ? KindElementAccessExpression : KindPropertyAccessExpression);
      assert.equal(nodes.length, 1);
      const node = nodes[0];
      assert.ok(node);
      const query = () => bracket
        ? queries.getResolvedElementAccessInfo(node)
        : queries.getResolvedPropertyAccessInfo(node);
      const selected = query();
      assert.ok(selected);
      assert.equal(selected.accessMode, operator === "=" ? "write" : "read-write");
      if (operator === "=") {
        assert.equal(selected.sourceReadType, undefined);
      } else {
        assert.equal(queries.typeToString(selected.sourceReadType), "number");
      }
      assert.equal(queries.typeToString(selected.sourceWriteType), "number | undefined");
      assert.equal(query(), selected);
      assert.ok(Object.isFrozen(selected));
      if (!bracket) {
        const property = queries.getResolvedPropertyAccessInfo(node);
        assert.equal(property?.selectedReadDeclaration?.Kind, operator === "=" ? undefined : KindGetAccessor);
        assert.equal(property?.selectedWriteDeclaration?.Kind, KindSetAccessor);
      }
      assertCleanSemanticDiagnostics(program, index);
    });
  }
}

test("logical indexed assignments preserve read unions and write intersections", () => {
  const { program, index } = createProgram(`
    class Value {
      get left(): number { return 0; }
      set left(next: number | undefined) {}
      get right(): number | undefined { return undefined; }
      set right(next: number) {}
    }
    declare const value: Value;
    declare const key: "left" | "right";
    value[key] ??= 7;
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const node = findNodesByKind(index, KindElementAccessExpression)[0];
  assert.ok(node);
  const selected = queries.getResolvedElementAccessInfo(node);
  assert.equal(selected?.accessMode, "read-write");
  assert.equal(queries.typeToString(selected?.sourceReadType), "number | undefined");
  assert.equal(queries.typeToString(selected?.sourceWriteType), "number");
  assert.equal(queries.getResolvedElementAccessInfo(node), selected);
  assertCleanSemanticDiagnostics(program, index);
});
