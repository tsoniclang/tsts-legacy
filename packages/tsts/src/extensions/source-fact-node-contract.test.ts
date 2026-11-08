import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "../internal/ast/ast.js";
import type { Type } from "../internal/checker/types.js";
import { createCompilerSessionFromFiles } from "../index.js";
import { testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";
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

test("argument passing facts retain one role and exact required original occurrence", () => {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": "let first = 1; let second = 2; void first;",
    },
    compilerOptions: testNoLibCompilerOptions,
  }).checkSource();
  assert.equal(checked.diagnostics.length, 0, "the actual original occurrences check");
  assert.equal(checked.extensionDiagnostics.length, 0, "the source fixture has no extension rejection");
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file !== undefined);
  const nodes: Node[] = [];
  const visit = (node: Node): void => {
    if (checked.ast.is.IsIdentifier(node)) {
      nodes.push(node);
    }
    checked.ast.forEachChild(node, child => {
      if (child !== undefined) {
        visit(child);
      }
    });
  };
  visit(file);
  const storageExpression = nodes[0];
  const otherExpression = nodes[1];
  assert.ok(storageExpression !== undefined && otherExpression !== undefined);
  const declaration = argumentPassingFactKey.snapshot({ role: "declaration", mode: "byref-readwrite" });
  const argument = argumentPassingFactKey.snapshot({ role: "argument", mode: "byref-readwrite", storageExpression });
  const otherArgument = argumentPassingFactKey.snapshot({ role: "argument", mode: "byref-readwrite", storageExpression: otherExpression });
  assert.equal(declaration.role === "declaration" && !("storageExpression" in declaration), true);
  assert.equal(argument.role === "argument" && argument.storageExpression === storageExpression, true);
  assert.equal(Object.isFrozen(declaration) && Object.isFrozen(argument), true);
  assert.equal(argumentPassingFactKey.equals(declaration, argument), false, "different roles never compare equal");
  assert.equal(argumentPassingFactKey.equals(argument, otherArgument), false, "same mode does not replace original identity");
  const pointer = pointerOperationFactKey.snapshot({
    operation: "address-of", exportName: "addressOf", call: storageExpression,
    arguments: [storageExpression], typeArguments: [],
    selection: { kind: "unavailable", reason: "unvisited" },
    pointee: { kind: "unavailable", reason: "unvisited" },
  });
  const samePointer = pointerOperationFactKey.snapshot(pointer);
  const differentPointer = pointerOperationFactKey.snapshot({ ...pointer, arguments: [otherExpression] });
  assert.equal(Object.isFrozen(pointer) && Object.isFrozen(pointer.arguments) && Object.isFrozen(pointer.selection), true);
  assert.equal(pointerOperationFactKey.equals(pointer, samePointer), true);
  assert.equal(pointerOperationFactKey.equals(pointer, differentPointer), false);
  const snapshotPointer = (value: unknown): unknown =>
    pointerOperationFactKey.snapshot(value as Parameters<typeof pointerOperationFactKey.snapshot>[0]);
  for (const malformed of [
    { operation: "address-of", call: storageExpression, pointeeType: {}, resultType: {}, storageExpression },
    { ...pointer, selection: { kind: "unavailable" } },
    { ...pointer, selection: { kind: "unavailable", reason: "unvisited", value: {} } },
    { ...pointer, pointee: { kind: "unavailable", reason: "missing", type: {} } },
  ]) {
    assert.throws(() => snapshotPointer(malformed), /PointerOperationFact/u);
  }
  assert.equal(argumentPassingFactKey.equals(argument, argumentPassingFactKey.snapshot(argument)), true);
  const snapshot = argumentPassingFactKey.snapshot as (value: unknown) => unknown;
  for (const malformed of [
    { mode: "byref-readwrite" },
    { mode: "byref-readwrite", storageExpression },
    { kind: "argument", mode: "byref-readwrite", storageExpression },
    { role: "argument", mode: "byref-readwrite" },
    { role: "declaration", mode: "byref-readwrite", storageExpression },
  ]) {
    assert.throws(() => snapshot(malformed), /ArgumentPassingFact/u);
  }
});

test("authored source fact payloads reject arbitrary identity objects", () => {
  const invalidNode = {} as Node;
  const invalidType = {} as Type;
  const cases: readonly (() => unknown)[] = [
    () => argumentPassingFactKey.snapshot({
      role: "argument",
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
      exportName: "allocatePointer",
      arguments: [invalidNode],
      typeArguments: [],
      selection: { kind: "unavailable", reason: "unvisited" },
      pointee: { kind: "available", type: invalidType, explicitTypeNode: undefined },
    }),
    () => pointerOperationFactKey.snapshot({
      operation: "equal-pointer",
      call: invalidNode,
      exportName: "equalPointer",
      arguments: [invalidNode, invalidNode],
      typeArguments: [],
      selection: { kind: "unavailable", reason: "unvisited" },
      pointee: { kind: "available", type: invalidType, explicitTypeNode: undefined },
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
