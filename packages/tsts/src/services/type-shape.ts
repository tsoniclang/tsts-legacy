import type { GoPtr } from "../go/compat.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import type { Symbol } from "../internal/ast/symbol.js";
import { SymbolName } from "../internal/ast/symbol.js";
import {
  CheckFlagsOptionalParameter,
  CheckFlagsRestParameter,
} from "../internal/ast/checkflags.js";
import { SymbolFlagsOptional } from "../internal/ast/symbolflags.js";
import type { Program } from "../internal/compiler/program.js";
import { Program_GetTypeCheckerForFile } from "../internal/compiler/program.js";
import type { Context } from "../go/context.js";
import { Background } from "../go/context.js";
import {
  Checker_GetApparentType,
  Checker_GetExpandedParameters,
  Checker_GetIndexInfosOfType,
  Checker_GetPropertiesOfType,
  Checker_GetReturnTypeOfSignature,
  Checker_GetSignaturesOfType,
  Checker_GetTypeArguments,
  Checker_GetTypeFromTypeNode,
  Checker_GetTypeOfPropertyOfType,
  Checker_GetWidenedType,
  Checker_IsArrayLikeType,
  Checker_RemoveMissingOrUndefinedType,
  IsTupleType,
} from "../internal/checker/exports.js";
import {
  Checker_getTypeOfSymbol,
  Checker_isReadonlySymbol,
} from "../internal/checker/checker/symbols.js";
import { Checker_isOptionalParameter } from "../internal/checker/utilities.js";
import {
  getBigIntLiteralValue,
  getNumberLiteralValue,
  signatureHasRestParameter,
} from "../internal/checker/checker/state.js";
import { PseudoBigInt_String } from "../internal/jsnum/pseudobigint.js";
import { Checker_isTypeIdenticalTo } from "../internal/checker/relater.js";
import {
  Checker_GetConstantValue,
  Checker_GetRootSymbols,
} from "../internal/checker/services.js";
import { Checker_TypeToString } from "../internal/checker/printer.js";
import type { Checker } from "../internal/checker/checker/state.js";
import {
  ElementFlagsOptional,
  ElementFlagsRest,
  ElementFlagsVariadic,
  ObjectFlagsReference,
  SignatureKindCall,
  SignatureKindConstruct,
  TypeFlagsAny,
  TypeFlagsBigIntLike,
  TypeFlagsBigIntLiteral,
  TypeFlagsBooleanLike,
  TypeFlagsESSymbolLike,
  TypeFlagsIntersection,
  TypeFlagsNever,
  TypeFlagsNull,
  TypeFlagsNumberLike,
  TypeFlagsNumberLiteral,
  TypeFlagsStringLike,
  TypeFlagsSubstitution,
  TypeFlagsUnion,
  TypeFlagsUnknown,
  TypeFlagsVoidLike,
  TypeFlagsUndefined,
  TypeFlagsVoid,
  Type_Target,
  Type_TargetTupleType,
  Type_AsSubstitutionType,
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

export interface TypePropertyInfo {
  readonly symbol: Symbol;
  readonly rootSymbols: readonly Symbol[];
  readonly name: string;
  readonly type: Type;
  readonly optional: boolean;
  readonly readonly: boolean;
}

export interface TypeTupleElementInfo {
  readonly type: Type;
  readonly elementKind: "required" | "optional" | "rest" | "variadic";
  readonly declaration?: Node;
}

export interface TypeSignatureParameterInfo {
  readonly sourceSymbol: Symbol;
  readonly type: Type;
  readonly parameterKind: "required" | "optional" | "rest";
  readonly declaration?: Node;
}

export interface TypeSignatureThisParameterInfo {
  readonly symbol: Symbol;
  readonly type: Type;
  readonly declaration?: Node;
}

export interface CreateTypeShapeQueriesOptions {
  readonly sourceFile: GoPtr<SourceFile>;
  readonly context?: Context;
}

export interface TypeShapeQueries {
  readonly typeToString: (type: GoPtr<Type>) => string;
  readonly getTypeFromTypeNode: (node: GoPtr<Node>) => GoPtr<Type>;
  readonly getConstantValue: (node: GoPtr<Node>) => unknown;
  readonly getNumericLiteralTypeValue: (type: GoPtr<Type>) => number | bigint | undefined;
  readonly isAny: (type: GoPtr<Type>) => boolean;
  readonly isUnknown: (type: GoPtr<Type>) => boolean;
  readonly isNever: (type: GoPtr<Type>) => boolean;
  readonly isVoidLike: (type: GoPtr<Type>) => boolean;
  readonly isNullish: (type: GoPtr<Type>) => boolean;
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
  readonly getSubstitutionBaseType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly getTupleElementTypes: (type: GoPtr<Type>) => readonly GoPtr<Type>[];
  readonly getTupleElementInfos: (type: GoPtr<Type>) => readonly TypeTupleElementInfo[];
  readonly getPropertyInfos: (type: GoPtr<Type>) => readonly TypePropertyInfo[];
  readonly getCallSignatures: (type: GoPtr<Type>) => readonly GoPtr<Signature>[];
  readonly getConstructSignatures: (type: GoPtr<Type>) => readonly GoPtr<Signature>[];
  readonly getSignatureParameterInfos: (
    signature: GoPtr<Signature>,
  ) => readonly TypeSignatureParameterInfo[];
  readonly getSignatureThisParameterInfo: (
    signature: GoPtr<Signature>,
  ) => TypeSignatureThisParameterInfo | undefined;
  readonly getReturnTypeOfSignature: (signature: GoPtr<Signature>) => GoPtr<Type>;
  readonly getIndexInfos: (type: GoPtr<Type>) => readonly TypeIndexInfo[];
  readonly getApparentType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly getWidenedType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly removeMissingOrUndefined: (type: GoPtr<Type>) => GoPtr<Type>;
}

export function createTypeShapeQueries(program: GoPtr<Program>, defaultOptions: CreateTypeShapeQueriesOptions): TypeShapeQueries {
  if (program === undefined || defaultOptions.sourceFile === undefined) {
    throw new Error("Type-shape queries require one source file from the compiler program.");
  }
  const queries: TypeShapeQueries = {
    typeToString: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_TypeToString(checker, type)) ?? "",
    getTypeFromTypeNode: (node) => withCheckerForNode(program, node, defaultOptions, (checker) => Checker_GetTypeFromTypeNode(checker, node)),
    getConstantValue: (node) => withCheckerForNode(program, node, defaultOptions, (checker) => Checker_GetConstantValue(checker, node)),
    getNumericLiteralTypeValue: (type) => withCheckerForType(program, type, defaultOptions, () => {
      if (hasFlags(type, TypeFlagsNumberLiteral)) return getNumberLiteralValue(type);
      if (hasFlags(type, TypeFlagsBigIntLiteral)) return BigInt(PseudoBigInt_String(getBigIntLiteralValue(type)));
      return undefined;
    }),
    isAny: (type) => hasFlags(type, TypeFlagsAny),
    isUnknown: (type) => hasFlags(type, TypeFlagsUnknown),
    isNever: (type) => hasFlags(type, TypeFlagsNever),
    isVoidLike: (type) => hasFlags(type, TypeFlagsVoidLike) || hasFlags(type, TypeFlagsVoid),
    isNullish: (type) => hasFlags(type, TypeFlagsNull) || hasFlags(type, TypeFlagsUndefined),
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
    isTypeIdenticalTo: (left, right) => withCheckerForType(
      program,
      left,
      defaultOptions,
      (checker) => Checker_isTypeIdenticalTo(checker, left, right),
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
    getTypeReferenceTarget: (type) => Type_Target(type),
    getTypeArguments: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetTypeArguments(checker, type)) ?? [],
    getSubstitutionBaseType: (type) => hasFlags(type, TypeFlagsSubstitution)
      ? Type_AsSubstitutionType(type)?.baseType
      : undefined,
    getTupleElementTypes: (type) => withCheckerForType(program, type, defaultOptions, (checker) => {
      if (!isTupleType(type)) {
        return [];
      }
      return Checker_GetTypeArguments(checker, type);
    }) ?? [],
    getTupleElementInfos: (type) => withCheckerForType(
      program,
      type,
      defaultOptions,
      (checker) => getTypeTupleElementInfos(checker, type),
    ) ?? [],
    getPropertyInfos: (type) => withCheckerForType(
      program,
      type,
      defaultOptions,
      (checker) => getTypePropertyInfos(checker, type),
    ) ?? [],
    getCallSignatures: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetSignaturesOfType(checker, type, SignatureKindCall)) ?? [],
    getConstructSignatures: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetSignaturesOfType(checker, type, SignatureKindConstruct)) ?? [],
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
    getReturnTypeOfSignature: (signature) => withCheckerForSignature(program, signature, defaultOptions, (checker) => Checker_GetReturnTypeOfSignature(checker, signature)),
    getIndexInfos: (type) => withCheckerForType(program, type, defaultOptions, (checker) =>
      (Checker_GetIndexInfosOfType(checker, type) ?? []).map((info) => ({
        keyType: info?.keyType,
        valueType: info?.valueType,
        readonly: info?.isReadonly === true,
        declaration: info?.declaration,
        symbol: info?.indexSymbol,
        components: info?.components ?? [],
      } satisfies TypeIndexInfo))) ?? [],
    getApparentType: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetApparentType(checker, type)),
    getWidenedType: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetWidenedType(checker, type)),
    removeMissingOrUndefined: (type) => withCheckerForType(program, type, defaultOptions, (checker) => Checker_RemoveMissingOrUndefinedType(checker, type)),
  };
  return Object.freeze(queries);
}

