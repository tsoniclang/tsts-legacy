import type { GoPtr } from "../go/compat.js";
import { readObjectPropertyInfo, readTypeIndexInfo, readTypePropertyInfo, readTypePropertyHeader } from "./type-members.js";
import { readTypeIndexedAccessComponents, selectTypeIndexedAccess } from "./type-indexed-access.js";
import type { TypeIndexedAccessComponents, TypeIndexedAccessSelection } from "./type-indexed-access.js";
import { readTypeKeyOfComponents, readTypeSubstitutionComponents } from "./type-dependent-operands.js";
import type { TypeKeyOfComponents, TypeSubstitutionComponents } from "./type-dependent-operands.js";
import { readConditionalApplication, readTypeAliasApplication, resolveTypeAliasApplication,
  type RetainedTypeAliasApplication, type TypeAliasApplicationInfo } from "./type-applications.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import { Node_Symbol, Node_Type, SourceFile_FileName } from "../internal/ast/ast.js";
import { AsConditionalTypeNode } from "../internal/ast/generated/casts.js";
import { IsLiteralTypeNode } from "../internal/ast/generated/predicates.js";
import { KindEnumDeclaration } from "../internal/ast/generated/kinds.js";
import { Node_AsNode } from "../internal/ast/spine.js";
import { GetSourceFileOfNode, IsFunctionLike } from "../internal/ast/utilities.js";
import type { Symbol } from "../internal/ast/symbol.js";
import { SymbolFlagsEnum, SymbolFlagsEnumMember } from "../internal/ast/symbolflags.js";
import {
  CheckFlagsOptionalParameter,
  CheckFlagsRestParameter,
} from "../internal/ast/checkflags.js";
import type { Program } from "../internal/compiler/program.js";
import { Program_GetSourceFile, Program_GetTypeCheckerForFile, Program_HasUsableCheckerSession, Program_OfChecker, Program_SourceFiles } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { withOwnedChecker, withCheckerById, withOwnedCheckerAcquisition } from "./checker-ownership.js";
import { admitNativeChecker, type NativeCheckerAdmission, type NativeCheckerResult } from "../internal/checker/resource-admission.js";
import { createTypeNormalization } from "./type-normalization.js";
import { completedAnnotationSource, originalSignatureDeclaration, signatureReturnAnswer, sourceTypeAnswer } from "../internal/checker/checker/source-type-answers.js";
import { resolveSourceTypeAnswer } from "./source-type-answer.js";
import type { CheckerDiagnosticMembership, ResolvedSourceTypeInfo, SourceTypeAnswer } from "../internal/checker/checker/source-type-answers.js";
import type { Context } from "../go/context.js";
import { Background } from "../go/context.js";
import {
  Checker_GetApparentType,
  Checker_GetExpandedParameters,
  Checker_GetIndexInfosOfType,
  Checker_GetReturnTypeOfSignature,
  Checker_GetSignaturesOfType,
  Checker_GetTypeArguments,
  Checker_GetTypeFromTypeNode,
  Checker_GetWidenedType,
  Checker_IsArrayLikeType,
  Checker_RemoveMissingOrUndefinedType,
  IsTupleType,
} from "../internal/checker/exports.js";
import {
  Checker_getTypeOfSymbol,
  Checker_getInstantiatedBaseTypes,
  Checker_resolveStructuredTypeMembers,
} from "../internal/checker/checker/symbols.js";
import { Checker_getBaseTypeOfLiteralType, Checker_getPropertiesOfObjectType, Checker_getPropertiesOfUnionOrIntersectionType, Checker_getReducedApparentType, Checker_GetNonNullableType } from "../internal/checker/checker/types.js";
import { Checker_isOptionalParameter } from "../internal/checker/utilities.js";
import { Checker_getSignatureFromDeclaration } from "../internal/checker/checker/signatures.js";
import {
  getBigIntLiteralValue,
  getNumberLiteralValue,
  getStringLiteralValue,
  signatureHasRestParameter,
} from "../internal/checker/checker/state.js";
import { PseudoBigInt_String } from "../internal/jsnum/pseudobigint.js";
import { Checker_getMinArgumentCount, Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import {
  Checker_GetConstantValue,
} from "../internal/checker/services.js";
import { Checker_TypeToString } from "../internal/checker/printer.js";
import type { Checker } from "../internal/checker/checker/state.js";
import {
  ElementFlagsOptional,
  ElementFlagsRest,
  ElementFlagsVariadic,
  ObjectFlagsReference,
  ObjectFlagsClassOrInterface,
  SignatureKindCall,
  SignatureKindConstruct,
  StructuredType_Properties,
  TypeFlagsAny,
  TypeFlagsBigIntLike,
  TypeFlagsBigIntLiteral,
  TypeFlagsBooleanLike,
  TypeFlagsBooleanLiteral,
  TypeFlagsConditional,
  TypeFlagsEnumLike,
  TypeFlagsESSymbolLike,
  TypeFlagsIntersection,
  TypeFlagsNever,
  TypeFlagsNonPrimitive,
  TypeFlagsNull,
  TypeFlagsNumberLike,
  TypeFlagsNumberLiteral,
  TypeFlagsObject,
  TypeFlagsStringLike,
  TypeFlagsStringLiteral,
  TypeFlagsStructuredType,
  TypeFlagsStructuredOrInstantiable,
  TypeFlagsUnion,
  TypeFlagsUnknown,
  TypeFlagsVoidLike,
  TypeFlagsUndefined,
  TypeFlagsVoid,
  Type_Target,
  Type_TargetTupleType,
  Type_AsConditionalType,
  Type_AsInterfaceType,
  Type_AsLiteralType,
  LiteralType_Value,
  InterfaceType_TypeParameters,
  Type_Types,
  Signature_ThisParameter,
} from "../internal/checker/types.js";
import type { Signature, Type } from "../internal/checker/types.js";

export interface TypeIndexInfo {
  readonly keyType: GoPtr<Type>;
  readonly valueType: GoPtr<Type>;
  readonly readonly: boolean;
  readonly declaration: GoPtr<Node>;
  readonly symbol: GoPtr<Symbol>;
  readonly components: readonly GoPtr<Node>[];
}

export interface TypeReferenceArgumentInfo {
  readonly parameter: Type;
  readonly argument: Type;
  readonly scope: "outer" | "local";
}

export interface TypeConditionalBranch {
  readonly kind: "completed" | "invariant-atom";
  readonly type: Type;
}

export interface TypeConditionalComponents {
  readonly declaration: Node;
  readonly checkType: Type;
  readonly extendsType: Type;
  readonly distributive: boolean;
  readonly inferParameters: readonly Type[];
  readonly application: RetainedTypeAliasApplication["bindings"] | null;
  readonly trueBranch: TypeConditionalBranch | undefined;
  readonly falseBranch: TypeConditionalBranch | undefined;
}

export interface TypeMappedPropertyInfo {
  readonly keyType: GoPtr<Type>;
  readonly syntheticOrigin: GoPtr<Symbol>;
  readonly declaration: GoPtr<Node>;
}

export interface TypePropertyHeader {
  readonly symbol: Symbol;
  readonly rootSymbols: readonly Symbol[];
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly intrinsicOrigin?: "global-this" | "undefined";
  readonly classPrototype?: Node;
}

export interface TypePropertyInfo extends TypePropertyHeader {
  readonly type: Type;
  readonly typeSource?: Node;
  readonly bindingPattern?: { readonly element: Node; readonly keyType: Type };
  readonly mapped?: TypeMappedPropertyInfo;
}

export type TypePropertyRead<Stop extends object> = NativeCheckerResult<TypePropertyInfo, Stop>;

interface NativePropertyInventory<Value> {
  readonly length: number;
  readonly read: <Stop extends object>(index: number, admit: NativeCheckerAdmission<Stop>) => NativeCheckerResult<Value, Stop>;
}

export type TypePropertyInventory = NativePropertyInventory<TypePropertyInfo>;
export type TypePropertyHeaderInventory = NativePropertyInventory<TypePropertyHeader>;

export interface StructuredTypeInventory {
  readonly signatures: readonly GoPtr<Signature>[];
  readonly callSignatureCount: number;
  readonly indexes: readonly TypeIndexInfo[];
  readonly properties: TypePropertyInventory;
}

export interface TypeTupleElementInfo {
  readonly type: Type;
  readonly elementKind: "required" | "optional" | "rest" | "variadic";
  readonly declaration?: Node;
}

export interface TypeTupleInfo {
  readonly readonly: boolean;
  readonly elements: readonly TypeTupleElementInfo[];
}

export interface TypeSignatureParameterInfo {
  readonly sourceSymbol: Symbol;
  readonly type: Type;
  readonly typeSource?: Node;
  readonly parameterKind: "required" | "optional" | "rest";
  readonly acceptsOmission: boolean;
  readonly declaration?: Node;
}

export interface TypeSignatureThisParameterInfo {
  readonly symbol: Symbol;
  readonly type: Type;
  readonly declaration?: Node;
}

export interface TypeSignatureInfo {
  readonly signature: Signature;
  readonly parameters: readonly TypeSignatureParameterInfo[];
  readonly thisParameter?: TypeSignatureThisParameterInfo;
  readonly returnType: ResolvedSourceTypeInfo | undefined;
}

type OwnedSignatureInfo = Omit<TypeSignatureInfo, "returnType"> & { returnType: SourceTypeAnswer | undefined };

export interface CreateTypeShapeQueriesOptions {
  readonly sourceFile: GoPtr<SourceFile>;
  readonly context?: Context;
  readonly admitsCheckerDiagnostic?: CheckerDiagnosticMembership;
}

export interface TypeIntrinsicNullishFlags {
  readonly null: boolean;
  readonly undefined: boolean;
}

export interface TypeShapeQueries {
  readonly typeToString: (type: GoPtr<Type>) => string;
  readonly getTypeFromTypeNode: (node: GoPtr<Node>) => GoPtr<ResolvedSourceTypeInfo>;
  readonly instantiateTypeAlias: (declaration: GoPtr<Node>, arguments_: readonly Type[]) => TypeAliasApplicationInfo | undefined;
  readonly getTypeAliasApplication: (type: GoPtr<Type>) => RetainedTypeAliasApplication | undefined;
  readonly getConstantValue: (node: GoPtr<Node>) => unknown;
  readonly getNumericLiteralTypeValue: (type: GoPtr<Type>) => number | bigint | undefined;
  readonly getStringLiteralTypeValue: (type: GoPtr<Type>) => string | undefined;
  readonly getBooleanLiteralTypeValue: (type: GoPtr<Type>) => boolean | undefined;
  readonly isAny: (type: GoPtr<Type>) => boolean;
  readonly isError: (type: GoPtr<Type>) => boolean;
  readonly isUnknown: (type: GoPtr<Type>) => boolean;
  readonly isNever: (type: GoPtr<Type>) => boolean;
  readonly isNonPrimitive: (type: GoPtr<Type>) => boolean;
  readonly isGlobalScopeObject: (type: GoPtr<Type>) => boolean;
  readonly isVoidLike: (type: GoPtr<Type>) => boolean;
  readonly isNullish: (type: GoPtr<Type>) => boolean;
  readonly intrinsicNullishFlags: (type: GoPtr<Type>) => TypeIntrinsicNullishFlags;
  readonly isStringLike: (type: GoPtr<Type>) => boolean;
  readonly isNumberLike: (type: GoPtr<Type>) => boolean;
  readonly isBooleanLike: (type: GoPtr<Type>) => boolean;
  readonly isBigIntLike: (type: GoPtr<Type>) => boolean;
  readonly isSymbolLike: (type: GoPtr<Type>) => boolean;
  readonly isUnion: (type: GoPtr<Type>) => boolean;
  readonly isIntersection: (type: GoPtr<Type>) => boolean;
  readonly isTypeReference: (type: GoPtr<Type>) => boolean;
  readonly isTuple: (type: GoPtr<Type>) => boolean;
  readonly isArrayLike: (type: GoPtr<Type>) => boolean;
  readonly isTypeIdenticalTo: (
    left: GoPtr<Type>,
    right: GoPtr<Type>,
  ) => boolean;
  readonly couldContainTypeVariables: (type: GoPtr<Type>) => boolean;
  readonly getUnionOrIntersectionTypes: (type: GoPtr<Type>) => readonly GoPtr<Type>[];
  readonly getTypeReferenceTarget: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly getTypeArguments: (type: GoPtr<Type>) => readonly GoPtr<Type>[];
  readonly getTypeReferenceArgumentInfos: (type: GoPtr<Type>) => readonly TypeReferenceArgumentInfo[] | undefined;
  readonly getInstantiatedBaseTypes: (type: GoPtr<Type>) => readonly Type[] | undefined;
  readonly getKeyOfComponents: (type: GoPtr<Type>) => TypeKeyOfComponents | undefined;
  readonly getSubstitutionComponents: (type: GoPtr<Type>) => TypeSubstitutionComponents | undefined;
  readonly getTupleInfo: (type: GoPtr<Type>) => TypeTupleInfo | undefined;
  readonly getObjectPropertyInfo: (type: GoPtr<Type>, name: string) => TypePropertyInfo | null | undefined;
  readonly getEnumOwnerDeclaration: (type: GoPtr<Type>) => GoPtr<Node>;
  readonly getObjectPropertyHeaders: <Stop extends object>(type: GoPtr<Type>, admit: NativeCheckerAdmission<Stop>) => NativeCheckerResult<TypePropertyHeaderInventory, Stop>;
  readonly getStructuredInventory: <Stop extends object>(type: GoPtr<Type>, admit: NativeCheckerAdmission<Stop>) => NativeCheckerResult<StructuredTypeInventory, Stop>;
  readonly getCallSignatures: (type: GoPtr<Type>) => readonly GoPtr<Signature>[];
  readonly getConstructSignatures: (type: GoPtr<Type>) => readonly GoPtr<Signature>[];
  readonly getSignatureInfos: (type: GoPtr<Type>, kind: "call" | "construct") => readonly TypeSignatureInfo[];
  readonly getDeclarationSignatureInfo: (declaration: GoPtr<Node>) => TypeSignatureInfo | undefined;
  readonly getSignatureParameterInfos: (
    signature: GoPtr<Signature>,
  ) => readonly TypeSignatureParameterInfo[];
  readonly getSignatureThisParameterInfo: (
    signature: GoPtr<Signature>,
  ) => TypeSignatureThisParameterInfo | undefined;
  readonly getReturnTypeOfSignature: (signature: GoPtr<Signature>) => GoPtr<ResolvedSourceTypeInfo>;
  readonly getIndexInfos: (type: GoPtr<Type>) => readonly TypeIndexInfo[];
  readonly getIndexedAccessComponents: (type: GoPtr<Type>) => TypeIndexedAccessComponents | undefined;
  readonly getConditionalComponents: (type: GoPtr<Type>) => TypeConditionalComponents | undefined;
  readonly selectIndexedAccess: (objectType: GoPtr<Type>, indexType: GoPtr<Type>) => TypeIndexedAccessSelection | undefined;
  readonly getApparentType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly getWidenedType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly getBaseTypeOfLiteralType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly removeMissingOrUndefined: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly getNonNullableType: (type: GoPtr<Type>) => GoPtr<Type>;
}

export function createTypeShapeQueries(program: GoPtr<Program>, defaultOptions: CreateTypeShapeQueriesOptions): TypeShapeQueries {
  if (program === undefined || defaultOptions.sourceFile === undefined) {
    throw new Error("Type-shape queries require one source file from the compiler program.");
  }
  const withObject = <Value>(type: GoPtr<Type>, read: (checker: Checker, type: Type) => Value): Value | undefined => {
    if (type === undefined || !hasFlags(type, TypeFlagsObject) || type.data.AsType() !== type) return undefined;
    return withCheckerForType(program, type, defaultOptions, checker =>
      checker === undefined || checker.program.SourceFiles() !== Program_SourceFiles(program)
        ? undefined : read(checker, type));
  };
  const queries: TypeShapeQueries = {
    typeToString: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_TypeToString(checker, type)) ?? "",
    getTypeFromTypeNode: (node) => resolveSourceTypeAnswer(program, defaultOptions,
      withCheckerForNode(program, node, defaultOptions, checker =>
        sourceTypeAnswer(checker, node, Checker_GetTypeFromTypeNode(checker, node), defaultOptions.admitsCheckerDiagnostic))),
    instantiateTypeAlias: (declaration, arguments_) => withCheckerForNode(
      program, declaration, defaultOptions,
      checker => resolveTypeAliasApplication(checker, declaration, arguments_),
    ),
    getTypeAliasApplication: (type) => withOwnedChecker(
      program, defaultOptions.sourceFile, type?.checker, defaultOptions.context ?? Background(),
      checker => readTypeAliasApplication(checker, type),
    ),
    getIndexedAccessComponents: (type) => withOwnedChecker(
      program, defaultOptions.sourceFile, type?.checker, defaultOptions.context ?? Background(),
      checker => readTypeIndexedAccessComponents(checker, type),
    ),
    getConditionalComponents: (type) => withOwnedChecker(
      program, defaultOptions.sourceFile, type?.checker, defaultOptions.context ?? Background(),
      checker => readTypeConditionalComponents(checker, type),
    ),
    selectIndexedAccess: (objectType, indexType) => withOwnedChecker(
      program, defaultOptions.sourceFile, objectType?.checker, defaultOptions.context ?? Background(),
      checker => checker.program.SourceFiles() === Program_SourceFiles(program)
        ? selectTypeIndexedAccess(checker, objectType, indexType) : undefined,
    ),
    getConstantValue: (node) => withCheckerForNode(program, node, defaultOptions, (checker) => Checker_GetConstantValue(checker, node)),
    getNumericLiteralTypeValue: (type) => withCheckerForType(program, type, defaultOptions, () => {
      if (hasFlags(type, TypeFlagsNumberLiteral)) return getNumberLiteralValue(type);
      if (hasFlags(type, TypeFlagsBigIntLiteral)) return BigInt(PseudoBigInt_String(getBigIntLiteralValue(type)));
      return undefined;
    }),
    getStringLiteralTypeValue: (type) => withCheckerForType(program, type, defaultOptions, () =>
      hasFlags(type, TypeFlagsStringLiteral) ? getStringLiteralValue(type) : undefined),
    getBooleanLiteralTypeValue: (type) => withCheckerForType(program, type, defaultOptions, () => {
      if (!hasFlags(type, TypeFlagsBooleanLiteral)) return undefined;
      const value = LiteralType_Value(Type_AsLiteralType(type));
      return typeof value === "boolean" ? value : undefined;
    }),
    isAny: (type) => hasFlags(type, TypeFlagsAny),
    isError: (type) => type !== undefined && type.checker !== undefined && type === type.checker.errorType,
    isUnknown: (type) => hasFlags(type, TypeFlagsUnknown),
    isNever: (type) => hasFlags(type, TypeFlagsNever),
    isNonPrimitive: (type) => hasFlags(type, TypeFlagsNonPrimitive),
    isGlobalScopeObject: (type) => type !== undefined && withCheckerForType(program, type, defaultOptions, checker => {
      if (checker === undefined) return false;
      const symbol = checker.globalThisSymbol;
      return symbol !== undefined && type.symbol === symbol
        && LinkStore_TryGet(checker.valueSymbolLinks, symbol)?.resolvedType === type;
    }) === true,
    isVoidLike: (type) => hasFlags(type, TypeFlagsVoidLike) || hasFlags(type, TypeFlagsVoid),
    isNullish: (type) => hasFlags(type, TypeFlagsNull) || hasFlags(type, TypeFlagsUndefined),
    intrinsicNullishFlags: (type) => Object.freeze({
      null: hasFlags(type, TypeFlagsNull),
      undefined: hasFlags(type, TypeFlagsUndefined),
    }),
    isStringLike: (type) => hasFlags(type, TypeFlagsStringLike),
    isNumberLike: (type) => hasFlags(type, TypeFlagsNumberLike),
    isBooleanLike: (type) => hasFlags(type, TypeFlagsBooleanLike),
    isBigIntLike: (type) => hasFlags(type, TypeFlagsBigIntLike),
    isSymbolLike: (type) => hasFlags(type, TypeFlagsESSymbolLike),
    isUnion: (type) => hasFlags(type, TypeFlagsUnion),
    isIntersection: (type) => hasFlags(type, TypeFlagsIntersection),
    isTypeReference: (type) => type !== undefined && (type.objectFlags & ObjectFlagsReference) !== 0,
    isTuple: isTupleType,
    isArrayLike: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_IsArrayLikeType(checker, type)) === true,
    isTypeIdenticalTo: (left, right) => withOwnedChecker(
      program, defaultOptions.sourceFile, left?.checker, defaultOptions.context ?? Background(),
      checker => {
        if (left === undefined || right?.checker === undefined || checker.program.SourceFiles() !== Program_SourceFiles(program) ||
          right.checker.program!.SourceFiles() !== checker.program!.SourceFiles()) return false;
        return Checker_isTypeIdenticalTo(checker, left,
          right.checker === checker ? right : createTypeNormalization(checker).type(right));
      },
    ) === true,
    couldContainTypeVariables: (type) => withCheckerForType(
      program,
      type,
      defaultOptions,
      (checker) => {
        if (checker === undefined) {
          throw new Error("The source type has no owning checker for genericity analysis.");
        }
        return checker.couldContainTypeVariables(type);
      },
    ) === true,
    getUnionOrIntersectionTypes: (type) => Type_Types(type) ?? [],
    getTypeReferenceTarget: (type) => withCheckerForType(program, type, defaultOptions, () =>
      hasFlags(type, TypeFlagsObject) ? Type_Target(type) : undefined),
    getTypeArguments: (type) => withCheckerForType(program, type, defaultOptions, (checker) =>
      hasFlags(type, TypeFlagsObject) && type !== undefined && (type.objectFlags & ObjectFlagsReference) !== 0
        ? Checker_GetTypeArguments(checker, type)
        : []) ?? [],
    getInstantiatedBaseTypes(type) {
      return withOwnedChecker(program, defaultOptions.sourceFile, type?.checker,
        defaultOptions.context ?? Background(), owner => {
        const bases = Checker_getInstantiatedBaseTypes(owner, type);
        if (bases === undefined) return undefined;
        const selected: Type[] = [];
        for (const base of bases) {
          if (base === undefined || base === owner.errorType) return undefined;
          selected.push(base);
        }
        return Object.freeze(selected);
      });
    },
    getTypeReferenceArgumentInfos: (type) => withCheckerForType(program, type, defaultOptions, (checker) => {
      if (type === undefined || checker === undefined || !hasFlags(type, TypeFlagsObject)) return undefined;
      const target = Type_Target(type) ?? type;
      if ((target.objectFlags & ObjectFlagsClassOrInterface) === 0) return undefined;
      const definition = Type_AsInterfaceType(target);
      if (definition === undefined) return undefined;
      const parameters = InterfaceType_TypeParameters(definition);
      if ((type.objectFlags & ObjectFlagsReference) === 0) {
        return parameters.length === 0 && definition.outerTypeParameterCount === 0
          ? Object.freeze([])
          : undefined;
      }
      const arguments_ = Checker_GetTypeArguments(checker, type);
      if (!Number.isSafeInteger(definition.outerTypeParameterCount) ||
        definition.outerTypeParameterCount < 0 || definition.outerTypeParameterCount > parameters.length ||
        arguments_.length < parameters.length ||
        arguments_.length > parameters.length + (definition.thisType === undefined ? 0 : 1)) return undefined;
      const result: TypeReferenceArgumentInfo[] = [];
      for (const [index, parameter] of parameters.entries()) {
        const argument = arguments_[index];
        if (parameter === undefined || argument === undefined) return undefined;
        result.push(Object.freeze({ parameter, argument,
          scope: index < definition.outerTypeParameterCount ? "outer" : "local" }));
      }
      return Object.freeze(result);
    }),
    getKeyOfComponents: (type) => withOwnedChecker(
      program, defaultOptions.sourceFile, type?.checker, defaultOptions.context ?? Background(),
      checker => readTypeKeyOfComponents(checker, type),
    ),
    getSubstitutionComponents: (type) => withOwnedChecker(
      program, defaultOptions.sourceFile, type?.checker, defaultOptions.context ?? Background(),
      checker => readTypeSubstitutionComponents(checker, type),
    ),
    getTupleInfo: (type) => withCheckerForType(
      program,
      type,
      defaultOptions,
      (checker) => getTypeTupleInfo(checker, type),
    ),
    getObjectPropertyInfo: (type, name) => withObject(type, (checker, object) => readObjectPropertyInfo(checker, object, name)),
    getEnumOwnerDeclaration: type => withCheckerForType(program, type, defaultOptions, () => enumOwnerDeclaration(type)),
    getObjectPropertyHeaders: (type, admit) => getObjectPropertyHeaders(program, type, defaultOptions, admit),
    getStructuredInventory: (type, admit) => getStructuredTypeInventory(program, type, defaultOptions, admit),
    getCallSignatures: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetSignaturesOfType(checker, type, SignatureKindCall)) ?? [],
    getConstructSignatures: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetSignaturesOfType(checker, type, SignatureKindConstruct)) ?? [],
    getSignatureInfos: (type, kind) => {
      if (kind !== "call" && kind !== "construct") throw new Error("Unknown signature kind.");
      const owned = withCheckerForType(program, type, defaultOptions, checker =>
        (Checker_GetSignaturesOfType(checker, type, kind === "call" ? SignatureKindCall : SignatureKindConstruct) ?? [])
          .map(signature => {
            if (signature === undefined) throw new Error("The checker returned an absent type signature.");
            return getTypeSignatureInfo(checker, signature, defaultOptions.admitsCheckerDiagnostic);
          }),
      ) ?? [];
      for (const info of owned) publishSignatureInfo(program, defaultOptions, info);
      return Object.freeze(owned);
    },
    getDeclarationSignatureInfo: declaration => {
      if (!IsFunctionLike(declaration)) return undefined;
      const owned = withCheckerForNode(program, declaration, defaultOptions, checker => {
        const signature = Checker_getSignatureFromDeclaration(checker, declaration);
        return signature === undefined ? undefined : getTypeSignatureInfo(checker, signature, defaultOptions.admitsCheckerDiagnostic);
      });
      return owned === undefined ? undefined : publishSignatureInfo(program, defaultOptions, owned);
    },
    getSignatureParameterInfos: (signature) => withCheckerForSignature(
      program,
      signature,
      defaultOptions,
      (checker) => getTypeSignatureParameterInfos(checker, signature),
    ) ?? [],
    getSignatureThisParameterInfo: (signature) => withCheckerForSignature(
      program,
      signature,
      defaultOptions,
      (checker) => getTypeSignatureThisParameterInfo(checker, signature),
    ),
    getReturnTypeOfSignature: (signature) => resolveSourceTypeAnswer(program, defaultOptions,
      withCheckerForSignature(program, signature, defaultOptions, checker =>
        signatureReturnAnswer(checker, signature, Checker_GetReturnTypeOfSignature(checker, signature), defaultOptions.admitsCheckerDiagnostic))),
    getIndexInfos: (type) => withCheckerForType(program, type, defaultOptions, (checker) =>
      (Checker_GetIndexInfosOfType(checker, type) ?? []).map((info) => readTypeIndexInfo(checker, type, info))) ?? [],
    getApparentType: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetApparentType(checker, type)),
    getWidenedType: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetWidenedType(checker, type)),
    getBaseTypeOfLiteralType: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_getBaseTypeOfLiteralType(checker, type)),
    removeMissingOrUndefined: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_RemoveMissingOrUndefinedType(checker, type)),
    getNonNullableType: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetNonNullableType(checker, type)),
  };
  return Object.freeze(queries);
}

