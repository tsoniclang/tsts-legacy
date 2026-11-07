import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "../internal/ast/ast.js";
import type { Type } from "../internal/checker/types.js";
import { createCompilerSessionFromFiles } from "../index.js";
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

test("argument passing facts distinguish declaration modes from complete value arguments", () => {
  const checked = createCompilerSessionFromFiles({ currentDirectory: "/src", files: {
    "/src/index.ts": "const value = 1; void value;",
  }, compilerOptions: { strict: true } }).checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/src/index.ts");
  const nodes: Node[] = [];
  const visit = (node: Node): void => { if (checked.ast.is.IsIdentifier(node)) nodes.push(node);
    checked.ast.forEachChild(node, child => { if (child !== undefined) visit(child); }); };
  assert.ok(file !== undefined);
  visit(file);
  const storageExpression = nodes[0];
  assert.ok(storageExpression !== undefined);
  const declaration = argumentPassingFactKey.snapshot({ kind: "declaration", mode: "byref-readwrite" });
  const argument = argumentPassingFactKey.snapshot({ kind: "argument", mode: "byref-readwrite", storageExpression });
  assert.equal(declaration.kind === "declaration" && !("storageExpression" in declaration), true);
  assert.equal(argument.kind === "argument" && argument.storageExpression === storageExpression, true);
  assert.equal(Object.isFrozen(declaration) && Object.isFrozen(argument), true);
  assert.equal(argumentPassingFactKey.equals(declaration, argument), false);
  const snapshot = argumentPassingFactKey.snapshot as (value: unknown) => unknown;
  for (const malformed of [{ mode: "byref-readwrite" }, { mode: "byref-readwrite", storageExpression },
    { kind: "argument", mode: "byref-readwrite" }, { kind: "declaration", mode: "byref-readwrite", storageExpression }]) {
    assert.throws(() => snapshot(malformed), /ArgumentPassingFact/u);
  }
});

test("authored source fact payloads reject arbitrary identity objects", () => {
  const invalidNode = {} as Node;
  const invalidType = {} as Type;
  const cases: readonly (() => unknown)[] = [
    () => argumentPassingFactKey.snapshot({
      kind: "argument",
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
