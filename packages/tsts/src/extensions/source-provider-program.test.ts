import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic_Code, Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  argumentPassingFactKey,
  createCompilerSessionFromFiles,
  providerTypeFamilyFactKey,
  providerVirtualDeclarationFactKey,
  type ProviderDeclarationModel,
  type ProviderModuleContext,
} from "../index.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";

test("source provider declarations bind through normal checking and retain exact provider identities", () => {
  const moduleSpecifier = "@test/native/counter.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Counter",
    exports: [{
      id: "Counter",
      name: "Counter",
      kind: "class",
      members: [{
        id: "Counter::.ctor",
        name: "constructor",
        kind: "constructor",
        signatures: [{
          id: "Counter::.ctor()",
          parameters: [],
        }],
      }, {
        id: "Counter::increment",
        name: "increment",
        kind: "method",
        signatures: [{
          id: "Counter::increment()",
          parameters: [],
          returnType: { kind: "number" },
        }],
      }, {
        id: "Counter::value",
        name: "value",
        kind: "property",
        readonly: true,
        type: { kind: "number" },
      }],
    }],
  };
  const session = providerSession(model, [
    `import { Counter } from "${moduleSpecifier}";`,
    "const counter = new Counter();",
    "const next = counter.increment();",
    "export const value = counter.value + next;",
  ].join("\n"));

  const checked = session.checkSource();
  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const calls = findNodes(sourceFile, checked.ast.children, checked.ast.is.IsCallExpression);
  const properties = findNodes(sourceFile, checked.ast.children, checked.ast.is.IsPropertyAccessExpression);
  assert.equal(calls.length, 1);
  assert.equal(properties.length, 2);

  const call = source.checker.getResolvedCallInfo(calls[0]);
  assert.equal(call?.outcome, "applicable");
  assert.equal(call?.sourceCalleeAccess?.kind, "property");
  assert.equal(
    checked.sourceFacts?.getFact(call?.sourceCalleeAccess?.selectedDeclaration, providerVirtualDeclarationFactKey)?.memberId,
    "Counter::increment",
  );
  assert.equal(
    checked.sourceFacts?.getFact(
      source.checker.getSignatureDeclaration(call?.selectedSignature),
      providerVirtualDeclarationFactKey,
    )?.signatureId,
    "Counter::increment()",
  );

  const valueProperty = properties
    .map((property) => source.checker.getResolvedPropertyAccessInfo(property))
    .find((info) =>
      checked.sourceFacts?.getFact(info?.selectedDeclaration, providerVirtualDeclarationFactKey)?.memberId
      === "Counter::value");
  assert.ok(valueProperty !== undefined);
  assert.equal(source.checker.typeToString(valueProperty.sourceReadType), "number");
  const declarationIdentity = checked.sourceFacts?.getFact(
    valueProperty.selectedDeclaration,
    providerVirtualDeclarationFactKey,
  );
  const symbolIdentity = checked.sourceFacts?.getFact(
    valueProperty.selectedSymbol,
    providerVirtualDeclarationFactKey,
  );
  assert.deepEqual(
    [
      declarationIdentity?.providerModuleId,
      declarationIdentity?.exportId,
      declarationIdentity?.memberId,
      declarationIdentity?.memberStatic,
    ],
    ["Test.Native.Counter", "Counter", "Counter::value", false],
  );
  assert.deepEqual(
    [
      symbolIdentity?.providerModuleId,
      symbolIdentity?.exportId,
      symbolIdentity?.memberId,
      symbolIdentity?.memberStatic,
    ],
    ["Test.Native.Counter", "Counter", "Counter::value", false],
  );
});

test("source provider facts distinguish same-spelling static and instance members", () => {
  const moduleSpecifier = "@test/native/dual.js";
  const method = (id: string, staticMember: boolean) => ({
    id,
    name: "equals",
    kind: "method" as const,
    static: staticMember,
    signatures: [{
      id: `${id}()`,
      parameters: [],
      returnType: { kind: "boolean" as const },
    }],
  });
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Dual",
    exports: [{
      id: "Dual",
      name: "Dual",
      kind: "class",
      members: [
        {
          id: "Dual::.ctor",
          name: "constructor",
          kind: "constructor",
          signatures: [{ id: "Dual::.ctor()", parameters: [] }],
        },
        method("Dual::equals#static", true),
        method("Dual::equals#instance", false),
      ],
    }],
  };
  const session = providerSession(model, [
    `import { Dual } from "${moduleSpecifier}";`,
    "const item = new Dual();",
    "export const pair = [Dual.equals(), item.equals()];",
  ].join("\n"));

  const checked = session.checkSource();
  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const calls = findNodes(
    sourceFile,
    checked.ast.children,
    checked.ast.is.IsCallExpression,
  ).map((node) => source.checker.getResolvedCallInfo(node));
  assert.equal(calls.length, 2);
  const facts = calls.map((call) =>
    checked.sourceFacts?.getFact(call?.sourceCalleeAccess?.selectedDeclaration, providerVirtualDeclarationFactKey));
  assert.deepEqual(
    facts.map((fact) => [fact?.memberId, fact?.memberStatic]),
    [
      ["Dual::equals#static", true],
      ["Dual::equals#instance", false],
    ],
  );
});

