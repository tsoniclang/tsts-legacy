import type { bool } from "../go/scalars.js";
import { checkerBackingConstraints } from "../internal/checker/checker/backing-constraint-evidence.js";
import type { ResolvedCheckerBackingConstraint } from "../internal/checker/types.js";
import type { GoPtr } from "../go/compat.js";
import type { Context } from "../go/context.js";
import { Background } from "../go/context.js";
import type { Node, SourceFile } from "../internal/ast/ast.js";
import { Node_Arguments, Node_Expression, Node_PropertyNameOrName, Node_Symbol, Node_Text, SourceFile_FileName, SourceFile_Path } from "../internal/ast/ast.js";
import { AsExportDeclaration } from "../internal/ast/generated/casts.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { Node_Name } from "../internal/ast/spine.js";
import type { Symbol } from "../internal/ast/symbol.js";
import type { Diagnostic } from "../internal/ast/diagnostic.js";
import type { Expression } from "../internal/ast/generated/unions.js";
import { readTypeIndexInfo } from "./type-members.js";
import { readInvocationReturnType } from "./signature-returns.js";
import { sourceModuleLink } from "./source-module-link.js";
import type { ResolvedSourceModuleLink } from "./source-module-link.js";
export type { ResolvedSourceModuleLink } from "./source-module-link.js";
import { acquireLeasedChecker, withOwnedChecker, withCheckerById, withSourceFileChecker } from "./checker-ownership.js";
import { sourceTypeAnswer } from "../internal/checker/checker/source-type-answers.js";
import { admitSourceTypeAnswer, querySourceType, readSourceType, settleSourceTypeAnswer } from "./source-type-answer.js";
import type { SourceTypeRequest } from "./source-type-answer.js";
export type { SourceTypeRequest } from "./source-type-answer.js";
import { admitNativeChecker, type NativeCheckerAdmission, type NativeCheckerResult } from "../internal/checker/resource-admission.js";
import type { CheckerDiagnosticMembership, ResolvedSourceTypeInfo } from "../internal/checker/checker/source-type-answers.js";
export type { ResolvedSourceTypeInfo } from "../internal/checker/checker/source-type-answers.js";
import type { TypeIndexInfo } from "./type-shape.js";
import {
  NodeFlagsOptionalChain,
  SymbolFlagsAlias,
  SymbolFlagsNamespace,
  SymbolFlagsType,
  SymbolFlagsValue,
} from "../internal/ast/generated/flags.js";
import type { SymbolFlags } from "../internal/ast/generated/flags.js";
import {
  IsElementAccessExpression,
  IsAwaitExpression,
  IsExportDeclaration,
  IsExportSpecifier,
  IsGetAccessorDeclaration,
  IsIdentifier,
  IsImportSpecifier,
  IsNamespaceExport,
  IsNamespaceImport,
  IsObjectLiteralExpression,
  IsMethodDeclaration,
  IsMethodSignatureDeclaration,
  IsPropertyAccessExpression,
  IsPropertyAssignment,
  IsPropertyDeclaration,
  IsPropertySignatureDeclaration,
  IsSetAccessorDeclaration,
  IsShorthandPropertyAssignment,
} from "../internal/ast/generated/predicates.js";
import {
  GetSourceFileOfNode,
  GetContainingFunction,
  IsCallOrNewExpression,
  IsFunctionLike,
  IsObjectLiteralMethod,
  IsOuterExpression,
  IsPropertyName,
  IsDynamicName,
  IsImportCall,
  IsInExpressionContext,
  IsRightSideOfQualifiedNameOrPropertyAccess,
  ModuleExportNameIsDefault,
  OEKAssertions,
  OEKParentheses,
  SkipOuterExpressions,
  SkipParentheses,
  type OuterExpressionKinds,
} from "../internal/ast/utilities.js";
import { Program_GetSourceFile, Program_GetTypeChecker, Program_HasUsableCheckerSession, Program_IsSourceFileDefaultLibrary } from "../internal/compiler/program.js";
import { CheckerLifetimeAPI, CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { getExtensionHost } from "../extensions/host.js";
import type { Program } from "../internal/compiler/program.js";
import {
  Checker_GetPropertyOfType,
  Checker_GetPropertiesOfType,
  Checker_ResolveName,
  Checker_GetSignaturesOfType,
  Checker_GetTypeOfPropertyOfType,
} from "../internal/checker/exports.js";
import {
  Checker_finalizeResolvedCallEvidence,
  Checker_getResolvedCallSelectionEvidence,
  Checker_getResolvedSignature,
} from "../internal/checker/checker/signatures.js";
import { CheckModeNormal, getNumberLiteralValue } from "../internal/checker/checker/state.js";
import type { Checker } from "../internal/checker/checker/state.js";
import {
  Checker_GetAliasedSymbol,
  Checker_getResolvedSourceElementAccessInfo,
  Checker_getResolvedSourcePropertyAccessInfo,
  Checker_GetSymbolAtLocation,
  Checker_getDeclarationOfAliasSymbol,
  Checker_getDeclaredTypeOfSymbol,
  Checker_getEffectivePropertyNameForPropertyNameNode,
  Checker_getExportSymbolOfValueSymbolIfExported,
  Checker_getIdentifierAssignmentError,
  Checker_getImmediateAliasedSymbol,
  Checker_getLiteralTypeFromPropertyName,
  Checker_getTypeOfPropertyOfContextualTypeEx,
  Checker_getResolvedSymbolOrNil,
  Checker_getModuleSpecifierForImportOrExport,
  Checker_getExportsOfModule,
  Checker_getTypeOfSymbol,
  Checker_getWriteTypeOfSymbol,
  Checker_resolveExternalModuleName,
  Checker_resolveExternalModuleSymbol,
  isSourceModuleBinding,
  retainedAliasFailure,
} from "../internal/checker/checker/symbols.js";
import type {
  ResolvedSourceElementAccessInfo as CheckerResolvedSourceElementAccessInfo,
  ResolvedSourcePropertyAccessInfo as CheckerResolvedSourcePropertyAccessInfo,
} from "../internal/checker/checker/symbols.js";
import {
  Checker_getApparentTypeOfContextualType,
  Checker_getAwaitedType,
  Checker_GetTypeAtLocation,
} from "../internal/checker/checker/types.js";
import { Checker_isAssignmentToReadonlyEntity } from "../internal/checker/checker/relations.js";
import { AssignmentKindDefinite, AssignmentKindNone, getAssignmentTargetKind, isReservedMemberName } from "../internal/checker/utilities.js";
import { Checker_getResolvedSourceIterationInfo } from "../internal/checker/checker/syntax-checking.js";
import type { ExtensionCheckedIterationSelection } from "../internal/checker/checker/iteration-evidence.js";
import {
  Checker_GetConstantValue,
  Checker_GetRootSymbols,
  Checker_GetSignatureFromDeclaration,
} from "../internal/checker/services.js";
import { Checker_TypeToString } from "../internal/checker/printer.js";
import type {
  ContextFlags,
  ResolvedCallEvidence,
  Signature,
  Type,
} from "../internal/checker/types.js";
import { ContextFlagsNone, SignatureKindCall, SignatureKindConstruct, TypeFlagsNumberLiteral, TypeFlagsStringLiteral, TypeFlagsUniqueESSymbol } from "../internal/checker/types.js";
import { Number_String } from "../internal/jsnum/string.js";
import {
  resolveSourceCallableCompletionInfo,
  resolveSourceGeneratorInfo,
  resolveSourceResourceManagementInfo,
  resolveSourceWellKnownSymbolInfo,
  resolveSourceYieldInfo,
} from "./source-control-flow-evidence.js";
import { resolveSourceFlowConditionInfo } from "./source-flow-conditions.js";
import type { ResolvedSourceFlowConditionInfo } from "./source-flow-conditions.js";
export type { ResolvedSourceFlowCondition, ResolvedSourceFlowConditionInfo } from "./source-flow-conditions.js";

export type {
  ResolvedSourceCallableCompletionInfo,
  ResolvedSourceGeneratorInfo,
  ResolvedSourceResourceManagementInfo,
  ResolvedSourceWellKnownSymbolInfo,
  ResolvedSourceYieldInfo,
} from "./source-control-flow-evidence.js";
import type {
  ResolvedSourceCallableCompletionInfo,
  ResolvedSourceGeneratorInfo,
  ResolvedSourceResourceManagementInfo,
  ResolvedSourceWellKnownSymbolInfo,
  ResolvedSourceYieldInfo,
} from "./source-control-flow-evidence.js";

export interface CreateTypeCheckerQueriesOptions {
  readonly sourceFile: GoPtr<SourceFile>;
  readonly context?: Context;
  readonly admitsCheckerDiagnostic?: CheckerDiagnosticMembership;
}

export type ResolvedSourceCallInfo = ResolvedCallEvidence;
export interface ResolvedSourceIntrinsicValueInfo {
  readonly kind: "undefined";
  readonly symbol: Symbol;
}
export interface ResolvedSourcePropertyNameInfo {
  readonly kind: "string" | "numeric" | "unique-symbol";
  readonly name: string;
  readonly type: Type;
}
export interface ResolvedSourceReceiverValueEvidence {
  readonly valueSymbol?: Symbol;
  readonly valueDeclaration?: Node;
  readonly intrinsic?: "global-object";
}

type PublicSelectedPropertyAccess<Selection> = Selection extends CheckerResolvedSourcePropertyAccessInfo
  ? Omit<Selection, "selectedIndex"> & { readonly selectedIndex?: TypeIndexInfo }
  : never;

/**
 * What a property access selects.
 *
 * "member": a member of the receiver's type, with the receiver, the selected symbol and declaration and the types.
 *
 * "module-exported-value": the access reads the `default` member the checker makes for the namespace of a
 * CommonJS-format module (`ns.default`), which stands for the module's exported value. That member has no
 * declaration and its symbol is shared between modules, so nothing is taken from the symbol. `target` names the
 * module only where the receiver EXPRESSION proves it: when the receiver is an import's own namespace binding it is
 * what getAliasStep gives for that binding (the module's `export =` assignment when it has one, the module
 * otherwise); when the receiver is `await import("m")` itself it is the same for that module. For any other receiver
 * (a variable the namespace value flowed into, a parameter, a conditional) `target` is nothing: the checker knows
 * that the member is a module's exported value and not which module. The receiver's type does not tell: a value
 * typed by one import's namespace may be another module's. The member's own symbol is shared by every module whose
 * exported value has the same type, and its Parent is the first such module: a consumer takes the module only from
 * `target`, never from that symbol.
 */
export type ResolvedSourcePropertyAccessInfo =
  | (PublicSelectedPropertyAccess<CheckerResolvedSourcePropertyAccessInfo> & {
      readonly kind: "member";
      readonly receiver: CheckerResolvedSourcePropertyAccessInfo["receiver"] & ResolvedSourceReceiverValueEvidence;
    })
  | { readonly kind: "module-exported-value"; readonly target: Symbol | undefined };
export type ResolvedSourceElementAccessInfo = CheckerResolvedSourceElementAccessInfo & {
  readonly receiver: CheckerResolvedSourceElementAccessInfo["receiver"] & ResolvedSourceReceiverValueEvidence;
};
export type ResolvedSourceIterationInfo = ExtensionCheckedIterationSelection;

export type ResolvedSourceObjectLiteralElementKind =
  | "property"
  | "shorthand"
  | "method"
  | "get"
  | "set";

export interface ResolvedSourceObjectLiteralElementInfo {
  readonly objectLiteral: Node;
  readonly element: Node;
  readonly elementKind: ResolvedSourceObjectLiteralElementKind;
  readonly objectLiteralType: Type;
  readonly contextualType?: Type;
  readonly sourceElementSymbol?: Symbol;
  readonly sourceElementType: Type;
  readonly sourceSelectedSymbol?: Symbol;
  readonly sourceSelectedDeclaration?: Node;
  readonly sourceSelectedDeclarations: readonly Node[];
  readonly sourceSelectedType: Type;
}

/**
 * One step of an alias chain: what an alias binding names directly.
 *
 * "symbol": the step is a symbol, itself an alias when the chain continues.
 * - import specifier, export specifier: the module's export of that name, or the local entity that a
 *   local `export { a }` names;
 * - default import: the module's default export;
 * - `import x = require(...)`, namespace import, `export * as ns`: the module itself, or, for a module
 *   with `export =`, the symbol of that assignment (an alias when the assignment names an entity; declared
 *   by the assignment either way). The assignment is never skipped, and the symbol the checker makes for
 *   a namespace import of a CommonJS-format file is never the answer;
 * - `import x = N.v`: the named entity.
 *
 * "exported-value-member": an import or export specifier that names a member of the value a module
 * exports with `export =`. The checker finds such a member on the final value behind the assignment, so
 * the step is not a symbol of the module: `exportAssignment` is the assignment's symbol, the boundary
 * the binding passes, and `member` is the member found behind it, or nothing. When `member` is nothing,
 * the steps from `exportAssignment` tell which: they end at a value that has no such member, or they end
 * at an alias that does not resolve.
 *
 * Not covered: a destructured `require` in a JavaScript file (`const { a } = require("m")`), whose alias
 * is a binding element. It is answered as a "symbol" step with the checker's own target, which lies
 * behind the module's `export =`.
 */
export type ResolvedAliasTarget =
  | { readonly kind: "symbol"; readonly symbol: Symbol }
  | { readonly kind: "unresolved"; readonly cause: Diagnostic };

export type ResolvedAliasStep =
  | ResolvedAliasTarget
  | { readonly kind: "exported-value-member"; readonly exportAssignment: Symbol; readonly member: ResolvedAliasTarget | undefined };

export interface ResolvedModuleExport {
  readonly name: string;
  readonly symbol: Symbol;
  readonly typeOnlyStar: Node | null;
}

export interface ResolvedSourceStorageInfo {
  readonly expression: Node;
  readonly storageExpression: Node;
  readonly type: ResolvedSourceTypeInfo;
  readonly symbol?: Symbol;
  readonly declaration?: Node;
  readonly writable: boolean;
}

export interface TypeCheckerQueries {
  readonly getBackingConstraints: () => readonly ResolvedCheckerBackingConstraint[];
  readonly getGlobalValueSymbol: (name: string) => GoPtr<Symbol>;
  readonly isDefaultLibraryDeclaration: (node: GoPtr<Node>) => boolean;
  readonly getAwaitedType: (type: GoPtr<Type>) => GoPtr<Type>;
  readonly acquireSourceType: <Stop extends object>(request: SourceTypeRequest,
    admit: NativeCheckerAdmission<Stop>) => NativeCheckerResult<ResolvedSourceTypeInfo, Stop>;
  readonly getTypeAtLocation: (node: GoPtr<Node>) => GoPtr<ResolvedSourceTypeInfo>;
  readonly getTypeFromTypeNode: (node: GoPtr<Node>) => GoPtr<ResolvedSourceTypeInfo>;
  readonly getContextualType: (node: GoPtr<Node>, contextFlags?: ContextFlags) => GoPtr<ResolvedSourceTypeInfo>;
  readonly getEffectivePropertyName: (node: GoPtr<Node>) => GoPtr<ResolvedSourcePropertyNameInfo>;
  readonly getSymbolAtLocation: (node: GoPtr<Node>) => GoPtr<Symbol>;
  readonly getLexicallyResolvedSymbol: (identifier: GoPtr<Node>) => GoPtr<Symbol>;
  readonly getResolvedSymbol: (node: GoPtr<Node>) => GoPtr<Symbol>;
  readonly getResolvedSymbolOrNil: (node: GoPtr<Node>) => GoPtr<Symbol>;
  readonly getResolvedIntrinsicValueInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceIntrinsicValueInfo>;
  readonly getAliasedSymbol: (symbol: GoPtr<Symbol>) => GoPtr<Symbol>;
  /**
   * One step of an alias chain (see ResolvedAliasStep). Nothing, and no throw, for a symbol that is not
   * an alias and for an unavailable step with no retained producing evidence. A failed module-member
   * answer with its actual original diagnostic is unresolved. A member of a circular alias chain has a step: following the steps from it
   * returns to a symbol already visited, which is how a caller finds the cycle's members.
   *
   * Compare what the two alias queries return by declaration, never by symbol identity. getAliasedSymbol
   * gives the final target of the whole chain, and for a namespace import, in an ECMAScript-format file,
   * of a CommonJS-format file that target is a symbol made for that import declaration: it has the
   * target's declarations and is a different object for each import declaration. Steps are symbols of
   * modules and declarations, but one export reached by two bindings is not promised to be one object.
   *
   * A retained failed answer borrows its original diagnostic without re-emission. A genuine native
   * re-evaluation replaces that answer; an unavailable step without such evidence is not a cached failure.
   */
  readonly getAliasStep: (symbol: GoPtr<Symbol>) => GoPtr<ResolvedAliasStep>;
  readonly getTypeOfSymbol: (symbol: GoPtr<Symbol>) => GoPtr<Type>;
  readonly getWriteTypeOfSymbol: (symbol: GoPtr<Symbol>) => GoPtr<Type>;
  readonly getDeclaredTypeOfSymbol: (symbol: GoPtr<Symbol>) => GoPtr<Type>;
  readonly getResolvedSignature: (node: GoPtr<Node>) => GoPtr<Signature>;
  readonly getSignatureFromDeclaration: (declaration: GoPtr<Node>) => GoPtr<Signature>;
  readonly getResolvedCallInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceCallInfo>;
  readonly getResolvedPropertyAccessInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourcePropertyAccessInfo>;
  readonly getResolvedElementAccessInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceElementAccessInfo>;
  readonly getResolvedIterationInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceIterationInfo>;
  readonly getResolvedObjectLiteralElementInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceObjectLiteralElementInfo>;
  readonly getResolvedStorageInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceStorageInfo>;
  readonly acquireResolvedStorage: <Stop extends object>(node: GoPtr<Node>,
    admit: NativeCheckerAdmission<Stop>) => NativeCheckerResult<ResolvedSourceStorageInfo, Stop>;
  readonly getResolvedCallableCompletionInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceCallableCompletionInfo>;
  readonly getResolvedFlowConditionInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceFlowConditionInfo>;
  readonly getResolvedGeneratorInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceGeneratorInfo>;
  readonly getResolvedYieldInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceYieldInfo>;
  readonly getResolvedWellKnownSymbolInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceWellKnownSymbolInfo>;
  readonly getResolvedResourceManagementInfo: (node: GoPtr<Node>) => GoPtr<ResolvedSourceResourceManagementInfo>;
  readonly getReturnTypeOfSignature: (signature: GoPtr<Signature>) => GoPtr<ResolvedSourceTypeInfo>;
  readonly getInvocationReturnTypeOfSignature: (signature: GoPtr<Signature>) => GoPtr<Type>;
  readonly getCallSignaturesOfType: (type: GoPtr<Type>) => readonly GoPtr<Signature>[];
  readonly getConstructSignaturesOfType: (type: GoPtr<Type>) => readonly GoPtr<Signature>[];
  readonly getPropertyOfType: (type: GoPtr<Type>, name: string) => GoPtr<Symbol>;
  readonly getTypeOfPropertyOfType: (type: GoPtr<Type>, name: string) => GoPtr<Type>;
  readonly getConstantValue: (node: GoPtr<Node>) => unknown;
  readonly typeToString: (type: GoPtr<Type>) => string;
  readonly getModuleSymbolFromSpecifier: (moduleSpecifier: GoPtr<Node>) => GoPtr<Symbol>;
  readonly getResolvedSourceModuleLink: (specifier: GoPtr<Node>) => GoPtr<ResolvedSourceModuleLink>;
  readonly getResolvedExternalModuleSymbol: (moduleSymbol: GoPtr<Symbol>, dontResolveAlias?: boolean) => GoPtr<Symbol>;
  readonly getExportsOfModule: (moduleSymbol: GoPtr<Symbol>) => readonly ResolvedModuleExport[];
  readonly getSymbolName: (symbol: GoPtr<Symbol>) => string;
  readonly getSymbolDeclarations: (symbol: GoPtr<Symbol>) => readonly GoPtr<Node>[];
  readonly getRootSymbols: (symbol: GoPtr<Symbol>) => readonly GoPtr<Symbol>[];
  readonly getSymbolValueDeclaration: (symbol: GoPtr<Symbol>) => GoPtr<Node>;
  readonly getPrimarySymbolDeclaration: (symbol: GoPtr<Symbol>) => GoPtr<Node>;
  readonly getSymbolSourceFile: (symbol: GoPtr<Symbol>) => GoPtr<SourceFile>;
  readonly getTypeSymbol: (type: GoPtr<Type>) => GoPtr<Symbol>;
  readonly getTypeAliasSymbol: (type: GoPtr<Type>) => GoPtr<Symbol>;
  readonly getSignatureDeclaration: (signature: GoPtr<Signature>) => GoPtr<Node>;
  readonly getSignatureParameters: (signature: GoPtr<Signature>) => readonly GoPtr<Symbol>[];
  readonly getSignatureThisParameter: (signature: GoPtr<Signature>) => GoPtr<Symbol>;
}

export function createTypeCheckerQueries(program: GoPtr<Program>, defaultOptions: CreateTypeCheckerQueriesOptions): TypeCheckerQueries {
  if (program === undefined || defaultOptions.sourceFile === undefined) {
    throw new Error("Type-checker queries require one source file from the compiler program.");
  }
  const callInfos = new WeakMap<Node, ResolvedSourceCallInfo>();
  const propertyNames = new WeakMap<Node, ResolvedSourcePropertyNameInfo | null>();
  const propertyAccessInfos = new WeakMap<Node, ResolvedSourcePropertyAccessInfo>();
  const elementAccessInfos = new WeakMap<Node, ResolvedSourceElementAccessInfo>();
  const iterationInfos = new WeakMap<Node, ResolvedSourceIterationInfo>();
  const objectLiteralElementInfos = new WeakMap<Node, ResolvedSourceObjectLiteralElementInfo>();
  const objectLiteralElementSymbols = new WeakMap<Type, ReadonlyMap<Node, Symbol>>();
  const storageInfos = new WeakMap<Node, ResolvedSourceStorageInfo>();
  const readStorage = <Stop extends object>(node: GoPtr<Node>, admit: NativeCheckerAdmission<Stop> | null):
    NativeCheckerResult<ResolvedSourceStorageInfo, Stop> => {
    if (node === undefined) return { kind: "unavailable" };
    const context = defaultOptions.context ?? Background();
    let known: ResolvedSourceStorageInfo | undefined;
    const head = withSourceFileChecker(program, defaultOptions.sourceFile, GetSourceFileOfNode(node), context,
      (checker): NativeCheckerResult<ResolvedSourceStorageInfo | undefined, Stop> => {
        const read = () => {
          admitNativeChecker(checker, "work");
          known = storageInfos.get(node);
          const selected = known ?? getResolvedSourceStorageInfo(checker, node);
          if (selected === undefined) return undefined;
          const type = admitSourceTypeAnswer(selected.type, defaultOptions.admitsCheckerDiagnostic, checker);
          if (type === selected.type) return selected;
          admitNativeChecker(checker, "retained");
          return Object.freeze({ ...selected, type });
        };
        return admit === null ? { kind: "complete", value: read() }
          : acquireLeasedChecker(checker, WithCheckerLifetime(context, CheckerLifetimeDiagnostics), admit, read);
      });
    if (head === undefined || head.kind === "unavailable") return { kind: "unavailable" };
    if (head.kind === "refused") return head;
    const selected = head.value;
    if (selected === undefined) return { kind: "unavailable" };
    const type = settleSourceTypeAnswer(program, defaultOptions, selected.type, admit);
    if (type.kind !== "complete") return type;
    if (selected === known && type.value === selected.type) return { kind: "complete", value: selected };
    const stop = admit?.("retained", type.value === selected.type ? 1 : 2) ?? null;
    if (stop !== null) return { kind: "refused", stop };
    const completed = type.value === selected.type ? selected : Object.freeze({ ...selected, type: type.value });
    storageInfos.set(node, completed);
    return { kind: "complete", value: completed };
  };
  const callableCompletionInfos = new WeakMap<Node, ResolvedSourceCallableCompletionInfo>();
  const flowConditionInfos = new WeakMap<Node, ResolvedSourceFlowConditionInfo>();
  const generatorInfos = new WeakMap<Node, ResolvedSourceGeneratorInfo>();
  const yieldInfos = new WeakMap<Node, ResolvedSourceYieldInfo>();
  const wellKnownSymbolInfos = new WeakMap<Node, ResolvedSourceWellKnownSymbolInfo>();
  const resourceManagementInfos = new WeakMap<Node, ResolvedSourceResourceManagementInfo>();
  const queries: TypeCheckerQueries = {
    getBackingConstraints() {
      const constraints = withCheckedFile(program, defaultOptions.sourceFile, defaultOptions, checker => {
        if (checker === undefined) throw new Error("Backing-constraint queries require the original checked program.");
        return checkerBackingConstraints(checker);
      });
      if (constraints === undefined) throw new Error("Backing-constraint queries lost their checked lifetime.");
      return constraints;
    },
    getGlobalValueSymbol(name) {
      if (Program_GetSourceFile(program, SourceFile_FileName(defaultOptions.sourceFile)) !== defaultOptions.sourceFile) return undefined;
      return withChecker(program, defaultOptions.sourceFile, defaultOptions, checker => {
        const symbol = checker?.globals.get(name);
        return symbol !== undefined && (symbol.Flags & SymbolFlagsValue) !== 0 ? symbol : undefined;
      });
    },
    isDefaultLibraryDeclaration(node) {
      if (Program_GetSourceFile(program, SourceFile_FileName(defaultOptions.sourceFile)) !== defaultOptions.sourceFile) return false;
      const file = GetSourceFileOfNode(node);
      return file !== undefined && Program_GetSourceFile(program, SourceFile_FileName(file)) === file &&
        Program_IsSourceFileDefaultLibrary(program, SourceFile_Path(file));
    },
    getAwaitedType(type) {
      return withOwnedChecker(program, defaultOptions.sourceFile, type?.checker,
        defaultOptions.context ?? Background(), owner => Checker_getAwaitedType(owner, type));
    },
    acquireSourceType: (request, admit) => readSourceType(program, defaultOptions, request, admit),
    getTypeAtLocation: (node) => querySourceType(program, defaultOptions, { kind: "expression", node }),
    getTypeFromTypeNode: (node) => querySourceType(program, defaultOptions, { kind: "annotation", node }),
    getContextualType: (node, flags = ContextFlagsNone) => querySourceType(program, defaultOptions, { kind: "contextual", node, flags }),
    getEffectivePropertyName(node) {
      if (node === undefined) return undefined;
      const cached = propertyNames.get(node);
      if (cached !== undefined) return cached ?? undefined;
      const selected = withCheckerForNode(program, node, defaultOptions, checker => {
        if (!IsPropertyName(node)) return undefined;
        const [literalName, present] = Checker_getEffectivePropertyNameForPropertyNameNode(checker, node);
        if (!present) return undefined;
        const type = Checker_getLiteralTypeFromPropertyName(checker, node);
        if (type === undefined) return undefined;
        const declaration = node.Parent;
        const staticallyBound = declaration !== undefined && !IsDynamicName(node) &&
          (IsPropertyDeclaration(declaration) || IsPropertySignatureDeclaration(declaration) ||
            IsMethodDeclaration(declaration) || IsMethodSignatureDeclaration(declaration) ||
            IsGetAccessorDeclaration(declaration) || IsSetAccessorDeclaration(declaration)) &&
          !IsObjectLiteralExpression(declaration.Parent);
        const symbol = staticallyBound ? Node_Symbol(declaration) : undefined;
        if (staticallyBound && symbol === undefined) return undefined;
        const name = staticallyBound ? symbol!.Name : literalName;
        if ((type.flags & TypeFlagsUniqueESSymbol) !== 0) return Object.freeze({ kind: "unique-symbol" as const, name, type });
        if ((type.flags & TypeFlagsNumberLiteral) !== 0) return Object.freeze({ kind: "numeric" as const,
          name: staticallyBound ? name : Number_String(getNumberLiteralValue(type)), type });
        if ((type.flags & TypeFlagsStringLiteral) !== 0) return Object.freeze({ kind: "string" as const, name, type });
        return undefined;
      });
      propertyNames.set(node, selected ?? null);
      return selected;
    },
    getSymbolAtLocation: (node) =>
      withCheckerForNode(program, node, defaultOptions, (checker) => Checker_GetSymbolAtLocation(checker, node)),
    getLexicallyResolvedSymbol: (identifier) =>
      withCheckerForNode(program, identifier, defaultOptions, (checker) =>
        IsIdentifier(identifier)
          ? Checker_ResolveName(
              checker,
              Node_Text(identifier),
              identifier,
              (SymbolFlagsValue | SymbolFlagsType | SymbolFlagsNamespace | SymbolFlagsAlias) as SymbolFlags,
              false as bool,
            )
          : undefined),
    getResolvedSymbol: (node) =>
      withCheckerForNode(program, node, defaultOptions, (checker) => getDiagnosticFreeResolvedSymbol(checker, node)),
    getResolvedSymbolOrNil: (node) =>
      withCheckerForNode(program, node, defaultOptions, (checker) => Checker_getResolvedSymbolOrNil(checker, node)),
    getResolvedIntrinsicValueInfo: (node) =>
      withCheckerForNode(program, node, defaultOptions, (checker): GoPtr<ResolvedSourceIntrinsicValueInfo> => {
        if (checker === undefined || node?.Parent === undefined || !IsIdentifier(node)) return undefined;
        const symbol = LinkStore_TryGet(checker.symbolNodeLinks, node)?.resolvedSymbol;
        return symbol !== undefined && symbol === checker.undefinedSymbol
          && IsInExpressionContext(node) && !IsRightSideOfQualifiedNameOrPropertyAccess(node)
          && getAssignmentTargetKind(node) !== AssignmentKindDefinite
          ? { kind: "undefined", symbol } : undefined;
      }),
    getAliasedSymbol: (symbol) =>
      withCheckerForSymbol(program, symbol, defaultOptions, (checker) => {
        // The made default member of a module's exported value is shared between modules: its alias target is the
        // first module's and is not handed out. Its boundary is asked by occurrence (getResolvedPropertyAccessInfo).
        if (isSyntheticDefaultMember(checker, symbol)) return undefined;
        const target = Checker_GetAliasedSymbol(checker, symbol);
        return target === checker?.unknownSymbol ? undefined : target;
      }),
    getAliasStep: (symbol) => {
      if (symbol === undefined || (symbol.Flags & SymbolFlagsAlias) === 0) return undefined;
      const declaration = Checker_getDeclarationOfAliasSymbol(undefined, symbol);
      if (declaration === undefined) return undefined;
      return withCheckedFile(program, GetSourceFileOfNode(declaration), defaultOptions, (checker): GoPtr<ResolvedAliasStep> => {
        if (checker === undefined) return undefined;
        const retained = LinkStore_TryGet(checker.aliasSymbolLinks, symbol);
        // The two binding forms whose target the checker computes through a module's `export =` assignment.
        const namespaceForm = IsNamespaceImport(declaration) || IsNamespaceExport(declaration);
        const memberForm = (IsImportSpecifier(declaration) || IsExportSpecifier(declaration))
          && !ModuleExportNameIsDefault(Node_PropertyNameOrName(declaration));
        const moduleForm = isSourceModuleBinding(declaration);
        const moduleSpecifier = moduleForm ? Checker_getModuleSpecifierForImportOrExport(checker, declaration) : undefined;
        const selectedModule = moduleSpecifier === undefined ? undefined : moduleOfSpecifier(checker, declaration, moduleSpecifier);
        const referenced = namespaceForm || memberForm ? selectedModule : undefined;
        const exportDeclaration = IsExportSpecifier(declaration) ? AsExportDeclaration(declaration.Parent?.Parent) : undefined;
        if (exportDeclaration !== undefined && exportDeclaration.ModuleSpecifier === undefined && Node_Symbol(declaration) !== symbol) return undefined;
        // A namespace form names the module itself: its `export =` assignment when it has one, the module otherwise.
        // The checker's own target for it is the final value behind the assignment or a symbol it makes for the import.
        if (referenced !== undefined && namespaceForm) return { kind: "symbol", symbol: referenced.exportAssignment ?? referenced.module };
        const failure = retainedAliasFailure(checker, declaration, symbol, selectedModule === undefined);
        const immediate = failure === undefined
          ? Checker_getImmediateAliasedSymbol(checker, symbol) : retained?.immediateTarget;
        const target = immediate === checker?.unknownSymbol ? undefined : immediate;
        const cause = failure ?? LinkStore_TryGet(checker.aliasSymbolLinks, symbol)?.immediateFailure;
        const answer: ResolvedAliasTarget | undefined = target !== undefined ? { kind: "symbol", symbol: target }
          : cause === undefined || defaultOptions.admitsCheckerDiagnostic?.(cause) === false ? undefined : { kind: "unresolved", cause };
        if (referenced?.exportAssignment !== undefined) {
          return { kind: "exported-value-member", exportAssignment: referenced.exportAssignment, member: answer };
        }
        return answer;
      });
    },
    getTypeOfSymbol: (symbol) =>
      withCheckerForSymbol(program, symbol, defaultOptions, (checker) => Checker_getTypeOfSymbol(checker, symbol)),
    getWriteTypeOfSymbol: (symbol) =>
      withCheckerForSymbol(program, symbol, defaultOptions, (checker) => Checker_getWriteTypeOfSymbol(checker, symbol)),
    getDeclaredTypeOfSymbol: (symbol) =>
      withCheckerForSymbol(program, symbol, defaultOptions, (checker) => Checker_getDeclaredTypeOfSymbol(checker, symbol)),
    getResolvedSignature: (node) =>
      withCheckedFile(program, GetSourceFileOfNode(node), defaultOptions, (checker) =>
        Checker_getResolvedSignature(checker, node, undefined, CheckModeNormal)),
    getSignatureFromDeclaration(declaration) {
      if (!IsFunctionLike(declaration)) return undefined;
      const sourceFile = GetSourceFileOfNode(declaration);
      if (sourceFile === undefined || Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) return undefined;
      return withCheckedFile(program, sourceFile, defaultOptions,
        checker => Checker_GetSignatureFromDeclaration(checker, declaration));
    },
    getResolvedCallInfo: (node) =>
      memoizeResolvedNodeQuery(callInfos, node, () =>
        withCheckedFile(program, GetSourceFileOfNode(node), defaultOptions, (checker) => {
          if (!IsCallOrNewExpression(node)) {
            return undefined;
          }
          Checker_getResolvedSignature(checker, node, undefined, CheckModeNormal);
          const selection = Checker_getResolvedCallSelectionEvidence(checker, node);
          if (selection?.kind !== "applicable") return selection;
          const sourceResultType = Checker_GetTypeAtLocation(checker, node);
          return Checker_finalizeResolvedCallEvidence(checker, node, sourceResultType);
        })),
    getResolvedPropertyAccessInfo: (node) =>
      memoizeResolvedNodeQuery(propertyAccessInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker): GoPtr<ResolvedSourcePropertyAccessInfo> => {
          const selected = Checker_getResolvedSourcePropertyAccessInfo(checker, node);
          return isSyntheticDefaultMember(checker, selected?.sourceSymbol)
            ? { kind: "module-exported-value", target: exportedValueBoundary(checker, node) }
            : withResolvedPropertyAccessEvidence(checker, selected);
        })),
    getResolvedElementAccessInfo: (node) =>
      memoizeResolvedNodeQuery(elementAccessInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) => {
          const selected = Checker_getResolvedSourceElementAccessInfo(checker, node);
          // An element access that reads the made default member would name the first module's value: nothing.
          return isSyntheticDefaultMember(checker, selected?.sourceSymbol)
            ? undefined
            : withResolvedSourceReceiverValueEvidence(checker, selected);
        })),
    getResolvedIterationInfo: (node) =>
      memoizeResolvedNodeQuery(iterationInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          Checker_getResolvedSourceIterationInfo(checker, node))),
    getResolvedObjectLiteralElementInfo: (node) =>
      memoizeResolvedNodeQuery(objectLiteralElementInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          getResolvedSourceObjectLiteralElementInfo(checker, node, objectLiteralElementSymbols))),
    getResolvedStorageInfo: (node) => {
      const result = readStorage(node, null);
      return result.kind === "complete" ? result.value : undefined;
    },
    acquireResolvedStorage: readStorage,
    getResolvedCallableCompletionInfo: (node) =>
      memoizeResolvedNodeQuery(callableCompletionInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          resolveSourceCallableCompletionInfo(checker, node))),
    getResolvedFlowConditionInfo: (node) =>
      memoizeResolvedNodeQuery(flowConditionInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          resolveSourceFlowConditionInfo(checker, node))),
    getResolvedGeneratorInfo: (node) =>
      memoizeResolvedNodeQuery(generatorInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          resolveSourceGeneratorInfo(checker, node))),
    getResolvedYieldInfo: (node) =>
      memoizeResolvedNodeQuery(yieldInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) => {
          const declaration = GetContainingFunction(node);
          const generator = memoizeResolvedNodeQuery(
            generatorInfos,
            declaration,
            () => resolveSourceGeneratorInfo(checker, declaration),
          );
          return resolveSourceYieldInfo(checker, node, generator);
        })),
    getResolvedWellKnownSymbolInfo: (node) =>
      memoizeResolvedNodeQuery(wellKnownSymbolInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          resolveSourceWellKnownSymbolInfo(checker, node))),
    getResolvedResourceManagementInfo: (node) =>
      memoizeResolvedNodeQuery(resourceManagementInfos, node, () =>
        withCheckerForNode(program, node, defaultOptions, (checker) =>
          resolveSourceResourceManagementInfo(checker, node))),
    getReturnTypeOfSignature: (signature) => querySourceType(program, defaultOptions, { kind: "signature-return", signature }),
    getInvocationReturnTypeOfSignature: (signature) =>
      withCheckerForSignature(program, signature, defaultOptions, (checker) => readInvocationReturnType(checker, signature)),
    getCallSignaturesOfType: (type) =>
      withCheckerForType(program, type, defaultOptions, (checker) =>
        Checker_GetSignaturesOfType(checker, type, SignatureKindCall)) ?? [],
    getConstructSignaturesOfType: (type) =>
      withCheckerForType(program, type, defaultOptions, (checker) =>
        Checker_GetSignaturesOfType(checker, type, SignatureKindConstruct)) ?? [],
    getPropertyOfType: (type, name) =>
      withCheckerForType(program, type, defaultOptions, (checker) =>
        Checker_GetPropertyOfType(checker, type, name)),
    getTypeOfPropertyOfType: (type, name) =>
      withCheckerForType(program, type, defaultOptions, (checker) => Checker_GetTypeOfPropertyOfType(checker, type, name)),
    getConstantValue: (node) =>
      withCheckerForNode(program, node, defaultOptions, (checker) => Checker_GetConstantValue(checker, node)),
    typeToString: (type) =>
      withCheckerForType(program, type, defaultOptions, (checker) => Checker_TypeToString(checker, type)) ?? "",
    getModuleSymbolFromSpecifier: (moduleSpecifier) =>
      withCheckerForNode(program, moduleSpecifier, defaultOptions, (checker) => Checker_resolveExternalModuleName(checker, moduleSpecifier, moduleSpecifier, true as bool)),
    getResolvedSourceModuleLink: (specifier) => specifier === undefined ? undefined
      : withCheckedFile(program, GetSourceFileOfNode(specifier), defaultOptions, checker =>
        checker === undefined ? undefined : sourceModuleLink(checker, specifier, defaultOptions.admitsCheckerDiagnostic)),
    getResolvedExternalModuleSymbol: (moduleSymbol, dontResolveAlias = false) =>
      withCheckerForSymbol(program, moduleSymbol, defaultOptions, (checker) => Checker_resolveExternalModuleSymbol(checker, moduleSymbol, dontResolveAlias as bool)),
    getExportsOfModule: (moduleSymbol) => {
      if (moduleSymbol === undefined) return [];
      const readExports = (checker: GoPtr<Checker>) => {
        if (checker === undefined) return undefined;
        const exports = Checker_getExportsOfModule(checker, moduleSymbol);
        const links = LinkStore_TryGet(checker.moduleSymbolLinks, moduleSymbol);
        if (links?.resolvedExports !== exports) throw new Error("A module export answer requires its actual native export table.");
        const rows: { name: string; symbol: Symbol; typeOnlyStar: Node | null }[] = [];
        for (const [name, symbol] of exports) {
          if (isReservedMemberName(name)) continue;
          if (symbol === undefined) throw new Error("A native export row requires its actual symbol.");
          rows.push({ name, symbol, typeOnlyStar: links.typeOnlyExportStarMap?.get(name) ?? null });
        }
        return rows;
      };
      const owner = moduleSymbol.checkerId;
      const rows = (owner === undefined
        ? withCheckedFile(program, getSymbolSourceFile(moduleSymbol), defaultOptions, readExports)
        : withCheckerById(program, defaultOptions.sourceFile, owner, defaultOptions.context ?? Background(), readExports)) ?? [];
      for (const row of rows) {
        if (row.typeOnlyStar !== null || (row.symbol.Flags & SymbolFlagsAlias) === 0) continue;
        const alias = Checker_getDeclarationOfAliasSymbol(undefined, row.symbol);
        if (alias === undefined) continue;
        row.typeOnlyStar = withCheckedFile(program, GetSourceFileOfNode(alias), defaultOptions, checker => {
          const origin = LinkStore_TryGet(checker?.aliasSymbolLinks, row.symbol)?.typeOnlyDeclaration;
          if (origin === undefined || !IsExportDeclaration(origin)) return undefined;
          const declaration = AsExportDeclaration(origin);
          return declaration?.IsTypeOnly && declaration.ExportClause === undefined ? origin : undefined;
        }) ?? null;
      }
      return rows;
    },
    getSymbolName: (symbol) => symbol?.Name ?? "",
    getSymbolDeclarations: (symbol) => symbol?.Declarations ?? [],
    getRootSymbols: (symbol) =>
      withCheckerForSymbol(
        program,
        symbol,
        defaultOptions,
        (checker) => Checker_GetRootSymbols(checker, symbol),
      ) ?? [],
    getSymbolValueDeclaration: (symbol) => symbol?.ValueDeclaration,
    getPrimarySymbolDeclaration: (symbol) => getPrimarySymbolDeclaration(symbol),
    getSymbolSourceFile: (symbol) => getSymbolSourceFile(symbol),
    getTypeSymbol: (type) => type?.symbol,
    getTypeAliasSymbol: (type) => type?.alias?.symbol,
    getSignatureDeclaration: (signature) => signature?.declaration,
    getSignatureParameters: (signature) => signature?.parameters ?? [],
    getSignatureThisParameter: (signature) => signature?.thisParameter,
  };
  return Object.freeze(queries);
}

