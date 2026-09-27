import assert from "node:assert/strict";
import { test } from "node:test";
import { getProviderMemberSurfaceKey, type ProviderMemberDeclaration } from "../index.js";

test("provider member source identity unifies ordinary and intrinsic property surfaces", () => {
  const expected = JSON.stringify([false, ["property-key", "select"]]);
  for (const kind of ["method", "property", "field", "intrinsic"] as const) {
    for (const name of ["select", { kind: "identifier", text: "select" }, { kind: "string-literal", text: "select" }] as const) {
      assert.equal(getProviderMemberSurfaceKey({ id: `member.${kind}`, name, kind }), expected);
    }
  }
  const method: ProviderMemberDeclaration = { id: "Call", name: "select", kind: "method" };
  assert.equal(getProviderMemberSurfaceKey({ ...method, static: true }), JSON.stringify([true, ["property-key", "select"]]));
  assert.equal(getProviderMemberSurfaceKey({ ...method, static: false }), expected);
  assert.equal(getProviderMemberSurfaceKey({ ...method, name: "Select" }), JSON.stringify([false, ["property-key", "Select"]]));
  assert.equal(getProviderMemberSurfaceKey({ ...method, id: "AnotherIdentity" }), expected);
});

test("provider member identity preserves native source property and signature namespaces", () => {
  const member: ProviderMemberDeclaration = { id: "Value", name: "0", kind: "property" };
  assert.equal(getProviderMemberSurfaceKey(member), getProviderMemberSurfaceKey({ ...member, name: { kind: "number-literal", value: 0 } }));
  const iterator = getProviderMemberSurfaceKey({ ...member, name: { kind: "well-known-symbol", name: "iterator" } });
  assert.equal(iterator, JSON.stringify([false, ["well-known-symbol", "iterator"]]));
  assert.notEqual(iterator, getProviderMemberSurfaceKey({ ...member, name: "Symbol.iterator" }));
  assert.equal(getProviderMemberSurfaceKey({ ...member, kind: "constructor" }), "constructor");
  assert.equal(getProviderMemberSurfaceKey({ ...member, kind: "indexer" }), "indexer");
  assert.notEqual(getProviderMemberSurfaceKey({ ...member, name: "constructor" }), "constructor");
  assert.notEqual(getProviderMemberSurfaceKey({ ...member, name: "indexer" }), "indexer");
});