test("source type families preserve arity variants and member separation", () => {
  const moduleSpecifier = "@test/native/task.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Task",
    exports: [{
      id: "Task",
      name: "Task",
      kind: "class",
      sourceTypeFamily: { exportName: "Task", typeArgumentCount: 0 },
      members: [],
    }, {
      id: "Task<TResult>",
      name: "Task",
      kind: "class",
      sourceTypeFamily: { exportName: "Task", typeArgumentCount: 1 },
      typeParameters: [{ name: "TResult" }],
      members: [{
        id: "Task<TResult>::result",
        name: "result",
        kind: "property",
        readonly: true,
        type: { kind: "type-parameter", name: "TResult" },
      }],
    }],
  };
  const valid = providerSession(model, [
    `import type { Task } from "${moduleSpecifier}";`,
    "declare const plain: Task;",
    "declare const generic: Task<string>;",
    "export const result = generic.result;",
  ].join("\n")).checkSource();
  assertNoDiagnostics(valid);
  const validSourceFile = valid.getSourceFile("/src/index.ts");
  const validSource = valid.getSourceFileQueries(validSourceFile);

  const imports = findNodes(
    validSourceFile,
    valid.ast.children,
    valid.ast.is.IsImportSpecifier,
  );
  const taskSymbol = validSource.checker.getAliasedSymbol(
    validSource.checker.getSymbolAtLocation(valid.ast.name(imports[0])),
  );
  const family = valid.sourceFacts?.getFact(taskSymbol, providerTypeFamilyFactKey);
  assert.deepEqual(family?.variants.map((variant) => variant.sourceTypeArgumentCount), [0, 1]);
  assert.deepEqual(
    family?.variants.map((variant) => variant.declaration.exportId),
    ["Task", "Task<TResult>"],
  );

  const invalid = providerSession(model, [
    `import type { Task } from "${moduleSpecifier}";`,
    "declare const plain: Task;",
    "export const result = plain.result;",
  ].join("\n")).checkSource();
  assert.equal(invalid.diagnostics.some((diagnostic) => Diagnostic_Code(diagnostic) === 2339), true);
});

test("source type family arities remain nominally distinct during overload selection", () => {
  const moduleSpecifier = "@test/native/builder.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Builder",
    exports: [{
      id: "Builder",
      name: "Builder",
      kind: "class",
      sourceTypeFamily: { exportName: "Builder", typeArgumentCount: 0 },
      members: [],
    }, {
      id: "Builder<TContext>",
      name: "Builder",
      kind: "class",
      sourceTypeFamily: { exportName: "Builder", typeArgumentCount: 1 },
      typeParameters: [{ name: "TContext" }],
      heritage: [{
        kind: "extends",
        type: { kind: "provider-ref", moduleSpecifier, exportName: "Builder" },
      }],
      members: [],
    }, {
      id: "configure",
      name: "configure",
      kind: "function",
      signatures: [{
        id: "configure<TContext>(Builder<TContext>)",
        typeParameters: [{ name: "TContext" }],
        parameters: [{
          name: "builder",
          type: {
            kind: "provider-ref",
            moduleSpecifier,
            exportName: "Builder",
            typeArguments: [{ kind: "type-parameter", name: "TContext" }],
          },
        }],
        returnType: { kind: "literal", value: "generic" },
      }, {
        id: "configure(Builder)",
        parameters: [{
          name: "builder",
          type: { kind: "provider-ref", moduleSpecifier, exportName: "Builder" },
        }],
        returnType: { kind: "literal", value: "plain" },
      }],
    }],
  };
  const checked = providerSession(model, [
    `import { configure, type Builder } from "${moduleSpecifier}";`,
    "declare const plain: Builder;",
    "declare const generic: Builder<string>;",
    "export const selectedPlain: \"plain\" = configure(plain);",
    "export const selectedGeneric: \"generic\" = configure(generic);",
    "export const genericAsPlain: Builder = generic;",
  ].join("\n")).checkSource();

  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const calls = findNodes(
    sourceFile,
    checked.ast.children,
    checked.ast.is.IsCallExpression,
  );
  assert.deepEqual(
    calls.map((call) => {
      const callInfo = source.checker.getResolvedCallInfo(call);
      assert.equal(callInfo?.outcome, "applicable");
      return checked.sourceFacts?.getFact(
        source.checker.getSignatureDeclaration(callInfo.selectedSignature),
        providerVirtualDeclarationFactKey,
      )?.signatureId;
    }),
    [
      "configure(Builder)",
      "configure<TContext>(Builder<TContext>)",
    ],
  );

  const invalid = providerSession(model, [
    `import type { Builder } from "${moduleSpecifier}";`,
    "declare const plain: Builder;",
    "export const invalid: Builder<string> = plain;",
  ].join("\n")).checkSource();
  assert.equal(
    invalid.diagnostics.some((diagnostic) => Diagnostic_Code(diagnostic) === 2741),
    true,
    invalid.diagnostics.map((diagnostic) => Diagnostic_String(diagnostic)).join("\n"),
  );
});

