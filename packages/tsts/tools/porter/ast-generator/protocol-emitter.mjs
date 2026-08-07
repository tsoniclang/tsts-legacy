export function emitProtocol(schema) {
  const constants = [];
  const pattern = /^export const ([A-Z][A-Z0-9_]*) = (0x[0-9A-Fa-f_]+|[0-9_]+);$/gm;
  for (const match of schema.protocolSource.matchAll(pattern)) {
    constants.push({ name: match[1], value: match[2] });
  }
  if (constants.length === 0) {
    throw new Error("TS-Go protocol schema contains no numeric constants");
  }
  return constants
    .map(({ name, value }) => `export const ${name} = ${value};`)
    .join("\n") + "\n";
}
