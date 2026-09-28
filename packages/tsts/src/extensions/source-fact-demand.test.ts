import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "../internal/ast/ast.js";
import { createCompilerSessionFromFiles } from "../services/compiler-session.js";
import { defineExtensionFactKey, getExtensionHost } from "./index.js";
import type { CompilerExtension, ExtensionFactResolverContext, ExtensionFactKey } from "./index.js";
import type { SourceElaborationContext } from "./source-elaboration-model.js";
import { testCoreDeclarations, testNoLibCompilerOptions } from "./source-provider-test-support.js";

let nextIdentity = 0;

function key<T>(snapshot: (value: T) => T, extensionId = `test.source-fact-demand.${++nextIdentity}`): ExtensionFactKey<T> {
  return defineExtensionFactKey({ extensionId, name: `selection.${++nextIdentity}`, snapshot });
}

function session(extensions: readonly CompilerExtension[]) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: { "/src/core.d.ts": testCoreDeclarations, "/src/index.ts": "export const value = 42;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true },
    extensionHostOptions: { extensions },
  });
}

test("source facts have one lazy owner before checking and during final analysis", () => {
  const selected = key<{ readonly node: Node }>(value => Object.freeze({ ...value }));
  let calls = 0;
  let analyzed = false;
  let early: { readonly node: Node } | undefined;
  const compiler = session([{
    identity: { id: selected.extensionId, version: "1" },
    initialize(context) {
      context.registerFactResolver(selected, (subject, resolver) => {
        calls += 1;
        assert.equal(analyzed, false);
        const file = resolver.source.getSourceFile("/src/index.ts");
        assert.equal(subject, file);
        assert.ok(file);
        assert.equal(resolver.source.getSourceFileQueries(file).sourceFile, file);
        return { value: { node: file } };
      });
    },
    elaborateSource(context) {
      const file = context.source.getSourceFile("/src/index.ts")!;
      early = context.factResolver.resolve(file, selected);
      assert.ok(early);
      assert.equal(context.factResolver.resolve(file, selected), early);
      assert.equal(context.facts.get(file, selected), early);
      assert.equal(Object.isFrozen(early), true);
      assert.deepEqual(Object.keys(context.facts).sort(), ["get", "getEntry", "has"]);
    },
    analyzeSource(context) {
      analyzed = true;
      assert.equal(context.factResolver.resolve(context.source.getSourceFile("/src/index.ts")!, selected), early);
    },
  }]);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.equal(calls, 1);
  assert.equal(analyzed, true);
  assert.equal(checked.sourceFacts.getFact(checked.getSourceFile("/src/index.ts"), selected), early);
});

test("nested fact resolution uses each owner's declared dependencies, not the original caller's permissions", () => {
  const base = key<number>(value => value);
  const middle = key<number>(value => value);
  const outer = key<number>(value => value);
  const order: string[] = [];
  const compiler = session([{
    identity: { id: base.extensionId, version: "1" },
    initialize: context => context.registerFactResolver(base, () => {
      order.push("base");
      return { value: 20 };
    }),
  }, {
    identity: { id: middle.extensionId, version: "1" },
    dependencies: { dependsOn: [base.extensionId] },
    initialize: context => context.registerFactResolver(middle, (subject, resolver) => {
      order.push("middle");
      const value = resolver.factResolver.resolve(subject, base);
      assert.equal(value, 20);
      assert.equal(resolver.facts.get(subject, base), value);
      return { value: value + 1 };
    }),
  }, {
    identity: { id: outer.extensionId, version: "1" },
    dependencies: { dependsOn: [middle.extensionId] },
    initialize: context => context.registerFactResolver(outer, (subject, resolver) => {
      order.push("outer");
      const value = resolver.factResolver.resolve(subject, middle);
      assert.equal(value, 21);
      assert.throws(() => resolver.facts.get(subject, base), /explicitly declared source dependencies/);
      assert.throws(() => resolver.factResolver.resolve(subject, base), /explicitly declared source dependencies/);
      return { value: value * 2 };
    }),
    elaborateSource(context) {
      assert.equal(context.factResolver.resolve(context.source.getSourceFile("/src/index.ts")!, outer), 42);
    },
  }]);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.deepEqual(order, ["outer", "middle", "base"]);
});

test("an active outer reader cannot borrow a nested resolver's stronger permissions", () => {
  const privateValue = key<number>(value => value);
  const inner = key<number>(value => value);
  const outer = key<number>(value => value);
  let readOuter: (() => unknown) | undefined;
  const compiler = session([{
    identity: { id: privateValue.extensionId, version: "1" },
    initialize: context => context.registerFactResolver(privateValue, () => ({ value: 7 })),
  }, {
    identity: { id: inner.extensionId, version: "1" },
    dependencies: { dependsOn: [privateValue.extensionId] },
    initialize: context => context.registerFactResolver(inner, (subject, resolver) => {
      assert.equal(resolver.factResolver.resolve(subject, privateValue), 7);
      assert.ok(readOuter);
      assert.throws(readOuter, /explicitly declared source dependencies/);
      return { value: 7 };
    }),
  }, {
    identity: { id: outer.extensionId, version: "1" },
    dependencies: { dependsOn: [inner.extensionId] },
    elaborateSource(context) {
      const file = context.source.getSourceFile("/src/index.ts")!;
      readOuter = () => context.facts.get(file, privateValue);
      assert.equal(context.factResolver.resolve(file, inner), 7);
    },
  }]);
  assert.deepEqual(compiler.checkSource().extensionDiagnostics, []);
});

