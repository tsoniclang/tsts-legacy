import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Type } from "../internal/ast/ast.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { getUnionKey, IntersectionFlagsNoConstraintReduction } from "../internal/checker/checker/state.js";
import { Checker_getIntersectionTypeEx, Checker_getTypeFromTypeNode, Checker_newIntersectionType,
  Checker_newUnionType } from "../internal/checker/checker/types.js";
import { Checker_cloneSignature, Checker_getOrCreateTypeFromSignature, Checker_getSignatureFromDeclaration,
  Checker_getSignaturesOfType } from "../internal/checker/checker/signatures.js";
import { ObjectFlagsNone, SignatureKindCall, SignatureKindConstruct, TypeFlagsIntersection, TypeFlagsUnion, Type_AsUnionType, Type_Types } from "../internal/checker/types.js";
import type { Signature, Type } from "../internal/checker/types.js";
import { reacquireCompositeType } from "./type-normalization-composites.js";
import { reacquireCompositeSignature } from "./type-normalization-signatures.js";
import { createTypeNormalization } from "./type-normalization.js";

function fixture(checkers: number, text = `export interface Left {
    (value:"a"):string; (value:number):number; new(value:string):{left:string};
  }
  export interface Right {
    (value:"a"):number; (value:number):string; new(value:string):{right:number};
  }
  export interface Mixin { new(...args:any[]):{extra:boolean} }
  export interface Inherited extends Left { extra:boolean }
  export declare const union:Left|Right;
  export declare const intersection:Mixin&Right;
  export declare const reused:Left|Inherited;`) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/composites", includeBundledLibraries: false,
    files: { "/composites/core.d.ts": testCoreDeclarations,
      "/composites/use.ts": text,
      "/composites/other.ts": "export const other=1;", "/composites/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true);
  const program = session.program;
  const file = checked.getSourceFile("/composites/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual composite fixture owns its Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, view.ast.is.IsVariableDeclaration);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The requested native checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const rows = (owner: Checker): Type[] => declarations.map(declaration => {
    const type = Checker_getTypeFromTypeNode(owner, Node_Type(declaration));
    if (type === undefined) throw new Error("The actual composite annotation retains its native answer");
    return type;
  });
  return { owners, rows };
}

function sameMembers(left: readonly (Signature | undefined)[], right: ReadonlySet<Signature>): boolean {
  const actual = new Set(left);
  return actual.size === right.size && [...actual].every(member => member !== undefined && right.has(member));
}