function getResolvedSourceObjectLiteralElementInfo(
  checker: GoPtr<Checker>,
  element: GoPtr<Node>,
  symbolsByType: WeakMap<Type, ReadonlyMap<Node, Symbol>>,
): GoPtr<ResolvedSourceObjectLiteralElementInfo> {
  const elementKind = resolvedSourceObjectLiteralElementKind(element);
  const objectLiteral = element?.Parent;
  if (checker === undefined || element === undefined || elementKind === undefined ||
    objectLiteral === undefined ||
    !IsObjectLiteralExpression(objectLiteral)) {
    return undefined;
  }
  const objectLiteralType = Checker_GetTypeAtLocation(checker, objectLiteral);
  const sourceElementType = Checker_GetTypeAtLocation(checker, element);
  const contextualType = Checker_getApparentTypeOfContextualType(
    checker,
    objectLiteral,
    ContextFlagsNone,
  );
  if (objectLiteralType === undefined || sourceElementType === undefined) {
    return undefined;
  }
  let symbols = symbolsByType.get(objectLiteralType);
  if (symbols === undefined) {
    const selected = new Map<Node, Symbol>();
    const ambiguous = new Set<Node>();
    for (const symbol of Checker_GetPropertiesOfType(checker, objectLiteralType)) {
      if (symbol === undefined) continue;
      for (const declaration of symbol.Declarations ?? []) {
        if (declaration === undefined || ambiguous.has(declaration)) continue;
        const prior = selected.get(declaration);
        if (prior !== undefined && prior !== symbol) {
          selected.delete(declaration);
          ambiguous.add(declaration);
        } else {
          selected.set(declaration, symbol);
        }
      }
    }
    symbols = selected;
    symbolsByType.set(objectLiteralType, symbols);
  }
  const sourceElementSymbol = symbols.get(element);
  if (sourceElementSymbol === undefined) return undefined;
  const contextualElementType = contextualType === undefined
    ? undefined
    : Checker_getTypeOfPropertyOfContextualTypeEx(
        checker,
        contextualType,
        sourceElementSymbol.Name,
        Checker_getLiteralTypeFromPropertyName(checker, Node_Name(element)),
      );
  const sourceSelectedSymbol = contextualElementType === undefined
    ? sourceElementSymbol
    : Checker_GetPropertyOfType(checker, contextualType, sourceElementSymbol.Name);
  const sourceSelectedType = contextualElementType === undefined
    ? Checker_getTypeOfSymbol(checker, sourceElementSymbol)
    : contextualElementType;
  if (sourceSelectedType === undefined) {
    return undefined;
  }
  const rawSourceSelectedDeclarations = sourceSelectedSymbol?.Declarations ?? [];
  if (rawSourceSelectedDeclarations.some((declaration) => declaration === undefined)) {
    return undefined;
  }
  const sourceSelectedDeclarations = Object.freeze([
    ...rawSourceSelectedDeclarations,
  ] as Node[]);
  return Object.freeze({
    objectLiteral,
    element,
    elementKind,
    objectLiteralType,
    ...(contextualType === undefined ? {} : { contextualType }),
    sourceElementSymbol,
    sourceElementType,
    ...(sourceSelectedSymbol === undefined ? {} : { sourceSelectedSymbol }),
    ...(() => {
      const sourceSelectedDeclaration = getPrimarySymbolDeclaration(sourceSelectedSymbol);
      return sourceSelectedDeclaration === undefined ? {} : { sourceSelectedDeclaration };
    })(),
    sourceSelectedDeclarations,
    sourceSelectedType,
  });
}

