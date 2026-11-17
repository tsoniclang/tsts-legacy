import type { Node } from "../internal/ast/ast.js";
import type { SourcePrimitiveKind } from "./facts.js";

export interface ProviderRenderedSourcePrimitive {
  readonly marker: number;
  readonly exportId: string;
  readonly primitive: SourcePrimitiveKind;
}

export interface ProviderSourcePrimitiveAnnotation {
  readonly node: Node;
  readonly primitive: SourcePrimitiveKind;
}

const markerPrefix = "/*@tsts-provider-primitive:";
const markerSuffix = "*/";
export const providerSourcePrimitiveMarkerMaximumLength = markerPrefix.length + 16 + markerSuffix.length;

export function renderProviderSourcePrimitiveMarker(marker: number): string {
  if (!Number.isSafeInteger(marker) || marker < 0) {
    throw new Error("Provider source-primitive marker must be a non-negative safe integer.");
  }
  return `${markerPrefix}${marker}${markerSuffix}`;
}

export function parseProviderSourcePrimitiveMarker(sourceText: string): number | undefined {
  const match = /^\/\*@tsts-provider-primitive:(0|[1-9][0-9]{0,15})\*\//u.exec(sourceText);
  if (match === null) return undefined;
  const marker = Number(match[1]);
  return Number.isSafeInteger(marker) ? marker : undefined;
}
