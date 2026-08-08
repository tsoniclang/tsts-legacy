import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "../internal/ast/ast.js";
import type { Type } from "../internal/checker/types.js";
import {
  argumentPassingFactKey,
  attributeFactKey,
  defaultValueFactKey,
  fieldFactKey,
  functionPointerFactKey,
  pointerFactKey,
  pointerOperationFactKey,
  rawPointerFactKey,
  rawPointerOperationFactKey,
} from "./facts.js";

test("authored source fact payloads reject arbitrary identity objects", () => {
  const invalidNode = {} as Node;
  const invalidType = {} as Type;
  const cases: readonly (() => unknown)[] = [
    () => argumentPassingFactKey.snapshot({
      mode: "by-value",
      storageExpression: invalidNode,
    }),
    () => attributeFactKey.snapshot({
      target: invalidNode,
      attributeName: "Example",
      arguments: [],
    }),
    () => defaultValueFactKey.snapshot({ type: invalidNode }),
    () => fieldFactKey.snapshot({ name: "value", type: invalidNode }),
    () => functionPointerFactKey.snapshot({
      parameters: [invalidNode],
      result: invalidNode,
      abi: [],
    }),
    () => pointerFactKey.snapshot({
      pointee: invalidNode,
      mutability: "unspecified",
    }),
    () => pointerOperationFactKey.snapshot({
      operation: "allocate",
      call: invalidNode,
      pointeeType: invalidType,
      resultType: invalidType,
      initialExpression: invalidNode,
      initialType: invalidType,
      locationIdentity: invalidNode,
    }),
    () => pointerOperationFactKey.snapshot({
      operation: "equal-pointer",
      call: invalidNode,
      pointeeType: invalidType,
      resultType: invalidType,
      leftExpression: invalidNode,
      leftType: invalidType,
      rightExpression: invalidNode,
      rightType: invalidType,
    }),
    () => rawPointerOperationFactKey.snapshot({
      operation: "bind-raw-pointer",
      call: invalidNode,
      resultType: invalidType,
      identityExpression: invalidNode,
      identityType: invalidType,
    }),
  ];

  assert.deepEqual(rawPointerFactKey.snapshot({ representation: "opaque-identity" }), {
    representation: "opaque-identity",
  });

  for (const snapshot of cases) {
    assert.throws(snapshot, /must be a compiler source node/);
  }
});