function resolvedSourceObjectLiteralElementKind(
  element: GoPtr<Node>,
): ResolvedSourceObjectLiteralElementKind | undefined {
  if (IsPropertyAssignment(element)) {
    return "property";
  }
  if (IsShorthandPropertyAssignment(element)) {
    return "shorthand";
  }
  if (IsObjectLiteralMethod(element)) {
    return "method";
  }
  if (IsGetAccessorDeclaration(element)) {
    return "get";
  }
  if (IsSetAccessorDeclaration(element)) {
    return "set";
  }
  return undefined;
}

function getResolvedSourceStorageInfo(
  checker: GoPtr<Checker>,
  expression: GoPtr<Node>,
): GoPtr<ResolvedSourceStorageInfo> {
  if (checker === undefined || expression === undefined) {
    return undefined;
  }
  let storageExpression: GoPtr<Node> = expression;
  const kinds = (OEKAssertions | OEKParentheses) as OuterExpressionKinds;
  for (; storageExpression !== undefined;) {
    admitNativeChecker(checker, "work");
    if (!IsOuterExpression(storageExpression as GoPtr<Expression>, kinds)) break;
    storageExpression = Node_Expression(storageExpression);
  }
  if (
    storageExpression === undefined
    || (storageExpression.Flags & NodeFlagsOptionalChain) !== 0
  ) {
    return undefined;
  }
  if (IsIdentifier(storageExpression)) {
    const referenceSymbol = getDiagnosticFreeResolvedSymbol(checker, storageExpression);
    const symbol = referenceSymbol !== undefined && (referenceSymbol.Flags & SymbolFlagsAlias) !== 0
      ? Checker_GetAliasedSymbol(checker, referenceSymbol)
      : referenceSymbol;
    const type = sourceTypeAnswer(checker, storageExpression, Checker_GetTypeAtLocation(checker, storageExpression));
    if (referenceSymbol === undefined || symbol === undefined || symbol === checker.unknownSymbol || type === undefined) {
      return undefined;
    }
    let writable: boolean;
    if (getAssignmentTargetKind(storageExpression) !== AssignmentKindNone) {
      const localOrExport = Checker_getExportSymbolOfValueSymbolIfExported(checker, referenceSymbol);
      if (localOrExport === undefined) return undefined;
      writable = Checker_getIdentifierAssignmentError(checker, storageExpression, localOrExport) === undefined;
    } else {
      writable = !Checker_isAssignmentToReadonlyEntity(checker, storageExpression, symbol, AssignmentKindDefinite);
    }
    const declaration = getPrimarySymbolDeclaration(symbol);
    admitNativeChecker(checker, "retained");
    return Object.freeze({
      expression,
      storageExpression,
      type,
      symbol,
      ...(declaration === undefined ? {} : { declaration }),
      writable,
    });
  }
  if (IsPropertyAccessExpression(storageExpression)) {
    const selected = Checker_getResolvedSourcePropertyAccessInfo(
      checker,
      storageExpression,
    );
    const type = sourceTypeAnswer(checker, storageExpression, selectedAccessType(selected));
    if (selected === undefined || type === undefined) {
      return undefined;
    }
    admitNativeChecker(checker, "retained");
    return Object.freeze({
      expression,
      storageExpression,
      type,
      ...(selected.selectedSymbol === undefined
        ? {}
        : { symbol: selected.selectedSymbol }),
      ...(selected.selectedDeclaration === undefined
        ? {}
        : { declaration: selected.selectedDeclaration }),
      writable: selected.writable,
    });
  }
  if (IsElementAccessExpression(storageExpression)) {
    const selected = Checker_getResolvedSourceElementAccessInfo(
      checker,
      storageExpression,
    );
    const type = sourceTypeAnswer(checker, storageExpression, selectedAccessType(selected));
    if (selected === undefined || type === undefined) {
      return undefined;
    }
    admitNativeChecker(checker, "retained");
    return Object.freeze({
      expression,
      storageExpression,
      type,
      ...(selected.selectedSymbol === undefined
        ? {}
        : { symbol: selected.selectedSymbol }),
      ...(selected.selectedDeclaration === undefined
        ? {}
        : { declaration: selected.selectedDeclaration }),
      writable: selected.writable,
    });
  }
  return undefined;
}

