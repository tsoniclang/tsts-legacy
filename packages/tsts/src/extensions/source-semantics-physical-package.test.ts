import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompilerSessionFromFiles, createSourceSemanticsExtension, fieldFactKey, sourcePrimitive,
  sourcePrimitiveFactKey, structFactKey,
} from "../index.js";
import type { Node } from "../internal/ast/ast.js";

const packageRoot = "/src/node_modules/physical-marker";

test("a name-qualified physical registration cannot attach to a same-spelled paths redirect", () => {
  const name = "physical-marker";
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/index.ts"],
    files: {
      "/src/index.ts": `export type Word = import("${name}").word;`,
      "/src/impostor.d.ts": "export type word = number;",
    },
    compilerOptions: { strict: true, target: "es2024", module: "esnext", moduleResolution: "bundler",
      paths: { [name]: ["./impostor.d.ts"] } },
    extensionHostOptions: { extensions: [createSourceSemanticsExtension({ modules: [{
      moduleSpecifier: name, packageName: name, exports: [sourcePrimitive("word", "int32", "number", true, 32)],
    }] })] },
  }).checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/src/index.ts");
  assert.ok(file);
  const declaration = checked.ast.statements(file)[0];
  const imported = checked.ast.typeNode(declaration);
  const argument = checked.ast.as.AsImportTypeNode(imported)?.Argument;
  const literal = checked.ast.as.AsLiteralTypeNode(argument)?.Literal;
  assert.ok(imported && literal);
  assert.equal(checked.ast.getFileName(checked.resolveModuleSourceFile(literal)), "/src/impostor.d.ts");
  assert.equal(checked.getCheckedModulePackage(literal) === undefined, true);
  assert.equal(checked.sourceFacts.getFact(imported, sourcePrimitiveFactKey) === undefined, true);
});

for (const [site, setup, structure, markers] of [
  ["named", 'import { struct, field } from "physical-marker";', "struct", "field"],
  ["namespace", 'import * as native from "physical-marker";', "native.struct", "native.field"],
  ["re-export", 'import { struct, field } from "./barrel.js";', "struct", "field"],
] as const) for (const [name, version, registerSuccessor] of [
  ["physical-marker", "1.0.0", false],
  ["physical-marker", "2.0.0", false],
  ["physical-marker", "2.0.0", true],
  ["foreign-marker", "1.0.0", false],
] as const) {
  test(`Source semantics checks the actual physical package for a ${site} use of ${name}@${version}, successor ${registerSuccessor}`, () => {
    const original = name === "physical-marker" && version === "1.0.0";
    const checked = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/index.ts"],
      files: {
        "/src/index.ts": `${setup}
          export const Shape = ${structure}({ flag: ${markers}<boolean>() });
          export type Word = import("physical-marker").word;
          export const unrelated = "physical-marker";`,
        "/src/barrel.ts": 'export { struct, field } from "physical-marker";',
        [`${packageRoot}/package.json`]: JSON.stringify({
          name, version, type: "module", exports: { ".": "./index.d.ts" },
        }),
        [`${packageRoot}/index.d.ts`]: "export declare function struct<T>(value: T): T; export declare function field<T>(): T; export type word = number;",
      },
      compilerOptions: { strict: true, target: "es2024", module: "esnext", moduleResolution: "bundler" },
      extensionHostOptions: { extensions: [createSourceSemanticsExtension({ modules: [{
        moduleSpecifier: "physical-marker", packageName: "physical-marker", packageVersion: "1.0.0",
        exports: [
          { kind: "call-marker", exportName: "struct", marker: "struct" },
          { kind: "call-marker", exportName: "field", marker: "field" },
          sourcePrimitive("word", "int32", "number", true, 32),
        ],
      }, ...(registerSuccessor ? [{
        moduleSpecifier: "physical-marker", packageName: "physical-marker", packageVersion: "2.0.0",
        exports: [sourcePrimitive("word", "uint32", "number", false, 32)],
      }] : [])] })] },
    }).checkSource();
    assert.equal(checked.diagnostics.length, 0);
    const file = checked.getSourceFile("/src/index.ts");
    if (file === undefined) throw new Error("The actual checked importer is required.");
    const { ast, sourceFacts } = checked;
    const pending: Node[] = [file];
    const nodes: Node[] = [];
    while (pending.length !== 0) {
      const node = pending.pop()!;
      nodes.push(node);
      for (const child of ast.children(node)) if (child !== undefined) pending.push(child);
    }
    const callSites = nodes.filter(node => ast.kindName(node) === "KindCallExpression");
    assert.equal(callSites.length, 2);
    assert.equal(callSites.filter(node => sourceFacts.getFact(node, structFactKey) !== undefined).length, original ? 1 : 0);
    assert.equal(callSites.filter(node => sourceFacts.getFact(node, fieldFactKey) !== undefined).length, original ? 1 : 0);
    const importType = nodes.find(node => ast.kindName(node) === "KindImportType");
    assert.ok(importType);
    assert.equal(sourceFacts.getFact(importType, sourcePrimitiveFactKey)?.kind, original ? "int32" : registerSuccessor ? "uint32" : undefined);
    const argument = ast.as.AsImportTypeNode(importType)?.Argument;
    assert.ok(argument);
    const moduleSpecifier = ast.as.AsLiteralTypeNode(argument)?.Literal;
    assert.ok(moduleSpecifier);
    const checkedPackage = checked.getCheckedModulePackage(moduleSpecifier);
    assert.equal(checkedPackage?.Name, name);
    assert.equal(checkedPackage?.Version, version);
    const copiedSpecifier = { ...moduleSpecifier };
    assert.equal(ast.parent(copiedSpecifier) === argument, true);
    assert.equal(checked.getCheckedModulePackage(copiedSpecifier) === undefined, true);
    const sameSpelling = nodes.filter(node => ast.kindName(node) === "KindStringLiteral" && ast.text(node) === "physical-marker");
    assert.equal(sameSpelling.some(node => {
      const association = checked.getCheckedModulePackage(node);
      return association?.Name === name && association.Version === version;
    }), true);
    const unrelated = sameSpelling.find(node => ast.kindName(ast.parent(node)) === "KindVariableDeclaration");
    assert.equal(unrelated !== undefined, true);
    assert.equal(checked.getCheckedModulePackage(unrelated) === undefined, true);
  });
}
