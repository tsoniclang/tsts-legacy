import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  defineExtensionFactKey,
  functionPointerFactKey,
  pointerFactKey,
  rawPointerFactKey,
  sourceMarkerFactKey,
  sourceSemanticsExtensionId,
} from "../index.js";
import type { Node, SourceElaborationContext, SourceFactResolver, SourceTypeMarkerKind } from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import type { ProviderDeclarationModel } from "./host.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";

const moduleSpecifier = "@test/native-types.js";
const declarations = [
  { exportName: "Pointer", marker: "pointer", arguments: "<number>" },
  { exportName: "RawPointer", marker: "raw-pointer", arguments: "" },
  { exportName: "FunctionPointer", marker: "function-pointer", arguments: "<[number, boolean], string>" },
  { exportName: "FixedArray", marker: "fixed-array", arguments: "<number, 4>" },
  { exportName: "JsString", marker: "js-string", arguments: "" },
] as const;

const model: ProviderDeclarationModel = {
  moduleSpecifier,
  providerModuleId: "Test.NativeTypes",
  exports: [
    { id: "Pointer", name: "Pointer", kind: "type", typeParameters: [{ name: "T" }],
      type: { kind: "type-parameter", name: "T" } },
    { id: "RawPointer", name: "RawPointer", kind: "type", type: { kind: "number" } },
    { id: "FunctionPointer", name: "FunctionPointer", kind: "type", typeParameters: [{ name: "Parameters" }, { name: "Result" }],
      type: { kind: "type-parameter", name: "Result" } },
    { id: "FixedArray", name: "FixedArray", kind: "type", typeParameters: [{ name: "T" }, { name: "Length" }],
      type: { kind: "array", elementType: { kind: "type-parameter", name: "T" } } },
    { id: "JsString", name: "JsString", kind: "type", type: { kind: "string" } },
  ],
};

const forms = [
  { name: "direct", prefix: `import type { NAME } from "${moduleSpecifier}";`, reference: "NAME" },
  { name: "renamed", prefix: `import type { NAME as Selected } from "${moduleSpecifier}";`, reference: "Selected" },
  { name: "namespace", prefix: `import type * as native from "${moduleSpecifier}";`, reference: "native.NAME" },
  { name: "re-export", prefix: 'import type { NAME as Selected } from "./bridge.js";', reference: "Selected" },
  { name: "namespace re-export", prefix: 'import type * as bridge from "./bridge.js";', reference: "bridge.NAME" },
] as const;

for (const declaration of declarations) {
  for (const form of forms) {
    test(`source ${declaration.marker} facts retain ${form.name} identity before final analysis`, () => {
      let early: ReturnType<typeof readFacts> | undefined;
      let subject: Node | undefined;
      const text = `${form.prefix.replaceAll("NAME", declaration.exportName)}
        export type Value = ${form.reference.replaceAll("NAME", declaration.exportName)}${declaration.arguments};`;
      const checked = checkTypes(text, (context, node) => {
        early = readFacts(context.factResolver, node);
        subject = node;
        assertFact(context, node, declaration.marker, early);
        const repeated = readFacts(context.factResolver, node);
        for (const kind of factKinds) assert.equal(repeated[kind], early[kind]);
      });
      assert.ok(subject);
      assert.ok(early);
      const name = checked.ast.as.AsTypeReferenceNode(subject)?.TypeName;
      assert.ok(name);
      const final = readFacts({ resolve: checked.sourceFacts.getFact }, subject);
      const selectedName = readFacts({ resolve: checked.sourceFacts.getFact }, name);
      for (const kind of factKinds) {
        assert.equal(final[kind], early[kind]);
        if (early[kind] !== undefined) assert.deepEqual(selectedName[kind], early[kind]);
      }
      assertChecked(checked);
    });
  }
}

for (const arguments_ of ["<[], string>", "<number, string>", "<[number, ...boolean[]], string>"]) {
  test(`function-pointer ${arguments_} retains its exact parameter nodes`, () => {
    const checked = checkTypes(`import type { FunctionPointer } from "${moduleSpecifier}";
      export type Value = FunctionPointer${arguments_};`, (context, node) => {
      assertFact(context, node, "function-pointer", readFacts(context.factResolver, node));
    });
    assertChecked(checked);
  });
}