function selectedAccessType(
  selected:
    | CheckerResolvedSourcePropertyAccessInfo
    | CheckerResolvedSourceElementAccessInfo
    | undefined,
): GoPtr<Type> {
  if (selected === undefined) {
    return undefined;
  }
  switch (selected.accessMode) {
    case "read":
    case "delete":
      return selected.sourceReadType;
    case "write":
      return selected.sourceWriteType;
    case "read-write":
      return selected.sourceReadType;
  }
}

function memoizeResolvedNodeQuery<T extends object>(
  cache: WeakMap<Node, T>,
  node: GoPtr<Node>,
  query: () => GoPtr<T>,
): GoPtr<T> {
  if (node === undefined) {
    return undefined;
  }
  const cached = cache.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = query();
  if (resolved !== undefined) {
    cache.set(node, resolved);
  }
  return resolved;
}

function getDiagnosticFreeResolvedSymbol(checker: GoPtr<Checker>, node: GoPtr<Node>): GoPtr<Symbol> {
  const resolved = Checker_getResolvedSymbolOrNil(checker, node);
  return resolved !== undefined && resolved !== checker?.unknownSymbol
    ? resolved
    : undefined;
}

function withResolvedPropertyAccessEvidence(
  checker: GoPtr<Checker>,
  selected: GoPtr<CheckerResolvedSourcePropertyAccessInfo>,
): GoPtr<ResolvedSourcePropertyAccessInfo> {
  if (checker === undefined || selected === undefined) return undefined;
  const { selectedIndex, ...access } = selected;
  const resolved = withResolvedSourceReceiverValueEvidence(checker, access);
  if (resolved === undefined) return undefined;
  return Object.freeze({
    kind: "member" as const,
    ...resolved,
    ...(selectedIndex === undefined ? {} : {
      selectedIndex: Object.freeze(readTypeIndexInfo(checker, selected.receiver.type, selectedIndex)),
    }),
  });
}