function hasFlags(type: GoPtr<Type>, flags: number): boolean {
  return type !== undefined && (type.flags & flags) !== 0;
}

function enumOwnerDeclaration(type: GoPtr<Type>): GoPtr<Node> {
  if (type === undefined || !hasFlags(type, TypeFlagsEnumLike) || type.data.AsType() !== type) return undefined;
  const symbol = type.symbol;
  if (symbol === undefined) return undefined;
  const owner = (symbol.Flags & SymbolFlagsEnumMember) === 0 ? symbol : symbol.Parent;
  const declaration = owner?.ValueDeclaration;
  return owner !== undefined && (owner.Flags & SymbolFlagsEnum) !== 0 && declaration?.Kind === KindEnumDeclaration
    ? declaration : undefined;
}

function readConditionalBranch(checker: Checker, node: GoPtr<Node>, completed: GoPtr<Type>): TypeConditionalBranch | undefined {
  if (completed !== undefined) return Object.freeze({ kind: "completed", type: completed });
  if (node === undefined || !IsLiteralTypeNode(node)) return undefined;
  const links = LinkStore_TryGet(checker.typeNodeLinks, node);
  const atom = links?.resolvedType;
  if (atom?.checker !== checker || links?.resolutionFailure !== undefined || links?.grammarFailure !== undefined ||
    links?.declarationFailure !== undefined || atom.alias !== undefined ||
    (atom.flags & TypeFlagsStringLiteral) === 0 || (atom.flags & TypeFlagsStructuredOrInstantiable) !== 0) return undefined;
  return Object.freeze({ kind: "invariant-atom", type: atom });
}

