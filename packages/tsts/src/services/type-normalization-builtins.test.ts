import assert from "node:assert/strict";
import test from "node:test";
import { createCompilerSession, createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Node } from "../internal/ast/spine.js";
import { Node_Symbol } from "../internal/ast/ast.js";
import { Checker_GetTypeAtLocation, Checker_getBigIntLiteralType, Checker_getFreshTypeOfLiteralType, Checker_getNumberLiteralType,
  Checker_getStringLiteralType, Checker_newIntrinsicType } from "../internal/checker/checker/types.js";
import { Checker_cloneSignature, Checker_cloneTypeParameter, Checker_getBaseSignature, Checker_getCanonicalSignature, Checker_getErasedSignature,
  Checker_getOptionalCallSignature, Checker_getOrCreateTypeFromSignature, Checker_getSignaturesOfType, Checker_getSignatureFromDeclaration } from "../internal/checker/checker/signatures.js";
import { Checker_getRestrictiveTypeParameter } from "../internal/checker/checker/signatures.js";
import { Checker_getSignatureInstantiationWithoutFillingInTypeArguments } from "../internal/checker/checker/signatures.js";
import { Checker_cloneTypeReference, Checker_createTypeReference, Checker_getTemplateLiteralType, Checker_getTupleTargetType } from "../internal/checker/checker/types.js";
import { Checker_getRegularTypeOfObjectLiteral, Checker_getWidenedType, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { Checker_checkExpressionCached, Checker_checkExpressionCachedEx } from "../internal/checker/checker/syntax-checking.js";
import { CheckModeContextual } from "../internal/checker/checker/state.js";
import { Checker_getStringMappingType, Checker_getSubstitutionType, Checker_getTypeAliasInstantiation } from "../internal/checker/checker/inference.js";
import { Checker_getConstraintTypeFromMappedType } from "../internal/checker/checker/inference.js";
import { Checker_createReverseMappedType, Checker_inferTypeForHomomorphicMappedType } from "../internal/checker/inference.js";
import { AccessFlagsIncludeUndefined, AccessFlagsNone, IndexFlagsNoIndexSignatures, IndexFlagsNoReducibleCheck, IndexFlagsNone, IndexFlagsStringsOnly,
  SignatureFlagsIsInnerCallChain, SignatureFlagsIsOuterCallChain, SignatureKindCall, TypeFlagsAny, Type_AsIndexType, Type_AsIndexedAccessType, Type_AsLiteralType } from "../internal/checker/types.js";
import { Type_AsInterfaceType } from "../internal/checker/types.js";
import { ElementFlagsRequired, ElementFlagsOptional } from "../internal/checker/types.js";
import type { TupleElementInfo } from "../internal/checker/types.js";
import { Checker_getDeclaredTypeOfSymbol, Checker_getIndexTypeEx, Checker_getIndexedAccessTypeEx, Checker_getTypeOfSymbol } from "../internal/checker/checker/symbols.js";
import type { Type } from "../internal/checker/types.js";
import { checkerPool_as_compiler_CheckerPool, newCheckerPool } from "../internal/compiler/checkerpool.js";
import type { checkerPool } from "../internal/compiler/checkerpool.js";
import { reacquireBuiltinSignature, reacquireBuiltinType } from "./type-normalization-builtins.js";
import { reacquireLiteralType } from "./type-normalization-literals.js";
import { reacquireTypeOperator } from "./type-normalization-operators.js";
import { reacquireCachedObjectExpression } from "./type-normalization-expressions.js";
import { cachedSignatureArguments, cachedSignatureConstruction, reacquireCachedSignature, reacquireSignatureInstantiation, reacquireSignatureType } from "./type-normalization-signatures.js";
import { reacquireDeclarationSignature, reacquireDeclaredRestriction, reacquireDeclaredType, reacquireTypeAlias, reacquireTypeReference } from "./type-normalization-declarations.js";
import { FromString } from "../internal/jsnum/string.js";
import { ParseValidBigInt } from "../internal/jsnum/pseudobigint.js";

const anchors = [
  "anyType",
  "autoType",
  "wildcardType",
  "blockedStringType",
  "errorType",
  "unresolvedType",
  "nonInferrableAnyType",
  "intrinsicMarkerType",
  "unknownType",
  "undefinedType",
  "undefinedWideningType",
  "missingType",
  "undefinedOrMissingType",
  "optionalType",
  "nullType",
  "nullWideningType",
  "stringType",
  "numberType",
  "bigintType",
  "regularFalseType",
  "falseType",
  "regularTrueType",
  "trueType",
  "booleanType",
  "esSymbolType",
  "voidType",
  "neverType",
  "silentNeverType",
  "implicitNeverType",
  "unreachableNeverType",
  "nonPrimitiveType",
  "stringOrNumberType",
  "stringNumberSymbolType",
  "numberOrBigIntType",
  "numericStringType",
  "templateConstraintType",
  "uniqueLiteralType",
  "emptyObjectType",
  "emptyJsxObjectType",
  "emptyFreshJsxObjectType",
  "emptyTypeLiteralType",
  "unknownEmptyObjectType",
  "unknownUnionType",
  "emptyGenericType",
  "anyFunctionType",
  "noConstraintType",
  "circularConstraintType",
  "resolvingDefaultType",
  "markerSuperType",
  "markerSubType",
  "markerOtherType",
  "markerSuperTypeForCheck",
  "markerSubTypeForCheck",
  "emptyStringType",
  "zeroType",
  "zeroBigIntType",
  "typeofType",
] as const;

for (const count of [1, 4]) for (const custom of [false, true]) for (const exactOptionalPropertyTypes of [false, true]) {
  test(`native builtin construction anchors preserve roles with ${count} checkers, custom=${custom}, exactOptional=${exactOptionalPropertyTypes}`, () => {
    const base = createCompilerSessionFromFiles({
      currentDirectory: "/builtins", includeBundledLibraries: false,
      files: { "/builtins/core.d.ts": `${testCoreDeclarations}\ntype Uppercase<S extends string> = intrinsic;`, "/builtins/a.ts": `export const a = 1;
        export function f<T>(value:T):T{return value;}
        export function pair<T,U>(left:T,right:U):[T,U]{return [left,right];}
        export function plain(value:number):number{return value;}
        export function constrained<T extends {value:number}>(value:T):T{return value;}
        export class Box<T> {
          constructor(public value:T) {}
          method<U>(this:Box<T>, value:U):U{return value;}
          get read():T{return this.value;}
          set read(value:T){this.value=value;}
        }
        export interface Contract<T> { value:T; self():this; }
        export type Alias<T> = { readonly value?:T };
        export type AliasTuple<T,U> = [T,U];
        export type AliasChoice<T> = T|string;
        export type Homomorphic<T> = {[K in keyof T]:T[K]};
        export const literal = {value:1};
        export const spread = {...literal,second:"x"};
        export const contextual:{value:number} = {value:2};
        export enum Values { first=1, second=2, text="x", alias=1 }
        export enum OtherValues { first=1 }
        export function input():number{return 1;}
        export enum ComputedValues { first=input() }
        export namespace Left {export class Same {private value!:number;}}
        export namespace Right {export class Same {private value!:number;}}`,
        "/builtins/b.ts": "export const b = 2;", "/builtins/c.ts": "export const c = 3;", "/builtins/d.ts": "export const d = 4;" },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true, target: "es2022", checkers: count, exactOptionalPropertyTypes },
    });
    const baseProgram = base.program;
    if (baseProgram === undefined) throw new Error("The fixture requires its actual Program");
    let selectedPool: checkerPool | undefined;
    const session = custom ? createCompilerSession({ programOptions: { ...baseProgram.opts,
      CreateCheckerPool: program => {
        if (program === undefined) throw new Error("The custom pool requires its actual Program");
        const pool = newCheckerPool(program);
        if (pool === undefined) throw new Error("The native pool constructor must complete");
        selectedPool = pool;
        return checkerPool_as_compiler_CheckerPool(pool);
      } } }) : base;
    const checked = session.checkSource();
    assert.equal(checked.diagnostics.length, 0);
    const originalFile = checked.getSourceFile("/builtins/a.ts");
    if (originalFile === undefined) throw new Error("The original checked function file must exist");
    const queries = checked.getSourceFileQueries(originalFile);
    const declaration = findNodes(originalFile, queries.ast.children, queries.ast.is.IsFunctionDeclaration)[0];
    if (declaration === undefined) throw new Error("The actual checked generic declaration must exist");
    const program = session.program;
    if (program === undefined) throw new Error("The checked fixture requires its actual Program");
    const pool = custom ? selectedPool : program.compilerCheckerPool;
    if (pool === undefined) throw new Error("The fixture requires its selected native pool");
    const owners: Checker[] = [];
    for (const owner of pool.checkers) {
      if (owner === undefined) throw new Error("Every selected checker must be constructed by the checked fixture");
      owners.push(owner);
    }
    assert.equal(owners.length, count);
    const wrapped = createCompilerSessionFromProgram(program, session.host, session.config);
    assert.equal(wrapped.program === program, true);
    assert.equal(wrapped.checkSource().diagnostics.length, 0);
    for (const source of owners) for (const producer of owners) {
      assert.equal(source.program.SourceFiles() === producer.program.SourceFiles(), true, "actual same-Program outer admission");
      for (const anchor of anchors) {
        const original = source[anchor];
        const expected = producer[anchor];
        if (original === undefined || expected === undefined) throw new Error(`Actual native anchor missing: ${anchor}`);
        assert.equal(original.checker === source, true, anchor);
        assert.equal(reacquireBuiltinType(producer, original) === expected, true, anchor);
        assert.equal(reacquireBuiltinType(producer, original) === expected, true, `${anchor}: repeated exact acquisition`);
      }
      assert.equal(source.anyType === source.wildcardType, false, "same native flags/name do not make the roles identical");
      assert.equal(source.undefinedOrMissingType === (exactOptionalPropertyTypes ? source.missingType : source.undefinedType), true);
      assert.equal(source.regularTrueType === source.trueType, false, "fresh and regular native values are distinct");
      assert.equal(Type_AsLiteralType(producer.regularTrueType)?.freshType === producer.trueType, true);
      assert.equal(Type_AsLiteralType(producer.regularFalseType)?.freshType === producer.falseType, true);
      const constructed = Checker_newIntrinsicType(source, TypeFlagsAny, "any");
      if (constructed === undefined) throw new Error("The real native constructor must return its Type");
      assert.equal(reacquireBuiltinType(producer, constructed) === undefined, true,
        "a different actual native construction is not guessed to be a builtin by flags or name");
      assert.throws(() => reacquireBuiltinType(producer, { ...constructed, checker: undefined }),
        error => error instanceof TypeError && error.message === "A native type construction requires its actual producer");
      for (const anchor of ["anySignature", "unknownSignature", "resolvingSignature", "silentNeverSignature"] as const) {
        const original = source[anchor];
        const expected = producer[anchor];
        if (original === undefined || expected === undefined) throw new Error(`Actual native signature anchor missing: ${anchor}`);
        assert.equal(reacquireBuiltinSignature(source, producer, original) === expected, true, anchor);
        assert.equal(reacquireBuiltinSignature(source, producer, original) === expected, true, `${anchor}: repeated exact acquisition`);
        if (source !== producer) assert.throws(() => reacquireBuiltinSignature(producer, producer, original),
          error => error instanceof TypeError && error.message === "A native signature construction requires its actual producer");
      }
      assert.equal(source.anySignature === source.resolvingSignature, false, "same-signature constructor fields do not erase native roles");
      const signature = Checker_cloneSignature(source, source.anySignature, undefined);
      if (signature === undefined) throw new Error("The real native clone must return its Signature");
      assert.equal(reacquireBuiltinSignature(source, producer, signature) === undefined, true,
        "a genuine native clone is not its constructor's builtin role");
      for (const value of ["", "literal#/:", "é\ud800"]) {
        const original = Checker_getStringLiteralType(source, value);
        const expected = Checker_getStringLiteralType(producer, value);
        if (original === undefined || expected === undefined) throw new Error("The native string constructors must return their values");
        assert.equal(reacquireLiteralType(producer, original) === expected, true);
        const fresh = Checker_getFreshTypeOfLiteralType(source, original);
        if (fresh === undefined) throw new Error("The native fresh constructor must return its value");
        assert.equal(reacquireLiteralType(producer, fresh) === Checker_getFreshTypeOfLiteralType(producer, expected), true);
      }
      for (const value of ["0", "-0", "1.5", "1.7976931348623157e308"]) {
        const checkedValue = FromString(value);
        const original = Checker_getNumberLiteralType(source, checkedValue);
        const expected = Checker_getNumberLiteralType(producer, checkedValue);
        if (original === undefined || expected === undefined) throw new Error("The native numeric constructors must return their values");
        assert.equal(reacquireLiteralType(producer, original) === expected, true, "SDK checker evidence, not authored exact-rational capture");
        const fresh = Checker_getFreshTypeOfLiteralType(source, original);
        if (fresh === undefined) throw new Error("The native fresh constructor must return its value");
        assert.equal(reacquireLiteralType(producer, fresh) === Checker_getFreshTypeOfLiteralType(producer, expected), true);
      }
      for (const value of ["0n", "9007199254740993n", "-1208925819614629174706176n"]) {
        const checkedValue = ParseValidBigInt(value);
        const original = Checker_getBigIntLiteralType(source, checkedValue);
        const expected = Checker_getBigIntLiteralType(producer, checkedValue);
        if (original === undefined || expected === undefined) throw new Error("The native bigint constructors must return their values");
        assert.equal(reacquireLiteralType(producer, original) === expected, true, "native-width bigint is never routed through double");
        const fresh = Checker_getFreshTypeOfLiteralType(source, original);
        if (fresh === undefined) throw new Error("The native fresh constructor must return its value");
        assert.equal(reacquireLiteralType(producer, fresh) === Checker_getFreshTypeOfLiteralType(producer, expected), true);
      }
      const nativeString = source.stringType;
      if (nativeString === undefined) throw new Error("The actual primitive anchor must exist");
      assert.equal(reacquireLiteralType(producer, nativeString) === undefined, true, "a nonliteral is a different construction");
      const sourceType = Checker_GetTypeAtLocation(source, queries.ast.name(declaration));
      const targetType = Checker_GetTypeAtLocation(producer, queries.ast.name(declaration));
      if (sourceType === undefined || targetType === undefined) throw new Error("The actual checked function types must exist");
      const sourceSignature = Checker_getSignaturesOfType(source, sourceType, SignatureKindCall)[0];
      const targetSignature = Checker_getSignaturesOfType(producer, targetType, SignatureKindCall)[0];
      if (sourceSignature === undefined || targetSignature === undefined) throw new Error("The actual checked generic signatures must exist");
      assert.equal(reacquireDeclarationSignature(source, producer, sourceSignature) === targetSignature, true);
      const declarationClone = Checker_cloneSignature(source, sourceSignature, sourceSignature.constructorClass);
      if (declarationClone === undefined) throw new Error("The actual declaration clone must exist");
      assert.equal(declarationClone.declaration === sourceSignature.declaration, true);
      assert.equal(reacquireDeclarationSignature(source, producer, declarationClone), undefined,
        "the same declaration does not turn a cloned signature into its native declaration signature");
      for (const predicate of [queries.ast.is.IsConstructorDeclaration, queries.ast.is.IsMethodDeclaration,
        queries.ast.is.IsGetAccessorDeclaration, queries.ast.is.IsSetAccessorDeclaration]) {
        const member = findNodes(originalFile, queries.ast.children, predicate)[0];
        if (member === undefined) throw new Error("The checked member declaration must exist");
        const original = Checker_getSignatureFromDeclaration(source, member);
        const expected = Checker_getSignatureFromDeclaration(producer, member);
        if (original === undefined || expected === undefined) throw new Error("The actual native declaration signatures must exist");
        assert.equal(reacquireDeclarationSignature(source, producer, original) === expected, true);
        assert.equal(reacquireDeclarationSignature(source, producer, original) === expected, true);
        assert.equal(expected.parameters.length, original.parameters.length);
        assert.equal(expected.typeParameters.length, original.typeParameters.length);
        assert.equal(expected.thisParameter === undefined, original.thisParameter === undefined);
        assert.equal(expected.constructorClass === original.constructorClass, true);
        if (source !== producer) assert.throws(() => reacquireDeclarationSignature(producer, producer, original),
          error => error instanceof TypeError);
      }
      assert.equal(cachedSignatureConstruction(source, sourceSignature), undefined);
      const constructors = [
        ["erased", Checker_getErasedSignature(source, sourceSignature), Checker_getErasedSignature(producer, targetSignature)],
        ["canonical", Checker_getCanonicalSignature(source, sourceSignature), Checker_getCanonicalSignature(producer, targetSignature)],
        ["base", Checker_getBaseSignature(source, sourceSignature), Checker_getBaseSignature(producer, targetSignature)],
        ["inner-call", Checker_getOptionalCallSignature(source, sourceSignature, SignatureFlagsIsInnerCallChain),
          Checker_getOptionalCallSignature(producer, targetSignature, SignatureFlagsIsInnerCallChain)],
        ["outer-call", Checker_getOptionalCallSignature(source, sourceSignature, SignatureFlagsIsOuterCallChain),
          Checker_getOptionalCallSignature(producer, targetSignature, SignatureFlagsIsOuterCallChain)],
      ] as const;
      for (const [kind, original, expected] of constructors) {
        if (original === undefined || expected === undefined) throw new Error("The actual native derived signatures must exist");
        assert.equal(cachedSignatureConstruction(source, original), kind, "actual native cache relation, not inferred flags");
        assert.equal(reacquireCachedSignature(producer, kind, targetSignature) === expected, true);
        assert.equal(reacquireCachedSignature(producer, kind, targetSignature) === expected, true, "same native constructor cache");
        const originalIsolated = Checker_getOrCreateTypeFromSignature(source, original);
        const expectedIsolated = Checker_getOrCreateTypeFromSignature(producer, expected);
        if (originalIsolated === undefined || expectedIsolated === undefined) throw new Error("The actual native isolated signature types must exist");
        const normalizeSignature = (value: NonNullable<typeof original>): NonNullable<typeof expected> => {
          assert.equal(value === original, true, "the exact existing isolated-signature source relation");
          return expected;
        };
        assert.equal(reacquireSignatureType(producer, originalIsolated, normalizeSignature) === expectedIsolated, true);
        assert.equal(reacquireSignatureType(producer, originalIsolated, normalizeSignature) === expectedIsolated, true);
        if (source !== producer) {
          assert.throws(() => cachedSignatureConstruction(producer, original), error => error instanceof TypeError);
          assert.throws(() => reacquireCachedSignature(producer, kind, sourceSignature), error => error instanceof TypeError);
          assert.throws(() => reacquireSignatureType(producer, originalIsolated, () => original), error => error instanceof TypeError);
        }
      }
      assert.equal(reacquireSignatureType(producer, sourceType, () => targetSignature), undefined,
        "an ordinary declaration function type is not its isolated signature construction");
      for (const node of findNodes(originalFile, queries.ast.children, queries.ast.is.IsFunctionDeclaration)) {
        const original = Checker_getSignatureFromDeclaration(source, node);
        const normalized = Checker_getSignatureFromDeclaration(producer, node);
        if (original === undefined || normalized === undefined) throw new Error("The native generic declaration signatures must exist");
        const originalArguments = original.typeParameters.map((_parameter, index) => index === 0 ? source.stringType : source.numberType);
        const targetArguments = normalized.typeParameters.map((_parameter, index) => index === 0 ? producer.stringType : producer.numberType);
        if (targetArguments.some(type => type === undefined)) throw new Error("The actual native instantiation arguments must exist");
        const native = Checker_getSignatureInstantiationWithoutFillingInTypeArguments(source, original, originalArguments);
        const expected = Checker_getSignatureInstantiationWithoutFillingInTypeArguments(producer, normalized, targetArguments);
        if (native === undefined || expected === undefined) throw new Error("The actual native cached instantiations must exist");
        const arguments_ = cachedSignatureArguments(source, native);
        if (arguments_ === undefined) throw new Error("The actual source cache must retain its complete native construction relation");
        assert.equal(arguments_.length, originalArguments.length);
        assert.equal(arguments_.every((type, index) => type === originalArguments[index]), true,
          "native constructor argument order, not inference from parameter names");
        const requiredArguments: Type[] = [];
        for (const type of targetArguments) {
          if (type === undefined) throw new Error("The target native argument must exist");
          requiredArguments.push(type);
        }
        assert.equal(reacquireSignatureInstantiation(producer, normalized, requiredArguments) === expected, true);
        assert.equal(reacquireSignatureInstantiation(producer, normalized, requiredArguments) === expected, true);
        const clone = Checker_cloneSignature(source, native, native.constructorClass);
        if (clone === undefined) throw new Error("The actual native instantiated clone must exist");
        assert.equal(cachedSignatureArguments(source, clone), undefined,
          "a clone with inherited mapper fields is not the actual cached instantiation");
        if (source !== producer) {
          assert.throws(() => cachedSignatureArguments(producer, native), error => error instanceof TypeError);
          assert.throws(() => reacquireSignatureInstantiation(producer, original, requiredArguments), error => error instanceof TypeError);
        }
      }
      assert.equal(cachedSignatureConstruction(source, signature), undefined, "an uncached native clone cannot borrow a cached construction");
      const sourceParameter = sourceSignature.typeParameters[0];
      const targetParameter = targetSignature.typeParameters[0];
      if (sourceParameter === undefined || targetParameter === undefined) throw new Error("The actual declared type parameters must exist");
      assert.equal(reacquireDeclaredType(producer, sourceParameter) === targetParameter, true);
      const clonedParameter = Checker_cloneTypeParameter(source, sourceParameter);
      if (clonedParameter === undefined) throw new Error("The actual native cloned parameter must exist");
      assert.equal(clonedParameter.symbol === sourceParameter.symbol, true);
      assert.equal(reacquireDeclaredType(producer, clonedParameter), undefined,
        "a cloned parameter with the same symbol is not its original declaration's type");
      const declaredClasses: Type[] = [];
      for (const predicate of [queries.ast.is.IsClassDeclaration, queries.ast.is.IsInterfaceDeclaration, queries.ast.is.IsEnumDeclaration]) {
        for (const node of findNodes(originalFile, queries.ast.children, predicate)) {
          const symbol = Node_Symbol(node);
          if (symbol === undefined) throw new Error("The actual bound declaration symbol must exist");
          const original = Checker_getDeclaredTypeOfSymbol(source, symbol);
          const expected = Checker_getDeclaredTypeOfSymbol(producer, symbol);
          if (original === undefined || expected === undefined) throw new Error("The actual declared native types must exist");
          if (predicate === queries.ast.is.IsEnumDeclaration && original.symbol !== symbol) {
            assert.equal(reacquireDeclaredType(producer, original), undefined,
              "a collapsed single-member enum result is not an enum-owned declaration Type");
            assert.equal(reacquireLiteralType(producer, original) === expected, true,
              "the real native literal construction retains the collapsed enum's exact result");
          } else {
            assert.equal(reacquireDeclaredType(producer, original) === expected, true,
              "the exact native source declared-type relation selects its target constructor");
            assert.equal(reacquireDeclaredType(producer, original) === expected, true);
          }
          if (predicate === queries.ast.is.IsClassDeclaration) declaredClasses.push(expected);
          if (predicate !== queries.ast.is.IsEnumDeclaration) {
            const originalSelf = Type_AsInterfaceType(original)?.thisType;
            const expectedSelf = Type_AsInterfaceType(expected)?.thisType;
            if (originalSelf === undefined || expectedSelf === undefined) throw new Error("The actual native polymorphic self types must exist");
            assert.equal(reacquireDeclaredType(producer, originalSelf) === expectedSelf, true,
              "the exact declared owner's self remains distinct from its owner type");
            assert.equal(expectedSelf === expected, false);
          }
        }
      }
      assert.equal(declaredClasses.length, 3);
      assert.equal(declaredClasses[1] === declaredClasses[2], false, "same spelling does not merge private declaration owners");
      const normalizeAccessOperand = (value: Type): Type => {
        if (value === sourceParameter) return targetParameter;
        const builtin = reacquireBuiltinType(producer, value);
        if (builtin !== undefined) return builtin;
        const literal = reacquireLiteralType(producer, value);
        if (literal !== undefined) return literal;
        throw new Error("The access kernel fixture requires an actual declared parameter or native literal operand");
      };
      for (const flags of [IndexFlagsNone, IndexFlagsStringsOnly, IndexFlagsNoIndexSignatures, IndexFlagsNoReducibleCheck,
        IndexFlagsStringsOnly | IndexFlagsNoIndexSignatures, IndexFlagsStringsOnly | IndexFlagsNoReducibleCheck,
        IndexFlagsNoIndexSignatures | IndexFlagsNoReducibleCheck,
        IndexFlagsStringsOnly | IndexFlagsNoIndexSignatures | IndexFlagsNoReducibleCheck]) {
        const original = Checker_getIndexTypeEx(source, sourceParameter, flags);
        const expected = Checker_getIndexTypeEx(producer, targetParameter, flags);
        if (original === undefined || expected === undefined) throw new Error("The actual native index constructors must complete");
        assert.equal(reacquireTypeOperator(producer, original, normalizeAccessOperand) === expected, true,
          "actual index flags, not default keyof flags");
        assert.equal(Type_AsIndexType(original)?.indexFlags, Type_AsIndexType(expected)?.indexFlags);
      }
      const sourceIndex = Checker_getStringLiteralType(source, "value");
      const targetIndex = Checker_getStringLiteralType(producer, "value");
      if (sourceIndex === undefined || targetIndex === undefined) throw new Error("The actual native index values must exist");
      for (const flags of [AccessFlagsNone, AccessFlagsIncludeUndefined]) {
        const original = Checker_getIndexedAccessTypeEx(source, sourceParameter, sourceIndex, flags, undefined, undefined);
        const expected = Checker_getIndexedAccessTypeEx(producer, targetParameter, targetIndex, flags, undefined, undefined);
        if (original === undefined || expected === undefined) throw new Error("The actual deferred native indexed accesses must exist");
        assert.equal(reacquireTypeOperator(producer, original, normalizeAccessOperand) === expected, true,
          "persistent indexed access flags are part of the actual constructor");
        assert.equal(Type_AsIndexedAccessType(original)?.accessFlags, flags);
        assert.equal(Type_AsIndexedAccessType(expected)?.accessFlags, flags);
      }
      assert.equal(reacquireTypeOperator(producer, sourceParameter, normalizeAccessOperand), undefined,
        "the declared parameter is not itself an access construction");
      const core = checked.getSourceFile("/builtins/core.d.ts");
      if (core === undefined) throw new Error("The actual checked intrinsic declaration file must exist");
      const coreQueries = checked.getSourceFileQueries(core);
      const intrinsic = findNodes(core, coreQueries.ast.children, coreQueries.ast.is.IsTypeAliasDeclaration)[0];
      const intrinsicSymbol = intrinsic === undefined ? undefined : Node_Symbol(intrinsic);
      if (intrinsicSymbol === undefined) throw new Error("The genuine native intrinsic symbol must exist");
      const texts = ["prefix#/:", "middleé", "suffix\ud800"];
      const operations = [
        [Checker_getTemplateLiteralType(source, texts, [sourceParameter, source.stringType]),
          Checker_getTemplateLiteralType(producer, texts, [targetParameter, producer.stringType])],
        [Checker_getStringMappingType(source, intrinsicSymbol, sourceParameter),
          Checker_getStringMappingType(producer, intrinsicSymbol, targetParameter)],
        [Checker_getSubstitutionType(source, sourceParameter, source.stringType),
          Checker_getSubstitutionType(producer, targetParameter, producer.stringType)],
      ];
      for (const [original, expected] of operations) {
        if (original === undefined || expected === undefined) throw new Error("The actual native type operator must complete");
        assert.equal(reacquireTypeOperator(producer, original, normalizeAccessOperand) === expected, true);
        assert.equal(reacquireTypeOperator(producer, original, normalizeAccessOperand) === expected, true,
          "repeated acquisition uses the same native constructor cache");
        if (source !== producer) assert.throws(() => reacquireTypeOperator(producer, original, value => value),
          error => error instanceof TypeError && error.message === "A native type operator requires its normalized input producer");
      }
      const label = findNodes(originalFile, queries.ast.children, queries.ast.is.IsParameterDeclaration)[0];
      if (label === undefined) throw new Error("The actual checked tuple label declaration must exist");
      for (const readonly of [false, true]) for (const labeled of [false, true]) {
        const elements: TupleElementInfo[] = [
          { flags: ElementFlagsRequired, labeledDeclaration: labeled ? label : undefined },
          { flags: ElementFlagsOptional, labeledDeclaration: undefined },
        ];
        const originalTarget = Checker_getTupleTargetType(source, elements, readonly);
        const expectedTarget = Checker_getTupleTargetType(producer, elements, readonly);
        if (originalTarget === undefined || expectedTarget === undefined) throw new Error("The native tuple targets must exist");
        assert.equal(reacquireTypeReference(producer, originalTarget, () => {
          throw new Error("The target's generated parameters must not be reconstructed independently");
        }) === expectedTarget, true, "actual tuple labels, element flags and readonly mode select the native target");
        const normalizeReference = (value: Type): Type => value === originalTarget ? expectedTarget : normalizeAccessOperand(value);
        const original = Checker_createTypeReference(source, originalTarget, [sourceParameter, source.numberType]);
        const expected = Checker_createTypeReference(producer, expectedTarget, [targetParameter, producer.numberType]);
        if (original === undefined || expected === undefined) throw new Error("The native tuple references must exist");
        assert.equal(reacquireTypeReference(producer, original, normalizeReference) === expected, true);
        assert.equal(reacquireTypeReference(producer, original, normalizeReference) === expected, true);
        const clone = Checker_cloneTypeReference(source, original);
        if (clone === undefined) throw new Error("The actual native reference clone must exist");
        assert.equal(reacquireTypeReference(producer, clone, normalizeReference), undefined,
          "the same target and arguments do not turn an uncached native clone into its original construction");
        if (source !== producer) assert.throws(() => reacquireTypeReference(producer, original, value => value),
          error => error instanceof TypeError && error.message === "A native reference requires its normalized input producer");
      }
      const boxNode = findNodes(originalFile, queries.ast.children, queries.ast.is.IsClassDeclaration)[0];
      const boxSymbol = boxNode === undefined ? undefined : Node_Symbol(boxNode);
      const originalBox = Checker_getDeclaredTypeOfSymbol(source, boxSymbol);
      const expectedBox = Checker_getDeclaredTypeOfSymbol(producer, boxSymbol);
      if (originalBox === undefined || expectedBox === undefined) throw new Error("The genuine generic class targets must exist");
      const originalBoxReference = Checker_createTypeReference(source, originalBox, [source.stringType]);
      const expectedBoxReference = Checker_createTypeReference(producer, expectedBox, [producer.stringType]);
      if (originalBoxReference === undefined || expectedBoxReference === undefined) throw new Error("The genuine class instantiations must exist");
      assert.equal(reacquireTypeReference(producer, originalBoxReference,
        value => value === originalBox ? expectedBox : normalizeAccessOperand(value)) === expectedBoxReference, true);
      for (const aliasNode of findNodes(originalFile, queries.ast.children, queries.ast.is.IsTypeAliasDeclaration)) {
        const symbol = Node_Symbol(aliasNode);
        const original = Checker_getDeclaredTypeOfSymbol(source, symbol);
        const expected = Checker_getDeclaredTypeOfSymbol(producer, symbol);
        if (original === undefined || expected === undefined) throw new Error("The actual native declared aliases must exist");
        assert.equal(reacquireTypeAlias(producer, original, normalizeAccessOperand) === expected, true);
        const parameters = original.alias?.typeArguments;
        if (parameters === undefined) throw new Error("The genuine generic aliases must retain their native parameters");
        const originalArguments = parameters.map((_value, index) => index === 0 ? sourceParameter : source.numberType);
        const expectedArguments = parameters.map((_value, index) => index === 0 ? targetParameter : producer.numberType);
        const originalInstantiation = Checker_getTypeAliasInstantiation(source, symbol, originalArguments, undefined);
        const expectedInstantiation = Checker_getTypeAliasInstantiation(producer, symbol, expectedArguments, undefined);
        if (originalInstantiation === undefined || expectedInstantiation === undefined) throw new Error("The native generic aliases must instantiate");
        assert.equal(reacquireTypeAlias(producer, originalInstantiation, normalizeAccessOperand) === expectedInstantiation, true);
        assert.equal(reacquireTypeAlias(producer, originalInstantiation, normalizeAccessOperand) === expectedInstantiation, true);
        if (source !== producer) assert.throws(() => reacquireTypeAlias(producer, originalInstantiation, value => value),
          error => error instanceof TypeError && error.message === "A native type alias requires its normalized input producer");
      }
      const constrainedNode: Node | undefined = findNodes(originalFile, queries.ast.children, queries.ast.is.IsFunctionDeclaration)[3];
      if (constrainedNode === undefined) throw new Error("The authored constrained function must exist");
      const originalConstrained: Type | undefined = Checker_getSignatureFromDeclaration(source, constrainedNode)?.typeParameters[0];
      const expectedConstrained: Type | undefined = Checker_getSignatureFromDeclaration(producer, constrainedNode)?.typeParameters[0];
      if (originalConstrained === undefined || expectedConstrained === undefined) throw new Error("The actual declared constrained parameters must exist");
      const restriction = Checker_getRestrictiveTypeParameter(source, originalConstrained);
      const expectedRestriction = Checker_getRestrictiveTypeParameter(producer, expectedConstrained);
      if (restriction === undefined || expectedRestriction === undefined) throw new Error("The native restrictions must exist");
      assert.equal(restriction === originalConstrained, false);
      assert.equal(reacquireDeclaredRestriction(producer, restriction) === expectedRestriction, true);
      assert.equal(reacquireDeclaredRestriction(producer, restriction) === expectedRestriction, true);
      assert.equal(reacquireDeclaredRestriction(producer, originalConstrained), undefined);
      const restrictionClone = Checker_cloneTypeParameter(source, restriction);
      if (restrictionClone === undefined) throw new Error("The genuine restriction clone must exist");
      assert.equal(reacquireDeclaredRestriction(producer, restrictionClone), undefined,
        "shared parameter symbol alone does not prove a restrictive construction");
      for (const expression of findNodes(originalFile, queries.ast.children, queries.ast.is.IsObjectLiteralExpression)) {
        const original = Checker_checkExpressionCached(source, expression);
        const expected = Checker_checkExpressionCached(producer, expression);
        if (original === undefined || expected === undefined) throw new Error("The genuine normal-mode expression caches must exist");
        assert.equal(reacquireCachedObjectExpression(producer, original) === expected, true);
        assert.equal(reacquireCachedObjectExpression(producer, original) === expected, true);
        for (const factory of [Checker_getRegularTypeOfObjectLiteral, Checker_getWidenedType]) {
          const transformed = factory(source, original);
          const expectedTransformed = factory(producer, expected);
          if (transformed === undefined || expectedTransformed === undefined) throw new Error("The native context-free expression construction must complete");
          assert.equal(reacquireCachedObjectExpression(producer, transformed) === expectedTransformed, true);
        }
        const contextual = Checker_checkExpressionCachedEx(source, expression, CheckModeContextual);
        if (contextual === undefined) throw new Error("The genuine contextual checker operation must complete");
        assert.equal(contextual === original, false);
        assert.equal(reacquireCachedObjectExpression(producer, contextual), undefined,
          "the same node is not enough to reconstruct a context-specific uncached expression");
        const unrelated = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
        if (unrelated === undefined) throw new Error("The genuine anonymous construction must complete");
        assert.equal(reacquireCachedObjectExpression(producer, unrelated), undefined,
          "shared source symbol is not the native cached expression relation");
      }
      const enumResults: Type[] = [];
      for (const node of findNodes(originalFile, queries.ast.children, queries.ast.is.IsEnumMember)) {
        const symbol = Node_Symbol(node);
        const original = Checker_getTypeOfSymbol(source, symbol);
        const expected = Checker_getTypeOfSymbol(producer, symbol);
        if (original === undefined || expected === undefined) throw new Error("The genuine enum member types must exist");
        const regular = Type_AsLiteralType(original)?.regularType;
        const expectedRegular = Type_AsLiteralType(expected)?.regularType;
        if (regular === undefined || expectedRegular === undefined) throw new Error("The real enum literal relation must exist");
        assert.equal(reacquireLiteralType(producer, original) === expected, true);
        assert.equal(reacquireLiteralType(producer, regular) === expectedRegular, true);
        assert.equal(reacquireLiteralType(producer, original) === expected, true);
        enumResults.push(expected);
      }
      assert.equal(enumResults.length, 6);
      assert.equal(enumResults[0] === enumResults[3], true, "native equal-value enum aliases keep the same native identity");
      assert.equal(enumResults[0] === enumResults[4], false, "equal values in different real enums retain different owners");
      const mappingNode = findNodes(originalFile, queries.ast.children, queries.ast.is.IsTypeAliasDeclaration)[3];
      const mappingSymbol = mappingNode === undefined ? undefined : Node_Symbol(mappingNode);
      const originalMapping = Checker_getDeclaredTypeOfSymbol(source, mappingSymbol);
      const expectedMapping = Checker_getDeclaredTypeOfSymbol(producer, mappingSymbol);
      const inputNode = findNodes(originalFile, queries.ast.children, queries.ast.is.IsObjectLiteralExpression)[0];
      if (originalMapping === undefined || expectedMapping === undefined || inputNode === undefined) throw new Error("The real reverse-map source and mapped declaration must exist");
      const originalConstraint = Checker_getConstraintTypeFromMappedType(source, originalMapping);
      const expectedConstraint = Checker_getConstraintTypeFromMappedType(producer, expectedMapping);
      const originalInput = Checker_checkExpressionCached(source, inputNode);
      const expectedInput = Checker_checkExpressionCached(producer, inputNode);
      if (originalConstraint === undefined || expectedConstraint === undefined || originalInput === undefined || expectedInput === undefined) {
        throw new Error("The real reverse-map operands must exist");
      }
      const reverse = Checker_inferTypeForHomomorphicMappedType(source, originalInput, originalMapping, originalConstraint);
      const expectedReverse = Checker_inferTypeForHomomorphicMappedType(producer, expectedInput, expectedMapping, expectedConstraint);
      if (reverse === undefined || expectedReverse === undefined) throw new Error("The genuine cached homomorphic reverse mappings must exist");
      const normalizeReverse = (value: Type): Type => {
        if (value === originalInput) return expectedInput;
        if (value === originalMapping) return expectedMapping;
        if (value === originalConstraint) return expectedConstraint;
        throw new Error("The reverse-map fixture requires one of its exact three native operands");
      };
      assert.equal(reacquireTypeOperator(producer, reverse, normalizeReverse) === expectedReverse, true);
      assert.equal(reacquireTypeOperator(producer, reverse, normalizeReverse) === expectedReverse, true);
      const uncachedReverse = Checker_createReverseMappedType(source, originalInput, originalMapping, originalConstraint);
      if (uncachedReverse === undefined) throw new Error("The genuine uncached reverse-map constructor must complete");
      assert.equal(reacquireTypeOperator(producer, uncachedReverse, normalizeReverse), undefined,
        "the same three operands are not proof an uncached new reverse-map Type is its cached construction");
    }
  });
}
