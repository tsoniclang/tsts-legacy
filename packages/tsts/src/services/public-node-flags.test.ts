import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NodeFlagsAwaitContext,
  NodeFlagsNone,
  NodeFlagsThisNodeHasError,
  TokenFlagsHexSpecifier,
  TokenFlagsNone,
  TokenFlagsSingleQuote,
  createCompilerSessionFromFiles,
} from "../index.js";
import type { Node, NodeFlags, TokenFlags } from "../index.js";

// The node and token flag names come from the public entry and describe the flags the parser sets.
test("node and token flag names from the public entry describe a parsed node's flags", () => {
  const files = { "/case/a.mts": "export async function f(p: Promise<number>) { return await p; }\nexport const n = 0x10;\nexport const s = 'x';\nexport const plain = 1;\n" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files, rootFiles: ["/case/a.mts"], compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, target: "es2024" } });
  const checked = session.checkSource();
  const ast = checked.ast;
  const sourceFile = checked.getSourceFile("/case/a.mts");
  if (sourceFile === undefined) throw new Error("The session has no /case/a.mts.");
  const found = (kind: string): Node[] => {
    const nodes: Node[] = [];
    const visit = (node: Node): void => {
      if (ast.kindName(node) === `Kind${kind}`) nodes.push(node);
      ast.forEachChild(node, child => { if (child !== undefined) visit(child); });
    };
    visit(sourceFile);
    return nodes;
  };
  // An await expression is parsed in the await context of its async function.
  const [awaited] = found("AwaitExpression");
  if (awaited === undefined) throw new Error("The program has no await expression.");
  const awaitFlags: NodeFlags = awaited.Flags;
  assert.equal((awaitFlags & NodeFlagsAwaitContext) !== 0, true);
  assert.equal(awaitFlags & NodeFlagsThisNodeHasError, NodeFlagsNone);
  // A hex literal and a single-quoted string carry their token flags; a plain decimal literal carries none.
  const numeric = found("NumericLiteral").map(node => ast.as.AsNumericLiteral(node)?.TokenFlags as TokenFlags);
  assert.deepEqual(numeric.map(flags => (flags & TokenFlagsHexSpecifier) !== 0), [true, false]);
  assert.equal(numeric[1], TokenFlagsNone);
  const [single] = found("StringLiteral").filter(node => ast.as.AsStringLiteral(node)?.Text === "x");
  if (single === undefined) throw new Error("The program has no string literal 'x'.");
  assert.equal(((ast.as.AsStringLiteral(single)?.TokenFlags ?? 0) & TokenFlagsSingleQuote) !== 0, true);
});