function readTypeConditionalComponents(
  checker: GoPtr<Checker>,
  type: GoPtr<Type>,
): TypeConditionalComponents | undefined {
  if (checker === undefined || type === undefined || type.checker !== checker ||
    (type.flags & TypeFlagsConditional) === 0 || type.data.AsType() !== type)
    return undefined;
  const conditional = Type_AsConditionalType(type);
  const root = conditional?.root;
  const declaration = root?.node === undefined ? undefined : Node_AsNode(root.node);
  const checkType = conditional?.checkType;
  const extendsType = conditional?.extendsType;
  const syntax = AsConditionalTypeNode(declaration);
  if (conditional === undefined || root === undefined || declaration === undefined || syntax === undefined || checkType === undefined || extendsType === undefined
    || checkType.checker !== checker || extendsType.checker !== checker) return undefined;
  const inferParameters: Type[] = [];
  for (const parameter of root.inferTypeParameters ?? []) {
    if (parameter === undefined || parameter.checker !== checker) return undefined;
    inferParameters.push(parameter);
  }
  const trueType = conditional?.resolvedTrueType;
  const falseType = conditional?.resolvedFalseType;
  if (trueType !== undefined && trueType.checker !== checker || falseType !== undefined && falseType.checker !== checker)
    return undefined;
  return Object.freeze({ declaration, checkType, extendsType, distributive: root.isDistributive,
    inferParameters: Object.freeze(inferParameters),
    application: readConditionalApplication(checker, type, conditional),
    trueBranch: readConditionalBranch(checker, syntax.TrueType, trueType),
    falseBranch: readConditionalBranch(checker, syntax.FalseType, falseType) });
}

