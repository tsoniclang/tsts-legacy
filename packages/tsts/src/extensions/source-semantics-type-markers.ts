import type { Node } from "../internal/ast/ast.js";
import { Node_Elements, Node_TypeArguments } from "../internal/ast/ast.js";
import { KindTupleType } from "../internal/ast/generated/kinds.js";
import type {
  FunctionPointerFact,
  PointerFact,
  RawPointerFact,
  SourceMarkerFact,
  SourceTypeMarkerKind,
} from "./facts.js";

export type SourceTypeMarkerReferenceFact =
  | { readonly kind: "pointer"; readonly value: PointerFact }
  | { readonly kind: "raw-pointer"; readonly value: RawPointerFact }
  | { readonly kind: "function-pointer"; readonly value: FunctionPointerFact }
  | { readonly kind: "marker"; readonly value: SourceMarkerFact };

export function createSourceTypeMarkerReferenceFact(
  typeReference: Node,
  marker: SourceTypeMarkerKind,
): SourceTypeMarkerReferenceFact | undefined {
  const arguments_ = Node_TypeArguments(typeReference) ?? [];
  switch (marker) {
    case "raw-pointer":
      return arguments_.length === 0
        ? { kind: "raw-pointer", value: { representation: "opaque-identity" } }
        : undefined;
    case "pointer": {
      const pointee = arguments_[0];
      return arguments_.length === 1 && pointee !== undefined
        ? { kind: "pointer", value: { pointee, mutability: "readwrite" } }
        : undefined;
    }
    case "fixed-array":
      return { kind: "marker", value: { kind: "type-marker", marker } };
    case "js-string":
      return arguments_.length === 0
        ? { kind: "marker", value: { kind: "type-marker", marker } }
        : undefined;
    case "function-pointer": {
      const parameterList = arguments_[0];
      const result = arguments_[1];
      if (arguments_.length !== 2 || parameterList === undefined || result === undefined) return undefined;
      const parameters = parameterList.Kind === KindTupleType
        ? (Node_Elements(parameterList) ?? []).filter((node): node is Node => node !== undefined)
        : [parameterList];
      return { kind: "function-pointer", value: { parameters, result, abi: ["target-default"] } };
    }
  }
}