test("source type-marker demands preserve generic and nested pointee syntax", () => {
  const checked = checkTypes(`import type { Pointer } from "${moduleSpecifier}";
    export type Value<T> = Pointer<Pointer<T>>;`, (context, node) => {
    const first = context.factResolver.resolve(node, pointerFactKey);
    assert.ok(first);
    assert.equal(first.pointee, context.source.ast.typeArguments(node)[0]);
    const second = context.factResolver.resolve(first.pointee, pointerFactKey);
    assert.ok(second);
    assert.equal(second.pointee, context.source.ast.typeArguments(first.pointee)[0]);
    assert.equal(context.source.ast.text(context.source.ast.as.AsTypeReferenceNode(second.pointee)?.TypeName), "T");
    assert.notEqual(first, second);
  });
  assertChecked(checked);
});

for (const selected of [
  { name: "local homonym", text: "type Pointer<T> = T; export type Value = Pointer<number>;" },
  { name: "unconfigured provider", text: 'import type { Pointer } from "@test/foreign.js"; export type Value = Pointer<number>;' },
  { name: "unconfigured namespace", text: 'import type * as other from "@test/foreign.js"; export type Value = other.Pointer<number>;' },
  { name: "shadowed type parameter", text: `import type { RawPointer } from "${moduleSpecifier}"; export type Value<RawPointer> = RawPointer;` },
  { name: "ordinary alias", text: `import type { Pointer } from "${moduleSpecifier}"; type Alias = Pointer<number>; export type Value = Alias;` },
]) {
  test(`source type-marker demands do not classify ${selected.name} by spelling or erased shape`, () => {
    let subject: Node | undefined;
    const checked = checkTypes(selected.text, (context, node) => {
      subject = node;
      for (const fact of Object.values(readFacts(context.factResolver, node))) assert.equal(fact, undefined);
    });
    assert.ok(subject);
    for (const fact of Object.values(readFacts({ resolve: checked.sourceFacts.getFact }, subject))) assert.equal(fact, undefined);
    assertChecked(checked);
  });
}

for (const type of ["Pointer", "Pointer<number, string>", "RawPointer<number>", "FunctionPointer<number>",
  "FunctionPointer<[], number, string>", "JsString<number>"]) {
  test(`source type-marker demands reject malformed ${type} without suppressing source errors`, () => {
    const checked = checkTypes(`import type { Pointer, RawPointer, FunctionPointer, JsString } from "${moduleSpecifier}";
      export type Value = ${type};`, (context, node) => {
      for (const fact of Object.values(readFacts(context.factResolver, node))) assert.equal(fact, undefined);
    });
    assert.ok(checked.diagnostics.length > 0);
    assert.deepEqual(checked.extensionDiagnostics, []);
  });
}

test("fixed-array marker discovery does not claim to validate its length or source type arguments", () => {
  const checked = checkTypes(`import type { FixedArray } from "${moduleSpecifier}";
    export type Value = FixedArray<number>;`, (context, node) => {
    assert.deepEqual(context.factResolver.resolve(node, sourceMarkerFactKey), { kind: "type-marker", marker: "fixed-array" });
  });
  assert.ok(checked.diagnostics.length > 0);
  assert.deepEqual(checked.extensionDiagnostics, []);
});

test("early pointer facts retain assignment diagnostics", () => {
  const checked = checkTypes(`import type { Pointer } from "${moduleSpecifier}";
    export type Value = Pointer<number>;
    export const invalid: Value = "not a number";`, (context, node) => {
    assert.ok(context.factResolver.resolve(node, pointerFactKey));
  });
  assert.equal(checked.diagnostics.length, 1);
  assert.match(Diagnostic_String(checked.diagnostics[0]), /not assignable/);
  assert.deepEqual(checked.extensionDiagnostics, []);
});

test("type-marker facts are rebuilt with current nodes after source replay", () => {
  const replay = defineExtensionFactKey<{ readonly accepted: true }>({
    extensionId: "test.type-marker-demand", name: "replay",
    snapshot: value => Object.freeze({ accepted: value.accepted }), equals: (left, right) => left.accepted === right.accepted,
  });
  const pointees = new Set<Node>();
  let current: Node | undefined;
  const checked = checkTypes(`import type { Pointer } from "${moduleSpecifier}";
    export type Value = Pointer<number>;`, (context, node) => {
    const fact = context.factResolver.resolve(node, pointerFactKey);
    assert.ok(fact);
    assert.equal(fact.pointee, context.source.ast.typeArguments(node)[0]);
    pointees.add(fact.pointee);
    current = node;
    context.request(node, replay);
  }, replay);
  assert.ok(pointees.size >= 2, "Replay must use fresh epoch-owned source nodes.");
  assert.ok(current);
  const final = checked.sourceFacts.getFact(current, pointerFactKey);
  assert.ok(final);
  assert.equal(final.pointee, checked.ast.typeArguments(current)[0]);
  assertChecked(checked);
});