function withResolvedSourceReceiverValueEvidence<
  T extends { readonly receiver: { readonly expression: Node } },
>(
  checker: GoPtr<Checker>,
  selected: GoPtr<T>,
): GoPtr<T & {
  readonly receiver: T["receiver"] & ResolvedSourceReceiverValueEvidence;
}> {
  if (checker === undefined || selected === undefined) {
    return undefined;
  }
  const sourceSymbol = getDiagnosticFreeResolvedSymbol(
    checker,
    SkipOuterExpressions(selected.receiver.expression, (OEKAssertions | OEKParentheses) as OuterExpressionKinds),
  );
  const valueSymbol = sourceSymbol !== undefined &&
      (sourceSymbol.Flags & SymbolFlagsAlias) !== 0
    ? Checker_GetAliasedSymbol(checker, sourceSymbol)
    : sourceSymbol;
  if (valueSymbol === undefined || valueSymbol === checker.unknownSymbol) {
    return selected;
  }
  return Object.freeze({
    ...selected,
    receiver: Object.freeze({
      ...selected.receiver,
      valueSymbol,
      ...(valueSymbol === checker.globalThisSymbol ? { intrinsic: "global-object" as const } : {}),
      ...(valueSymbol.ValueDeclaration === undefined
        ? {}
        : { valueDeclaration: valueSymbol.ValueDeclaration }),
    }),
  });
}