function hasFlags(type: GoPtr<Type>, flags: number): boolean {
  return type !== undefined && (type.flags & flags) !== 0;
}

function getTypePropertyInfos(
  checker: GoPtr<Checker>,
  type: GoPtr<Type>,
): readonly TypePropertyInfo[] {
  if (checker === undefined) {
    throw new Error("The source type has no owning checker for property analysis.");
  }
  const properties = Checker_GetPropertiesOfType(checker, type) ?? [];
  return properties.map((symbol) => {
    if (symbol === undefined) {
      throw new Error("The checker returned an absent property symbol for a source type.");
    }
    const name = SymbolName(symbol);
    const propertyType = Checker_GetTypeOfPropertyOfType(
      checker,
      type,
      symbol.Name,
    );
    if (propertyType === undefined) {
      throw new Error(
        `The checker returned property '${name}' without its effective source type.`,
      );
    }
    return {
      symbol,
      rootSymbols: Object.freeze(
        Checker_GetRootSymbols(checker, symbol).filter(
          (root): root is Symbol => root !== undefined,
        ),
      ),
      name,
      type: propertyType,
      optional: (symbol.Flags & SymbolFlagsOptional) !== 0,
      readonly: Checker_isReadonlySymbol(checker, symbol) === true,
    } satisfies TypePropertyInfo;
  });
}

