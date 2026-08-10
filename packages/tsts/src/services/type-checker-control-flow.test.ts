import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KindComputedPropertyName,
  KindFunctionDeclaration,
  KindMethodDeclaration,
  KindVariableDeclaration,
  KindYieldExpression,
} from "../internal/ast/generated/kinds.js";
import { TypeFlagsBoolean, TypeFlagsNumberLike, TypeFlagsString } from "../internal/checker/types.js";
import { createAstReader } from "./ast-reader.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findNodesByKind,
} from "./type-checker-test-support.js";

const disposalGlobals = `
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
  interface Disposable {
    [Symbol.dispose](): void;
  }
  interface AsyncDisposable {
    [Symbol.asyncDispose](): PromiseLike<void>;
  }
`;

test("generator queries retain exact sync protocol and yield evidence", () => {
  const { program, index } = createProgram(`
    function* values(): Generator<number, string, boolean> {
      const accepted: boolean = yield 1;
      return accepted ? "yes" : "no";
    }
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const declaration = findNodesByKind(index, KindFunctionDeclaration)[0];
  const yieldExpression = findNodesByKind(index, KindYieldExpression)[0];

  const generator = queries.getResolvedGeneratorInfo(declaration);
  assert.equal(generator?.generatorKind, "sync");
  assert.ok(generator?.declaration === declaration);
  assert.equal(
    generator?.iterationTypes.yieldType.flags & TypeFlagsNumberLike,
    generator?.iterationTypes.yieldType.flags,
  );
  assert.equal(generator?.iterationTypes.returnType.flags & TypeFlagsString, TypeFlagsString);
  assert.equal(generator?.iterationTypes.nextType.flags & TypeFlagsBoolean, TypeFlagsBoolean);

  const yielded = queries.getResolvedYieldInfo(yieldExpression);
  assert.equal(yielded?.yieldKind, "value");
  assert.ok(yielded?.generator === generator);
  assert.equal(yielded?.sourceYieldType.flags & TypeFlagsNumberLike, yielded?.sourceYieldType.flags);
  assert.equal(yielded?.sourceResumeType.flags & TypeFlagsBoolean, TypeFlagsBoolean);
  assert.ok(yielded?.operand?.expression !== undefined);
  assert.ok(queries.getResolvedYieldInfo(yieldExpression) === yielded);
});

test("generator queries retain exact sync and async yield-star mechanisms", () => {
  const { program, index } = createProgram(`
    declare const syncValues: Generator<number, string, boolean>;
    declare const asyncValues: AsyncGenerator<number, string, boolean>;

    function* syncOuter(): Generator<number, string, boolean> {
      return yield* syncValues;
    }

    async function* asyncOuter(): AsyncGenerator<number, string, boolean> {
      return yield* asyncValues;
    }
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const yields = findNodesByKind(index, KindYieldExpression);
  assert.equal(yields.length, 2);

  const sync = queries.getResolvedYieldInfo(yields[0]);
  assert.equal(sync?.yieldKind, "delegate");
  assert.equal(sync?.delegation?.kind, "synchronous-iterator-protocol");
  assert.equal(
    sync?.delegation?.iterationTypes.yieldType.flags & TypeFlagsNumberLike,
    sync?.delegation?.iterationTypes.yieldType.flags,
  );
  assert.equal(sync?.delegation?.iterationTypes.returnType.flags & TypeFlagsString, TypeFlagsString);
  assert.equal(sync?.delegation?.iterationTypes.nextType.flags & TypeFlagsBoolean, TypeFlagsBoolean);

  const async = queries.getResolvedYieldInfo(yields[1]);
  assert.equal(async?.yieldKind, "delegate");
  assert.equal(async?.generator.generatorKind, "async");
  assert.equal(async?.delegation?.kind, "asynchronous-iterator-protocol");
  assert.equal(async?.delegation?.iterationTypes.returnType.flags & TypeFlagsString, TypeFlagsString);
});

test("well-known-symbol queries distinguish exact global symbols from shadows", () => {
  const { program, index } = createProgram(`
    ${disposalGlobals}
    class Resource {
      [Symbol.dispose](): void {}
    }

    declare const localDispose: unique symbol;
    class Other {
      [localDispose](): void {}
    }
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const computedNames = findNodesByKind(index, KindComputedPropertyName).slice(-2);
  assert.equal(computedNames.length, 2);

  const global = queries.getResolvedWellKnownSymbolInfo(computedNames[0]);
  assert.equal(global?.kind, "dispose");
  assert.ok(global?.wellKnownDeclaration !== undefined);
  assert.equal(queries.getResolvedWellKnownSymbolInfo(computedNames[1]), undefined);
  assert.ok(queries.getResolvedWellKnownSymbolInfo(computedNames[0]) === global);
});

test("resource queries retain exact sync and async disposer declarations", () => {
  const { program, index } = createProgram(`
    ${disposalGlobals}
    class SyncResource {
      [Symbol.dispose](): void {}
    }
    declare class AsyncResource {
      [Symbol.asyncDispose](): PromiseLike<void>;
    }

    function sync(resource: SyncResource | undefined): void {
      using active = resource;
    }
    async function asyncResource(resource: AsyncResource): Promise<void> {
      await using active = resource;
    }
    async function asyncFallback(resource: SyncResource): Promise<void> {
      await using active = resource;
    }
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const ast = createAstReader();
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const declarations = findNodesByKind(index, KindVariableDeclaration)
    .filter((node) => {
      const kind = ast.variableDeclarationKind(node);
      return kind === "using" || kind === "await using";
    });
  assert.equal(declarations.length, 3);

  const sync = queries.getResolvedResourceManagementInfo(declarations[0]);
  assert.equal(sync?.declarationKind, "using");
  assert.equal(sync?.acquisition.kind, "initializer");
  assert.equal(sync?.acceptsNullish, true);
  assert.equal(sync?.disposal.kind, "selected");
  assert.equal(sync?.disposal.alternatives.length, 1);
  assert.equal(sync?.disposal.alternatives[0]?.kind, "sync");
  assert.equal(sync?.disposal.alternatives[0]?.selectedDeclaration?.Kind, KindMethodDeclaration);

  const async = queries.getResolvedResourceManagementInfo(declarations[1]);
  assert.equal(async?.declarationKind, "await using");
  assert.equal(async?.disposal.kind, "selected");
  assert.equal(async?.disposal.alternatives[0]?.kind, "async");

  const fallback = queries.getResolvedResourceManagementInfo(declarations[2]);
  assert.equal(fallback?.declarationKind, "await using");
  assert.equal(fallback?.disposal.kind, "selected");
  assert.equal(fallback?.disposal.alternatives[0]?.kind, "sync");
  assert.ok(queries.getResolvedResourceManagementInfo(declarations[2]) === fallback);
});

test("resource queries retain exact for-of acquisition and disposal evidence", () => {
  const { program, index } = createProgram(`
    ${disposalGlobals}
    class Resource {
      [Symbol.dispose](): void {}
    }
    declare const resources: Resource[];
    for (using resource of resources) {}
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const ast = createAstReader();
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const declaration = findNodesByKind(index, KindVariableDeclaration)
    .find((node) => ast.variableDeclarationKind(node) === "using");
  const selected = queries.getResolvedResourceManagementInfo(declaration);

  assert.equal(selected?.acquisition.kind, "iteration");
  assert.equal(selected?.disposal.kind, "selected");
  assert.equal(selected?.disposal.alternatives.length, 1);
  assert.equal(selected?.disposal.alternatives[0]?.kind, "sync");
});

test("resource queries preserve union alternatives without inventing one disposer", () => {
  const { program, index } = createProgram(`
    ${disposalGlobals}
    class First {
      [Symbol.dispose](): void {}
    }
    class Second {
      [Symbol.dispose](): void {}
    }
    declare const resource: First | Second;
    using active = resource;
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const ast = createAstReader();
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const declaration = findNodesByKind(index, KindVariableDeclaration)
    .find((node) => ast.variableDeclarationKind(node) === "using");
  const selected = queries.getResolvedResourceManagementInfo(declaration);

  assert.equal(selected?.disposal.kind, "selected");
  assert.equal(selected?.disposal.alternatives.length, 2);
  const declarations = selected?.disposal.kind === "selected"
    ? selected.disposal.alternatives.map((alternative) => alternative.selectedDeclaration)
    : [];
  assert.equal(new Set(declarations).size, 2);
});

test("control-flow evidence queries reject unrelated syntax", () => {
  const { program, index } = createProgram("const value = 1;", { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const declaration = findNodesByKind(index, KindVariableDeclaration)[0];

  assert.equal(queries.getResolvedGeneratorInfo(declaration), undefined);
  assert.equal(queries.getResolvedYieldInfo(declaration), undefined);
  assert.equal(queries.getResolvedResourceManagementInfo(declaration), undefined);
  assert.equal(queries.getResolvedWellKnownSymbolInfo(declaration), undefined);
});