const factKinds = ["pointer", "raw-pointer", "function-pointer", "marker"] as const;

function readFacts(facts: Pick<SourceFactResolver, "resolve">, node: Node) {
  return {
    pointer: facts.resolve(node, pointerFactKey),
    "raw-pointer": facts.resolve(node, rawPointerFactKey),
    "function-pointer": facts.resolve(node, functionPointerFactKey),
    marker: facts.resolve(node, sourceMarkerFactKey),
  };
}

function assertFact(context: SourceElaborationContext, node: Node, marker: SourceTypeMarkerKind, facts: ReturnType<typeof readFacts>) {
  const kind = marker === "fixed-array" || marker === "js-string" ? "marker" : marker;
  for (const selected of factKinds) {
    if (selected !== kind) assert.equal(facts[selected], undefined);
  }
  assert.ok(facts[kind]);
  assert.equal(Object.isFrozen(facts[kind]), true);
  const arguments_ = context.source.ast.typeArguments(node);
  if (marker === "pointer") {
    assert.equal(facts.pointer?.pointee, arguments_[0]);
    assert.equal(facts.pointer?.mutability, "readwrite");
  } else if (marker === "raw-pointer") {
    assert.deepEqual(facts["raw-pointer"], { representation: "opaque-identity" });
  } else if (marker === "function-pointer") {
    const parameters = arguments_[0];
    assert.ok(parameters);
    const expected = context.source.ast.is.IsTupleTypeNode(parameters) ? context.source.ast.elements(parameters) : [parameters];
    assert.deepEqual(facts["function-pointer"]?.parameters, expected);
    assert.equal(facts["function-pointer"]?.result, arguments_[1]);
    assert.deepEqual(facts["function-pointer"]?.abi, ["target-default"]);
    assert.equal(Object.isFrozen(facts["function-pointer"]?.parameters), true);
  } else {
    assert.deepEqual(facts.marker, { kind: "type-marker", marker });
  }
}

function checkTypes(
  sourceText: string,
  inspect: (context: SourceElaborationContext, node: Node) => void,
  replay?: ReturnType<typeof defineExtensionFactKey<{ readonly accepted: true }>>,
) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": sourceText,
      "/src/bridge.ts": `export type { ${declarations.map(declaration => declaration.exportName).join(", ")} } from "${moduleSpecifier}";`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true },
    extensionHostOptions: { extensions: [
      sourceProviderExtension(new Map([
        [moduleSpecifier, model],
        ["@test/foreign.js", { ...model, moduleSpecifier: "@test/foreign.js", providerModuleId: "Test.Foreign" }],
      ])),
      createSourceSemanticsExtension({ modules: [{ moduleSpecifier,
        exports: declarations.map(({ exportName, marker }) => ({ kind: "type-marker", exportName, marker })),
      }] }),
      {
        identity: { id: "test.type-marker-demand", version: "1" },
        dependencies: { dependsOn: [sourceSemanticsExtensionId] },
        initialize(context) {
          if (replay !== undefined) context.registerSourceElaborator(replay, () => ({ accepted: true as const }));
        },
        elaborateSource(context) {
          const file = context.source.getSourceFile("/src/index.ts");
          const { ast } = context.source.getSourceFileQueries(file);
          const declaration = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration)
            .find(node => ast.text(ast.name(node)) === "Value");
          assert.ok(declaration);
          const node = ast.as.AsTypeAliasDeclaration(declaration)?.Type;
          assert.ok(node);
          assert.ok(ast.is.IsTypeReferenceNode(node));
          inspect(context, node);
        },
      },
    ] },
  }).checkSource();
}

function assertChecked(checked: ReturnType<typeof checkTypes>) {
  assert.equal(checked.diagnostics.length, 0, checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(checked.extensionDiagnostics, []);
}
