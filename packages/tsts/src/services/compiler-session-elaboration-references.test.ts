import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defineExtensionFactKey,
  type CompilerExtension,
  type SourceElaborationNodeReference,
  type SourceProgramQueries,
} from "../index.js";
import { createCompilerSessionFromFiles } from "./compiler-session.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { SourceElaborationCoordinator } from "../extensions/source-elaboration.js";
import { createSourceProgramQueries } from "../extensions/source-program.js";
import { SourceFile_IsBound } from "../internal/ast/ast.js";

let nextOwner = 0;

function session(extensions: readonly CompilerExtension[] = []) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/left.ts", "/src/right.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/left.ts": "export function left<T>(value: T): T { return value; }",
      "/src/right.ts": "export function right<T>(value: T): T { return value; }",
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true },
    extensionHostOptions: { extensions },
  });
}

test("elaboration references preserve same-spelled generic binder identities across files and fresh epochs", () => {
  const extensionId = `test.references.${++nextOwner}`;
  const referencesKey = defineExtensionFactKey<readonly SourceElaborationNodeReference[]>({
    extensionId, name: "binders", snapshot: value => Object.freeze(value.map(reference => Object.freeze({ ...reference }))),
  });
  const verificationKey = defineExtensionFactKey<boolean>({ extensionId, name: "verified", snapshot: value => value });
  let retiredSource: SourceProgramQueries | undefined;
  let analyzedBinders = 0;
  const compiler = session([{
    identity: { id: extensionId, version: "1.0.0" },
    initialize(context) {
      context.registerSourceElaborator(referencesKey, context => {
        retiredSource = context.source;
        return ["/src/left.ts", "/src/right.ts"].map(fileName => {
          const sourceFile = context.source.getSourceFile(fileName)!;
          const parameter = findNodes(sourceFile, context.source.ast.children, context.source.ast.is.IsTypeParameterDeclaration)[0];
          assert.ok(parameter);
          const first = context.reference(parameter);
          assert.deepEqual(context.reference(parameter), first);
          return first;
        });
      });
      context.registerSourceElaborator(verificationKey, context => {
        const references = context.require(context.node, referencesKey);
        const nodes = references.map(reference => context.resolve({ ...reference }));
        assert.notEqual(nodes[0], nodes[1]);
        const symbols = nodes.map(node => {
          const file = context.source.ast.getSourceFile(node)!;
          const query = context.source.getSourceFileQueries(file);
          return query.checker.getSymbolAtLocation(query.ast.name(node));
        });
        assert.ok(symbols[0]);
        assert.ok(symbols[1]);
        assert.notEqual(symbols[0], symbols[1]);
        assert.equal(context.source.ast.getFileName(context.source.ast.getSourceFile(nodes[0])!), "/src/left.ts");
        assert.equal(context.source.ast.getFileName(context.source.ast.getSourceFile(nodes[1])!), "/src/right.ts");
        return true;
      });
    },
    elaborateSource: context => context.request(context.source.getSourceFile("/src/left.ts")!, verificationKey),
    analyzeSource(context) {
      const references = context.facts.get(context.source.getSourceFile("/src/left.ts"), referencesKey);
      assert.ok(references);
      for (const reference of references) {
        const node = context.source.resolveElaborationReference(reference);
        assert.equal(context.source.ast.is.IsTypeParameterDeclaration(node), true);
        analyzedBinders += 1;
      }
    },
  }]);
  const checked = compiler.checkSource();
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(checked.extensionDiagnostics, []);
  assert.equal(checked.sourceFacts.getFact(checked.getSourceFile("/src/left.ts"), verificationKey), true);
  assert.equal(analyzedBinders, 2);
  const references = checked.sourceFacts.getFact(checked.getSourceFile("/src/left.ts"), referencesKey)!;
  for (const [index, fileName] of ["/src/left.ts", "/src/right.ts"].entries()) {
    const expected = findNodes(checked.getSourceFile(fileName)!, checked.ast.children,
      checked.ast.is.IsTypeParameterDeclaration)[0];
    assert.equal(checked.resolveElaborationReference(references[index]!), expected);
    assert.equal(checked.resolveElaborationReference({ ...references[index]! }), expected);
  }
  const retired = retiredSource;
  assert.ok(retired);
  assert.throws(() => retired.resolveElaborationReference(references[0]!), /retired/);
  const filtered = createSourceProgramQueries(compiler.program, {
    includeSourceFile: file => checked.ast.getFileName(file) !== "/src/right.ts",
  });
  assert.equal(filtered.resolveElaborationReference(references[0]!), checked.resolveElaborationReference(references[0]!));
  assert.throws(() => filtered.resolveElaborationReference(references[1]!), /included source file/);
});

test("reference resolution does not introduce elaboration for an ordinary checked program", () => {
  const checked = session().checkSource();
  assert.throws(() => checked.resolveElaborationReference({ session: 1, revision: 0, id: 0 }), /owning elaboration session/);
  assert.deepEqual(checked.diagnostics, []);
});

