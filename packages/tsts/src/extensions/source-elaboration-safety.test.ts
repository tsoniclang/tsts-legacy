import assert from "node:assert/strict";
import { test } from "node:test";
import { defineExtensionFactKey, type CompilerExtension, type ExtensionFactKey } from "./index.js";
import { defaultSourceElaborationLimits, snapshotSourceElaborationLimits } from "./source-elaboration-model.js";
import { SourceElaborationCoordinator } from "./source-elaboration.js";
import { createSourceProgramQueries } from "./source-program.js";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

let nextOwner = 0;

function factKey<T>(snapshot: (value: T) => T): ExtensionFactKey<T> {
  return defineExtensionFactKey({ extensionId: `test.elaboration.safety.${++nextOwner}`, name: "result", snapshot });
}

function session(extensions: readonly CompilerExtension[] = [], text = "export const value = 42;") {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/main.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/main.ts": text },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions },
  });
}

function attempt(value: unknown) {
  const key = factKey<unknown>(result => result);
  return session([{
    identity: { id: key.extensionId, version: "1.0.0" },
    initialize: context => context.registerSourceElaborator(key, () => value),
    elaborateSource(context) {
      const file = context.source.getSourceFile("/src/main.ts");
      assert.ok(file);
      context.request(file, key);
    },
  }]);
}

for (const name of Object.keys(defaultSourceElaborationLimits) as (keyof typeof defaultSourceElaborationLimits)[]) {
  for (const value of [0, -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(`elaboration rejects malformed ${name}: ${String(value)}`, () => {
      assert.throws(() => snapshotSourceElaborationLimits({ ...defaultSourceElaborationLimits, [name]: value }), /positive finite safe integer/);
    });
  }
}

test("elaboration limits are copied and reject accessors or an incomplete family without invoking accessors", () => {
  const input = { ...defaultSourceElaborationLimits };
  const snapshot = snapshotSourceElaborationLimits(input);
  input.maximumRounds = 1;
  assert.notEqual(snapshot.maximumRounds, 1);
  assert.ok(Object.isFrozen(snapshot));
  let reads = 0;
  Object.defineProperty(input, "maximumRounds", { get() { reads += 1; return 2; } });
  assert.throws(() => snapshotSourceElaborationLimits(input), /positive finite safe integer/);
  assert.equal(reads, 0);
  const incomplete = { ...defaultSourceElaborationLimits };
  Reflect.deleteProperty(incomplete, "maximumRounds");
  assert.throws(() => snapshotSourceElaborationLimits(incomplete), /complete budget family/);
  const extended = { ...defaultSourceElaborationLimits, extra: 1 };
  assert.throws(() => snapshotSourceElaborationLimits(extended), /complete budget family/);
});

for (const [name, value] of [
  ["function", () => 42],
  ["symbol", Symbol("unowned")],
  ["class instance", new Date(0)],
  ["map", new Map([["value", 42]])],
] as const) {
  test(`elaboration rejects ${name} results instead of retaining executable or foreign state`, () => {
    assert.throws(() => attempt(value).checkSource(), /sourceElaboration.value/);
  });
}

test("elaboration rejects cyclic results and getters without invoking them", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => attempt(cyclic).checkSource(), /cycle|cyclic/);
  let reads = 0;
  const value = Object.defineProperty({}, "result", { enumerable: true, get() { reads += 1; return 42; } });
  assert.throws(() => attempt(value).checkSource(), /data property/);
  assert.equal(reads, 0);
});

test("elaboration fails permanently when a result snapshot fails", () => {
  const key = factKey<number>(() => { throw new Error("invalid exact result"); });
  const compiler = session([{
    identity: { id: key.extensionId, version: "1.0.0" },
    initialize: context => context.registerSourceElaborator(key, () => 42),
    elaborateSource: context => context.request(context.source.getSourceFile("/src/main.ts")!, key),
  }]);
  assert.throws(() => compiler.checkSource(), /invalid exact result/);
  assert.throws(() => compiler.checkSource(), /previously failed/);
});

test("elaboration rejects a fact snapshot that changes the accepted answer during replay", () => {
  const key = factKey<number>(value => value + 1);
  const compiler = session([{
    identity: { id: key.extensionId, version: "1.0.0" },
    initialize: context => context.registerSourceElaborator(key, () => 42),
    elaborateSource: context => context.request(context.source.getSourceFile("/src/main.ts")!, key),
  }]);
  assert.throws(() => compiler.checkSource(), /changed while installing/);
});

test("failed elaboration initializer cannot leak a foreign resolver registration", () => {
  const owned = factKey<number>(value => value);
  const foreign = factKey<number>(value => value);
  const compiler = session([{
    identity: { id: owned.extensionId, version: "1.0.0" },
    initialize(context) {
      context.registerSourceElaborator(owned, () => 42);
      assert.throws(() => context.registerSourceElaborator(foreign, () => 7), /exact owning extension/);
    },
    elaborateSource: context => context.request(context.source.getSourceFile("/src/main.ts")!, owned),
  }]);
  const checked = compiler.checkSource();
  assert.ok(checked.extensionDiagnostics.some(diagnostic => diagnostic.extensionCode === "EXTENSION_INITIALIZE_FAILED"));
  assert.equal(checked.sourceFacts.getFact(checked.getSourceFile("/src/main.ts"), owned), undefined);
});

test("source replay rejects same-path changed source even when its length and anchor positions agree", () => {
  const coordinator = new SourceElaborationCoordinator();
  const first = session([], "export const value = 42;");
  const second = session([], "export const value = 43;");
  first.ensureBound();
  second.ensureBound();
  const source = createSourceProgramQueries(first.program);
  const round = coordinator.beginRound(source);
  const key = factKey<number>(value => value);
  round.request(source.getSourceFile("/src/main.ts")!, key);
  coordinator.finishRound(round, false);
  assert.throws(() => coordinator.beginRound(createSourceProgramQueries(second.program)), /source inputs changed/);
});

test("source replay rejects out-of-order completion, pending seals and reuse after seal", () => {
  const compiler = session();
  compiler.ensureBound();
  const source = createSourceProgramQueries(compiler.program);
  const first = new SourceElaborationCoordinator();
  const second = new SourceElaborationCoordinator();
  const firstRound = first.beginRound(source);
  const secondRound = second.beginRound(source);
  assert.throws(() => first.finishRound(secondRound, false), /creation order/);
  first.seal(firstRound);
  assert.throws(() => first.beginRound(source), /current state/);
  const key = factKey<number>(value => value);
  secondRound.request(source.getSourceFile("/src/main.ts")!, key);
  assert.throws(() => second.seal(secondRound), /every answer/);
});
