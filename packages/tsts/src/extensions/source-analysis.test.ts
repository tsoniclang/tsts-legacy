import { requireApplicableCallInfo } from "../services/type-checker-test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoPtr } from "../go/compat.js";
import type { Node } from "../internal/ast/ast.js";
import {
  createCompilerSessionFromFiles,
  defineExtensionFactKey,
  type CompilerExtension,
  type SourceAnalysisContext,
} from "../index.js";
import { getExtensionHost } from "./host.js";

const sourceAnalysisExtensionId = "test.source-analysis";
const selectedCallFactKey = defineExtensionFactKey<string>({
  extensionId: sourceAnalysisExtensionId,
  name: "selectedCall",
  snapshot: (value) => value,
});

test("source analysis consumes the fully checked program once through direct source queries", () => {
  let analysisCount = 0;
  let selectedCall: GoPtr<Node>;
  let analyzedSource: SourceAnalysisContext["source"] | undefined;
  const extension: CompilerExtension = {
    identity: {
      id: sourceAnalysisExtensionId,
      version: "1.0.0",
    },
    analyzeSource(context): void {
      analysisCount += 1;
      analyzedSource = context.source;
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.source), true);
      const sourceFile = context.source.getSourceFile("/src/index.ts");
      const source = context.source.getSourceFileQueries(sourceFile);
      const call = findFirstCall(source.ast, sourceFile);
      assert.ok(call !== undefined);
      const selected = requireApplicableCallInfo(source.checker.getResolvedCallInfo(call));
      assert.equal(selected?.kind, "applicable");
      assert.ok(selected?.call === call, "Source analysis must retain the exact checked call node.");
      assert.equal(selected?.selection.application.signatureTypeArguments?.length, 1);
      assert.equal(context.facts.set(call, selectedCallFactKey, "identity<number>"), "inserted");
      selectedCall = call;
    },
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/index.ts"],
    files: {
      "/src/index.ts": [
        "function identity<T>(value: T): T { return value; }",
        "const result = identity<number>(1);",
      ].join("\n"),
    },
    extensionHostOptions: { extensions: [extension] },
  });

  assert.equal(session.ensureChecked().length, 0);
  assert.equal(analysisCount, 0);
  const checked = session.checkSource();
  assert.equal(analysisCount, 1);
  assert.ok(analyzedSource?.ast === checked.ast);
  const analyzedSourceFile = analyzedSource?.getSourceFile("/src/index.ts");
  assert.ok(
    analyzedSource?.getSourceFileQueries(analyzedSourceFile)
      === checked.getSourceFileQueries(checked.getSourceFile("/src/index.ts")),
  );
  assert.equal(checked.sourceFacts?.getFact(selectedCall, selectedCallFactKey), "identity<number>");
  assert.ok(session.checkSource() === checked, "Source checking must retain one exact checked program.");
  assert.equal(analysisCount, 1);
});

test("source analysis is dependency ordered and globally fail closed", () => {
  const firstExtensionId = "test.source-analysis.first";
  const secondExtensionId = "test.source-analysis.second";
  const firstFactKey = defineExtensionFactKey<string>({
    extensionId: firstExtensionId,
    name: "first",
    snapshot: (value) => value,
  });
  const order: string[] = [];
  let subject: GoPtr<Node>;
  const first: CompilerExtension = {
    identity: {
      id: firstExtensionId,
      version: "1.0.0",
    },
    analyzeSource(context): void {
      order.push("first");
      subject = context.source.getSourceFile("/src/index.ts");
      assert.ok(subject !== undefined);
      assert.equal(context.facts.set(subject, firstFactKey, "provisional"), "inserted");
    },
  };
  const second: CompilerExtension = {
    identity: {
      id: secondExtensionId,
      version: "1.0.0",
    },
    dependencies: { dependsOn: [firstExtensionId] },
    analyzeSource(): void {
      order.push("second");
      throw new Error("source analysis failed");
    },
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/index.ts"],
    files: { "/src/index.ts": "export const value = 1;" },
    extensionHostOptions: { extensions: [second, first] },
  });

  assert.throws(() => session.checkSource(), /source analysis failed/);
  assert.deepEqual(order, ["first", "second"]);
  const host = getExtensionHost(session.program!);
  assert.ok(host !== undefined);
  assert.equal(host.facts.get(subject, firstFactKey), undefined);
  assert.equal(
    host.diagnostics.all().filter((diagnostic) =>
      diagnostic.extensionCode === "SOURCE_ANALYSIS_FAILED").length,
    1,
  );
  assert.throws(() => session.checkSource(), /previously failed/);
});

