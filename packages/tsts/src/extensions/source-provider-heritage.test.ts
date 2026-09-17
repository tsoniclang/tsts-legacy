import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import { Diagnostic_String } from "../internal/ast/diagnostic.js";
import {
  ExtensionHost,
  type ProviderDeclarationModel,
  type ProviderExportDeclaration,
} from "./index.js";
import {
  sourceProviderExtension,
  testCoreDeclarations,
  testNoLibCompilerOptions,
} from "./source-provider-test-support.js";

test("ordinary provider class heritage accepts exact defaulted type arguments", () => {
  const baseSpecifier = "@test/heritage/base.js";
  const derivedSpecifier = "@test/heritage/derived.js";
  const models = new Map<string, ProviderDeclarationModel>([
    [baseSpecifier, {
      moduleSpecifier: baseSpecifier,
      providerModuleId: "Test.Heritage.Base",
      exports: [{
        id: "Base",
        name: "Base",
        kind: "class",
        typeParameters: [{ name: "T", defaultType: { kind: "number" } }],
      }],
    }],
    [derivedSpecifier, {
      moduleSpecifier: derivedSpecifier,
      providerModuleId: "Test.Heritage.Derived",
      imports: [valueImport(baseSpecifier, "Base")],
      exports: [{
        id: "Derived",
        name: "Derived",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(baseSpecifier, "Base"),
        }],
      }],
    }],
  ]);

  assertProgramAccepts(
    models,
    derivedSpecifier,
    ["Derived"],
    ["export class UseDerived extends Derived {}"],
  );
});

test("provider family heritage selects the exact class-backed arity variant", () => {
  const baseSpecifier = "@test/family/base.js";
  const derivedSpecifier = "@test/family/derived.js";
  const baseVariants: ProviderExportDeclaration[] = [{
    id: "AccessRule",
    name: "AccessRule",
    kind: "class",
    sourceTypeFamily: { exportName: "AccessRule", typeArgumentCount: 0 },
  }, {
    id: "AccessRule_1",
    name: "AccessRule_1",
    kind: "class",
    sourceTypeFamily: { exportName: "AccessRule", typeArgumentCount: 1 },
    typeParameters: [{ name: "T" }],
  }];
  const models = new Map<string, ProviderDeclarationModel>([
    [baseSpecifier, {
      moduleSpecifier: baseSpecifier,
      providerModuleId: "Test.Family.Base",
      exports: baseVariants,
    }],
    [derivedSpecifier, {
      moduleSpecifier: derivedSpecifier,
      providerModuleId: "Test.Family.Derived",
      imports: [valueImport(baseSpecifier, "AccessRule")],
      exports: [{
        id: "ConcreteRule",
        name: "ConcreteRule",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(baseSpecifier, "AccessRule"),
        }],
      }, {
        id: "GenericRule",
        name: "GenericRule",
        kind: "class",
        typeParameters: [{ name: "T" }],
        heritage: [{
          kind: "extends",
          type: providerRef(baseSpecifier, "AccessRule", [{
            kind: "type-parameter",
            name: "T",
          }]),
        }],
      }],
    }],
  ]);

  assertProgramAccepts(
    models,
    derivedSpecifier,
    ["ConcreteRule", "GenericRule"],
    [
      "export class UseConcreteRule extends ConcreteRule {}",
      "export class UseGenericRule<T> extends GenericRule<T> {}",
    ],
  );
});

test("same-arity provider families retain distinct nominal identity across class heritage", () => {
  const baseSpecifier = "@test/family-nominal/base.js";
  const derivedSpecifier = "@test/family-nominal/derived.js";
  const models = new Map<string, ProviderDeclarationModel>([
    [baseSpecifier, {
      moduleSpecifier: baseSpecifier,
      providerModuleId: "Test.FamilyNominal.Base",
      exports: [{
        id: "Base",
        name: "Base",
        kind: "class",
        sourceTypeFamily: { exportName: "Base", typeArgumentCount: 0 },
      }],
    }],
    [derivedSpecifier, {
      moduleSpecifier: derivedSpecifier,
      providerModuleId: "Test.FamilyNominal.Derived",
      imports: [valueImport(baseSpecifier, "Base")],
      exports: [{
        id: "Derived",
        name: "Derived",
        kind: "class",
        sourceTypeFamily: { exportName: "Derived", typeArgumentCount: 0 },
        heritage: [{
          kind: "extends",
          type: providerRef(baseSpecifier, "Base"),
        }],
      }],
    }],
  ]);

  assertProgramAccepts(
    models,
    derivedSpecifier,
    ["Derived"],
    ["export class UseDerived extends Derived {}"],
  );
});