function getStructuredTypeInventory<Stop extends object>(
  program: GoPtr<Program>,
  type: GoPtr<Type>,
  options: CreateTypeShapeQueriesOptions,
  admit: NativeCheckerAdmission<Stop>,
): NativeCheckerResult<StructuredTypeInventory, Stop> {
  const source = options.sourceFile;
  const context = options.context ?? Background();
  const owner = type?.checker;
  return withOwnedCheckerAcquisition(program, source, owner, context, admit, checker => {
    const effective = Checker_getReducedApparentType(checker, type);
    if (effective === undefined) throw new Error("A checked type requires its actual reduced apparent type.");
    const structured = (effective.flags & TypeFlagsStructuredType) === 0 ? undefined
      : Checker_resolveStructuredTypeMembers(checker, effective);
    const indexInfos = structured?.indexInfos ?? [];
    admitNativeChecker(checker, "retained");
    const indexes: TypeIndexInfo[] = [];
    for (let index = 0; index < indexInfos.length; index += 1) {
      admitNativeChecker(checker, "work");
      const info = indexInfos[index];
      admitNativeChecker(checker, "retained");
      indexes.push(readTypeIndexInfo(checker, type, info));
    }
    const properties = (effective.flags & (TypeFlagsUnion | TypeFlagsIntersection)) !== 0
      ? Checker_getPropertiesOfUnionOrIntersectionType(checker, effective)
      : (effective.flags & TypeFlagsObject) !== 0 ? StructuredType_Properties(structured) ?? [] : [];
    admitNativeChecker(checker, "retained", 2);
    const inventory = propertyInventory(program, source, checker, context, properties,
      (current, symbol) => readTypePropertyInfo(current, type, symbol));
    return Object.freeze({ signatures: structured?.signatures ?? [], callSignatureCount: structured?.callSignatureCount ?? 0,
      indexes: Object.freeze(indexes), properties: inventory });
  });
}

