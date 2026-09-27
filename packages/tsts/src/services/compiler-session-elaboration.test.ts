import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "../internal/ast/ast.js";
import { SourceFile_IsBound } from "../internal/ast/ast.js";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  defineExtensionFactKey,
  getExtensionHost,
  type CompilerExtension,
  type ExtensionFactKey,
} from "../extensions/index.js";
import { extensionHostRequireElaboration } from "../extensions/host.js";
import { createSourceProgramQueries, type SourceProgramQueries } from "../extensions/source-program.js";
import { defaultSourceElaborationLimits, type SourceElaborationLimits, type SourceElaborationResolverContext } from "../extensions/source-elaboration-model.js";
import { findNodes, sourceProviderExtension, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "./compiler-session.js";

let nextOwner = 0;

function key<T>(snapshot: (value: T) => T) {
  return defineExtensionFactKey<T>({ extensionId: `test.elaboration.${++nextOwner}`, name: "answer", snapshot });
}

function session(extensions: readonly CompilerExtension[], limits?: SourceElaborationLimits, text = "export const first = 1; export const second = 2; export const third = 3;") {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": text },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true },
    extensionHostOptions: { extensions },
    ...(limits === undefined ? {} : { sourceElaborationLimits: limits }),
  });
}

function variables(source: SourceProgramQueries): readonly Node[] {
  const file = source.getSourceFile("/src/index.ts");
  assert.ok(file);
  return findNodes(file, source.ast.children, source.ast.is.IsVariableDeclaration).filter((node): node is Node => node !== undefined);
}

function extension<T>(factKey: ExtensionFactKey<T>, resolve: (context: SourceElaborationResolverContext) => T,
  extras: Pick<CompilerExtension, "dependencies" | "elaborateSource" | "analyzeSource"> = {}): CompilerExtension {
  return {
    identity: { id: factKey.extensionId, version: "1.0.0" },
    initialize: context => context.registerSourceElaborator(factKey, resolve),
    elaborateSource: context => context.request(variables(context.source)[0]!, factKey),
    ...extras,
  };
}

test("source elaboration batches independent demands and publishes facts only in the replayed epoch", () => {
  const factKey = key<number>(value => value);
  let discoveries = 0;
  let resolutions = 0;
  const compiler = session([extension(factKey, context => {
    resolutions += 1;
    return variables(context.source).indexOf(context.node) + 1;
  }, {
    elaborateSource(context) {
      discoveries += 1;
      for (const node of variables(context.source)) context.request(node, factKey);
    },
  })]);
  const originalProgram = compiler.program;
  const oldQueries = createSourceProgramQueries(originalProgram);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, [], checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.notEqual(checked.program, originalProgram);
  assert.equal(discoveries, 2);
  assert.equal(resolutions, 3);
  assert.deepEqual(variables(checked).map(node => checked.sourceFacts.getFact(node, factKey)), [1, 2, 3]);
  assert.throws(() => oldQueries.getSourceFile("/src/index.ts"), /retired compiler/);
  assert.equal(compiler.checkSource(), checked);
});

test("an elaborating session attaches its lifecycle before binding starts", () => {
  const factKey = key<number>(value => value);
  let resolutions = 0;
  const compiler = session([extension(factKey, context => {
    const file = context.source.getSourceFile("/src/index.ts");
    assert.ok(file);
    assert.equal(SourceFile_IsBound(file), true);
    resolutions += 1;
    return 42;
  })]);
  const file = createSourceProgramQueries(compiler.program).getSourceFile("/src/index.ts");
  assert.ok(file);
  assert.equal(SourceFile_IsBound(file), false);
  assert.equal(resolutions, 0);
  compiler.ensureBound();
  const current = createSourceProgramQueries(compiler.program).getSourceFile("/src/index.ts");
  assert.ok(current);
  assert.notEqual(current, file);
  assert.equal(SourceFile_IsBound(current), true);
  assert.equal(resolutions, 1);
});

