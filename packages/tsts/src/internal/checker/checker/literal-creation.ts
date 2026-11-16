import type { Node } from "../../ast/spine.js";
import type { Symbol, SymbolTable } from "../../ast/symbol.js";
import type { SymbolFlags } from "../../ast/generated/flags.js";
import type { CheckFlags } from "../../ast/checkflags.js";
import { LinkStore_TryGet } from "../../core/linkstore.js";
import type { Checker, CheckMode } from "./state.js";
import type { IndexInfo, ObjectFlags, Signature, Type } from "../types.js";
import { Type_AsStructuredType, ObjectFlagsAnonymous, ObjectFlagsMembersResolved, ObjectFlagsFreshLiteral,
  ObjectFlagsJSLiteral, ObjectFlagsObjectLiteral, ObjectFlagsObjectLiteralPatternWithComputedProperties,
  ObjectFlagsPropagatingFlags } from "../types.js";

import { Checker_newAnonymousType } from "./types.js";

export interface LiteralMemberInput {
  readonly symbol: Symbol;
  readonly target: Symbol | undefined;
  readonly flags: SymbolFlags;
  readonly checkFlags: CheckFlags;
  readonly nameType: Type | undefined;
  readonly value: Type | undefined;
  readonly declarations: readonly (Node | undefined)[];
  readonly parent: Symbol | undefined;
  readonly declaration: Node | undefined;
}

export interface LiteralCreationInput {
  readonly symbol: Symbol | undefined;
  readonly flags: ObjectFlags;
  readonly pattern: Node | undefined;
  readonly members: readonly LiteralMemberInput[];
  readonly calls: readonly Signature[];
  readonly constructs: readonly Signature[];
  readonly indexes: readonly IndexInfo[];
}

function copyIndex(input: IndexInfo): IndexInfo {
  return { ...input, components: input.components.slice() };
}

export class LiteralCreation {
  readonly #output: Type;
  readonly #checker: Checker;
  readonly #node: Node;
  readonly #mode: CheckMode;
  readonly #input: LiteralCreationInput;

  private constructor(output: Type, checker: Checker, node: Node, mode: CheckMode, input: LiteralCreationInput) {
    this.#output = output;
    this.#checker = checker;
    this.#node = node;
    this.#mode = mode;
    this.#input = input;
  }

  get node(): Node { return this.#node; }
  get mode(): CheckMode { return this.#mode; }

  static create(checker: Checker, node: Node, mode: CheckMode, symbol: Symbol | undefined,
    members: SymbolTable, calls: readonly Signature[], constructs: readonly Signature[], indexes: readonly IndexInfo[],
    flags: ObjectFlags, pattern: Node | undefined): Type {
    const output = Checker_newAnonymousType(checker, symbol, members, calls.slice(), constructs.slice(), indexes.slice());
    if (output === undefined) throw new Error("The actual native literal factory returns its fresh output");
    output.objectFlags |= flags;
    if (pattern !== undefined) checker.patternForType.set(output, pattern);
    const values: LiteralMemberInput[] = [];
    for (const member of members.values()) {
      if (member === undefined) throw new Error("The native literal factory supplies dense members");
      const links = LinkStore_TryGet(checker.valueSymbolLinks, member);
      values.push({ symbol: member, target: links?.target, flags: member.Flags, checkFlags: member.CheckFlags,
        nameType: links?.nameType, value: links?.resolvedType, declarations: (member.Declarations ?? []).slice(),
        parent: member.Parent, declaration: member.ValueDeclaration });
    }
    const input: LiteralCreationInput = { symbol, flags: output.objectFlags, pattern, members: values,
      calls: calls.slice(), constructs: constructs.slice(), indexes: indexes.map(copyIndex) };
    output.derivation = { kind: "object-literal", creation: new LiteralCreation(output, checker, node, mode, input) };
    return output;
  }

  static read(type: Type): LiteralCreation | undefined {
    const record = type.derivation;
    if (record?.kind !== "object-literal") return undefined;
    const creation = record.creation;
    if (typeof creation !== "object" || creation === null || !(#output in creation)
      || creation.#output !== type || creation.#checker !== type.checker) return undefined;
    const literalFactoryFlags = ObjectFlagsAnonymous | ObjectFlagsMembersResolved | ObjectFlagsFreshLiteral
      | ObjectFlagsJSLiteral | ObjectFlagsObjectLiteral | ObjectFlagsObjectLiteralPatternWithComputedProperties | ObjectFlagsPropagatingFlags;
    if ((type.objectFlags & literalFactoryFlags) !== (creation.#input.flags & literalFactoryFlags)
      || creation.#checker.patternForType.get(type) !== creation.#input.pattern) return undefined;
    const members = Type_AsStructuredType(type)?.members;
    if (type.symbol !== creation.#input.symbol || members === undefined || members.size !== creation.#input.members.length)
      return undefined;
    let position = 0;
    for (const symbol of members.values()) {
      const input = creation.#input.members[position++];
      if (input === undefined || symbol !== input.symbol || symbol === undefined) return undefined;
      const links = LinkStore_TryGet(creation.#checker.valueSymbolLinks, symbol);
      if (symbol.Flags !== input.flags || symbol.CheckFlags !== input.checkFlags || symbol.Parent !== input.parent
        || symbol.ValueDeclaration !== input.declaration || input.target !== undefined && (links?.target !== input.target
        || links?.nameType !== input.nameType || links?.resolvedType !== input.value)) return undefined;
      const declarations = symbol.Declarations ?? [];
      if (declarations.length !== input.declarations.length) return undefined;
      for (let index = 0; index < declarations.length; index++)
        if (declarations[index] !== input.declarations[index]) return undefined;
    }
    const structured = Type_AsStructuredType(type);
    if (structured === undefined || structured.signatures.length !== creation.#input.calls.length + creation.#input.constructs.length
      || structured.callSignatureCount !== creation.#input.calls.length
      || structured.indexInfos.length !== creation.#input.indexes.length) return undefined;
    for (let index = 0; index < structured.signatures.length; index++)
      if (structured.signatures[index] !== (index < creation.#input.calls.length ? creation.#input.calls[index]
        : creation.#input.constructs[index - creation.#input.calls.length])) return undefined;
    for (let index = 0; index < structured.indexInfos.length; index++) {
      const actual = structured.indexInfos[index];
      const input = creation.#input.indexes[index];
      if (actual === undefined || input === undefined || actual.keyType !== input.keyType || actual.valueType !== input.valueType
        || actual.declaration !== input.declaration || actual.isReadonly !== input.isReadonly
        || actual.indexSymbol !== input.indexSymbol || actual.components.length !== input.components.length) return undefined;
      for (let component = 0; component < actual.components.length; component++)
        if (actual.components[component] !== input.components[component]) return undefined;
    }
    return creation;
  }

  inputs(): LiteralCreationInput {
    const input = this.#input;
    return { ...input, members: input.members.map(member => ({ ...member, declarations: member.declarations.slice() })),
      calls: input.calls.slice(), constructs: input.constructs.slice(), indexes: input.indexes.map(copyIndex) };
  }
}
