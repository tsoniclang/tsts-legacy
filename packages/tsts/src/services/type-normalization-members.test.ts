import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { Node_Type } from "../internal/ast/ast.js";
import { Checker_cloneSignature, Checker_cloneTypeParameter, Checker_getOrCreateTypeFromSignature,
  Checker_getSignaturesOfType } from "../internal/checker/checker/signatures.js";
import { Checker_getTypeFromTypeNode } from "../internal/checker/checker/types.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { SignatureKindCall, SignatureKindConstruct, Type_AsTypeParameter } from "../internal/checker/types.js";
import type { Signature, SignatureDerivation, SignatureKind, Type } from "../internal/checker/types.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireMemberSignature } from "./type-normalization-signatures.js";

interface MemberRow {
  readonly type: Type;
  readonly kind: SignatureKind;
  readonly signatures: readonly (Signature | undefined)[];
}

function fixture(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/members", includeBundledLibraries: false,
    files: { "/members/core.d.ts": testCoreDeclarations,
      "/members/use.ts": `export interface Callable<Outer> {
          <Inner>(outer:Outer, inner:Inner):Inner;
          <Inner>(inner:Inner):[Outer,Inner];
        }
        export interface Constructible<Outer> {
          new<Inner>(outer:Outer, inner:Inner):[Outer,Inner];
          new<Inner>(inner:Inner):Inner;
        }
        export interface Inherited<Outer> extends Callable<Outer> {}
        export type FunctionOwner<Outer> = <Inner>(outer:Outer, inner:Inner)=>Inner;
        export type ConstructorOwner<Outer> = new<Inner>(outer:Outer, inner:Inner)=>[Outer,Inner];
        export declare const callable:Callable<number>;
        export declare const constructible:Constructible<number>;
        export declare const inherited:Inherited<number>;
        export declare const functionOwner:FunctionOwner<number>;
        export declare const constructorOwner:ConstructorOwner<number>;`,
      "/members/other.ts": "export const other = 1;", "/members/last.ts": "export const last = 2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length === 0, true, "the real generic call and construct declarations check without errors");
  const program = session.program;
  const file = checked.getSourceFile("/members/use.ts");
  if (program === undefined || file === undefined) throw new Error("The actual checked member fixture owns its Program and file");
  const view = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, view.ast.children, view.ast.is.IsVariableDeclaration);
  assert.equal(declarations.length, 5);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual native checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  const borrowed = createCompilerSessionFromProgram(program, session.host, session.config);
  assert.equal(borrowed.program === program && borrowed.checkSource().diagnostics.length === 0, true,
    "wrapping the existing Program retains the actual member producers");
  const rows = (owner: Checker): MemberRow[] => declarations.map((declaration, index) => {
    const type = Checker_getTypeFromTypeNode(owner, Node_Type(declaration));
    if (type === undefined) throw new Error("The actual generic annotation produces its native Type");
    const kind = index === 1 || index === 4 ? SignatureKindConstruct : SignatureKindCall;
    const signatures = Checker_getSignaturesOfType(owner, type, kind);
    assert.equal(signatures.length, index < 3 ? 2 : 1);
    return { type, kind, signatures };
  });
  return { owners, rows };
}

for (const checkers of [1, 4]) test(`resolved member signatures and cloned parameters retain actual owners with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The independent Program has its actual checker");
  const rows = new Map(current.owners.map(owner => [owner, current.rows(owner)]));
  for (const source of current.owners) for (const producer of current.owners) {
    const originalRows = rows.get(source);
    const expectedRows = rows.get(producer);
    if (originalRows === undefined || expectedRows === undefined) throw new Error("The actual native member rows are retained");
    for (const order of [originalRows, [...originalRows].reverse()]) {
      const normalization = createTypeNormalization(producer);
      for (const original of order) {
        const rowIndex = originalRows.indexOf(original);
        const expected: MemberRow | undefined = expectedRows[rowIndex];
        if (expected === undefined) throw new Error("The same real annotation has its target-producer answer");
        assert.equal(normalization.type(original.type) === expected.type, true, "the owner Type is normalized through its actual cached construction");
        for (const [index, signature] of original.signatures.entries()) {
          const target: Signature | undefined = expected.signatures[index];
          if (signature === undefined || target === undefined) throw new Error("The actual declared signature vectors are dense");
          const derivation: SignatureDerivation | undefined = signature.derivation;
          assert.equal(derivation?.kind === "member" && signature.checkerId === source.id &&
            Checker_getSignaturesOfType(source, derivation.owner,
              derivation.signatureKind === "call" ? SignatureKindCall : SignatureKindConstruct)[derivation.index] === signature, true,
            "the record names the exact producing owner's cached member, not a copied declared signature");
          if (derivation?.kind !== "member") throw new Error("The native instantiation retained its real member owner");
          const normalized: Signature | undefined = reacquireMemberSignature(source, producer, signature, normalization.type);
          assert.equal(normalized !== undefined && normalized === target && normalized.checkerId === producer.id, true,
            "both real overload positions and inherited members retain their exact target cache identity");
          const parameter: Type | undefined = signature.typeParameters[0];
          const expectedParameter: Type | undefined = target.typeParameters[0];
          if (parameter === undefined || expectedParameter === undefined) throw new Error("The native instantiated member owns its fresh parameter");
          assert.equal(parameter.derivation?.kind === "signature-parameter" && parameter.derivation.signature === signature &&
            parameter.derivation.index === 0 && Type_AsTypeParameter(parameter)?.target !== undefined &&
            signature.target?.typeParameters[0] !== parameter, true,
            "only the genuine cloned parameter receives the actual producing signature coordinate");
          assert.equal(normalization.type(parameter) === expectedParameter && normalization.type(parameter) === expectedParameter, true);
          const isolated: Type | undefined = Checker_getOrCreateTypeFromSignature(source, signature);
          const expectedIsolated: Type | undefined = Checker_getOrCreateTypeFromSignature(producer, target);
          if (isolated === undefined || expectedIsolated === undefined) throw new Error("The native signatures own their isolated Types");
          assert.equal(normalization.type(isolated) === expectedIsolated, true, "the actual Signature consumer uses the same member recipe");
          const clone: Signature | undefined = Checker_cloneSignature(source, signature, signature.constructorClass);
          if (clone === undefined) throw new Error("The native signature clone exists");
          clone.derivation = derivation;
          assert.equal(reacquireMemberSignature(source, producer, clone, normalization.type), undefined,
            "a genuinely uncached clone cannot borrow another member's record");
          assert.throws(() => reacquireMemberSignature(source, foreign, signature, () => foreign.anyType!), TypeError);
          if (source !== producer) {
            const parameterClone: Type | undefined = Checker_cloneTypeParameter(source, parameter);
            if (parameterClone === undefined) throw new Error("The native parameter clone exists");
            if (parameter.derivation === undefined) throw new Error("The real cloned parameter retains its producing coordinate");
            parameterClone.derivation = parameter.derivation;
            assert.throws(() => createTypeNormalization(producer).type(parameterClone), TypeError,
              "a copied record does not establish the original signature's parameter pointer");
            assert.throws(() => reacquireMemberSignature(producer, producer, signature, normalization.type), TypeError);
            assert.throws(() => reacquireMemberSignature(source, producer, signature, value => value), TypeError);
          }
          const sourceDeclared: Type | undefined = signature.target?.typeParameters[0];
          assert.equal(sourceDeclared !== undefined && sourceDeclared.derivation === undefined, true,
            "shared declared binders never receive the instantiated member's owner record");
        }
      }
    }
  }
});
