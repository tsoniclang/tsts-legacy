import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSession, createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import type { SourceFileQueries } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { newCheckerPool, checkerPool_as_compiler_CheckerPool } from "../internal/compiler/checkerpool.js";
import type { checkerPool } from "../internal/compiler/checkerpool.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { Background } from "../go/context.js";
import { AsVariableDeclaration } from "../internal/ast/generated/casts.js";

function fixture(checkers: number, custom: boolean) {
  const base = createCompilerSessionFromFiles({ currentDirectory: "/public-owners", includeBundledLibraries: false,
    files: { "/public-owners/core.d.ts": testCoreDeclarations,
      "/public-owners/definitions.ts": "export type Wrap<T>={value:T};export type Fields<T>={readonly [K in keyof T]?:T[K]};"
        + "export class Box<T>{value!:T}export class First{private value!:number}export class Second{private value!:number}"
        + "export function read(value:number):number{return value}",
      "/public-owners/left.ts": "import {Box,First,Fields} from './definitions.js';"
        + "export const literal={a:1,nested:{text:'same'}};export declare const boxed:Box<number>;"
        + "export declare const privateValue:First;export declare const mapped:Fields<{a:number}>;export type Key='a';",
      "/public-owners/right.ts": "import {Box,First,Second,Fields} from './definitions.js';"
        + "export const literal={a:1,nested:{text:'same'}};export declare const boxed:Box<number>;"
        + "export declare const different:Box<string>;export declare const privateValue:First;"
        + "export declare const otherPrivate:Second;export declare const mapped:Fields<{a:number}>;export type Key='a';" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  if (base.program === undefined) throw new Error("The real compiler session owns its Program");
  let selected: checkerPool | undefined;
  const session = custom ? createCompilerSession({ programOptions: { ...base.program.opts, CreateCheckerPool: program => {
    if (program === undefined) throw new Error("The native custom pool has its actual Program");
    selected = newCheckerPool(program);
    return checkerPool_as_compiler_CheckerPool(selected);
  } } }) : base;
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const pool = custom ? selected : session.program?.compilerCheckerPool;
  assert.equal(pool?.checkers.length, checkers);
  const wrapped = createCompilerSessionFromProgram(session.program, session.host, session.config).checkSource();
  assert.equal(wrapped.program === checked.program, true);
  const view = (path: string) => {
    const file = wrapped.getSourceFile("/public-owners/" + path + ".ts");
    if (file === undefined) throw new Error("The actual requested source file belongs to this Program");
    return wrapped.getSourceFileQueries(file);
  };
  return { checked: wrapped, left: view("left"), right: view("right"), definitions: view("definitions") };
}

function variable(source: SourceFileQueries, name: string, initializer = false) {
  const declaration = findNodes(source.sourceFile, source.ast.children, source.ast.is.IsVariableDeclaration)
    .find(node => source.ast.text(source.ast.name(node)) === name);
  const node = initializer ? AsVariableDeclaration(declaration)?.Initializer : source.ast.name(declaration);
  const answer = source.checker.getTypeAtLocation(node);
  if (answer === undefined || node === undefined) throw new Error("The real authored variable supplies its native answer");
  return { node, type: answer.type };
}

for (const checkers of [1, 4]) for (const custom of [false, true])
  test(`public native relations compose actual file owners with ${checkers} checkers, custom=${custom}`, () => {
    const current = fixture(checkers, custom);
    const declaration = findNodes(current.definitions.sourceFile, current.definitions.ast.children,
      current.definitions.ast.is.IsTypeAliasDeclaration).find(node => current.definitions.ast.text(current.definitions.ast.name(node)) === "Wrap");
    if (declaration === undefined) throw new Error("The actual type alias declaration is retained");
    const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.checked.program,
      WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), current.definitions.sourceFile);
    if (owner === undefined) throw new Error("The native declaration file has its own checker");
    try {
      for (const [source, target] of [[current.left, current.right], [current.right, current.left]] as const) {
        for (const name of ["boxed", "privateValue", "mapped"]) {
          const left = variable(source, name).type;
          const right = variable(target, name).type;
          assert.equal(left.checker === right.checker, checkers === 1);
          assert.equal(source.typeShape.isTypeIdenticalTo(left, right), true);
          assert.equal(target.typeShape.isTypeIdenticalTo(right, left), true);
        }
        const original = variable(source, "literal", true);
        const other = variable(target, "literal", true);
        assert.equal(source.typeShape.isTypeIdenticalTo(original.type, other.type), true);
        const again = source.checker.getTypeAtLocation(original.node);
        assert.equal(again !== undefined && again.type !== original.type, true,
          "The real plain TypeOnly handout remains genuinely fresh, not cached by the public replacement");
        assert.equal(target.typeShape.isTypeIdenticalTo(original.type, again?.type), true);
        const application = target.typeShape.instantiateTypeAlias(declaration, [original.type]);
        assert.equal(application !== undefined && application.bindings[0]?.argument === original.type
          && application.result.checker === owner, true,
          "The declaration owner produces the result while the receipt retains the original caller operand");
        const keyNode = findNodes(target.sourceFile, target.ast.children, target.ast.is.IsTypeAliasDeclaration)
          .find(node => target.ast.text(target.ast.name(node)) === "Key");
        const key = target.checker.getTypeFromTypeNode(target.ast.typeNode(keyNode))?.type;
        const selected = target.typeShape.selectIndexedAccess(original.type, key);
        assert.equal(selected?.kind === "resolved" && selected.readType.checker === original.type.checker
          && selected.indexType.checker === original.type.checker && selected.objectType === original.type, true);
        assert.equal(target.typeShape.isNumberLike(selected?.readType), true);
        assert.equal(target.typeShape.isTypeIdenticalTo(selected?.readType,
          source.checker.getTypeOfPropertyOfType(original.type, "a")), true,
        "Indexed selection agrees with the native property type, including actual mutable-property widening");
      }
      assert.equal(current.left.typeShape.isTypeIdenticalTo(variable(current.left, "boxed").type,
        variable(current.right, "different").type), false);
      assert.equal(current.left.typeShape.isTypeIdenticalTo(variable(current.left, "privateValue").type,
        variable(current.right, "otherPrivate").type), false);
      const callable = findNodes(current.definitions.sourceFile, current.definitions.ast.children,
        current.definitions.ast.is.IsFunctionDeclaration).find(node => current.definitions.ast.text(current.definitions.ast.name(node)) === "read");
      const signature = current.left.checker.getSignatureFromDeclaration(callable);
      assert.equal(signature !== undefined && signature.checkerId === owner.id, true,
        "A node-based signature answer is produced by its actual declaration file checker");
      assert.equal(current.right.typeShape.getReturnTypeOfSignature(signature)?.checker === owner, true);
      const parameter = current.right.typeShape.getSignatureParameterInfos(signature)[0];
      assert.equal(parameter?.type.checker === owner, true,
        "A signature consumer reads its parameters in that same signature owner");
    } finally { release(); }
  });
