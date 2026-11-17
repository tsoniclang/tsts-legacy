import assert from "node:assert/strict";
import test from "node:test";
import { createCompilerSession, createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { checkerPool_as_compiler_CheckerPool, newCheckerPool } from "../internal/compiler/checkerpool.js";
import type { checkerPool } from "../internal/compiler/checkerpool.js";
import { Program_GetCheckerPool } from "../internal/compiler/program.js";
import type { Program } from "../internal/compiler/program.js";
import { ParsedCommandLine_CompilerOptions } from "../internal/tsoptions/parsedcommandline.js";
import { TSTrue } from "../internal/core/tristate.js";

function session(checkers?: number) {
  return createCompilerSessionFromFiles({
    currentDirectory: "/checkers",
    includeBundledLibraries: false,
    files: {
      "/checkers/core.d.ts": testCoreDeclarations,
      "/checkers/a.ts": "export const a = 1;",
      "/checkers/b.ts": "export const b = 2;",
      "/checkers/c.ts": "export const c = 3;",
      "/checkers/d.ts": "export const d = 4;",
    },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022",
      ...(checkers === undefined ? {} : { checkers }) },
  });
}

function requiredProgram(program: Program | undefined): Program {
  if (program === undefined) throw new Error("The session has no compiler Program.");
  return program;
}

function nativePool(program: Program | undefined): checkerPool {
  const pool = requiredProgram(program).compilerCheckerPool;
  if (pool === undefined) throw new Error("The ordinary program has no native checker pool.");
  return pool;
}

test("ordinary synchronous SDK programs allocate one native checker without mutating compiler options", () => {
  const current = session();
  const options = ParsedCommandLine_CompilerOptions(current.config);
  assert.equal(options?.Checkers, undefined);
  assert.equal(nativePool(current.program).checkers.length, 1);
  assert.equal(current.checkSource().diagnostics.length, 0);
  assert.equal(options === ParsedCommandLine_CompilerOptions(current.config), true);
  assert.equal(options?.Checkers, undefined);
  assert.equal(nativePool(current.program).checkers.filter(checker => checker !== undefined).length, 1);
});

test("explicit one, two and four checker pools retain their selected native capacity", () => {
  for (const count of [1, 2, 4]) {
    const current = session(count);
    const pool = nativePool(current.program);
    assert.equal(pool.checkers.length, count);
    assert.equal(current.checkSource().diagnostics.length, 0);
    assert.equal(pool.checkers.filter(checker => checker !== undefined).length, count);
    assert.equal(ParsedCommandLine_CompilerOptions(current.config)?.Checkers, count);
    assert.equal(new Set(pool.fileAssociations.values()).size, count);
  }
});

test("the actual SingleThreaded option keeps its native precedence over an explicit checker count", () => {
  const base = session(4);
  const current = createCompilerSession({ programOptions: { ...requiredProgram(base.program).opts, SingleThreaded: TSTrue } });
  assert.equal(nativePool(current.program).checkers.length, 1);
  assert.equal(current.checkSource().diagnostics.length, 0);
  assert.equal(ParsedCommandLine_CompilerOptions(current.config)?.Checkers, 4);
});

test("wrapping an existing multi-checker Program preserves the original Program and actual pool", () => {
  const base = session(4);
  assert.equal(base.checkSource().diagnostics.length, 0);
  const pool = nativePool(base.program);
  const current = createCompilerSessionFromProgram(base.program, base.host, base.config);
  assert.equal(current.program === base.program, true);
  assert.equal(current.checkSource().diagnostics.length, 0);
  assert.equal(nativePool(current.program) === pool, true);
  assert.equal(pool.checkers.length, 4);
});

test("a supplied native pool factory remains authoritative without a session replacement pool", () => {
  const base = session(4);
  let selected: ReturnType<typeof checkerPool_as_compiler_CheckerPool> | undefined;
  let produced: checkerPool | undefined;
  let actualProgram: Program | undefined;
  const current = createCompilerSession({ programOptions: { ...requiredProgram(base.program).opts,
    CreateCheckerPool: program => {
      if (program === undefined) throw new Error("The custom pool requires its actual Program.");
      const pool = newCheckerPool(program);
      if (pool === undefined) throw new Error("The native pool constructor did not produce a pool.");
      actualProgram = program;
      produced = pool;
      selected = checkerPool_as_compiler_CheckerPool(pool);
      return selected;
    } } });
  assert.equal(actualProgram === current.program, true);
  assert.equal(Program_GetCheckerPool(current.program) === selected, true);
  assert.equal(requiredProgram(current.program).compilerCheckerPool === undefined, true, "a custom pool is not replaced by the default pool");
  assert.equal(current.checkSource().diagnostics.length, 0);
  assert.equal(produced?.checkers.length, 4);
  assert.equal(produced?.checkers.filter(checker => checker !== undefined).length, 4);
});