for (const operation of ["bind", "semantic", "suggestion", "declaration", "ensureBound", "ensureChecked", "emit-files"] as const) {
  test(`compiler session ${operation} stays inside the same demand/replay owner`, () => {
    const factKey = key<number>(value => value);
    const compiler = session([extension(factKey, () => 42)]);
    const originalProgram = compiler.program;
    const originalFile = createSourceProgramQueries(originalProgram).getSourceFile("/src/index.ts");
    assert.ok(originalFile);
    if (operation === "emit-files") {
      const files = compiler.getSourceFilesToEmit(originalFile);
      assert.ok(files.some(file => file !== undefined && file !== originalFile && file.Text() === originalFile.Text()));
    } else if (operation === "ensureBound") {
      compiler.ensureBound();
    } else {
      const diagnostics = operation === "ensureChecked"
        ? compiler.ensureChecked(originalFile)
        : compiler.getDiagnostics(operation, originalFile);
      assert.deepEqual(diagnostics, [], diagnostics.map(Diagnostic_String).join("\n"));
    }
    assert.notEqual(compiler.program, originalProgram);
    const checked = compiler.checkSource();
    assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 42);
  });
}

test("source elaboration resolves a dependency chain without retrying a mutated checker", () => {
  const factKey = key<number>(value => value);
  const visited: string[] = [];
  const queries: SourceProgramQueries[] = [];
  const compiler = session([extension(factKey, context => {
    queries.push(context.source);
    const nodes = variables(context.source);
    const index = nodes.indexOf(context.node);
    visited.push(String(index));
    const input = index < 2 ? context.require(nodes[index + 1]!, factKey) : 40;
    return input + 1;
  })]);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(visited, ["0", "1", "2", "1", "0"]);
  assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 43);
  for (const source of queries) assert.throws(() => source.getSourceFiles(), /retired compiler/);
});

test("source elaboration preserves independent completed results when a later demand suspends", () => {
  const factKey = key<number>(value => value);
  const visits: number[] = [];
  const compiler = session([extension(factKey, context => {
    const nodes = variables(context.source);
    const index = nodes.indexOf(context.node);
    visits.push(index);
    return index === 1 ? context.require(nodes[2]!, factKey) + 1 : index;
  }, {
    elaborateSource(context) {
      const nodes = variables(context.source);
      context.request(nodes[0]!, factKey);
      context.request(nodes[1]!, factKey);
    },
  })]);
  const checked = compiler.checkSource();
  assert.deepEqual(visits, [0, 1, 2, 1]);
  assert.equal(checked.sourceFacts.getFact(variables(checked)[1], factKey), 3);
});

for (const length of [1, 2]) {
  test(`source elaboration rejects an unresolved ${length}-node cycle`, () => {
    const factKey = key<number>(value => value);
    const queries: SourceProgramQueries[] = [];
    const compiler = session([extension(factKey, context => {
      queries.push(context.source);
      const nodes = variables(context.source);
      return context.require(nodes[(nodes.indexOf(context.node) + 1) % length]!, factKey);
    })]);
    assert.throws(() => compiler.checkSource(), /cyclic or unresolved demands/);
    assert.throws(() => compiler.checkSource(), /previously failed/);
    for (const source of queries) assert.throws(() => source.getSourceFiles(), /retired compiler/);
  });
}

test("a failed source elaboration retires escaped queries without replacing the original error", () => {
  const factKey = key<number>(value => value);
  const failure = new Error("rejected native evidence");
  let retained: SourceProgramQueries | undefined;
  const compiler = session([extension(factKey, context => {
    retained = context.source;
    throw failure;
  })]);
  assert.throws(() => compiler.checkSource(), error => error === failure);
  assert.ok(retained);
  const source = retained;
  assert.throws(() => source.getSourceFiles(), /retired compiler/);
  assert.throws(() => compiler.ensureChecked(), /previously failed/);
  assert.throws(() => compiler.ensureBound(), /previously failed/);
  assert.throws(() => compiler.getDiagnostics("bind"), /previously failed/);
});

test("binding through replay retains actual duplicate declaration diagnostics", () => {
  const factKey = key<number>(value => value);
  const compiler = session([extension(factKey, () => 42)], undefined,
    "export const duplicate = 1; export const duplicate = 2;");
  const originalProgram = compiler.program;
  const diagnostics = compiler.getDiagnostics("bind");
  assert.notEqual(compiler.program, originalProgram);
  assert.ok(diagnostics.some(diagnostic => Diagnostic_Code(diagnostic) === 2451),
    diagnostics.map(Diagnostic_String).join("\n"));
  compiler.ensureBound();
  const checked = compiler.checkSource();
  assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 42);
  assert.ok(checked.diagnostics.some(diagnostic => Diagnostic_Code(diagnostic) === 2451));
});