function getTypeTupleElementInfos(
  checker: GoPtr<Checker>,
  type: GoPtr<Type>,
): readonly TypeTupleElementInfo[] {
  if (checker === undefined || type === undefined || !isTupleType(type)) {
    return [];
  }
  const elementTypes = Checker_GetTypeArguments(checker, type);
  const elementInfos = Type_TargetTupleType(type)?.elementInfos ?? [];
  if (elementTypes.length !== elementInfos.length ||
    elementTypes.some((element) => element === undefined)) {
    throw new Error(
      "The checker returned tuple element types without matching tuple element evidence.",
    );
  }
  return Object.freeze(elementTypes.map((element, index) => {
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
  const tupleElements = restType === undefined
    ? []
    : getTypeTupleElementInfos(checker, restType);
  const tupleExpanded = restIndex >= 0 && tupleElements.length > 0 &&
    effectiveParameters.length === restIndex + tupleElements.length;
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
    return Object.freeze({
      sourceSymbol,
      type,
      parameterKind,
      ...(declaration === undefined ? {} : { declaration }),
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
  if (node === undefined) {
    return undefined;
  }
  return withCheckerForSourceFile(
    program,
    defaultOptions.sourceFile,
    defaultOptions,
    callback,
  );
}

function withCheckerForType<T>(
  program: GoPtr<Program>,
  type: GoPtr<Type>,
  defaultOptions: CreateTypeShapeQueriesOptions,
  callback: (checker: GoPtr<Checker>) => T,
): T | undefined {
  if (program === undefined || type === undefined) {
    return undefined;
  }
  if (type.checker !== undefined) {
    return callback(type.checker);
  }
  return withCheckerForSourceFile(
    program,
    defaultOptions.sourceFile,
    defaultOptions,
    callback,
  );
}

function withCheckerForSignature<T>(
  program: GoPtr<Program>,
  signature: GoPtr<Signature>,
  defaultOptions: CreateTypeShapeQueriesOptions,
  callback: (checker: GoPtr<Checker>) => T,
): T | undefined {
  if (program === undefined || signature === undefined) {
    return undefined;
  }
  return withCheckerForSourceFile(
    program,
    defaultOptions.sourceFile,
    defaultOptions,
    callback,
  );
}

function withCheckerForSourceFile<T>(
  program: GoPtr<Program>,
  sourceFile: GoPtr<SourceFile>,
  defaultOptions: CreateTypeShapeQueriesOptions,
  callback: (checker: GoPtr<Checker>) => T,
): T | undefined {
  if (sourceFile === undefined) {
    return undefined;
  }
  const [checker, done] = Program_GetTypeCheckerForFile(
    program,
    defaultOptions.context ?? Background(),
    sourceFile,
  );
  try {
    return callback(checker);
  } finally {
    done();
  }
}
