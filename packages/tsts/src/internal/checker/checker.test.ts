// Mirror of internal/checker/checker_test.go (TestGetSymbolAtLocation).
// BenchmarkNewChecker is a Go benchmark and has no mirror.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { bool } from "../../go/scalars.js";
import type { GoPtr } from "../../go/compat.js";
import { Background } from "../../go/context.js";
import type { Node } from "../ast/spine.js";
import { Node_Name } from "../ast/spine.js";
import { Node_Expression } from "../ast/ast.js";
import { AsVariableDeclarationList, AsVariableStatement } from "../ast/generated/casts.js";
import { LibPath, WrapFS } from "../bundled/bundled.js";
import { NewCompilerHost } from "../compiler/host.js";
import type { ProgramOptions } from "../compiler/program.js";
import { NewProgram, Program_BindSourceFiles, Program_GetSourceFile, Program_GetTypeChecker } from "../compiler/program.js";
import type { CompilerOptions } from "../core/compileroptions.js";
import type { Checker } from "./checker/state.js";
import { Checker_GetSymbolAtLocation } from "./checker/symbols.js";
import { newArrayToSingleTypeMapper, newArrayTypeMapper, newDeferredTypeMapper, newSimpleTypeMapper, TypeMapper_Map } from "./mapper.js";
import { runNativeCheckerAcquisition, type NativeCheckerResult } from "./resource-admission.js";
import type { Type } from "./types.js";
import type { ParseConfigHost } from "../tsoptions/tsconfigparsing.js";
import { GetParsedCommandLineOfConfigFile } from "../tsoptions/tsconfigparsing.js";
import { FromMap } from "../vfs/vfstest/vfstest.js";

function withChecker(content: string, action: (checker: Checker, file: NonNullable<ReturnType<typeof Program_GetSourceFile>>) => void): void {
  let fs = FromMap(new Map<string, string>([
    ["/foo.ts", content],
    ["/tsconfig.json", `
				{
					"compilerOptions": {},
					"files": ["foo.ts"]
				}
			`],
  ]), false as bool /*useCaseSensitiveFileNames*/);
  fs = WrapFS(fs);

  const cd = "/";
  const host = NewCompilerHost(cd, fs, LibPath(), undefined, undefined);

  const [parsed, errors] = GetParsedCommandLineOfConfigFile("/tsconfig.json", {} as CompilerOptions, undefined, host as ParseConfigHost, undefined);
  assert.equal((errors ?? []).length, 0, "Expected no errors in parsed command line");

  const p = NewProgram({
    Config: parsed,
    Host: host,
  } satisfies ProgramOptions);
  Program_BindSourceFiles(p);
  const [c, done] = Program_GetTypeChecker(p, Background());
  try {
    const file = Program_GetSourceFile(p, "/foo.ts");
    assert.ok(c !== undefined && file !== undefined);
    action(c, file);
  } finally {
    done();
  }
}

test("GetSymbolAtLocation", () => {
  withChecker(`interface Foo {
  bar: string;
}
declare const foo: Foo;
foo.bar;`, (checker, file) => {
    const interfaceId = Node_Name(file.Statements!.Nodes[0]);
    const varId = Node_Name(AsVariableDeclarationList(AsVariableStatement(file.Statements!.Nodes[1])!.DeclarationList)!.Declarations!.Nodes[0]);
    const propAccess = Node_Expression(file.Statements!.Nodes[2]);
    const nodes: Array<GoPtr<Node>> = [interfaceId, varId, propAccess];
    for (const node of nodes) {
      const symbol = Checker_GetSymbolAtLocation(checker, node);
      assert.ok(symbol !== undefined, "Expected symbol to be non-nil");
    }
  });
});

test("native substitutions admit only reached source rows and their exact selected target", () => {
  withChecker("export {};", checker => {
    const { stringType, booleanType, numberType, unknownType, trueType } = checker;
    assert.ok(stringType && booleanType && numberType && unknownType && trueType);
    const read: string[] = [];
    const sources = [stringType, numberType, unknownType];
    for (const [ordinal, source] of sources.entries()) {
      Object.defineProperty(sources, ordinal, { get: () => {
        read.push(`source ${ordinal}`);
        return source;
      } });
    }
    const targets = [unknownType, booleanType, stringType];
    Object.defineProperty(targets, 1, { get: () => {
      read.push("target 1");
      return booleanType;
    } });
    const deferredTargets = [() => unknownType, () => {
      read.push("target 1");
      return booleanType;
    }, () => stringType];
    const cases = [
      { label: "array", mapper: newArrayTypeMapper(sources, targets), matchedWork: 3, expected: ["source 0", "source 1", "target 1"] },
      { label: "deferred", mapper: newDeferredTypeMapper(sources, deferredTargets), matchedWork: 3, expected: ["source 0", "source 1", "target 1"] },
      { label: "single target", mapper: newArrayToSingleTypeMapper(sources, booleanType), matchedWork: 3, expected: ["source 0", "source 1"] },
      { label: "single source", mapper: newSimpleTypeMapper(numberType, booleanType), matchedWork: 2, expected: [] },
    ];
    for (const { label, mapper, matchedWork, expected } of cases) {
      const stop = { label };
      const acquire = (maximum: number, type: Type): NativeCheckerResult<GoPtr<Type>, { label: string }> => {
        read.length = 0;
        let used = 0;
        return runNativeCheckerAcquisition(checker, Background(), (cost, units) => {
          assert.equal(cost, "work");
          used += units;
          return used > maximum ? stop : null;
        }, () => assert.fail("An interrupted readonly mapping is not provisional"), () => TypeMapper_Map(mapper, type));
      };
      for (let maximum = 0; maximum < matchedWork; maximum += 1) {
        const refused = acquire(maximum, numberType);
        assert.equal(refused.kind === "refused" && refused.stop === stop, true, `${label}/${maximum}`);
        assert.deepEqual(read, expected.slice(0, maximum), `${label}/${maximum}`);
      }
      const mapped = acquire(matchedWork, numberType);
      assert.equal(mapped.kind === "complete" && mapped.value === booleanType, true, label);
      assert.deepEqual(read, expected, label);
      const missed = acquire(label === "single source" ? 1 : 3, trueType);
      assert.equal(missed.kind === "complete" && missed.value === trueType, true, `${label}/miss`);
      assert.deepEqual(read, label === "single source" ? [] : ["source 0", "source 1", "source 2"], `${label}/miss`);
    }
  });
});
