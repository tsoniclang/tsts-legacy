import assert from "node:assert/strict";
import { test } from "node:test";
import { Node_ModuleSpecifier } from "../internal/ast/ast.js";
import { createCompilerSessionFromFiles, getDiagnosticRunMembers } from "../index.js";

for (const checkers of [1, 4]) test(`static module evaluation follows actual checked bindings with ${checkers} checkers`, () => {
  const sources = {
    "/case/main.mts": [
      "import './value.mjs';",
      "import type { Flag as Explicit } from './value.mjs';",
      "import { Flag as Implicit } from './value.mjs';",
      "import { run as unused, type Flag as Inline } from './value.mjs';",
      "import { run as invoked } from './value.mjs';",
      "import h from './value.mjs';",
      "import * as space from './value.mjs';",
      "export { run as direct } from './value.mjs';",
      "export { run as erased } from './types.mjs';",
      "export type * from './value.mjs';",
      "export * from './relay.mjs';",
      "export { space };",
      "export function call(value: Explicit | Implicit | Inline): boolean { return invoked(h(value)); }",
    ].join("\n"),
    "/case/value.mts": "export type Flag = boolean; export function run(value: Flag): Flag { return value; } export default run;",
    "/case/types.mts": "export type * from './value.mjs';",
    "/case/relay.mts": "export const flag = true;",
    "/case/lazy.mts": "import defer * as future from './value.mjs'; import './missing.mjs'; export { future };",
    "/case/filtered.mts": "// @ts-expect-error\nimport './missing.mjs';",
  };
  const open = (verbatimModuleSyntax: boolean, noCheck = false) => {
    const session = createCompilerSessionFromFiles({ currentDirectory: "/case", files: sources, rootFiles: Object.keys(sources),
      compilerOptions: { checkers, module: "nodenext", moduleResolution: "nodenext", target: "es2024", strict: true, noEmit: true, verbatimModuleSyntax, noCheck } });
    assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
    return { session, checked: session.checkSource() };
  };
  const { session, checked } = open(false);
  const entry = checked.getSourceFile("/case/main.mts");
  const value = checked.getSourceFile("/case/value.mts");
  const types = checked.getSourceFile("/case/types.mts");
  const relay = checked.getSourceFile("/case/relay.mts");
  assert.ok(entry && value && types && relay);
  const reader = checked.getSourceFileQueries(relay).checker;
  const rows = (file: typeof entry) => checked.ast.children(file).flatMap(node => {
    const kind = checked.ast.kindName(node);
    return kind === "KindImportDeclaration" || kind === "KindExportDeclaration" ? [node] : [];
  });
  const valueSymbol = reader.getSymbolAtLocation(value);
  const typeSymbol = reader.getSymbolAtLocation(types);
  const relaySymbol = reader.getSymbolAtLocation(relay);
  assert.ok(valueSymbol && typeSymbol && relaySymbol);
  const phase = ["eager", "erased", "erased", "erased", "eager", "eager", "eager", "eager", "erased", "erased", "eager"];
  const modules = [valueSymbol, valueSymbol, valueSymbol, valueSymbol, valueSymbol, valueSymbol, valueSymbol, valueSymbol, typeSymbol, valueSymbol, relaySymbol];
  const statements = rows(entry);
  assert.equal(statements.length, phase.length + 1);
  for (const [position, declaration] of statements.entries()) {
    const specifier = Node_ModuleSpecifier(declaration);
    if (position === phase.length) assert.equal(specifier, undefined);
    const result = reader.getResolvedSourceModuleLink(specifier);
    assert.equal(result?.evaluation, phase[position], `phase ${position}`);
    assert.equal(position === phase.length ? result === undefined
      : result?.resolution.kind === "resolved" && result.resolution.module === modules[position], true, `module ${position}`);
  }
  const actual = Node_ModuleSpecifier(statements[0]);
  assert.ok(actual);
  assert.equal(reader.getResolvedSourceModuleLink({ ...actual }), undefined, "a copied specifier is not that declaration's occurrence");
  assert.equal(reader.getResolvedSourceModuleLink(statements[0]), undefined, "a declaration is not its own module specifier");
  const lazy = checked.getSourceFile("/case/lazy.mts");
  assert.ok(lazy);
  const before = session.getDiagnostics("all").flatMap(diagnostic => {
    assert.ok(diagnostic);
    return getDiagnosticRunMembers(diagnostic);
  });
  const [deferred, unresolved] = rows(lazy).map(declaration => reader.getResolvedSourceModuleLink(Node_ModuleSpecifier(declaration)));
  const missing = Node_ModuleSpecifier(rows(lazy)[1]);
  assert.ok(missing);
  assert.equal(deferred?.evaluation, "deferred");
  assert.equal(deferred?.resolution.kind === "resolved" && deferred.resolution.module === valueSymbol, true);
  assert.equal(unresolved?.evaluation, "eager");
  const failure = unresolved?.resolution;
  if (failure?.kind !== "unresolved" || failure.cause === undefined) throw new Error("The actual side-effect import must retain its original failure");
  assert.equal(failure.cause.file === lazy && failure.cause.code === 2882 && before.includes(failure.cause), true);
  const repeated = reader.getResolvedSourceModuleLink(missing)?.resolution;
  assert.equal(repeated?.kind === "unresolved" && repeated.cause === failure.cause, true);
  const filtered = checked.getSourceFile("/case/filtered.mts");
  assert.ok(filtered);
  const filteredSpecifier = Node_ModuleSpecifier(rows(filtered)[0]);
  assert.deepEqual(reader.getResolvedSourceModuleLink(filteredSpecifier),
    { resolution: { kind: "unresolved", cause: undefined }, evaluation: "eager" });
  const after = session.getDiagnostics("all").flatMap(diagnostic => {
    assert.ok(diagnostic);
    return getDiagnosticRunMembers(diagnostic);
  });
  assert.equal(after.length === before.length && after.every((diagnostic, index) => diagnostic === before[index]), true);
  const { checked: unchecked } = open(false, true);
  const uncheckedRoot = unchecked.getSourceFile("/case/lazy.mts");
  assert.ok(uncheckedRoot);
  assert.deepEqual(unchecked.getSourceFileQueries(uncheckedRoot).checker.getResolvedSourceModuleLink(Node_ModuleSpecifier(rows(uncheckedRoot)[1])),
    { resolution: { kind: "unresolved", cause: undefined }, evaluation: "eager" });
  const { checked: other } = open(true);
  const verbatim = other.getSourceFile("/case/main.mts");
  assert.ok(verbatim);
  const verbatimReader = other.getSourceFileQueries(verbatim).checker;
  assert.equal(verbatimReader.getResolvedSourceModuleLink(actual), undefined, "foreign checked source is not admitted");
  assert.deepEqual(rows(verbatim).map(declaration => verbatimReader.getResolvedSourceModuleLink(Node_ModuleSpecifier(declaration))?.evaluation),
    ["eager", "erased", "eager", "eager", "eager", "eager", "eager", "eager", "eager", "erased", "eager", undefined]);
});
