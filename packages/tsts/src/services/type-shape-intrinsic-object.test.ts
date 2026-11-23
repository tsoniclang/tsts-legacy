import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { Checker_getPropertyOfType } from "../internal/checker/checker/symbols.js";
import { Checker_getPropertiesOfObjectType } from "../internal/checker/checker/types.js";
import type { NativeCheckerResult } from "../internal/checker/resource-admission.js";
import type { TypePropertyHeader } from "./type-shape.js";

test("intrinsic object identity remains exact across aliases and source query owners", () => {
  const declarations = `export type Broad = object; export type Alias = Broad;
    export type Empty = {}; export interface EmptyInterface {}
    export type Interface = EmptyInterface; export class EmptyClass {}
    export type Class = EmptyClass; export type Record = { value: number };
    export type Text = string; export type Numeric = number;
    export type Wide = bigint; export type Truth = boolean;
    export type Absent = null | undefined; export type Mixed = object | null;
    export type Unknown = unknown; export type Any = any;
    export type Never = never; export type Parameter<Value extends object> = Value;`;
  const checked = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/first.ts": declarations,
      "/src/second.ts": `${declarations} import type { Alias as Imported } from "./first.js";
        export type CrossFile = Imported;`,
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022" },
  }).checkSource();
  assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  const owners = ["/src/first.ts", "/src/second.ts"].map(name => {
    const file = checked.getSourceFile(name);
    assert.equal(file !== undefined, true, name);
    return checked.getSourceFileQueries(file!);
  });
  for (const query of owners) {
    assert.equal(query.typeShape.isNonPrimitive(undefined), false);
    for (const owner of owners) {
      const aliases = findNodes(owner.sourceFile, owner.ast.children, owner.ast.is.IsTypeAliasDeclaration);
      for (const declaration of aliases) {
        const name = owner.ast.text(owner.ast.name(declaration));
        const type = owner.typeShape.getTypeFromTypeNode(owner.ast.typeNode(declaration))?.type;
        assert.equal(type !== undefined, true, name);
        assert.equal(query.typeShape.isNonPrimitive(type), ["Broad", "Alias", "CrossFile"].includes(name), name);
      }
    }
  }
});

test("global-scope object identity is the actual cached Type, not spelling or decoration", () => {
  for (const checkers of [1, 4]) {
    const paths = Array.from({ length: 16 }, (_, index) => `/src/scope-${index}.ts`);
    const open = () => createCompilerSessionFromFiles({
      currentDirectory: "/src",
      files: {
        "/src/core.d.ts": testCoreDeclarations,
        ...Object.fromEntries(paths.map(path => [path, `export type Scope = typeof globalThis; export type Broad = object;`])),
        "/src/shadow.ts": `declare const globalThis: { readonly metadata: symbol }; export type Scope = typeof globalThis;`,
      },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", checkers },
    }).checkSource();
    const checked = open();
    assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), []);
    const read = (session: ReturnType<typeof open>, path: string, name: string) => {
      const file = session.getSourceFile(path);
      if (file === undefined) assert.fail(path);
      const { ast, typeShape } = session.getSourceFileQueries(file);
      const declaration = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration)
        .find(node => ast.text(ast.name(node)) === name);
      if (declaration === undefined) assert.fail(name);
      const type = typeShape.getTypeFromTypeNode(ast.typeNode(declaration))?.type;
      if (type === undefined) assert.fail(name);
      return { type, typeShape };
    };
    const actual = paths.map(path => read(checked, path, "Scope"));
    const owners = [...new Map(actual.map(owner => [owner.type.checker, owner])).values()];
    assert.equal(owners.length, checkers);
    const ordinary = read(checked, paths[0]!, "Broad").type;
    const shadow = read(checked, "/src/shadow.ts", "Scope").type;
    const foreign = read(open(), paths[0]!, "Scope").type;
    for (const { typeShape } of owners) {
      for (const { type } of owners) {
        assert.equal(typeShape.isGlobalScopeObject(type), true);
        assert.equal(typeShape.isGlobalScopeObject({ ...type }), false);
      }
      for (const type of [ordinary, shadow, foreign, undefined])
        assert.equal(typeShape.isGlobalScopeObject(type), false);
    }
  }
});