// The module that an import or export declaration names, with the symbol of its `export =` assignment when it has
// one; nothing when the declaration names no module or the module does not resolve. Reports no diagnostic.
function referencedModule(checker: GoPtr<Checker>, declaration: GoPtr<Node>): { readonly module: Symbol; readonly exportAssignment: Symbol | undefined } | undefined {
  return moduleOfSpecifier(checker, declaration, Checker_getModuleSpecifierForImportOrExport(checker, declaration));
}

// Whether a symbol is the `default` member the checker makes for a module's exported value: its creator's mark.
function isSyntheticDefaultMember(checker: GoPtr<Checker>, symbol: GoPtr<Symbol>): boolean {
  return checker !== undefined && symbol !== undefined && LinkStore_TryGet(checker.aliasSymbolLinks, symbol)?.syntheticDefault === true;
}

// The module boundary of `E.default` where the member is the made default: one symbol, the module's `export =`
// assignment when it has one and the module otherwise, exactly as a namespace import steps. Given only where the
// receiver expression proves the module: an import's own namespace binding, or `await import("m")` itself.
function exportedValueBoundary(checker: GoPtr<Checker>, access: GoPtr<Node>): Symbol | undefined {
  const receiver = SkipParentheses(Node_Expression(access) as GoPtr<Expression>) as GoPtr<Node>;
  if (receiver === undefined) return undefined;
  let referenced: ReturnType<typeof referencedModule>;
  if (IsIdentifier(receiver)) {
    const binding = Checker_GetSymbolAtLocation(checker, receiver);
    const declaration = binding !== undefined && (binding.Flags & SymbolFlagsAlias) !== 0
      ? Checker_getDeclarationOfAliasSymbol(checker, binding) : undefined;
    referenced = declaration !== undefined && IsNamespaceImport(declaration) ? referencedModule(checker, declaration) : undefined;
  } else if (IsAwaitExpression(receiver)) {
    const awaited = SkipParentheses(Node_Expression(receiver) as GoPtr<Expression>) as GoPtr<Node>;
    referenced = awaited !== undefined && IsImportCall(awaited) ? moduleOfSpecifier(checker, awaited, Node_Arguments(awaited)?.[0]) : undefined;
  }
  return referenced === undefined ? undefined : referenced.exportAssignment ?? referenced.module;
}