test("recursive provider module closure accepts a shared DAG without inventing a heritage cycle", () => {
  const objectSpecifier = "@test/recursive/object.js";
  const memberSpecifier = "@test/recursive/member.js";
  const typeSpecifier = "@test/recursive/type.js";
  const typeInfoSpecifier = "@test/recursive/type-info.js";
  const models = new Map<string, ProviderDeclarationModel>([
    [objectSpecifier, {
      moduleSpecifier: objectSpecifier,
      providerModuleId: "Test.Recursive.Object",
      imports: [typeImport(typeInfoSpecifier, "TypeInfo")],
      exports: [{
        id: "Object",
        name: "Object",
        kind: "class",
        members: [{
          id: "Object::typeInfo",
          name: "typeInfo",
          kind: "property",
          readonly: true,
          type: providerRef(typeInfoSpecifier, "TypeInfo"),
        }],
      }],
    }],
    [memberSpecifier, {
      moduleSpecifier: memberSpecifier,
      providerModuleId: "Test.Recursive.Member",
      imports: [valueImport(objectSpecifier, "Object")],
      exports: [{
        id: "MemberInfo",
        name: "MemberInfo",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(objectSpecifier, "Object"),
        }],
      }],
    }],
    [typeSpecifier, {
      moduleSpecifier: typeSpecifier,
      providerModuleId: "Test.Recursive.Type",
      imports: [valueImport(memberSpecifier, "MemberInfo")],
      exports: [{
        id: "Type",
        name: "Type",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(memberSpecifier, "MemberInfo"),
        }],
      }],
    }],
    [typeInfoSpecifier, {
      moduleSpecifier: typeInfoSpecifier,
      providerModuleId: "Test.Recursive.TypeInfo",
      imports: [valueImport(typeSpecifier, "Type")],
      exports: [{
        id: "TypeInfo",
        name: "TypeInfo",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(typeSpecifier, "Type"),
        }],
      }],
    }],
  ]);

  assertProgramAccepts(
    models,
    typeInfoSpecifier,
    ["TypeInfo"],
    ["export class UseTypeInfo extends TypeInfo {}"],
  );
});

test("actual provider class heritage cycles reject in either resolution order", () => {
  const firstSpecifier = "@test/cycle/first.js";
  const secondSpecifier = "@test/cycle/second.js";
  const models = new Map<string, ProviderDeclarationModel>([
    [firstSpecifier, {
      moduleSpecifier: firstSpecifier,
      providerModuleId: "Test.Cycle.First",
      imports: [valueImport(secondSpecifier, "Second")],
      exports: [{
        id: "First",
        name: "First",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(secondSpecifier, "Second"),
        }],
      }],
    }],
    [secondSpecifier, {
      moduleSpecifier: secondSpecifier,
      providerModuleId: "Test.Cycle.Second",
      imports: [valueImport(firstSpecifier, "First")],
      exports: [{
        id: "Second",
        name: "Second",
        kind: "class",
        heritage: [{
          kind: "extends",
          type: providerRef(firstSpecifier, "First"),
        }],
      }],
    }],
  ]);

  for (const first of [firstSpecifier, secondSpecifier]) {
    const host = hostFor(models);
    const result = host.providers.resolveVirtualModule(first);
    assert.equal(result.kind, "rejected");
    assert.equal(
      result.kind === "rejected" ? result.diagnostic.extensionCode : "",
      "INVALID_PROVIDER_DECLARATION_MODEL",
    );
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
  }
});

test("provider value heritage rejects non-class targets and wrong family arity", () => {
  const baseSpecifier = "@test/invalid-heritage/base.js";
  const derivedSpecifier = "@test/invalid-heritage/derived.js";
  const invalidBases: readonly ProviderExportDeclaration[] = [{
    id: "Shape",
    name: "Shape",
    kind: "interface",
  }, {
    id: "Family_1",
    name: "Family_1",
    kind: "class",
    sourceTypeFamily: { exportName: "Family", typeArgumentCount: 1 },
    typeParameters: [{ name: "T" }],
  }];

  for (const [exportName, typeArguments] of [
    ["Shape", []],
    ["Family", []],
  ] as const) {
    const models = new Map<string, ProviderDeclarationModel>([
      [baseSpecifier, {
        moduleSpecifier: baseSpecifier,
        providerModuleId: "Test.InvalidHeritage.Base",
        exports: invalidBases,
      }],
      [derivedSpecifier, {
        moduleSpecifier: derivedSpecifier,
        providerModuleId: "Test.InvalidHeritage.Derived",
        imports: [valueImport(baseSpecifier, exportName)],
        exports: [{
          id: "Derived",
          name: "Derived",
          kind: "class",
          heritage: [{
            kind: "extends",
            type: providerRef(baseSpecifier, exportName, typeArguments),
          }],
        }],
      }],
    ]);
    const host = hostFor(models);
    const result = host.providers.resolveVirtualModule(derivedSpecifier);
    assert.equal(result.kind, "rejected");
    assert.deepEqual(host.providers.getVirtualDeclarationDocuments(), []);
  }
});

