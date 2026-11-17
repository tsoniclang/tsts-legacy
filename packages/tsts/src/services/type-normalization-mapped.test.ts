import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Type } from "../internal/ast/ast.js";
import { Checker_cloneTypeParameter, Checker_getTypeParameterFromMappedType } from "../internal/checker/checker/signatures.js";
import { Checker_getTypeFromTypeNode, Checker_instantiateAnonymousType } from "../internal/checker/checker/types.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { Type_AsMappedType, Type_AsObjectType, Type_AsTypeParameter } from "../internal/checker/types.js";
import type { Type } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireMappedParameter } from "./type-normalization-declarations.js";

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/mapped", includeBundledLibraries: false,
    files: { "/mapped/core.d.ts": testCoreDeclarations,
      "/mapped/use.ts": `export type Fields<T> = { [K in keyof T]:T[K] };
        export declare const first:Fields<{first:string}>;
        export declare const second:Fields<{second:number}>;`,
      "/mapped/other.ts": "export const other = 1;", "/mapped/last.ts": "export const last = 2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/mapped/use.ts");
  if (program === undefined || file === undefined) throw new Error("The checked mapped fixture owns its actual Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, view.ast.is.IsVariableDeclaration);
  assert.equal(declarations.length, 2);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The requested actual pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const rows = (owner: Checker): Type[] => declarations.map(declaration => {
    const value = Checker_getTypeFromTypeNode(owner, Node_Type(declaration));
    if (value === undefined) throw new Error("The actual mapped type annotation has its native answer");
    return value;
  });
  return { owners, rows };
}

for (const checkers of [1, 4]) test(`fresh mapped parameters retain their actual instantiated owner with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program owns its actual checker");
  const rows = new Map(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = rows.get(source);
    const expected = rows.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The native owner rows are present");
    assert.equal(Type_AsMappedType(originals[0])?.declaration === Type_AsMappedType(originals[1])?.declaration, true,
      "both real instantiations share their producing mapped syntax, not their cloned parameter");
    assert.notEqual(Type_AsMappedType(originals[0])?.typeParameter, Type_AsMappedType(originals[1])?.typeParameter);
    for (const order of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const mapped of order) {
        const index = originals.indexOf(mapped);
        const target: Type | undefined = expected[index];
        const parameter: Type | undefined = Checker_getTypeParameterFromMappedType(source, mapped);
        if (target === undefined || parameter === undefined) throw new Error("The actual mapped instance and its parameter are present");
        const selected: Type | undefined = Checker_getTypeParameterFromMappedType(producer, target);
        assert.equal(parameter.derivation?.kind === "mapped-parameter" && parameter.derivation.mapped === mapped
          && Type_AsMappedType(mapped)?.typeParameter === parameter && Type_AsTypeParameter(parameter)?.target !== undefined, true);
        assert.equal(normalization.type(mapped) === target && normalization.type(parameter) === selected, true);
        assert.equal(normalization.type(parameter) === selected, true, "repeated normalization returns the same cached producing parameter");
        const original: Type | undefined = Type_AsObjectType(mapped)?.target;
        if (original === undefined) throw new Error("The native instantiated mapped type retains its target");
        assert.equal(Checker_getTypeParameterFromMappedType(source, original)?.derivation, undefined,
          "the actual shared declared binder never receives an instantiated owner");
        const clone = Checker_cloneTypeParameter(source, parameter);
        if (clone === undefined || parameter.derivation === undefined) throw new Error("The native clone and genuine original recipe exist");
        clone.derivation = parameter.derivation;
        assert.equal(reacquireMappedParameter(producer, clone, normalization.type), undefined,
          "a copied recipe is not the actual mapped owner's parameter pointer");
        assert.throws(() => reacquireMappedParameter(foreign, parameter, () => foreign.anyType!), TypeError);
        if (source !== producer) {
          assert.throws(() => reacquireMappedParameter(producer, parameter, value => value), TypeError);
          assert.throws(() => createTypeNormalization(foreign).type(parameter), TypeError);
          const uncached = Checker_instantiateAnonymousType(source, original, Type_AsObjectType(mapped)?.mapper, undefined);
          const uncachedParameter = uncached === undefined ? undefined : Checker_getTypeParameterFromMappedType(source, uncached);
          if (uncachedParameter === undefined) throw new Error("The uncached actual native instantiation owns a fresh parameter");
          assert.throws(() => createTypeNormalization(producer).type(uncachedParameter),
            /unfinished for this producing relation/u, "an unpublished mapped clone cannot borrow the existing cached owner answer");
        }
      }
    }
  }
});
