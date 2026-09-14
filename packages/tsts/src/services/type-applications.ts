import type { GoPtr } from "../go/compat.js";
import { Node_Name, Node_Type, Node_TypeParameters } from "../internal/ast/ast.js";
import type { Node } from "../internal/ast/ast.js";
import { IsTypeAliasDeclaration } from "../internal/ast/generated/predicates.js";
import { AsTypeParameterDeclaration } from "../internal/ast/generated/casts.js";
import { GetSourceFileOfNode } from "../internal/ast/utilities.js";
import { Checker_GetDeclaredTypeOfSymbol, Checker_GetTypeFromTypeNode } from "../internal/checker/exports.js";
import { Checker_GetSymbolAtLocation } from "../internal/checker/checker/symbols.js";
import { Checker_instantiateType } from "../internal/checker/checker/types.js";
import { newTypeMapper } from "../internal/checker/mapper.js";
import { Checker_isTypeAssignableTo } from "../internal/checker/relater.js";
import type { Checker } from "../internal/checker/checker/state.js";
import type { Type } from "../internal/checker/types.js";
import { TypeFlagsTypeParameter } from "../internal/checker/types.js";

export interface TypeAliasApplicationInfo {
  readonly declaration: Node;
  readonly bindings: readonly {
    readonly declaration: Node;
    readonly parameter: Type;
    readonly argument: Type;
  }[];
  readonly result: Type;
}

export function resolveTypeAliasApplication(
  checker: GoPtr<Checker>,
  declaration: GoPtr<Node>,
  arguments_: readonly Type[],
): TypeAliasApplicationInfo | undefined {
  if (declaration === undefined || !IsTypeAliasDeclaration(declaration) || !Array.isArray(arguments_)) return undefined;
  const parameters = Node_TypeParameters(declaration) ?? [];
  if (parameters.length !== arguments_.length) return undefined;
  for (const parameter of parameters) {
    if (parameter === undefined) return undefined;
  }
  for (const argument of arguments_) {
    if (argument === undefined || argument === null) return undefined;
  }
  const sourceFile = GetSourceFileOfNode(declaration);
  if (checker === undefined || sourceFile === undefined || !checker.fileIndexMap.has(sourceFile) ||
    arguments_.some(argument => argument.checker !== checker)) return undefined;
  const typeNode = Node_Type(declaration);
  if (typeNode === undefined) return undefined;
  const sourceParameters: Type[] = [];
  for (const parameter of parameters) {
    const symbol = Checker_GetSymbolAtLocation(checker, Node_Name(parameter));
    const type = symbol === undefined ? undefined : Checker_GetDeclaredTypeOfSymbol(checker, symbol);
    if (type === undefined || type.checker !== checker || (type.flags & TypeFlagsTypeParameter) === 0 ||
      sourceParameters.includes(type)) return undefined;
    sourceParameters.push(type);
  }
  const template = Checker_GetTypeFromTypeNode(checker, typeNode);
  if (template === undefined || template === checker.errorType) return undefined;
  const mapper = sourceParameters.length === 0 ? undefined : newTypeMapper(sourceParameters, [...arguments_]);
  for (const [index, parameter] of parameters.entries()) {
    const constraintNode = AsTypeParameterDeclaration(parameter)?.Constraint;
    if (constraintNode === undefined) continue;
    const constraint = Checker_GetTypeFromTypeNode(checker, constraintNode);
    const instantiated = constraint === undefined ? undefined : Checker_instantiateType(checker, constraint, mapper);
    if (instantiated === undefined || instantiated === checker.errorType ||
      !Checker_isTypeAssignableTo(checker, arguments_[index], instantiated)) return undefined;
  }
  const result = Checker_instantiateType(checker, template, mapper);
  if (result === undefined || result === checker.errorType) return undefined;
  return Object.freeze({
    declaration,
    bindings: Object.freeze(parameters.map((parameter, index) => Object.freeze({
      declaration: parameter!, parameter: sourceParameters[index]!, argument: arguments_[index]!,
    }))),
    result,
  });
}
