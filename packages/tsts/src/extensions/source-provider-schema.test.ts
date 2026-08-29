import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  ExtensionHost,
  type ProviderDeclarationModel,
  type ProviderExportDeclaration,
  type ProviderImportDeclaration,
  type ProviderMemberDeclaration,
  type ProviderTypeExpression,
} from "./index.js";
import {
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";
import { getProviderTypeFamilyVariantNominalMemberName } from "./provider-virtual-internal.js";

test("the complete legal provider declaration matrix binds through ordinary source checking", () => {
  const baseSpecifier = "@test/schema-base.js";
  const moduleSpecifier = "@test/schema.js";
  const baseModel: ProviderDeclarationModel = {
    moduleSpecifier: baseSpecifier,
    providerModuleId: "Test.SchemaBase",
    exports: [{ id: "Base", name: "Base", kind: "class" }],
  };
  const derivedReference = (type: ProviderTypeExpression): ProviderTypeExpression => ({
    kind: "provider-ref",
    moduleSpecifier,
    exportName: "Derived",
    typeArguments: [type],
  });
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.Schema",
    imports: [{
      moduleSpecifier: baseSpecifier,
      namedImports: [{ exportedName: "Base", kind: "value" }],
    }],
    exports: [{
      id: "Derived",
      name: "Derived",
      kind: "class",
      typeParameters: [{ name: "T" }],
      heritage: [{
        kind: "extends",
        type: {
          kind: "provider-ref",
          moduleSpecifier: baseSpecifier,
          exportName: "Base",
        },
      }],
      members: [{
        id: "Derived::.ctor",
        name: "constructor",
        kind: "constructor",
        signatures: [{
          id: "Derived::.ctor(T)",
          parameters: [{ name: "value", type: { kind: "type-parameter", name: "T" } }],
        }],
      }, {
        id: "Derived::value",
        name: "value",
        kind: "property",
        readonly: true,
        type: { kind: "type-parameter", name: "T" },
      }, {
        id: "Derived::map",
        name: "map",
        kind: "method",
        signatures: [{
          id: "Derived::map<U>(function)",
          typeParameters: [{ name: "U" }],
          parameters: [{
            name: "convert",
            type: {
              kind: "function",
              id: "Derived::map::convert",
              parameters: [{
                name: "value",
                type: { kind: "type-parameter", name: "T" },
              }],
              returnType: { kind: "type-parameter", name: "U" },
            },
          }],
          returnType: { kind: "type-parameter", name: "U" },
        }],
      }, {
        id: "Derived::index",
        name: "index",
        kind: "indexer",
        readonly: true,
        signatures: [{
          id: "Derived::index(number)",
          parameters: [{ name: "index", type: { kind: "number" } }],
          returnType: { kind: "type-parameter", name: "T" },
        }],
      }, {
        id: "Derived::create",
        name: "create",
        kind: "method",
        static: true,
        signatures: [{
          id: "Derived::create<U>(U)",
          typeParameters: [{ name: "U" }],
          parameters: [{
            name: "value",
            type: { kind: "type-parameter", name: "U" },
          }],
          returnType: derivedReference({ kind: "type-parameter", name: "U" }),
        }],
      }],
    }, {
      id: "ForwardConstraint",
      name: "ForwardConstraint",
      kind: "class",
      typeParameters: [{
        name: "T",
        constraints: [{ kind: "type-parameter", name: "U" }],
      }, {
        name: "U",
      }],
      members: [{
        id: "ForwardConstraint::value",
        name: "value",
        kind: "property",
        readonly: true,
        type: { kind: "type-parameter", name: "T" },
      }],
    }, {
      id: "make",
      name: "make",
      kind: "function",
      signatures: [{
        id: "make<T>(T)",
        typeParameters: [{ name: "T" }],
        parameters: [{
          name: "value",
          type: { kind: "type-parameter", name: "T" },
        }],
        returnType: derivedReference({ kind: "type-parameter", name: "T" }),
      }],
    }, {
      id: "Mode",
      name: "Mode",
      kind: "enum",
      members: [
        { id: "Mode::Read", name: "Read", kind: "property" },
        { id: "Mode::Write", name: "Write", kind: "property" },
      ],
    }, {
      id: "Helpers",
      name: "Helpers",
      kind: "namespace",
      members: [{
        id: "Helpers::parse",
        name: "parse",
        kind: "method",
        signatures: [{
          id: "Helpers::parse(string)",
          parameters: [{ name: "value", type: { kind: "string" } }],
          returnType: { kind: "number" },
        }],
      }],
    }, {
      id: "Pair",
      name: "Pair",
      kind: "type",
      type: {
        kind: "tuple",
        elementTypes: [{ kind: "number" }, { kind: "string" }],
      },
    }, {
      id: "version",
      name: "version",
      kind: "value",
      type: { kind: "string" },
    }],
  };
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import { Derived, ForwardConstraint, Helpers, Mode, make, version } from "${moduleSpecifier}";`,
        `import type { Pair } from "${moduleSpecifier}";`,
        "declare const convert: (value: number) => string;",
        "const direct = new Derived<number>(1);",
        "export const value: number = direct.value;",
        "export const indexed: number = direct[0];",
        "export const mapped: string = direct.map(convert);",
        "export const created: Derived<string> = Derived.create('value');",
        "declare const forward: ForwardConstraint<number, number>;",
        "export const forwardValue: number = forward.value;",
        "export const made: Derived<number> = make(1);",
        "export const parsed: number = Helpers.parse('1');",
        "export const mode: Mode = Mode.Read;",
        "export const pair: Pair = [1, 'one'];",
        "export const currentVersion: string = version;",
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderExtension(new Map([
        [baseSpecifier, baseModel],
        [moduleSpecifier, model],
      ]))],
    },
  });
  const checked = session.checkSource();

  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map(Diagnostic_String).join("\n"),
  );
  assert.deepEqual(checked.extensionDiagnostics, []);
});

test("declaration kinds reject fields that their rendered schema cannot represent", () => {
  const cases: readonly {
    readonly name: string;
    readonly declaration: ProviderExportDeclaration;
  }[] = [{
    name: "class with alias type",
    declaration: {
      id: "Value",
      name: "Value",
      kind: "class",
      type: { kind: "number" },
    },
  }, {
    name: "function with members",
    declaration: {
      id: "Value",
      name: "Value",
      kind: "function",
      signatures: [{ id: "Value()", parameters: [], returnType: { kind: "void" } }],
      members: [{
        id: "Value::item",
        name: "item",
        kind: "property",
        type: { kind: "number" },
      }],
    },
  }, {
    name: "type alias with members",
    declaration: {
      id: "Value",
      name: "Value",
      kind: "type",
      type: { kind: "number" },
      members: [{
        id: "Value::item",
        name: "item",
        kind: "property",
        type: { kind: "number" },
      }],
    },
  }, {
    name: "value with signatures",
    declaration: {
      id: "Value",
      name: "Value",
      kind: "value",
      type: { kind: "number" },
      signatures: [{
        id: "Value()",
        parameters: [],
        returnType: { kind: "void" },
      }],
    },
  }, {
    name: "namespace constructor",
    declaration: {
      id: "Value",
      name: "Value",
      kind: "namespace",
      members: [{
        id: "Value::.ctor",
        name: "constructor",
        kind: "constructor",
        signatures: [{ id: "Value::.ctor()", parameters: [] }],
      }],
    },
  }, {
    name: "readonly enum member",
    declaration: {
      id: "Value",
      name: "Value",
      kind: "enum",
      members: [{ id: "Value::Entry", name: "Entry", kind: "property", readonly: true }],
    },
  }];

  for (const entry of cases) {
    assertInvalidModel(entry.name, [entry.declaration]);
  }
});

test("member kinds reject incomplete and unrendered field combinations", () => {
  const cases: readonly {
    readonly name: string;
    readonly member: ProviderMemberDeclaration;
  }[] = [{
    name: "property without type",
    member: { id: "Value::item", name: "item", kind: "property" },
  }, {
    name: "method without signatures",
    member: { id: "Value::run", name: "run", kind: "method" },
  }, {
    name: "method with direct type",
    member: {
      id: "Value::run",
      name: "run",
      kind: "method",
      type: { kind: "number" },
      signatures: [{ id: "Value::run()", parameters: [], returnType: { kind: "void" } }],
    },
  }, {
    name: "static constructor",
    member: {
      id: "Value::.ctor",
      name: "constructor",
      kind: "constructor",
      static: true,
      signatures: [{ id: "Value::.ctor()", parameters: [] }],
    },
  }, {
    name: "two-parameter indexer",
    member: {
      id: "Value::index",
      name: "index",
      kind: "indexer",
      signatures: [{
        id: "Value::index(number, number)",
        parameters: [
          { name: "left", type: { kind: "number" } },
          { name: "right", type: { kind: "number" } },
        ],
        returnType: { kind: "number" },
      }],
    },
  }];

  for (const entry of cases) {
    assertInvalidModel(entry.name, [{
      id: "Value",
      name: "Value",
      kind: "class",
      members: [entry.member],
    }]);
  }
});

test("provider references require explicit exact import and export bindings", () => {
  const moduleSpecifier = "@test/invalid-model.js";
  const dependencySpecifier = "@test/dependency.js";
  const reference = (
    targetModule: string,
    exportName: string,
    typeArguments?: readonly ProviderTypeExpression[],
  ): ProviderTypeExpression => ({
    kind: "provider-ref",
    moduleSpecifier: targetModule,
    exportName,
    ...(typeArguments === undefined ? {} : { typeArguments }),
  });
  const cases: readonly {
    readonly name: string;
    readonly imports?: readonly ProviderImportDeclaration[];
    readonly exports: readonly ProviderExportDeclaration[];
  }[] = [{
    name: "external reference without import",
    exports: [{
      id: "Value",
      name: "Value",
      kind: "type",
      type: reference(dependencySpecifier, "Missing"),
    }],
  }, {
    name: "external reference with mismatched alias",
    imports: [{
      moduleSpecifier: dependencySpecifier,
      namedImports: [{ exportedName: "Base", localName: "ImportedBase", kind: "type" }],
      typeOnly: true,
    }],
    exports: [{
      id: "Value",
      name: "Value",
      kind: "type",
      type: reference(dependencySpecifier, "Base"),
    }],
  }, {
    name: "same-module reference to missing export",
    exports: [{
      id: "Value",
      name: "Value",
      kind: "type",
      type: reference(moduleSpecifier, "Missing"),
    }],
  }, {
    name: "same-module reference to value-only export",
    exports: [{
      id: "RuntimeValue",
      name: "RuntimeValue",
      kind: "value",
      type: { kind: "number" },
    }, {
      id: "Value",
      name: "Value",
      kind: "type",
      type: reference(moduleSpecifier, "RuntimeValue"),
    }],
  }, {
    name: "same-module family reference with wrong arity",
    exports: [{
      id: "Task_1",
      name: "Task_1",
      kind: "class",
      sourceTypeFamily: { exportName: "Task", typeArgumentCount: 1 },
      typeParameters: [{ name: "T" }],
    }, {
      id: "Value",
      name: "Value",
      kind: "type",
      type: reference(moduleSpecifier, "Task", []),
    }],
  }, {
    name: "type-only external class heritage",
    imports: [{
      moduleSpecifier: dependencySpecifier,
      namedImports: [{ exportedName: "Base", kind: "type" }],
      typeOnly: true,
    }],
    exports: [{
      id: "Value",
      name: "Value",
      kind: "class",
      heritage: [{
        kind: "extends",
        type: reference(dependencySpecifier, "Base"),
      }],
    }],
  }];

  for (const entry of cases) {
    assertInvalidModel(entry.name, entry.exports, entry.imports);
  }
});

test("type parameters and parameter modes fail closed outside their exact scope", () => {
  assertInvalidModel("unbound type parameter", [{
    id: "Value",
    name: "Value",
    kind: "type",
    type: { kind: "type-parameter", name: "T" },
  }]);
  assertInvalidModel("static member using class type parameter", [{
    id: "Value",
    name: "Value",
    kind: "class",
    typeParameters: [{ name: "T" }],
    members: [{
      id: "Value::current",
      name: "current",
      kind: "property",
      static: true,
      type: { kind: "type-parameter", name: "T" },
    }],
  }]);
  assertInvalidModel("duplicate type parameters", [{
    id: "Value",
    name: "Value",
    kind: "type",
    typeParameters: [{ name: "T" }, { name: "T" }],
    type: { kind: "type-parameter", name: "T" },
  }]);
  assertInvalidModel("required type parameter after default", [{
    id: "Value",
    name: "Value",
    kind: "type",
    typeParameters: [
      { name: "T", defaultType: { kind: "number" } },
      { name: "U" },
    ],
    type: { kind: "type-parameter", name: "U" },
  }]);

  const parameter = { name: "value", type: { kind: "number" } } as const;
  Reflect.set(parameter, "passingMode", "invented-mode");
  assertInvalidModel("invalid parameter passing mode", [{
    id: "use",
    name: "use",
    kind: "function",
    signatures: [{
      id: "use(number)",
      parameters: [parameter],
      returnType: { kind: "void" },
    }],
  }]);

  const functionType: ProviderTypeExpression = {
    kind: "function",
    id: "callback",
    parameters: [],
    returnType: { kind: "void" },
  };
  Reflect.deleteProperty(functionType, "id");
  assertInvalidModel("function type without semantic id", [{
    id: "Callback",
    name: "Callback",
    kind: "type",
    type: functionType,
  }]);
});

test("provider type-family nominal member identity is reserved by the host", () => {
  const moduleSpecifier = "@test/invalid-model.js";
  const declaration: ProviderExportDeclaration = {
    id: "Family",
    name: "Family",
    kind: "class",
    sourceTypeFamily: { exportName: "Family", typeArgumentCount: 0 },
  };
  const nominalMemberName = getProviderTypeFamilyVariantNominalMemberName(
    moduleSpecifier,
    declaration,
  );
  assertInvalidModel("host-owned type-family member collision", [{
    ...declaration,
    members: [{
      id: "Family::collision",
      name: nominalMemberName,
      kind: "property",
      type: { kind: "never" },
    }],
  }]);
});

function assertInvalidModel(
  name: string,
  exports: readonly ProviderExportDeclaration[],
  imports?: readonly ProviderImportDeclaration[],
): void {
  const moduleSpecifier = "@test/invalid-model.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier,
    providerModuleId: "Test.InvalidModel",
    ...(imports === undefined ? {} : { imports }),
    exports,
  };
  const host = new ExtensionHost({}, {
    extensions: [sourceProviderExtension(new Map([[moduleSpecifier, model]]))],
  });
  const result = host.providers.resolveVirtualModule(moduleSpecifier);

  assert.equal(result.kind, "rejected", name);
  assert.equal(
    result.kind === "rejected" ? result.diagnostic.extensionCode : "",
    "INVALID_PROVIDER_DECLARATION_MODEL",
    name,
  );
  assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), [], name);
}
