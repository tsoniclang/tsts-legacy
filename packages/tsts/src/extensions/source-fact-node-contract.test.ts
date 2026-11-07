import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "../internal/ast/ast.js";
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
  const cases: readonly (() => unknown)[] = [
    () => argumentPassingFactKey.snapshot({
      role: "argument",
      mode: "byref-readwrite",
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
      initialExpression: invalidNode,
      locationIdentity: invalidNode,
    }),
    () => pointerOperationFactKey.snapshot({
      operation: "equal-pointer",
      call: invalidNode,
      leftExpression: invalidNode,
      rightExpression: invalidNode,
    }),
    () => rawPointerOperationFactKey.snapshot({
      operation: "bind-raw-pointer",
      call: invalidNode,
      identityExpression: invalidNode,
    }),
  ];

  assert.deepEqual(rawPointerFactKey.snapshot({ representation: "opaque-identity" }), {
    representation: "opaque-identity",
  });

  for (const snapshot of cases) {
    assert.throws(snapshot, /must be a compiler source node/);
  }
});

test("argument passing fact has exactly one declaration role and one argument role (WP0 A4)", () => {
  const storage = { Kind: 80 } as unknown as Node;
  const otherStorage = { Kind: 80 } as unknown as Node;

  const declaration = argumentPassingFactKey.snapshot({ role: "declaration", mode: "byref-readwrite" });
  assert.deepEqual(declaration, { role: "declaration", mode: "byref-readwrite" });
  assert.equal(Object.isFrozen(declaration), true);
  assert.equal("storageExpression" in declaration, false);

  for (const mode of ["byref-readonly", "byref-readwrite", "byref-writeonly-must-init"] as const) {
    const argument = argumentPassingFactKey.snapshot({ role: "argument", mode, storageExpression: storage });
    assert.equal(Object.isFrozen(argument), true);
    assert.equal(argument.role, "argument");
    assert.equal(argument.mode, mode);
    assert.equal(argument.role === "argument" ? argument.storageExpression : undefined, storage);
  }

  const argument = argumentPassingFactKey.snapshot({
    role: "argument",
    mode: "byref-readwrite",
    storageExpression: storage,
  });
  assert.equal(argumentPassingFactKey.equals(argument, {
    role: "argument",
    mode: "byref-readwrite",
    storageExpression: storage,
  }), true);
  assert.equal(argumentPassingFactKey.equals(argument, {
    role: "argument",
    mode: "byref-readwrite",
    storageExpression: otherStorage,
  }), false);
  assert.equal(argumentPassingFactKey.equals(argument, {
    role: "argument",
    mode: "byref-readonly",
    storageExpression: storage,
  }), false);
  assert.equal(argumentPassingFactKey.equals(argument, declaration), false);
  assert.equal(argumentPassingFactKey.equals(declaration, argument), false);
  assert.equal(argumentPassingFactKey.equals(declaration, { role: "declaration", mode: "byref-readwrite" }), true);
  assert.equal(argumentPassingFactKey.equals(declaration, { role: "declaration", mode: "byref-readonly" }), false);

  const rejected: readonly [() => unknown, RegExp][] = [
    // The old optional shape, with and without storage: no inferred role, no compatibility branch.
    [() => argumentPassingFactKey.snapshot({ mode: "byref-readwrite" } as never), /ArgumentPassingFact\.role must be a non-empty string/],
    [() => argumentPassingFactKey.snapshot({ mode: "byref-readwrite", storageExpression: storage } as never), /ArgumentPassingFact\.role must be a non-empty string/],
    [() => argumentPassingFactKey.snapshot({ role: "argument", mode: "byref-readwrite" } as never), /ArgumentPassingFact\.storageExpression must be an identity-bearing object/],
    [() => argumentPassingFactKey.snapshot({ role: "argument", mode: "byref-readwrite", storageExpression: undefined } as never), /ArgumentPassingFact\.storageExpression must be an identity-bearing object/],
    [() => argumentPassingFactKey.snapshot({ role: "declaration", mode: "byref-readwrite", storageExpression: storage } as never), /declaration role must not carry storageExpression/],
    [() => argumentPassingFactKey.snapshot({ role: "declaration", mode: "byref-readwrite", storageExpression: undefined } as never), /declaration role must not carry storageExpression/],
    [() => argumentPassingFactKey.snapshot({ role: "parameter", mode: "byref-readwrite" } as never), /ArgumentPassingFact\.role parameter is invalid/],
    [() => argumentPassingFactKey.snapshot({ role: "declaration", mode: "by-reference" } as never), /ArgumentPassingFact\.mode by-reference is invalid/],
    [() => argumentPassingFactKey.snapshot({ role: "declaration", mode: "byref-readwrite", kind: "argument" } as never), /unsupported field kind/],
  ];
  for (const [snapshot, message] of rejected) {
    assert.throws(snapshot, message);
  }
});