function getObjectPropertyHeaders<Stop extends object>(program: GoPtr<Program>, type: GoPtr<Type>,
  options: CreateTypeShapeQueriesOptions, admit: NativeCheckerAdmission<Stop>,
): NativeCheckerResult<TypePropertyHeaderInventory, Stop> {
  const owner = type?.checker;
  if (type === undefined || !hasFlags(type, TypeFlagsObject) || type.data.AsType() !== type ||
    owner === undefined || Program_OfChecker(owner) !== program) return { kind: "unavailable" };
  const source = options.sourceFile;
  const context = options.context ?? Background();
  return withOwnedCheckerAcquisition(program, source, owner, context, admit, checker => {
    admitNativeChecker(checker, "work");
    const properties = Checker_getPropertiesOfObjectType(checker, type) ?? [];
    admitNativeChecker(checker, "retained");
    return propertyInventory(program, source, checker, context, properties, readTypePropertyHeader);
  });
}

function propertyInventory<Value>(program: GoPtr<Program>, source: GoPtr<SourceFile>, owner: Checker,
  context: Context, properties: readonly GoPtr<Symbol>[], project: (checker: Checker, symbol: GoPtr<Symbol>) => Value,
): NativePropertyInventory<Value> {
  const length = properties.length;
  const inventory: NativePropertyInventory<Value> = {
    length,
    read: (index, admit) => {
      if (!Number.isSafeInteger(index) || index < 0 || Object.is(index, -0) || index >= length)
        throw new RangeError("A property read requires an actual inventory ordinal.");
      return withOwnedCheckerAcquisition(program, source, owner, context, admit, checker => {
        admitNativeChecker(checker, "work");
        return project(checker, properties[index]);
      });
    },
  };
  return Object.freeze(inventory);
}