test("ordinary binding does not add replay or semantic checking", () => {
  const compiler = session([], undefined, "export const value: string = 42;");
  const originalProgram = compiler.program;
  compiler.ensureBound();
  assert.equal(compiler.program, originalProgram);
  assert.deepEqual(compiler.getDiagnostics("bind"), []);
  assert.equal(compiler.program, originalProgram);
  assert.ok(compiler.ensureChecked().some(diagnostic => Diagnostic_Code(diagnostic) === 2322));
});

test("a swallowed demand suspension cannot publish the resolver's fabricated answer", () => {
  const factKey = key<number>(value => value);
  const compiler = session([extension(factKey, context => {
    const nodes = variables(context.source);
    if (context.node === nodes[1]) return 42;
    try {
      return context.require(nodes[1]!, factKey);
    } catch {
      return -1;
    }
  })]);
  const checked = compiler.checkSource();
  assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 42);
});

test("source elaboration retains ordinary strict source errors rather than certifying provisional diagnostics", () => {
  const factKey = key<number>(value => value);
  const compiler = session([extension(factKey, () => 42)], undefined, "export const value: string = 42;");
  const checked = compiler.checkSource();
  assert.ok(checked.diagnostics.some(diagnostic => Diagnostic_Code(diagnostic) === 2322));
  assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 42);
});

test("source elaboration keeps copied data immutable through source analysis and consumer reads", () => {
  const factKey = key<{ readonly nested: readonly number[] }>(value => Object.freeze({ nested: Object.freeze([...value.nested]) }));
  const result = { nested: [42] };
  const compiler = session([extension(factKey, () => result)]);
  const checked = compiler.checkSource();
  result.nested[0] = 7;
  const answer = checked.sourceFacts.getFact(variables(checked)[0], factKey);
  assert.deepEqual(answer, { nested: [42] });
  assert.ok(Object.isFrozen(answer));
  assert.ok(Object.isFrozen(answer.nested));
});

test("elaboration context capabilities cannot be retained outside their owning callbacks", () => {
  const factKey = key<number>(value => value);
  let retained: SourceElaborationResolverContext | undefined;
  const compiler = session([extension(factKey, context => { retained = context; return 42; })]);
  compiler.checkSource();
  assert.ok(retained);
  const context = retained;
  assert.throws(() => context.request(context.node, factKey), /outside their host-owned callback/);
  assert.throws(() => context.require(context.node, factKey), /outside their host-owned callback/);
});

for (const declared of [true, false]) {
  test(`source elaboration ${declared ? "allows declared" : "rejects undeclared"} cross-extension dependencies`, () => {
    const sourceKey = key<number>(value => value);
    const derivedKey = key<number>(value => value);
    const compiler = session([
      extension(sourceKey, () => 42, { elaborateSource: () => {} }),
      extension(derivedKey, context => context.require(context.node, sourceKey) + 1, {
        ...(declared ? { dependencies: { dependsOn: [sourceKey.extensionId] } } : {}),
      }),
    ]);
    if (!declared) {
      assert.throws(() => compiler.checkSource(), /cannot read or resolve fact key/);
      return;
    }
    const checked = compiler.checkSource();
    assert.equal(checked.sourceFacts.getFact(variables(checked)[0], derivedKey), 43);
  });
}

test("source elaboration rejects foreign syntax even at the same file name and span", () => {
  const foreign = session([]).checkSource();
  const foreignNode = variables(foreign)[0]!;
  const factKey = key<number>(value => value);
  const compiler = session([extension(factKey, context => context.require(foreignNode, factKey))]);
  assert.throws(() => compiler.checkSource(), /current compiler epoch/);
});

test("source elaboration rejects unregistered demand keys", () => {
  const factKey = key<number>(value => value);
  const compiler = session([{
    identity: { id: factKey.extensionId, version: "1.0.0" },
    elaborateSource: context => context.request(variables(context.source)[0]!, factKey),
  }]);
  assert.throws(() => compiler.checkSource(), /no exact registered owner/);
});

