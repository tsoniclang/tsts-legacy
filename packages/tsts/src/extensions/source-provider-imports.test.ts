import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import { providerVirtualDeclarationFactKey } from "./facts.js";
import type { ProviderDeclarationModel } from "./index.js";
import {
  findNodes,
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";

test("provider modules preserve default, renamed, and namespace import identities", () => {
  const moduleSpecifier = "@test/import-forms.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.ImportForms",
    exports: [{
      id: "DefaultBox",
      name: "DefaultBox",
      exportKind: "default",
      kind: "class",
      members: [{
        id: "DefaultBox::.ctor",
        name: "constructor",
        kind: "constructor",
        signatures: [{
          id: "DefaultBox::.ctor()",
          parameters: [],
        }],
      }],
    }, {
      id: "Box",
      name: "Box",
      kind: "class",
      members: [{
        id: "Box::.ctor",
        name: "constructor",
        kind: "constructor",
        signatures: [{
          id: "Box::.ctor()",
          parameters: [],
        }],
      }],
    }],
  };
  const checked = providerProgram(model, [
    `import DefaultBox, { Box as RenamedBox } from "${moduleSpecifier}";`,
    `import * as Native from "${moduleSpecifier}";`,
    "export const first = new DefaultBox();",
    "export const second = new RenamedBox();",
    "export const third = new Native.Box();",
  ].join("\n"));

  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const constructions = findNodes(sourceFile, source.ast.children, source.ast.is.IsNewExpression);
  assert.equal(constructions.length, 3);
  assert.deepEqual(
    constructions.map((construction) => {
      const selected = source.checker.getResolvedCallInfo(construction);
      return checked.sourceFacts?.getFact(
        selected?.sourceCallee.selectedDeclaration,
        providerVirtualDeclarationFactKey,
      )?.exportId;
    }),
    ["DefaultBox", "Box", "Box"],
  );
});

test("provider default imports retain member identity beside same-named module exports", () => {
  const moduleSpecifier = "@test/default-member-collision.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.DefaultMemberCollision",
    exports: [{
      id: "state",
      name: "state",
      kind: "value",
      type: { kind: "number" },
    }, {
      id: "DefaultModule",
      name: "DefaultModule",
      exportKind: "default",
      kind: "class",
      members: [{
        id: "DefaultModule::state",
        name: "state",
        kind: "property",
        static: true,
        readonly: false,
        type: { kind: "number" },
      }],
    }],
  };

  for (const rootFiles of [
    ["/src/core.d.ts", "/src/named.ts", "/src/default.ts"],
    ["/src/core.d.ts", "/src/default.ts", "/src/named.ts"],
  ]) {
    const checked = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles,
      files: {
        "/src/package.json": JSON.stringify({ type: "module" }),
        "/src/core.d.ts": testCoreDeclarations,
        "/src/named.ts": [
          `import { state } from "${moduleSpecifier}";`,
          "export const namedState = state;",
        ].join("\n"),
        "/src/default.ts": [
          `import DefaultModule from "${moduleSpecifier}";`,
          "DefaultModule.state = 2;",
          "export const defaultState = DefaultModule.state;",
        ].join("\n"),
      },
      compilerOptions: {
        ...testNoLibCompilerOptions,
        target: "es2024",
        module: "nodenext",
        moduleResolution: "nodenext",
        preserveSymlinks: true,
      },
      extensionHostOptions: {
        extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]), {
          packageName: moduleSpecifier,
          packageVersion: "1.0.0",
        })],
      },
    }).checkSource();

    assertNoDiagnostics(checked);
    const sourceFile = checked.getSourceFile("/src/default.ts");
    const source = checked.getSourceFileQueries(sourceFile);
    const accesses = findNodes(sourceFile, source.ast.children, source.ast.is.IsPropertyAccessExpression);
    assert.equal(accesses.length, 2);
    assert.deepEqual(
      accesses.map((access) => {
        const selected = source.checker.getResolvedPropertyAccessInfo(access);
        return checked.sourceFacts?.getFact(
          selected?.selectedWriteDeclaration ?? selected?.selectedReadDeclaration ?? selected?.selectedDeclaration,
          providerVirtualDeclarationFactKey,
        );
      }).map((fact) => ({
        exportId: fact?.exportId,
        memberId: fact?.memberId,
      })),
      [{
        exportId: "DefaultModule",
        memberId: "DefaultModule::state",
      }, {
        exportId: "DefaultModule",
        memberId: "DefaultModule::state",
      }],
    );
  }
});

