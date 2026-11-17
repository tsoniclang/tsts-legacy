const providerWellKnownSymbolNames = [
  "asyncDispose",
  "asyncIterator",
  "dispose",
  "hasInstance",
  "isConcatSpreadable",
  "iterator",
  "match",
  "matchAll",
  "replace",
  "search",
  "species",
  "split",
  "toPrimitive",
  "toStringTag",
  "unscopables",
] as const;

export type ProviderWellKnownSymbolName = typeof providerWellKnownSymbolNames[number];

const providerWellKnownSymbolNameSet: ReadonlySet<string> = new Set(providerWellKnownSymbolNames);

export function isProviderWellKnownSymbolName(name: string): name is ProviderWellKnownSymbolName {
  return providerWellKnownSymbolNameSet.has(name);
}
