import { test } from "node:test";
import assert from "node:assert/strict";
import { Node_Name } from "../internal/ast/spine.js";
import { KindExpressionStatement } from "../internal/ast/generated/kinds.js";
import { TypeFlagsString } from "../internal/checker/types.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findIdentifierByText,
  findPropertyAccessByName,
} from "./type-checker-test-support.js";

test("public type-checker queries expose flow-narrowed receiver member access", () => {
  const { program, index } = createProgram(`
    class PageValue { value!: string; }
    declare let current: PageValue | number;

    if (current instanceof PageValue) {
      current;
      current.value;
    }
  `);
  assertCleanSemanticDiagnostics(program, index);

  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const narrowedCurrent = findIdentifierByText(
    index,
    "current",
    (node) => node?.Parent?.Kind === KindExpressionStatement,
  );
  const narrowedCurrentType = queries.getTypeAtLocation(narrowedCurrent)?.type;
  assert.equal(queries.getSymbolName(queries.getTypeSymbol(narrowedCurrentType)), "PageValue");

  const valueAccess = findPropertyAccessByName(
    index,
    "value",
    (node) => node?.Parent?.Kind === KindExpressionStatement,
  );
  const valueType = queries.getTypeAtLocation(valueAccess)?.type;
  assert.equal((valueType?.flags ?? 0) & TypeFlagsString, TypeFlagsString);
  assert.equal(queries.getSymbolAtLocation(Node_Name(valueAccess))?.Name, "value");
  assertCleanSemanticDiagnostics(program, index);
});

test("assertion flow does not create false initializer circularity", () => {
  const { program, index } = createProgram(`
    interface RequestedExport {
      readonly exportedName: string;
      readonly localName?: string | undefined;
    }

    declare function assertBoundaryString(value: unknown): asserts value is string;
    declare function countString(value: string): void;

    export function snapshot(requestedExports: readonly RequestedExport[] | undefined): readonly string[] {
      const entries: string[] = [];
      if (requestedExports !== undefined) {
        for (let index = 0; index < requestedExports.length; index++) {
          const request = requestedExports[index];
          const exportedName = request.exportedName;
          const localName = request.localName;
          assertBoundaryString(exportedName);
          countString(exportedName);
          if (localName !== undefined) {
            assertBoundaryString(localName);
            countString(localName);
          }
          entries.push(localName === undefined ? exportedName : localName);
        }
      }
      return entries;
    }
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
});

test("write-only JavaScript property inference does not query the circular read type", () => {
  const { program, index } = createProgram(`
    class Values {
      constructor() {
        this.items = [3];
        this.items = [this.items[0] * 2];
      }
    }
  `, { noLib: false, fileName: "index.js", checkJs: true });
  assertCleanSemanticDiagnostics(program, index);
});
