import assert from "node:assert/strict";
import { test } from "node:test";
import { SymbolFlagsPrototype } from "./index.js";
import { SymbolFlagsPrototype as internalPrototype } from "./internal/ast/symbolflags.js";

test("the public Prototype flag is the unchanged compiler flag", () => {
  assert.equal(SymbolFlagsPrototype, internalPrototype);
});