test("source elaboration registration is atomic even when an extension catches its registration error", () => {
  const factKey = key<number>(value => value);
  let calls = 0;
  const compiler = session([{
    identity: { id: factKey.extensionId, version: "1.0.0" },
    initialize(context) {
      context.registerSourceElaborator(factKey, () => ++calls);
      assert.throws(() => context.registerSourceElaborator(factKey, () => ++calls), /already registered/);
    },
    elaborateSource: context => context.request(variables(context.source)[0]!, factKey),
  }]);
  const checked = compiler.checkSource();
  assert.equal(calls, 0);
  assert.ok(checked.extensionDiagnostics.some(diagnostic => diagnostic.extensionCode === "EXTENSION_INITIALIZE_FAILED"));
});

test("source elaboration cannot use a fixed externally owned program", () => {
  const factKey = key<number>(value => value);
  const compiler = session([extension(factKey, () => 42)]);
  assert.throws(() => createCompilerSessionFromProgram(compiler.program, compiler.host, compiler.config), /owns fresh program creation/);
});

test("source analysis may suspend and is rerun with complete elaboration evidence", () => {
  const factKey = key<number>(value => value);
  let compiler: ReturnType<typeof session>;
  compiler = session([extension(factKey, () => 42, {
    elaborateSource: () => {},
    analyzeSource(context) {
      const host = getExtensionHost(compiler.program!);
      assert.ok(host);
      assert.equal(host[extensionHostRequireElaboration](variables(context.source)[0]!, factKey), 42);
    },
  })]);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 42);
});

test("provider materialization invalidates elaboration answers before source checking resumes", () => {
  const factKey = key<number>(value => value);
  let providerComplete = false;
  const model = {
    moduleSpecifier: "@test/elaboration.js", providerModuleId: "Elaboration.Provider",
    exports: [{ id: "Elaboration.Value", name: "Value", kind: "class" as const }],
  };
  const provider = sourceProviderExtension(new Map([[model.moduleSpecifier, model]]), {
    declarationMaterialization: "incremental",
    getDeclarationModel(_resolution, _model, request) {
      providerComplete = request.materialization.kind === "complete" || request.materialization.completeExports.length !== 0;
      return { ...model, exports: [{ ...model.exports[0]!, ...(providerComplete ? { members: [{
        id: "Elaboration.Value.count", name: "count", kind: "property" as const, type: { kind: "number" as const },
      }] } : {}) }] };
    },
  });
  const answers: number[] = [];
  const compiler = session([provider, extension(factKey, () => {
    const answer = providerComplete ? 42 : 0;
    answers.push(answer);
    return answer;
  })], undefined, 'import type { Value } from "@test/elaboration.js"; declare const value: Value; export const count = value.count;');
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, [], checked.diagnostics.map(Diagnostic_String).join("\n"));
  assert.deepEqual(answers, [0, 42]);
  assert.equal(checked.sourceFacts.getFact(variables(checked)[0], factKey), 42);
});

for (const [field, selected, expected] of [
  ["maximumRounds", 1, /replay budget/],
  ["maximumRequests", 1, /request budget/],
  ["maximumReferences", 1, /reference budget/],
  ["maximumDependencies", 1, /dependency budget/],
  ["maximumAnchorDepth", 1, /depth budget/],
  ["maximumDataRows", 1, /evidence budget/],
  ["maximumDataCodeUnits", 1, /evidence budget/],
] as const) {
  test(`source elaboration independently enforces ${field}`, () => {
    const factKey = key<unknown>(value => value !== null && typeof value === "object" ? Object.freeze(structuredClone(value)) : value);
    const compiler = session([extension(factKey, context => {
      const nodes = variables(context.source);
      const index = nodes.indexOf(context.node);
      if (field === "maximumReferences") {
        context.reference(nodes[0]!);
        context.reference(nodes[1]!);
      }
      if (field === "maximumDependencies" && index === 0) {
        context.require(nodes[1]!, factKey);
        context.require(nodes[2]!, factKey);
      }
      return { value: "answer" };
    }, {
      elaborateSource(context) {
        for (const node of variables(context.source)) context.request(node, factKey);
      },
    })], { ...defaultSourceElaborationLimits, [field]: selected });
    assert.throws(() => compiler.checkSource(), expected);
  });
}