test("one named object property retains real native ownership without resolving unrelated values", () => {
  for (const checkers of [1, 4]) {
    const paths = Array.from({ length: 16 }, (_, index) => `/src/named-${index}.ts`);
    const open = (metadata: boolean) => createCompilerSessionFromFiles({
      currentDirectory: "/src",
      files: {
        "/src/core.d.ts": `${testCoreDeclarations}
          interface Object { onlyApparent: boolean }
          interface SelectedSymbol { ${metadata ? "readonly metadata: symbol;" : ""} optional?: string; }
          declare var Symbol: SelectedSymbol;
          declare var broken: MissingCheckedType;
          declare var actualAny: any;
          declare function untouched(): string;`,
        ...Object.fromEntries(paths.map(path => [path, "export type Subject = typeof globalThis; export type Empty = {};"])),
        "/src/shadow.ts": `declare const globalThis: { Symbol: { metadata: string }; [key: string]: unknown };
          export type Subject = typeof globalThis;`,
      },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", checkers },
    }).checkSource();
    const read = (session: ReturnType<typeof open>, path: string, alias = "Subject") => {
      const file = session.getSourceFile(path);
      if (file === undefined) assert.fail(path);
      const { ast, typeShape } = session.getSourceFileQueries(file);
      const declaration = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration)
        .find(node => ast.text(ast.name(node)) === alias);
      const type = typeShape.getTypeFromTypeNode(ast.typeNode(declaration))?.type;
      if (type === undefined || type.checker === undefined) assert.fail("actual source type and owner");
      return { type, typeShape, checker: type.checker };
    };
    const checked = open(true);
    const opposite = open(false);
    assert.deepEqual(checked.diagnostics.map(diagnostic => diagnostic?.code), [2304]);
    assert.deepEqual(opposite.diagnostics.map(diagnostic => diagnostic?.code), [2304]);
    const sources = [...new Map(paths.map(path => {
      const row = read(checked, path);
      return [row.checker, row];
    })).values()];
    assert.equal(sources.length, checkers);
    const oppositeScope = read(opposite, paths[0]!);
    const shadow = read(checked, "/src/shadow.ts");
    const empty = read(checked, paths[0]!, "Empty");
    const unexpected = () => assert.fail("an empty or unreadable inventory cannot read a header");
    for (const { typeShape } of sources) {
      for (const { type, checker } of sources) {
        const untouched = checker.globalThisSymbol?.Exports.get("untouched");
        if (untouched === undefined) assert.fail("actual unrelated global symbol");
        assert.equal(LinkStore_TryGet(checker.valueSymbolLinks, untouched)?.resolvedType === undefined, true, "untouched before lookup");
        const native = Checker_getPropertiesOfObjectType(checker, type) ?? [];
        const expected = native.map(row => row?.Name);
        const acquired = typeShape.getObjectPropertyHeaders(type, () => null);
        assert.equal(acquired.kind, "complete");
        assert.equal(acquired.value.length, native.length);
        for (let limit = 0; limit <= native.length; limit += 1) {
          for (const stopAfterRow of [false, true]) {
            if (stopAfterRow && limit === 0) continue;
            const events: string[] = [];
            for (let index = 0; index < limit; index += 1) {
              let first = true;
              const selected: NativeCheckerResult<TypePropertyHeader, never> = acquired.value.read<never>(index, (cost, units) => {
                if (first) {
                  assert.deepEqual([cost, units], ["work", 1]);
                  events.push("admit");
                  first = false;
                }
                return null;
              });
              assert.equal(selected.kind, "complete");
              const header: TypePropertyHeader = selected.value;
              assert.equal(header.symbol === native[index], true, "original symbol");
              assert.equal("type" in header, false);
              events.push(header.name);
            }
            const prefix = expected.slice(0, limit).flatMap(name => ["admit", name]);
            if (!stopAfterRow && limit < native.length) {
              const stop = { limit };
              const refused = acquired.value.read(limit, () => { events.push("admit"); return stop; });
              assert.ok(refused.kind === "refused" && refused.stop === stop);
              prefix.push("admit");
            }
            assert.deepEqual(events, prefix);
          }
        }
        assert.equal(LinkStore_TryGet(checker.valueSymbolLinks, untouched)?.resolvedType === undefined, true, "inventory did not resolve values");
        const symbol = typeShape.getObjectPropertyInfo(type, "Symbol");
        if (symbol == null) assert.fail("the actual global value");
        assert.equal(symbol.symbol === checker.globalThisSymbol?.Exports.get("Symbol"), true);
        assert.equal(symbol.type.checker === checker, true);
        const selected = typeShape.getObjectPropertyInfo(symbol.type, "metadata");
        if (selected == null) assert.fail("the actual nested value");
        assert.equal(selected.type.checker === checker, true);
        assert.equal(typeShape.isSymbolLike(selected.type), true);
        assert.equal(selected.readonly, true);
        assert.equal(selected.optional, false);
        const symbolHeaders = typeShape.getObjectPropertyHeaders(symbol.type, () => null);
        assert.equal(symbolHeaders.kind, "complete");
        for (let index = 0; index < symbolHeaders.value.length; index += 1) {
          const row: NativeCheckerResult<TypePropertyHeader, never> = symbolHeaders.value.read<never>(index, () => null);
          assert.equal(row.kind, "complete");
          const header: TypePropertyHeader = row.value;
          if (header.name === "metadata") {
            assert.equal(header.symbol === selected.symbol && header.rootSymbols[0] === selected.rootSymbols[0], true);
            assert.equal(header.readonly, selected.readonly);
            assert.equal(header.optional, selected.optional);
          }
        }
        assert.equal(typeShape.getObjectPropertyInfo(symbol.type, "metadata")?.symbol === selected.symbol, true);
        assert.equal(typeShape.getObjectPropertyInfo(symbol.type, "optional")?.optional, true);
        assert.equal(typeShape.getObjectPropertyInfo(symbol.type, "absent") === null, true, "real missing member");
        assert.equal(typeShape.getObjectPropertyInfo(type, "broken") === undefined, true, "unavailable property value");
        assert.equal(typeShape.isAny(typeShape.getObjectPropertyInfo(type, "actualAny")?.type), true, "genuine any is present");
        assert.equal(typeShape.getObjectPropertyInfo(selected.type, "meta") === undefined, true, "nonobject");
        assert.equal(typeShape.getObjectPropertyInfo({ ...type }, "Symbol") === undefined, true, "copied receiver");
        assert.equal(typeShape.getObjectPropertyHeaders({ ...type }, unexpected).kind, "unavailable");
        assert.equal(LinkStore_TryGet(checker.valueSymbolLinks, untouched)?.resolvedType === undefined, true, "untouched after lookup");
        assert.equal(Checker_getPropertyOfType(checker, symbol.type, "onlyApparent") !== undefined, true);
        assert.equal(typeShape.getObjectPropertyInfo(symbol.type, "onlyApparent") === null, true, "not an apparent Object property");
      }
      assert.equal(typeShape.getObjectPropertyInfo(oppositeScope.type, "Symbol") === undefined, true, "foreign receiver");
      assert.equal(typeShape.getObjectPropertyHeaders(oppositeScope.type, unexpected).kind, "unavailable");
      const emptyHeaders = typeShape.getObjectPropertyHeaders(empty.type, () => null);
      assert.ok(emptyHeaders.kind === "complete" && emptyHeaders.value.length === 0);
      assert.throws(() => emptyHeaders.value.read(0, unexpected), RangeError);
      const ordinary = typeShape.getObjectPropertyInfo(shadow.type, "Symbol");
      if (ordinary == null) assert.fail("the ordinary shadow retains its own selected object");
      const shadowMetadata = typeShape.getObjectPropertyInfo(ordinary.type, "metadata");
      assert.equal(typeShape.isStringLike(shadowMetadata?.type), true);
      assert.equal(typeShape.getObjectPropertyInfo(shadow.type, "absent") === null, true, "not an index signature fallback");
    }
    const missingOwner = oppositeScope.typeShape.getObjectPropertyInfo(oppositeScope.type, "Symbol");
    if (missingOwner == null) assert.fail("the missing metadata control retains Symbol");
    assert.equal(oppositeScope.typeShape.getObjectPropertyInfo(missingOwner.type, "metadata") === null, true, "missing global metadata");
  }
});
