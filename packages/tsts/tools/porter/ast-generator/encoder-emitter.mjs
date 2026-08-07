const DATA_CHILDREN = "TargetAstNodeDataChildren";
const DATA_STRING = "TargetAstNodeDataString";
const DATA_EXTENDED = "TargetAstNodeDataExtended";

export function emitEncoder(schema) {
  const lines = [];
  const owners = schema.nodeNames();
  const castOwners = owners.filter((owner) => owner !== "SourceFile");
  const kinds = kindOwners(schema);

  lines.push(`import type { GoPtr } from "../../../go/compat.js";`);
  lines.push(`import { AsSourceFile } from "../ast.js";`);
  lines.push(`import type { SourceFile } from "../ast.js";`);
  lines.push(`import type { Node, NodeList } from "../spine.js";`);
  lines.push(`import {`);
  for (const owner of castOwners) lines.push(`  As${owner},`);
  lines.push(`} from "./casts.js";`);
  lines.push(`import type {`);
  for (const owner of castOwners) lines.push(`  ${owner},`);
  lines.push(`} from "./data.js";`);
  lines.push(`import {`);
  for (const kind of [...kinds.keys()].sort()) lines.push(`  Kind${kind},`);
  lines.push(`} from "./kinds.js";`);
  lines.push("");
  lines.push(`export const TargetAstNodeDataChildren = 0;`);
  lines.push(`export const TargetAstNodeDataString = 1;`);
  lines.push(`export const TargetAstNodeDataExtended = 2;`);
  lines.push("");
  lines.push(`export interface TargetAstEncodedChild {`);
  lines.push(`  readonly name: string;`);
  lines.push(`  readonly present: boolean;`);
  lines.push(`  readonly required: boolean;`);
  lines.push(`  readonly raw: boolean;`);
  lines.push(`  readonly node?: GoPtr<Node>;`);
  lines.push(`  readonly nodes?: readonly GoPtr<Node>[];`);
  lines.push(`  readonly list?: GoPtr<NodeList>;`);
  lines.push(`}`);
  lines.push("");
  lines.push(`export interface TargetAstNodeEncoding {`);
  lines.push(`  readonly dataType: 0 | 1 | 2;`);
  lines.push(`  readonly commonData: number;`);
  lines.push(`  readonly children: readonly TargetAstEncodedChild[];`);
  lines.push(`  readonly text?: string;`);
  lines.push(`  readonly rawText?: string;`);
  lines.push(`  readonly tokenFlags?: number;`);
  lines.push(`  readonly extended: "literal" | "template" | "source-file" | "none";`);
  lines.push(`}`);
  lines.push("");
  lines.push(`export function targetAstNodeEncoding(node: Node): TargetAstNodeEncoding {`);
  lines.push(`  switch (node.Kind) {`);
  for (const [kind, owner] of [...kinds.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const cast = owner === "SourceFile" ? "AsSourceFile" : `As${owner}`;
    lines.push(`    case Kind${kind}:`);
    lines.push(`      return encode${owner}(${cast}(node)!);`);
  }
  lines.push(`    default:`);
  lines.push(`      throw new globalThis.Error("TS-Go target AST encoder has no schema owner for kind " + node.Kind);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");

  for (const owner of owners) emitOwnerEncoder(schema, owner, lines);
  return lines.join("\n");
}

function kindOwners(schema) {
  const result = new Map();
  for (const owner of schema.nodeNames()) {
    for (const kind of schema.kindTypesOf(owner).kindNames) {
      const existing = result.get(kind);
      if (
        existing !== undefined &&
        existing !== owner &&
        !isGenericOwner(schema, existing) &&
        !isGenericOwner(schema, owner)
      ) {
        throw new Error(`TS-Go kind ${kind} has encoder owners ${existing} and ${owner}`);
      }
      if (existing === undefined || !isGenericOwner(schema, owner)) result.set(kind, owner);
    }
  }
  return result;
}

function isGenericOwner(schema, owner) {
  return (schema.definitions[owner].typeParameters ?? []).length !== 0;
}

function encodedMembers(schema, owner) {
  return schema.members(owner).filter((member) =>
    member.name !== "Kind" &&
    member.name !== "kind" &&
    !member.noTS &&
    !member.noGo
  );
}

function emitOwnerEncoder(schema, owner, lines) {
  const members = encodedMembers(schema, owner);
  const children = members.filter((member) => member.isChild());
  if (children.length > 8) {
    throw new Error(`${owner} has ${children.length} encoded children; protocol supports 8`);
  }
  const dataType = nodeDataType(schema, owner, members);
  lines.push(`function encode${owner}(node: ${owner}): TargetAstNodeEncoding {`);
  const common = emitCommonData(schema, owner, members, dataType, lines);
  lines.push(`  const children: TargetAstEncodedChild[] = [`);
  for (const member of children) lines.push(`    ${childExpression(member)},`);
  lines.push(`  ];`);
  if (owner === "JSDocParameterOrPropertyTag") {
    lines.push(`  if (!node.IsNameFirst) {`);
    lines.push(`    const second = children[1]!;`);
    lines.push(`    children[1] = children[2]!;`);
    lines.push(`    children[2] = second;`);
    lines.push(`  }`);
  }
  lines.push(`  return {`);
  lines.push(`    dataType: ${dataType},`);
  lines.push(`    commonData: ${common},`);
  lines.push(`    children,`);
  for (const field of extendedFields(owner, members, dataType)) lines.push(`    ${field}`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push("");
}

function nodeDataType(schema, owner, members) {
  if (owner === "SourceFile") return DATA_EXTENDED;
  const nonChildren = members.filter((member) => !member.isChild());
  const strings = nonChildren.filter(isStringMember);
  const hasUnencodedCommon = nonChildren.some((member) =>
    !isStringMember(member) &&
    !(member.name === "Flags" && member.rawType === "NodeFlags") &&
    !isBooleanMember(member) &&
    memberKindValues(schema, owner, member).length === 0
  );
  if (strings.length > 1 || (strings.length === 1 && hasUnencodedCommon)) return DATA_EXTENDED;
  if (strings.length === 1) return DATA_STRING;
  return DATA_CHILDREN;
}

function containsAny(member) {
  return Array.isArray(member.rawType)
    ? member.rawType.includes("any")
    : member.rawType === "any";
}

function childExpression(member) {
  const value = `node.${member.name}`;
  const required = !member.optional;
  if (member.listKind === "raw") {
    return `{ name: ${JSON.stringify(member.name)}, present: ${value}.length !== 0, required: false, raw: true, nodes: ${value} }`;
  }
  if (member.listKind === "NodeList" || member.listKind === "ModifierList") {
    const present = member.optional || member.listKind === "ModifierList"
      ? `${value} !== undefined`
      : "true";
    return `{ name: ${JSON.stringify(member.name)}, present: ${present}, required: ${required}, raw: false, nodes: ${value}?.Nodes ?? [], list: ${value} }`;
  }
  const requiredExpression = member.name === "Expression"
    ? `(node.Kind === KindDefaultClause ? false : ${required})`
    : String(required);
  return `{ name: ${JSON.stringify(member.name)}, present: ${value} !== undefined, required: ${requiredExpression}, raw: false, node: ${value} }`;
}

function emitCommonData(schema, owner, members, dataType, lines) {
  if (dataType === DATA_EXTENDED) return "0";
  if (members.some(containsAny)) return "0";
  let bit = 24;
  let index = 0;
  lines.push(`  let commonData = 0;`);
  for (const member of members) {
    if (
      member.isChild() ||
      isStringMember(member) ||
      (member.name === "Flags" && member.rawType === "NodeFlags")
    ) {
      continue;
    }
    if (isBooleanMember(member)) {
      lines.push(`  if (node.${member.name}) commonData |= 1 << ${bit};`);
      bit += 1;
      continue;
    }
    const kinds = memberKindValues(schema, owner, member);
    if (kinds.length === 0) {
      throw new Error(`${owner}.${member.name} has no target AST common-data encoding`);
    }
    const width = bitWidth(kinds.length - 1 + (member.optional ? 1 : 0));
    const encodedName = `encoded${index}`;
    lines.push(`  let ${encodedName} = 0;`);
    lines.push(`  switch (node.${member.name}) {`);
    kinds.forEach((kind, kindIndex) => {
      lines.push(`    case Kind${kind}:`);
      lines.push(`      ${encodedName} = ${kindIndex + (member.optional ? 1 : 0)};`);
      lines.push(`      break;`);
    });
    if (member.optional) {
      lines.push(`    case 0:`);
      lines.push(`      break;`);
    }
    lines.push(`    default:`);
    lines.push(`      throw new globalThis.Error(${JSON.stringify(`${owner}.${member.name} has an invalid TS-Go kind value`)});`);
    lines.push(`  }`);
    if (width !== 0) lines.push(`  commonData |= ${encodedName} << ${bit};`);
    bit += width;
    index += 1;
  }
  if (bit > 30) throw new Error(`${owner} target AST common data exceeds six bits`);
  return "commonData >>> 0";
}

function extendedFields(owner, members, dataType) {
  if (owner === "SourceFile") return [`extended: "source-file",`];
  if (dataType === DATA_CHILDREN) return [`extended: "none",`];
  const text = members.find(isStringMember);
  if (text === undefined) throw new Error(`${owner} has no target AST text member`);
  const textExpression = text.listKind === "raw"
    ? `node.${text.name}.join("")`
    : `node.${text.name}`;
  if (dataType === DATA_STRING) {
    return [`text: ${textExpression},`, `extended: "none",`];
  }
  const rawText = members.find((member) => member.name === "RawText");
  const flags = members.find((member) =>
    member.name === "TokenFlags" || member.name === "TemplateFlags"
  );
  if (flags === undefined) {
    throw new Error(`${owner} extended target AST data has no token flags`);
  }
  if (rawText !== undefined) {
    return [
      `text: ${textExpression},`,
      `rawText: node.${rawText.name},`,
      `tokenFlags: node.${flags.name},`,
      `extended: "template",`,
    ];
  }
  return [
    `text: ${textExpression},`,
    `tokenFlags: node.${flags.name},`,
    `extended: "literal",`,
  ];
}

function isStringMember(member) {
  return member.rawType === "string";
}

function isBooleanMember(member) {
  return member.rawType === "bool" || member.rawType === "boolean";
}

function memberKindValues(schema, owner, member) {
  let raw = member.rawType;
  if (!Array.isArray(raw)) {
    const parameter = (schema.definitions[owner].typeParameters ?? [])
      .find((candidate) => candidate.name === raw);
    if (parameter !== undefined) raw = parameter.constraint;
  }
  if (Array.isArray(raw)) {
    if (!raw.every((value) => value.startsWith("SyntaxKind."))) return [];
    return raw.map(stripSyntaxKind);
  }
  if (typeof raw === "string" && raw.startsWith("SyntaxKind.")) {
    return [stripSyntaxKind(raw)];
  }
  if (typeof raw === "string" && schema.hasKindAlias(raw)) {
    return schema.expandKindAliasMembers(raw);
  }
  return [];
}

function stripSyntaxKind(value) {
  return value.slice("SyntaxKind.".length);
}

function bitWidth(value) {
  return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
}
