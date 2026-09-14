import type { GoPtr } from "../../../go/compat.js";
import type { Node } from "../../ast/spine.js";
import type { ConditionalRoot, Type } from "../types.js";
import type { TypeMapper } from "../mapper.js";

export interface ExtensionConditionalStep {
  readonly conditional: Node;
  readonly branch: "true" | "false" | "deferred";
  readonly selectedNode: GoPtr<Node>;
  readonly parameters: readonly Type[];
  readonly mapper: GoPtr<TypeMapper>;
}

export interface ExtensionConditionalCapture {
  readonly complete: boolean;
  readonly steps: readonly ExtensionConditionalStep[];
  record(root: GoPtr<ConditionalRoot>, branch: ExtensionConditionalStep["branch"],
    selectedNode: GoPtr<Node>, mapper: GoPtr<TypeMapper>): void;
}

export function createExtensionConditionalCapture(): ExtensionConditionalCapture {
  const steps: ExtensionConditionalStep[] = [];
  let complete = true;
  let parametersUsed = 0;
  const capture: ExtensionConditionalCapture = {
    get complete() { return complete; },
    get steps() { return Object.freeze([...steps]); },
    record(root, branch, selectedNode, mapper) {
      if (!complete) return;
      if (root?.node === undefined || steps.length >= 1_024 ||
        root.outerTypeParameters.length + root.inferTypeParameters.length > 8_192 - parametersUsed) {
        complete = false;
        return;
      }
      const parameters: Type[] = [];
      for (const parameter of [...root.outerTypeParameters, ...root.inferTypeParameters]) {
        if (parameter === undefined) {
          complete = false;
          return;
        }
        if (!parameters.includes(parameter)) parameters.push(parameter);
      }
      parametersUsed += parameters.length;
      steps.push(Object.freeze({ conditional: root.node, branch, selectedNode,
        parameters: Object.freeze(parameters), mapper }));
    },
  };
  return Object.freeze(capture);
}