for (const checkers of [1, 4]) test(`native composite constructors and member origins close with ${checkers} actual checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program has its real checker");
  const rows = new Map(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = rows.get(source);
    const expected = rows.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The actual native answers are present");
    assert.equal(originals.length, 3);
    for (const ordered of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      const normalizeSignature = (signature: Signature): Signature => {
        const isolated = Checker_getOrCreateTypeFromSignature(source, signature);
        if (isolated === undefined) throw new Error("The actual source Signature owns its native isolated Type");
        const type = normalization.type(isolated);
        const values = [...Checker_getSignaturesOfType(producer, type, SignatureKindCall),
          ...Checker_getSignaturesOfType(producer, type, SignatureKindConstruct)];
        assert.equal(values.length, 1);
        const result = values[0];
        if (result === undefined) throw new Error("The normalized isolated Type retains its actual Signature");
        return result;
      };
      for (const original of ordered) {
        const index = originals.indexOf(original);
        const target: Type | undefined = expected[index];
        if (target === undefined) throw new Error("The same actual annotation owns the target checker answer");
        assert.equal(normalization.type(original) === target && normalization.type(original) === target, true);
        const kind = index === 1 ? SignatureKindConstruct : SignatureKindCall;
        const signatures = Checker_getSignaturesOfType(source, original, kind);
        const targets = Checker_getSignaturesOfType(producer, target, kind);
        assert.equal(signatures.length > 0 && targets.length === signatures.length, true);
        if (index !== 2) assert.equal(signatures.every(signature => signature?.derivation?.kind
          === (index === 0 ? "union-member" : "intersection-member")), true,
        "the actual fresh union and mixin outputs retain their own native producing relation");
        for (const signature of signatures) {
          if (signature === undefined) throw new Error("The native signature vector is dense");
          const record = signature.derivation;
          if (record?.kind !== "union-member" && record?.kind !== "intersection-member") continue;
          assert.equal(record.owner === original, true);
          const selected = reacquireCompositeSignature(source, producer, signature, normalization.type, normalizeSignature);
          assert.equal(selected !== undefined && targets.includes(selected), true);
          if (record.kind === "union-member") {
            const constituents = new Set<Signature>();
            for (const member of record.constituents) {
              if (member?.declaration === undefined) throw new Error("The real fixture constituent owns its authored signature declaration");
              const actual = Checker_getSignatureFromDeclaration(producer, member.declaration);
              if (actual === undefined) throw new Error("The target declaration owns its actual native Signature");
              constituents.add(actual);
              assert.equal(member.derivation === undefined, true, "shared declared input signatures acquire no union ownership");
            }
            assert.equal(selected?.derivation?.kind === "union-member"
              && sameMembers(selected.derivation.constituents, constituents), true);
          } else {
            const actual = Checker_getSignatureFromDeclaration(producer, record.source.declaration);
            assert.equal(selected?.derivation?.kind === "intersection-member" && selected.derivation.source === actual, true);
            assert.equal(record.source.derivation === undefined, true, "the original declared constructor is not overwritten");
          }
          const clone = Checker_cloneSignature(source, signature, signature.constructorClass);
          if (clone === undefined) throw new Error("The native Signature clone exists");
          clone.derivation = record;
          assert.equal(reacquireCompositeSignature(source, producer, clone, normalization.type, normalizeSignature), undefined,
            "a genuine uncached native clone cannot borrow a cached member's record");
          assert.throws(() => reacquireCompositeSignature(source, foreign, signature, normalization.type, normalizeSignature),
            error => error instanceof TypeError);
          assert.throws(() => reacquireCompositeSignature(foreign, producer, signature, normalization.type, normalizeSignature),
            error => error instanceof TypeError);
          const isolated = Checker_getOrCreateTypeFromSignature(source, signature);
          const expectedType = Checker_getOrCreateTypeFromSignature(producer, selected);
          if (isolated === undefined || expectedType === undefined) throw new Error("The actual composite Signature Types exist");
          assert.equal(normalization.type(isolated) === expectedType, true);
        }
        const members = Type_Types(original);
        const uncached = (original.flags & TypeFlagsUnion) !== 0
          ? Checker_newUnionType(source, ObjectFlagsNone, members) : Checker_newIntersectionType(source, ObjectFlagsNone, members);
        if (uncached === undefined) throw new Error("The native uncached composite constructor returns its actual object");
        assert.equal(reacquireCompositeType(producer, uncached, normalization.type), undefined);
        assert.throws(() => reacquireCompositeType(foreign, original, normalization.type), error => error instanceof TypeError);
        assert.throws(() => reacquireCompositeType(producer, original, () => foreign.stringType!), error => error instanceof TypeError);
        if (index === 1) {
          const constrained = Checker_getIntersectionTypeEx(source, members, IntersectionFlagsNoConstraintReduction, undefined);
          const selected = Checker_getIntersectionTypeEx(producer, Type_Types(target), IntersectionFlagsNoConstraintReduction, undefined);
          if (constrained === undefined || selected === undefined) throw new Error("Both actual no-constraint-reduction constructors return their own values");
          assert.equal(normalization.type(constrained) === selected, true);
        }
      }
    }
  }
});

for (const checkers of [1, 4]) test(`native cached unions retain uncached presentation origins with ${checkers} actual checkers`, () => {
  const current = fixture(checkers, `export interface Left { left:string }
    export interface Right { right:number }
    export interface Extra { extra:boolean }
    export type Named=Left|Right;
    export declare const named:Named|Extra;
    export declare const distributed:(Left|Right)&Extra;`);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The foreign Program retains its actual owner");
  const rows = new Map(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originals = rows.get(source);
    const expected = rows.get(producer);
    if (originals === undefined || expected === undefined) throw new Error("The annotation owns its actual native answers");
    assert.equal(originals.length, 2);
    for (const ordered of [originals, [...originals].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const original of ordered) {
        const index = originals.indexOf(original);
        const target: Type | undefined = expected[index];
        const origin: Type | undefined = Type_AsUnionType(original)?.origin;
        if (target === undefined || origin === undefined) throw new Error("The native cached union retains its presentation origin");
        const members = Type_Types(original);
        const originMembers = [...Type_Types(origin)];
        assert.equal(source.unionTypes.get(getUnionKey(members, origin, undefined)) === original, true);
        assert.equal((origin.flags & (index === 0 ? TypeFlagsUnion : TypeFlagsIntersection)) !== 0, true);
        assert.equal([...source.unionTypes.values(), ...source.intersectionTypes.values()].includes(origin), false,
          "the genuine native presentation node is not an independently cached Type");
        assert.equal(normalization.type(original) === target && normalization.type(original) === target, true,
          "normalization returns the actual existing target cache answer, not an equivalent fresh Type");
        const targetOrigin: Type | undefined = Type_AsUnionType(target)?.origin;
        if (targetOrigin === undefined) throw new Error("The target native union retains its actual origin");
        assert.equal((targetOrigin.flags & (index === 0 ? TypeFlagsUnion : TypeFlagsIntersection)) !== 0, true);
        assert.equal(Type_AsUnionType(original)?.origin === origin, true);
        assert.equal(Type_Types(origin).every((member, offset) => member === originMembers[offset]), true);
        const uncached = Checker_newUnionType(source, ObjectFlagsNone, members);
        if (uncached === undefined) throw new Error("The native uncached constructor retains its result");
        Type_AsUnionType(uncached)!.origin = origin;
        assert.equal(reacquireCompositeType(producer, uncached, normalization.type), undefined,
          "a copied actual origin cannot authorize an uncached root");
        assert.throws(() => reacquireCompositeType(foreign, original, normalization.type), error => error instanceof TypeError);
        assert.throws(() => reacquireCompositeType(producer, original, () => foreign.stringType!), error => error instanceof TypeError);
      }
    }
  }
});