test("source-global provider references bind the active checked globals without local capture", () => {
  const moduleSpecifier = "@test/source-globals.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.SourceGlobals",
    exports: [{
      id: "Date",
      name: "Date",
      kind: "class",
      members: [{
        id: "Date::providerOnly",
        name: "providerOnly",
        kind: "property",
        readonly: true,
        type: { kind: "string" },
      }],
    }, {
      id: "Promise",
      name: "Promise",
      kind: "class",
      members: [{
        id: "Promise::providerOnly",
        name: "providerOnly",
        kind: "property",
        readonly: true,
        type: { kind: "string" },
      }],
    }, {
      id: "useDate",
      name: "useDate",
      kind: "function",
      signatures: [{
        id: "useDate(Date)",
        parameters: [{
          name: "value",
          type: { kind: "source-global", name: "Date" },
        }],
        returnType: { kind: "source-global", name: "Date" },
      }],
    }, {
      id: "promiseOf",
      name: "promiseOf",
      kind: "function",
      signatures: [{
        id: "promiseOf()",
        parameters: [],
        returnType: {
          kind: "source-global",
          name: "Promise",
          typeArguments: [{ kind: "string" }],
        },
      }],
    }],
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/globals.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/globals.d.ts": [
        "interface Date { readonly time: number; }",
        "interface Promise<T> { readonly value: T; }",
      ].join("\n"),
      "/src/index.ts": [
        `import { Date as ProviderDate, Promise as ProviderPromise, promiseOf, useDate } from "${moduleSpecifier}";`,
        "declare const value: Date;",
        "export const same: number = useDate(value).time;",
        "export const promise: string = promiseOf().value;",
        "export declare const providerValue: ProviderDate;",
        "export declare const providerPromise: ProviderPromise;",
        "export const providerDateMarker: string = providerValue.providerOnly;",
        "export const providerPromiseMarker: string = providerPromise.providerOnly;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))],
    },
  });
  const checked = session.checkSource();

  assertNoDiagnostics(checked);
  const sourceFile = checked.getSourceFile("/src/index.ts");
  const source = checked.getSourceFileQueries(sourceFile);
  const calls = findNodes(sourceFile, source.ast.children, source.ast.is.IsCallExpression);
  assert.deepEqual(
    calls.map((call) =>
      checked.sourceFacts?.getFact(
        source.checker.getSignatureDeclaration(
          source.checker.getResolvedCallInfo(call)?.selectedSignature,
        ),
        providerVirtualDeclarationFactKey,
      )?.signatureId),
    ["useDate(Date)", "promiseOf()"],
  );
});

test("missing source-global declarations fail through ordinary source checking", () => {
  const moduleSpecifier = "@test/missing-global.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.MissingGlobal",
    exports: [{
      id: "missing",
      name: "missing",
      kind: "function",
      signatures: [{
        id: "missing()",
        parameters: [],
        returnType: { kind: "source-global", name: "MissingGlobal" },
      }],
    }],
  };
  const checked = providerProgram(
    model,
    `import { missing } from "${moduleSpecifier}";\nexport const value = missing();`,
  );

  assert.equal(checked.extensionDiagnostics.length, 0);
  assert.ok(
    checked.diagnostics.some((diagnostic) =>
      Diagnostic_String(diagnostic).includes("MissingGlobal")),
    "The ordinary checker must diagnose an unavailable source global.",
  );
});

test("provider source primitives render their exact TypeScript runtime bases", () => {
  const moduleSpecifier = "@test/source-primitives.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.SourcePrimitives",
    exports: [{
      id: "roundTrip",
      name: "roundTrip",
      kind: "function",
      signatures: [{
        id: "roundTrip(int64,uint64,int128,uint128)",
        parameters: [{
          name: "signed64",
          type: { kind: "source-primitive", name: "int64" },
        }, {
          name: "unsigned64",
          type: { kind: "source-primitive", name: "uint64" },
        }, {
          name: "signed",
          type: { kind: "source-primitive", name: "int128" },
        }, {
          name: "unsigned",
          type: { kind: "source-primitive", name: "uint128" },
        }],
        returnType: { kind: "source-primitive", name: "uint128" },
      }],
    }],
  };
  const checked = providerProgram(model, [
    `import { roundTrip } from "${moduleSpecifier}";`,
    "export const value: bigint = roundTrip(1n, 2n, 3n, 4n);",
  ].join("\n"));

  assertNoDiagnostics(checked);
});

function providerProgram(model: ProviderDeclarationModel, source: string) {
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
  }).checkSource();
}

function assertNoDiagnostics(checked: ReturnType<typeof providerProgram>): void {
  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map(Diagnostic_String).join("\n"),
  );
  assert.equal(
    checked.extensionDiagnostics.length,
    0,
    checked.extensionDiagnostics.map((diagnostic) =>
      `${diagnostic.extensionCode}: ${diagnostic.message}`).join("\n"),
  );
}