test("independent source analyzers produce one deterministic fact manifest under registration permutation", () => {
  const extensionIds = [
    "test.source-analysis.alpha",
    "test.source-analysis.zeta",
  ] as const;
  const factKeys = extensionIds.map((extensionId) =>
    defineExtensionFactKey<string>({
      extensionId,
      name: "value",
      snapshot: (value) => value,
    }));

  const run = (reverse: boolean) => {
    const analysisOrder: string[] = [];
    const extensions = extensionIds.map((extensionId, index): CompilerExtension => ({
      identity: {
        id: extensionId,
        version: "1.0.0",
      },
      analyzeSource(context): void {
        analysisOrder.push(extensionId);
        const sourceFile = context.source.getSourceFile("/src/index.ts");
        assert.ok(sourceFile !== undefined);
        assert.equal(
          context.facts.set(sourceFile, factKeys[index]!, extensionId),
          "inserted",
        );
      },
    }));
    const session = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/index.ts"],
      files: { "/src/index.ts": "export const value = 1;" },
      extensionHostOptions: {
        extensions: reverse ? [...extensions].reverse() : extensions,
      },
    });
    const checked = session.checkSource();
    const sourceFile = checked.getSourceFile("/src/index.ts");
    assert.ok(sourceFile !== undefined);
    return {
      analysisOrder,
      diagnostics: checked.extensionDiagnostics.map((diagnostic) => [
        diagnostic.extensionId,
        diagnostic.extensionCode,
        diagnostic.numericCode,
        diagnostic.message,
      ]),
      facts: checked.sourceFacts?.getFacts(sourceFile).map((entry) => [
        entry.key.id,
        entry.value,
        entry.evidence,
      ]),
    };
  };

  const forward = run(false);
  const reverse = run(true);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.analysisOrder, [...extensionIds]);
  assert.deepEqual(forward.diagnostics, []);
  assert.deepEqual(
    forward.facts?.map(([keyId, value]) => [keyId, value]),
    extensionIds.map((extensionId, index) => [factKeys[index]!.id, extensionId]),
  );
});

test("source analyzer ordering does not grant undeclared fact-read authority", () => {
  const producerId = "test.source-analysis.producer";
  const consumerId = "test.source-analysis.consumer";
  const producerFactKey = defineExtensionFactKey<string>({
    extensionId: producerId,
    name: "value",
    snapshot: (value) => value,
  });
  let subject: GoPtr<Node>;
  const producer: CompilerExtension = {
    identity: {
      id: producerId,
      version: "1.0.0",
    },
    analyzeSource(context): void {
      subject = context.source.getSourceFile("/src/index.ts");
      assert.ok(subject !== undefined);
      assert.equal(context.facts.set(subject, producerFactKey, "producer"), "inserted");
    },
  };
  const consumer: CompilerExtension = {
    identity: {
      id: consumerId,
      version: "1.0.0",
    },
    dependencies: { runsAfter: [producerId] },
    analyzeSource(context): void {
      context.facts.get(subject, producerFactKey);
    },
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/index.ts"],
    files: { "/src/index.ts": "export const value = 1;" },
    extensionHostOptions: { extensions: [consumer, producer] },
  });

  assert.throws(
    () => session.checkSource(),
    /facts from explicitly declared source dependencies/,
  );
  assert.equal(getExtensionHost(session.program!)?.facts.get(subject, producerFactKey), undefined);
});

function findFirstCall(ast: SourceAnalysisContext["source"]["ast"], root: GoPtr<Node>): GoPtr<Node> {
  if (root === undefined) {
    return undefined;
  }
  if (ast.is.IsCallExpression(root)) {
    return root;
  }
  for (const child of ast.children(root)) {
    const found = findFirstCall(ast, child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