function getTypeTupleInfo(
  checker: GoPtr<Checker>,
  type: GoPtr<Type>,
): TypeTupleInfo | undefined {
  if (checker === undefined || type === undefined || !isTupleType(type)) return undefined;
  const target = Type_TargetTupleType(type);
  if (target === undefined) return undefined;
  const elementTypes = Checker_GetTypeArguments(checker, type);
  const elementInfos = target.elementInfos ?? [];
  if (elementTypes.length !== elementInfos.length ||
    elementTypes.some((element) => element === undefined)) {
    throw new Error(
      "The checker returned tuple element types without matching tuple element evidence.",
    );
  }
  const elements = Object.freeze(elementTypes.map((element, index) => {
    const info = elementInfos[index]!;
    const elementKind = (info.flags & ElementFlagsVariadic) !== 0
      ? "variadic"
      : (info.flags & ElementFlagsRest) !== 0
        ? "rest"
        : (info.flags & ElementFlagsOptional) !== 0
          ? "optional"
          : "required";
    return Object.freeze({
      type: element!,
      elementKind,
      ...(info.labeledDeclaration === undefined
        ? {}
        : { declaration: info.labeledDeclaration }),
    });
  }));
  return { readonly: target.readonly, elements };
}

function getTypeSignatureInfo(checker: GoPtr<Checker>, signature: Signature, admits?: CheckerDiagnosticMembership): OwnedSignatureInfo {
  const thisParameter = getTypeSignatureThisParameterInfo(checker, signature);
  return { signature, parameters: getTypeSignatureParameterInfos(checker, signature),
    ...(thisParameter === undefined ? {} : { thisParameter }),
    returnType: signatureReturnAnswer(checker, signature, Checker_GetReturnTypeOfSignature(checker, signature), admits) };
}