test("provider index signatures expose exact declaration evidence without fabricated symbols", () => {
  const moduleSpecifier = "@test/native/dictionary.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Dictionary",
    exports: [{
      id: "Dictionary",
      name: "Dictionary",
      kind: "interface",
      members: [{
        id: "Dictionary::index",
        name: "index",
        kind: "indexer",
        readonly: true,
        signatures: [{
          id: "Dictionary::index(string)",
          parameters: [{ name: "key", type: { kind: "string" } }],
          returnType: { kind: "number" },
        }],
      }],
    }],
  };
  const checked = providerSession(model, [
    `import type { Dictionary } from "${moduleSpecifier}";`,
    "declare const values: Dictionary;",
    "export const value = values['key'];",
  ].join("\n")).checkSource();

  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const element = findNodes(
    sourceFile,
    checked.ast.children,
    checked.ast.is.IsElementAccessExpression,
  )[0];
  const info = source.checker.getResolvedElementAccessInfo(element);
  assert.equal(info?.selectedSymbol === undefined, true);
  assert.ok(info?.selectedDeclaration !== undefined);
  assert.equal(
    checked.sourceFacts?.getFact(info?.selectedDeclaration, providerVirtualDeclarationFactKey)?.memberId,
    "Dictionary::index",
  );

  const invalidWrite = providerSession(model, [
    `import type { Dictionary } from "${moduleSpecifier}";`,
    "declare const values: Dictionary;",
    "values['key'] = 1;",
  ].join("\n")).checkSource();
  assert.deepEqual(
    invalidWrite.diagnostics.map((diagnostic) => Diagnostic_Code(diagnostic)),
    [2542],
  );
  assert.deepEqual(invalidWrite.extensionDiagnostics, []);
});