test("a sealed reference owner remains readable but cannot issue further references", () => {
  const current = round();
  const file = current.source.getSourceFile("/src/left.ts")!;
  const reference = current.value.reference(file);
  current.coordinator.seal(current.value);
  assert.equal(current.value.resolveReference(reference), file);
  assert.throws(() => current.value.reference(file), /sealed/);
});

test("finished reference owners cannot be read after replay retires their epoch", () => {
  const current = round();
  const reference = current.value.reference(current.source.getSourceFile("/src/left.ts")!);
  current.coordinator.finishRound(current.value, true);
  assert.throws(() => current.value.resolveReference(reference), /finished/);
});

for (const field of ["session", "revision", "id"] as const) {
  test(`sealed references still validate their exact ${field}`, () => {
    const current = round();
    const reference = current.value.reference(current.source.getSourceFile("/src/left.ts")!);
    current.coordinator.seal(current.value);
    assert.throws(() => current.value.resolveReference({ ...reference, [field]: reference[field] + 1 }),
      /different session or input revision|not issued/);
    assert.throws(() => current.value.resolveReference(reference), /failed/);
  });
}

function round() {
  const compiler = session();
  compiler.ensureBound();
  const source = createSourceProgramQueries(compiler.program);
  const coordinator = new SourceElaborationCoordinator();
  return { coordinator, source, value: coordinator.beginRound(source) };
}

test("elaboration references reject another session even with identical source and reference ordinals", () => {
  const first = round();
  const second = round();
  const reference = first.value.reference(first.source.getSourceFile("/src/left.ts")!);
  second.value.reference(second.source.getSourceFile("/src/left.ts")!);
  assert.throws(() => second.value.resolveReference(reference), /different session or input revision/);
});

test("accepted elaboration facts resolve into unbound syntax before the new epoch binds", () => {
  const compiler = session();
  compiler.ensureBound();
  const source = createSourceProgramQueries(compiler.program);
  const owner = new SourceElaborationCoordinator();
  const first = owner.beginRound(source);
  const file = source.getSourceFile("/src/left.ts");
  assert.ok(file);
  const parameter = findNodes(file, source.ast.children, source.ast.is.IsTypeParameterDeclaration)[0];
  assert.ok(parameter);
  const factKey = defineExtensionFactKey<number>({ extensionId: "test.unbound.replay", name: "value", snapshot: value => value });
  first.request(parameter, factKey);
  const request = first.ready()[0];
  assert.ok(request);
  first.resolve(request, () => 42);
  owner.finishRound(first, false);

  const fresh = session();
  const freshSource = createSourceProgramQueries(fresh.program);
  const freshFile = freshSource.getSourceFile("/src/left.ts");
  assert.ok(freshFile);
  assert.equal(SourceFile_IsBound(freshFile), false);
  const next = owner.beginRound(freshSource);
  const answer = next.accepted()[0];
  assert.ok(answer);
  assert.equal(answer.value, 42);
  assert.notEqual(answer.node, parameter);
  assert.equal(answer.node, findNodes(freshFile, freshSource.ast.children, freshSource.ast.is.IsTypeParameterDeclaration)[0]);
  assert.equal(SourceFile_IsBound(freshFile), false);
  owner.seal(next);
});

test("provider revision changes invalidate previously issued source references", () => {
  const current = round();
  const reference = current.value.reference(current.source.getSourceFile("/src/left.ts")!);
  current.coordinator.finishRound(current.value, true);
  const next = current.coordinator.beginRound(current.source);
  next.reference(current.source.getSourceFile("/src/left.ts")!);
  assert.throws(() => next.resolveReference(reference), /different session or input revision/);
});

for (const mutation of [
  (reference: SourceElaborationNodeReference) => ({ ...reference, id: 999 }),
  (reference: SourceElaborationNodeReference) => ({ ...reference, id: -1 }),
  (reference: SourceElaborationNodeReference) => ({ ...reference, id: Infinity }),
  (reference: SourceElaborationNodeReference) => ({ ...reference, id: 0.25 }),
  (reference: SourceElaborationNodeReference) => ({ ...reference, unrelated: true }),
]) {
  test("elaboration references reject malformed or unissued identities", () => {
    const current = round();
    const reference = current.value.reference(current.source.getSourceFile("/src/left.ts")!);
    assert.throws(() => current.value.resolveReference(mutation(reference)), /reference/);
  });
}

test("elaboration reference resolution does not execute accessors", () => {
  const current = round();
  const reference = { ...current.value.reference(current.source.getSourceFile("/src/left.ts")!) };
  let reads = 0;
  Object.defineProperty(reference, "id", { get() { reads += 1; return 0; } });
  assert.throws(() => current.value.resolveReference(reference), /invalid identity field/);
  assert.equal(reads, 0);
});