function publishSignatureInfo(program: Program, options: CreateTypeShapeQueriesOptions, info: OwnedSignatureInfo): TypeSignatureInfo {
  info.returnType = resolveSourceTypeAnswer(program, options, info.returnType);
  return Object.freeze(info);
}

function getTypeSignatureParameterInfos(
  checker: GoPtr<Checker>,
  signature: GoPtr<Signature>,
): readonly TypeSignatureParameterInfo[] {
  if (checker === undefined || signature === undefined) {
    return [];
  }
  const sourceParameters = signature.parameters ?? [];
  const expandedGroups = Checker_GetExpandedParameters(
    checker,
    signature,
    true,
  );
  if (expandedGroups.length !== 1) {
    throw new Error(
      "The checker returned more than one effective parameter group while union expansion was disabled.",
    );
  }
  const effectiveParameters = expandedGroups[0] ?? [];
  const restIndex = signatureHasRestParameter(signature)
    ? sourceParameters.length - 1
    : -1;
  const restSymbol = restIndex < 0 ? undefined : sourceParameters[restIndex];
  const restType = restSymbol === undefined
    ? undefined
    : Checker_getTypeOfSymbol(checker, restSymbol);
  const tupleElements = getTypeTupleInfo(checker, restType)?.elements ?? [];
  const tupleExpanded = restIndex >= 0 && tupleElements.length > 0 &&
    effectiveParameters.length === restIndex + tupleElements.length;
  const minimumArgumentCount = Checker_getMinArgumentCount(checker, signature);
  const owner = originalSignatureDeclaration(checker, signature);
  return Object.freeze(effectiveParameters.map((parameter, index) => {
    if (parameter === undefined) {
      throw new Error(
        "The checker returned an absent effective signature parameter.",
      );
    }
    const tupleElement = tupleExpanded && index >= restIndex
      ? tupleElements[index - restIndex]
      : undefined;
    const unexpandedRest = restIndex >= 0 && !tupleExpanded &&
      index === restIndex;
    const sourceSymbol = tupleElement === undefined
      ? unexpandedRest
        ? restSymbol
        : parameter
      : restSymbol;
    const type = unexpandedRest
      ? restType
      : Checker_getTypeOfSymbol(checker, parameter);
    if (sourceSymbol === undefined || type === undefined) {
      throw new Error(
        "The checker returned an effective signature parameter without exact source ownership or type evidence.",
      );
    }
    const declaration = tupleElement?.declaration ??
      sourceSymbol.ValueDeclaration ?? sourceSymbol.Declarations?.[0];
    const parameterKind = tupleElement?.elementKind === "optional" ||
        (declaration !== undefined &&
          Checker_isOptionalParameter(checker, declaration)) ||
        (parameter.CheckFlags & CheckFlagsOptionalParameter) !== 0
      ? "optional"
      : unexpandedRest || tupleElement?.elementKind === "rest" ||
          tupleElement?.elementKind === "variadic" ||
          (parameter.CheckFlags & CheckFlagsRestParameter) !== 0
        ? "rest"
        : "required";
    const typeSource = owner !== undefined && declaration?.Parent === owner && parameterKind === "required"
      && !tupleExpanded && !unexpandedRest && signature.parameters[index] === parameter && Node_Symbol(declaration) === parameter
      ? completedAnnotationSource(checker, Node_Type(declaration), type) : undefined;
    return Object.freeze({
      sourceSymbol,
      type,
      parameterKind,
      acceptsOmission: index >= minimumArgumentCount,
      ...(declaration === undefined ? {} : { declaration }),
      ...(typeSource === undefined ? {} : { typeSource }),
    });
  }));
}