for (const phase of ["elaboration", "analysis"] as const) {
  test(`cyclic fact dependencies fail closed during ${phase}`, () => {
    const first = key<number>(value => value);
    const second = key<number>(value => value, first.extensionId);
    let subject: Node | undefined;
    const select = (context: Pick<SourceElaborationContext, "source" | "factResolver">) => {
      subject = context.source.getSourceFile("/src/index.ts");
      assert.ok(subject);
      context.factResolver.resolve(subject, first);
    };
    const compiler = session([{
      identity: { id: first.extensionId, version: "1" },
      initialize(context) {
        context.registerFactResolver(first, (subject, resolver) => {
          const value = resolver.factResolver.resolve(subject, second);
          return value === undefined ? undefined : { value };
        });
        context.registerFactResolver(second, (subject, resolver) => {
          const value = resolver.factResolver.resolve(subject, first);
          return value === undefined ? undefined : { value };
        });
      },
      ...(phase === "elaboration" ? { elaborateSource: select } : { analyzeSource: select }),
    }]);
    assert.throws(() => compiler.checkSource(), /Cyclic source fact resolution/);
    assert.throws(() => compiler.checkSource(), /previously failed/);
    const host = getExtensionHost(compiler.program!);
    assert.ok(host);
    assert.ok(subject);
    assert.equal(host.facts.get(subject, first), undefined);
    assert.equal(host.facts.get(subject, second), undefined);
  });
}

test("early resolver reads, source queries, diagnostics and nested resolution are revoked after the callback", () => {
  const selected = key<number>(value => value);
  let retained: ExtensionFactResolverContext | undefined;
  let early: SourceElaborationContext | undefined;
  const compiler = session([{
    identity: { id: selected.extensionId, version: "1" },
    initialize: context => context.registerFactResolver(selected, (_subject, resolver) => {
      retained = resolver;
      return { value: 42 };
    }),
    elaborateSource(context) {
      early = context;
      assert.equal(context.factResolver.resolve(context.source.getSourceFile("/src/index.ts")!, selected), 42);
    },
  }]);
  const checked = compiler.checkSource();
  const file = checked.getSourceFile("/src/index.ts")!;
  assert.ok(retained);
  assert.ok(early);
  const resolver = retained;
  const elaboration = early;
  assert.throws(() => resolver.source, /callback scope/);
  assert.throws(() => resolver.facts.get(file, selected), /callback scope/);
  assert.throws(() => resolver.factResolver.resolve(file, selected), /callback scope/);
  assert.throws(() => resolver.factResolver.getVirtualDeclarationDocument("/src/index.ts"), /callback scope/);
  assert.throws(() => resolver.diagnostics.append({ extensionId: selected.extensionId,
    extensionCode: "LATE", numericCode: 9999000, category: "error", message: "late" }), /callback scope/);
  assert.throws(() => elaboration.facts.get(file, selected), /callback scope/);
  assert.throws(() => elaboration.factResolver.resolve(file, selected), /callback scope/);
  assert.equal(checked.sourceFacts.getFact(file, selected), 42);
});

test("suspended source elaboration does not carry provisional fact objects into another source epoch", () => {
  const selected = key<{ readonly node: Node }>(value => Object.freeze({ ...value }));
  const prerequisite = key<number>(value => value, selected.extensionId);
  const result = key<number>(value => value, selected.extensionId);
  const observations: { readonly source: ExtensionFactResolverContext["source"]; readonly node: Node }[] = [];
  const compiler = session([{
    identity: { id: selected.extensionId, version: "1" },
    initialize(context) {
      context.registerFactResolver(selected, (subject, resolver) => {
        const file = resolver.source.getSourceFile("/src/index.ts")!;
        assert.equal(subject, file);
        observations.push({ source: resolver.source, node: file });
        return { value: { node: file } };
      });
      context.registerSourceElaborator(prerequisite, () => 21);
      context.registerSourceElaborator(result, resolver => {
        const fact = resolver.factResolver.resolve(resolver.node, selected);
        assert.equal(fact?.node, resolver.node);
        return resolver.require(resolver.node, prerequisite) * 2;
      });
    },
    elaborateSource(context) {
      context.request(context.source.getSourceFile("/src/index.ts")!, result);
    },
  }]);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.equal(checked.sourceFacts.getFact(checked.getSourceFile("/src/index.ts"), result), 42);
  assert.ok(observations.length >= 2);
  assert.notEqual(observations[0]!.node, observations[1]!.node);
  assert.throws(() => observations[0]!.source.getSourceFiles(), /retired compiler program or epoch/);
});