test("provider classes extend exact source-global constructors with checked inherited members", () => {
  const specifier = "@test/global-derived.js";
  const model: ProviderDeclarationModel = {
    moduleSpecifier: specifier,
    providerModuleId: "Test.GlobalDerived",
    exports: [{
      id: "Derived", name: "Derived", kind: "class",
      heritage: [{ kind: "extends", type: {
        kind: "source-global", name: "GlobalBase", typeArguments: [{ kind: "number" }],
      } }],
    }],
  };
  for (const scenario of [{
    global: "interface GlobalBase<T> { [index: number]: T; readonly length: number; } declare var GlobalBase: { new<T>(): GlobalBase<T>; };",
    accepted: true,
  }, {
    global: "", accepted: false,
  }, {
    global: "interface GlobalBase<T> { value: T; }", accepted: false,
  }, {
    global: "declare var GlobalBase: number;", accepted: false,
  }, {
    global: "declare var GlobalBase: { new(): { value: string }; };", accepted: false,
  }, {
    global: "declare class GlobalBase<T> { [index: number]: T; readonly length: number; }", accepted: false,
  }]) {
    const session = createCompilerSessionFromFiles({
      currentDirectory: "/src",
      rootFiles: ["/src/core.d.ts", "/src/index.ts"],
      files: {
        "/src/core.d.ts": `${testCoreDeclarations}\n${scenario.global}`,
        "/src/index.ts": `import { Derived } from "${specifier}";
          export function read(value: Derived): number { return value[0] + value.length; }`,
      },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true },
      extensionHostOptions: { extensions: [sourceProviderExtension(new Map([[specifier, model]]))] },
    });
    const checked = session.checkSource();
    assert.equal(checked.extensionDiagnostics.length, 0);
    assert.equal(checked.diagnostics.length === 0, scenario.accepted,
      `${scenario.global}\n${checked.diagnostics.map(Diagnostic_String).join("\n")}`);
  }
});

function assertProgramAccepts(
  models: ReadonlyMap<string, ProviderDeclarationModel>,
  moduleSpecifier: string,
  exportNames: readonly string[],
  sourceUses: readonly string[],
): void {
  const session = createCompilerSessionFromFiles({
    currentDirectory: "/src",
    rootFiles: ["/src/core.d.ts", "/src/index.ts"],
    files: {
      "/src/core.d.ts": testCoreDeclarations,
      "/src/index.ts": [
        `import { ${exportNames.join(", ")} } from "${moduleSpecifier}";`,
        ...sourceUses,
      ].join("\n"),
    },
    compilerOptions: testNoLibCompilerOptions,
    extensionHostOptions: {
      extensions: [sourceProviderExtension(models)],
    },
  });
  const checked = session.checkSource();
  assert.equal(
    checked.extensionDiagnostics.length,
    0,
    checked.extensionDiagnostics.map((diagnostic) =>
      [
        `${diagnostic.extensionCode}: ${diagnostic.message}`,
        ...(diagnostic.evidence ?? []).map((entry) =>
          `${entry.message}: ${JSON.stringify(entry.details)}`),
      ].join("\n")).join("\n"),
  );
  assert.equal(
    checked.diagnostics.length,
    0,
    checked.diagnostics.map(Diagnostic_String).join("\n"),
  );
}

function hostFor(models: ReadonlyMap<string, ProviderDeclarationModel>): ExtensionHost {
  return new ExtensionHost({}, {
    extensions: [sourceProviderExtension(models)],
  });
}

function typeImport(moduleSpecifier: string, exportedName: string) {
  return {
    moduleSpecifier,
    namedImports: [{ exportedName, kind: "type" as const }],
    typeOnly: true,
  };
}

function valueImport(moduleSpecifier: string, exportedName: string) {
  return {
    moduleSpecifier,
    namedImports: [{ exportedName, kind: "value" as const }],
  };
}

function providerRef(
  moduleSpecifier: string,
  exportName: string,
  typeArguments: readonly {
    readonly kind: "type-parameter";
    readonly name: string;
  }[] = [],
) {
  return {
    kind: "provider-ref" as const,
    moduleSpecifier,
    exportName,
    ...(typeArguments.length === 0 ? {} : { typeArguments }),
  };
}