function getTypeSignatureThisParameterInfo(
  checker: GoPtr<Checker>,
  signature: GoPtr<Signature>,
): TypeSignatureThisParameterInfo | undefined {
  if (checker === undefined || signature === undefined) {
    return undefined;
  }
  const symbol = Signature_ThisParameter(signature);
  if (symbol === undefined) {
    return undefined;
  }
  const type = Checker_getTypeOfSymbol(checker, symbol);
  if (type === undefined) {
    throw new Error(
      "The checker returned an explicit this parameter without its selected source type.",
    );
  }
  const declaration = symbol.ValueDeclaration ?? symbol.Declarations?.[0];
  return Object.freeze({
    symbol,
    type,
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function isTupleType(type: GoPtr<Type>): boolean {
  return type !== undefined && IsTupleType(type);
}

function withCheckerForNode<T>(
  program: GoPtr<Program>,
  node: GoPtr<Node>,
  defaultOptions: CreateTypeShapeQueriesOptions,
  callback: (checker: GoPtr<Checker>) => T,
): T | undefined {
  const sourceFile = GetSourceFileOfNode(node);
  if (program === undefined || sourceFile === undefined || !Program_HasUsableCheckerSession(program) ||
    Program_GetSourceFile(program, SourceFile_FileName(defaultOptions.sourceFile)) !== defaultOptions.sourceFile ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) {
    return undefined;
  }
  const [checker, done] = Program_GetTypeCheckerForFile(program,
    WithCheckerLifetime(defaultOptions.context ?? Background(), CheckerLifetimeDiagnostics), sourceFile);
  try { return callback(checker); } finally { done(); }
}

function withCheckerForType<T>(
  program: GoPtr<Program>,
  type: GoPtr<Type>,
  defaultOptions: CreateTypeShapeQueriesOptions,
  callback: (checker: GoPtr<Checker>) => T,
): T | undefined {
  return withOwnedChecker(program, defaultOptions.sourceFile, type?.checker,
    defaultOptions.context ?? Background(), callback);
}

function withCheckerForSignature<T>(
  program: GoPtr<Program>,
  signature: GoPtr<Signature>,
  defaultOptions: CreateTypeShapeQueriesOptions,
  callback: (checker: GoPtr<Checker>) => T,
): T | undefined {
  return signature === undefined ? undefined : withCheckerById(program, defaultOptions.sourceFile,
    signature.checkerId, defaultOptions.context ?? Background(), callback);
}