function moduleOfSpecifier(checker: GoPtr<Checker>, declaration: GoPtr<Node>, moduleSpecifier: GoPtr<Node>): { readonly module: Symbol; readonly exportAssignment: Symbol | undefined } | undefined {
  if (moduleSpecifier === undefined) return undefined;
  const moduleSymbol = Checker_resolveExternalModuleName(checker, declaration, moduleSpecifier, true as bool);
  if (moduleSymbol === undefined) return undefined;
  const exported = Checker_resolveExternalModuleSymbol(checker, moduleSymbol, true as bool);
  return { module: moduleSymbol, exportAssignment: exported === undefined || exported === moduleSymbol ? undefined : exported };
}

function withCheckerForNode<T>(
  program: GoPtr<Program>,
  node: GoPtr<Node>,
  defaultOptions: CreateTypeCheckerQueriesOptions,
  callback: (checker: GoPtr<Checker>) => GoPtr<T>,
): GoPtr<T> {
  if (node === undefined) {
    return undefined;
  }
  return withCheckedFile(
    program,
    GetSourceFileOfNode(node),
    defaultOptions,
    callback,
  );
}

function withCheckerForSymbol<T>(
  program: GoPtr<Program>,
  symbol: GoPtr<Symbol>,
  defaultOptions: CreateTypeCheckerQueriesOptions,
  callback: (checker: GoPtr<Checker>) => GoPtr<T>,
): GoPtr<T> {
  if (symbol === undefined) {
    return undefined;
  }
  if (symbol.checkerId !== undefined) {
    return withCheckerById(program, defaultOptions.sourceFile, symbol.checkerId,
      defaultOptions.context ?? Background(), callback);
  }
  return withChecker(
    program,
    defaultOptions.sourceFile,
    defaultOptions,
    callback,
  );
}

