import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderDeclarationModel,
  ProviderTypeExpression,
} from "./index.js";
import {
  validateProviderDeclarationModelGraph,
} from "./provider-model-graph.js";

test("provider bigint literals retain exact canonical values in immutable snapshots", () => {
  for (const value of ["0", "9007199254740992", "9007199254740993", "-9223372036854775808", "18446744073709551615"]) {
    const type: ProviderTypeExpression = { kind: "bigint-literal", value };
    const result = validateProviderDeclarationModelGraph(modelWithType(type));
    assert.equal(result.kind, "valid", value);
    if (result.kind !== "valid") continue;
    assert.deepEqual(result.model.exports[0]?.type, type);
    assert.ok(Object.isFrozen(result.model.exports[0]?.type));
    Reflect.set(type, "value", "1");
    assert.equal(result.model.exports[0]?.type?.kind, "bigint-literal");
    assert.equal(Reflect.get(result.model.exports[0]!.type!, "value"), value);
  }
});

test("provider bigint literals reject noncanonical values and source injection", () => {
  for (const value of ["", "01", "-0", "+1", "1n", "0x10", "1.5", "1e3", "NaN", " 1", "1; type Injected = string"]) {
    const result = validateProviderDeclarationModelGraph(modelWithType({ kind: "bigint-literal", value }));
    assert.equal(result.kind, "invalid", value);
  }
  const malformed: ProviderTypeExpression = { kind: "bigint-literal", value: "1" };
  Reflect.set(malformed, "value", 1);
  assert.equal(validateProviderDeclarationModelGraph(modelWithType(malformed)).kind, "invalid");
});

test("provider type variants reject every field outside their exact schema", () => {
  const cases: readonly {
    readonly name: string;
    readonly type: ProviderTypeExpression;
    readonly extraField: string;
    readonly extraValue: unknown;
  }[] = [{
    name: "string sourceShape",
    type: { kind: "string" },
    extraField: "sourceShape",
    extraValue: { kind: "provider-ref", moduleSpecifier: "fake", exportName: "String" },
  }, {
    name: "array sourceShape",
    type: { kind: "array", elementType: { kind: "number" } },
    extraField: "sourceShape",
    extraValue: { kind: "provider-ref", moduleSpecifier: "fake", exportName: "Array" },
  }, {
    name: "boolean elementType",
    type: { kind: "boolean" },
    extraField: "elementType",
    extraValue: { kind: "number" },
  }, {
    name: "number name",
    type: { kind: "number" },
    extraField: "name",
    extraValue: "float64",
  }, {
    name: "source primitive type arguments",
    type: { kind: "source-primitive", name: "int32" },
    extraField: "typeArguments",
    extraValue: [{ kind: "number" }],
  }, {
    name: "undefined default type",
    type: { kind: "undefined" },
    extraField: "defaultType",
    extraValue: { kind: "void" },
  }];

  for (const entry of cases) {
    Reflect.set(entry.type, entry.extraField, entry.extraValue);
    const result = validateProviderDeclarationModelGraph(modelWithType(entry.type));
    assert.equal(result.kind, "invalid", entry.name);
    assert.match(
      result.kind === "invalid" ? result.reason : "",
      /shape/,
      entry.name,
    );
  }
});

test("string and array provider types remain exact source-native shapes", () => {
  const model: ProviderDeclarationModel = {
    moduleSpecifier: "@test/exact-native-types.js",
    providerModuleId: "Test.ExactNativeTypes",
    exports: [{
      id: "Text",
      name: "Text",
      kind: "type",
      type: { kind: "string" },
    }, {
      id: "Texts",
      name: "Texts",
      kind: "type",
      type: { kind: "array", elementType: { kind: "string" } },
    }],
  };
  const result = validateProviderDeclarationModelGraph(model);

  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") {
    return;
  }
  assert.deepEqual(result.model.exports[0]?.type, { kind: "string" });
  assert.deepEqual(result.model.exports[1]?.type, {
    kind: "array",
    elementType: { kind: "string" },
  });
  assert.equal("sourceShape" in result.model.exports[0]!.type!, false);
  assert.equal("sourceShape" in result.model.exports[1]!.type!, false);
});

function modelWithType(type: ProviderTypeExpression): ProviderDeclarationModel {
  return {
    moduleSpecifier: "@test/invalid-shape.js",
    providerModuleId: "Test.InvalidShape",
    exports: [{
      id: "Value",
      name: "Value",
      kind: "type",
      type,
    }],
  };
}
