import { Node_Initializer, Node_QuestionToken } from "../ast/ast.js";
import type { Node } from "../ast/spine.js";
import { IsParameterDeclaration } from "../ast/generated/predicates.js";
import type { Symbol } from "../ast/symbol.js";
import { SymbolFlagsOptional } from "../ast/symbolflags.js";
import { SignatureFlagsHasRestParameter } from "./types.js";
import type { ResolvedOriginalSignatureEvidence, Signature } from "./types.js";

export function readOriginalSignature(signature: Signature): ResolvedOriginalSignatureEvidence {
  const declaration = (parameter: Symbol | undefined): Node | undefined => parameter?.ValueDeclaration
    ?? parameter?.Declarations?.find(node => node !== undefined);
  const restIndex = (signature.flags & SignatureFlagsHasRestParameter) !== 0 ? signature.parameters.length - 1 : -1;
  return Object.freeze({ declaration: signature.declaration, target: signature.target,
    parameters: Object.freeze(signature.parameters.map((parameter, index) => {
      const original = declaration(parameter);
      return Object.freeze({ index, declaration: original, rest: index === restIndex,
        optional: parameter !== undefined && ((parameter.Flags & SymbolFlagsOptional) !== 0 ||
          IsParameterDeclaration(original) && (Node_QuestionToken(original) !== undefined || Node_Initializer(original) !== undefined)) });
    })),
    receiver: signature.thisParameter === undefined ? undefined
      : Object.freeze({ declaration: declaration(signature.thisParameter) }) });
}