test("provider import slices compose one public export identity independent of dependency order", () => {
  const ioSpecifier = "@test/native/io.js";
  const consumerSpecifier = "@test/native/consumer.js";
  const ioModel: ProviderDeclarationModel = {
    moduleSpecifier: ioSpecifier,
    providerModuleId: "Test.Native.IO",
    exports: ["Stream", "Reader", "Writer"].map((name) => ({
      id: name,
      name,
      kind: "class" as const,
    })),
  };
  const consumerModel: ProviderDeclarationModel = {
    moduleSpecifier: consumerSpecifier,
    providerModuleId: "Test.Native.Consumer",
    imports: [{
      moduleSpecifier: ioSpecifier,
      namedImports: [{ exportedName: "Stream", kind: "type" }],
      typeOnly: true,
    }],
    exports: [{
      id: "Consumer",
      name: "Consumer",
      kind: "class",
      members: [{
        id: "Consumer::stream",
        name: "stream",
        kind: "property",
        readonly: true,
        type: { kind: "provider-ref", moduleSpecifier: ioSpecifier, exportName: "Stream" },
      }],
    }],
  };
  const contexts: ProviderModuleContext[] = [];
  const extension = sourceProviderExtension(
    new Map([
      [ioSpecifier, ioModel],
      [consumerSpecifier, consumerModel],
    ]),
    { onContext: (_specifier, context) => void contexts.push(context) },
  );
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import type { Consumer } from "${consumerSpecifier}";`,
        `import type { Reader, Writer } from "${ioSpecifier}";`,
        "declare const consumer: Consumer;",
        "declare const reader: Reader;",
        "declare const writer: Writer;",
        "export const values = [consumer.stream, reader, writer];",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: { extensions: [extension] },
  });

  const checked = session.checkSource();
  assertNoDiagnostics(checked);
  assert.equal(contexts.some((context) =>
    context.importSlice?.requestedExports?.some((item) => item.exportedName === "Stream")), true);
  assert.equal(contexts.some((context) =>
    context.importSlice?.requestedExports?.some((item) => item.exportedName === "Reader")), true);
  const imports = findNodes(
    checked.getSourceFile("/src/index.ts"),
    checked.ast.children,
    checked.ast.is.IsImportSpecifier,
  );
  const source = checked.getSourceFileQueries(checked.getSourceFile("/src/index.ts"));
  const providerIdentities = imports.map((specifier) => {
    const alias = source.checker.getSymbolAtLocation(checked.ast.name(specifier));
    const symbol = source.checker.getAliasedSymbol(alias);
    return checked.sourceFacts?.getFact(symbol, providerVirtualDeclarationFactKey)?.exportId;
  });
  assert.deepEqual(providerIdentities, ["Consumer", "Reader", "Writer"]);
});

test("provider parameter modes remain declaration facts keyed by exact signature parameter", () => {
  const moduleSpecifier = "@test/native/ref.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Ref",
    exports: [{
      id: "update",
      name: "update",
      kind: "function",
      signatures: [{
        id: "update(ref number)",
        parameters: [{ name: "value", type: { kind: "number" }, passingMode: "byref-readwrite" }],
        returnType: { kind: "void" },
      }],
    }],
  };
  const checked = providerSession(model, [
    `import { update } from "${moduleSpecifier}";`,
    "let value = 1;",
    "update(value);",
  ].join("\n")).checkSource();

  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const callNode = findNodes(
    sourceFile,
    checked.ast.children,
    checked.ast.is.IsCallExpression,
  )[0];
  const call = source.checker.getResolvedCallInfo(callNode);
  const parameter = call?.sourceSelectedSignatureParameters[0];
  assert.equal(parameter?.parameterName, "value");
  assert.equal(
    checked.sourceFacts?.getFact(parameter?.parameterDeclaration, argumentPassingFactKey)?.mode,
    "byref-readwrite",
  );
});

test("source-file queries retain checker ownership for instantiated provider signature parameters", () => {
  const moduleSpecifier = "@test/native/sequence.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Native.Sequence",
    exports: [{
      id: "Sequence<T>",
      name: "Sequence",
      kind: "class",
      typeParameters: [{ name: "T" }],
      members: [{
        id: "Sequence<T>::push",
        name: "push",
        kind: "method",
        signatures: [{
          id: "Sequence<T>::push(T[])",
          parameters: [{
            name: "items",
            rest: true,
            type: {
              kind: "array",
              elementType: { kind: "type-parameter", name: "T" },
            },
          }],
          returnType: { kind: "number" },
        }],
      }],
    }],
  };
  const checked = providerSession(model, [
    `import type { Sequence } from "${moduleSpecifier}";`,
    "declare const values: Sequence<number>;",
    "values.push(1);",
  ].join("\n")).checkSource();

  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const call = findNodes(
    sourceFile,
    checked.ast.children,
    checked.ast.is.IsCallExpression,
  )[0];
  const calleeType = source.checker.getResolvedCallInfo(call)?.sourceCallee.type;
  const signature = source.checker.getCallSignaturesOfType(calleeType)[0];
  const parameter = source.checker.getSignatureParameters(signature)[0];

  assert.equal(source.checker.typeToString(source.checker.getTypeOfSymbol(parameter)), "number[]");
  assert.equal(source.checker.typeToString(source.checker.getReturnTypeOfSignature(signature)), "number");
});

function providerSession(model: ProviderDeclarationModel, source: string) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": source,
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderExtension(new Map([[model.moduleSpecifier, model]]))],
    },
  });
}

function assertNoDiagnostics(checked: ReturnType<ReturnType<typeof providerSession>["checkSource"]>): void {
  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map((diagnostic) => Diagnostic_String(diagnostic)).join("\n"),
  );
  assert.deepEqual(checked.extensionDiagnostics, []);
}
