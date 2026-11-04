import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalIdentityFactKey,
  createCompilerSessionFromFiles,
  createSourceSemanticsExtension,
  sourcePrimitive,
  sourcePrimitiveFactKey,
} from "../index.js";
import type { Node } from "../internal/ast/ast.js";

function fixture(annotation: string) {
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/node_modules/@test/words/package.json": JSON.stringify({
        name: "@test/words", version: "1.0.0", type: "module", exports: { ".": "./index.d.ts" },
      }),
      "/src/node_modules/@test/words/index.d.ts": "export type int32 = number; export type int64 = bigint;",
      "/src/unrelated.ts": "export type int32 = number;",
      "/src/index.ts": `import type { int32, int64 } from "@test/words";
        type Named32 = int32; type Named64 = int64; type Imported = ${annotation};`,
    },
    compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" },
    extensionHostOptions: { extensions: [createSourceSemanticsExtension({ modules: [{
      moduleSpecifier: "@test/words", packageName: "@test/words", exports: [
        sourcePrimitive("int32", "int32", "number", true, 32),
        sourcePrimitive("int64", "int64", "bigint", true, 64),
      ],
    }] })] },
  }).checkSource();
  assert.equal(checked.diagnostics.length, 0);
  assert.equal(checked.extensionDiagnostics.length, 0);
  const file = checked.getSourceFile("/src/index.ts");
  if (file === undefined) throw new Error("The original checked source file is required.");
  const nodes: Node[] = [];
  const pending: Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    for (const child of checked.ast.children(node)) if (child !== undefined) pending.push(child);
  }
  const imported = nodes.find(node => checked.ast.is.IsImportTypeNode(node));
  const qualifier = imported === undefined ? undefined : checked.ast.as.AsImportTypeNode(imported)?.Qualifier;
  if (imported === undefined || qualifier === undefined) throw new Error("The authored import annotation and qualifier are required.");
  return { checked, file, nodes, imported, qualifier };
}

for (const [name, runtimeBase, width] of [["int32", "number", 32], ["int64", "bigint", 64]] as const) {
  test(`ImportType ${name} records the same primitive fact as its checked TypeReference declaration`, () => {
    const current = fixture(`import("@test/words").${name}`);
    const { checked, file, imported, qualifier } = current;
    const reference = current.nodes.find(node => checked.ast.is.IsTypeReferenceNode(node) &&
      checked.ast.text(checked.ast.as.AsTypeReferenceNode(node)?.TypeName) === name);
    if (reference === undefined) throw new Error("The matching authored type reference is required.");
    const facts = checked.sourceFacts;
    const expected = { kind: name, runtimeBase, signed: true, width };
    assert.deepEqual(facts.getFact(reference, sourcePrimitiveFactKey), expected);
    assert.deepEqual(facts.getFact(imported, sourcePrimitiveFactKey), expected);
    assert.deepEqual(facts.getFact(qualifier, sourcePrimitiveFactKey), expected);
    assert.equal(facts.getFact(imported, canonicalIdentityFactKey)?.id,
      facts.getFact(reference, canonicalIdentityFactKey)?.id);
    const checker = checked.getSourceFileQueries(file).checker;
    const namedSymbol = checker.getSymbolAtLocation(checked.ast.as.AsTypeReferenceNode(reference)?.TypeName);
    const selected = checker.getSymbolAtLocation(qualifier);
    assert.equal(selected !== undefined && namedSymbol !== undefined &&
      checker.getAliasedSymbol(namedSymbol) === selected, true, "the qualifier selects the identical checked exported declaration");
  });
}

test("an unrelated ImportType with the same primitive spelling gets no configured fact", () => {
  const { checked, imported, qualifier } = fixture('import("./unrelated.js").int32');
  assert.equal(checked.sourceFacts.getFact(imported, sourcePrimitiveFactKey) === undefined, true);
  assert.equal(checked.sourceFacts.getFact(qualifier, sourcePrimitiveFactKey) === undefined, true);
  assert.equal(checked.sourceFacts.getFact(imported, canonicalIdentityFactKey) === undefined, true);
});
