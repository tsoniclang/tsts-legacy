import type { Node } from "../internal/ast/ast.js";
import type { ExtensionFactKey } from "./fact-key.js";
import type { SourceProgramQueries } from "./source-program.js";

export interface SourceElaborationRequest {
  readonly node: Node;
  readonly key: ExtensionFactKey<unknown>;
}

export interface SourceElaborationNodeReference {
  readonly session: number;
  readonly revision: number;
  readonly id: number;
}

export interface SourceElaborationContext {
  readonly source: SourceProgramQueries;
  readonly request: <T>(node: Node, key: ExtensionFactKey<T>) => void;
}

export interface SourceElaborationResolverContext extends SourceElaborationContext {
  readonly node: Node;
  readonly require: <T>(node: Node, key: ExtensionFactKey<T>) => T;
  readonly reference: (node: Node) => SourceElaborationNodeReference;
  readonly resolve: (reference: SourceElaborationNodeReference) => Node;
}

export type SourceElaborationResolver<T> = (context: SourceElaborationResolverContext) => T;

export interface SourceElaborationLimits {
  readonly maximumRounds: number;
  readonly maximumRequests: number;
  readonly maximumReferences: number;
  readonly maximumDependencies: number;
  readonly maximumAnchorDepth: number;
  readonly maximumDataRows: number;
  readonly maximumDataCodeUnits: number;
}

export const defaultSourceElaborationLimits: SourceElaborationLimits = Object.freeze({
  maximumRounds: 1024,
  maximumRequests: 65_536,
  maximumReferences: 262_144,
  maximumDependencies: 262_144,
  maximumAnchorDepth: 2048,
  maximumDataRows: 4_194_304,
  maximumDataCodeUnits: 64 * 1024 * 1024,
});

export function snapshotSourceElaborationLimits(value: SourceElaborationLimits): SourceElaborationLimits {
  if (value === null || typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Source elaboration limits must be a plain data record.");
  }
  const fields = Object.keys(defaultSourceElaborationLimits) as (keyof SourceElaborationLimits)[];
  if (Reflect.ownKeys(value).length !== fields.length) {
    throw new Error("Source elaboration limits require exactly the complete budget family.");
  }
  const result = {} as Record<keyof SourceElaborationLimits, number>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    const selected: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < 1) {
      throw new Error(`Source elaboration limit '${field}' must be a positive finite safe integer.`);
    }
    result[field] = selected;
  }
  return Object.freeze(result);
}