function withCheckerForType<T>(
  program: GoPtr<Program>,
  type: GoPtr<Type>,
  defaultOptions: CreateTypeCheckerQueriesOptions,
  callback: (checker: GoPtr<Checker>) => GoPtr<T>,
): GoPtr<T> {
  return withOwnedChecker(program, defaultOptions.sourceFile, type?.checker,
    defaultOptions.context ?? Background(), callback);
}

function withCheckerForSignature<T>(
  program: GoPtr<Program>,
  signature: GoPtr<Signature>,
  defaultOptions: CreateTypeCheckerQueriesOptions,
  callback: (checker: GoPtr<Checker>) => GoPtr<T>,
): GoPtr<T> {
  if (signature === undefined) {
    return undefined;
  }
  return withCheckerById(program, defaultOptions.sourceFile, signature.checkerId,
    defaultOptions.context ?? Background(), callback);
}

function withCheckedFile<T>(
  program: GoPtr<Program>,
  sourceFile: GoPtr<SourceFile>,
  defaultOptions: CreateTypeCheckerQueriesOptions,
  callback: (checker: GoPtr<Checker>) => GoPtr<T>,
): GoPtr<T> {
  return withSourceFileChecker(program, defaultOptions.sourceFile, sourceFile, defaultOptions.context ?? Background(), callback);
}

function withChecker<T>(
  program: GoPtr<Program>,
  sourceFile: GoPtr<SourceFile>,
  defaultOptions: CreateTypeCheckerQueriesOptions,
  callback: (checker: GoPtr<Checker>) => GoPtr<T>,
): GoPtr<T> {
  if (program === undefined || sourceFile === undefined || !Program_HasUsableCheckerSession(program) ||
    Program_GetSourceFile(program, SourceFile_FileName(sourceFile)) !== sourceFile) {
    return undefined;
  }
  const context = defaultOptions.context ?? Background();
  const [checker, done] = Program_GetTypeChecker(program, WithCheckerLifetime(context, CheckerLifetimeAPI));
  try {
    return callback(checker);
  } finally {
    done();
  }
}

function getSymbolSourceFile(symbol: GoPtr<Symbol>): GoPtr<SourceFile> {
  const declaration = getPrimarySymbolDeclaration(symbol);
  return GetSourceFileOfNode(declaration);
}

function getPrimarySymbolDeclaration(symbol: GoPtr<Symbol>): GoPtr<Node> {
  return symbol?.ValueDeclaration ?? symbol?.Declarations?.find((candidate) => candidate !== undefined);
}
