import type { Node } from "../../ast/spine.js";
import type { Symbol, SymbolTable } from "../../ast/symbol.js";
import type { SymbolFlags } from "../../ast/generated/flags.js";
import type { CheckFlags } from "../../ast/checkflags.js";
import { LinkStore_TryGet } from "../../core/linkstore.js";
import type { Checker, CheckMode } from "./state.js";
import type { IndexInfo, LiteralSpreadSite, ObjectFlags, Signature, Type, TypeNodeLinks } from "../types.js";
import { GetSourceFileOfNode } from "../../ast/utilities.js";
import { SourceFile_FileName } from "../../ast/ast.js";
import { Type_AsStructuredType, ObjectFlagsAnonymous, ObjectFlagsMembersResolved, ObjectFlagsFreshLiteral,
  ObjectFlagsJSLiteral, ObjectFlagsObjectLiteral, ObjectFlagsObjectLiteralPatternWithComputedProperties,
  ObjectFlagsPropagatingFlags, ObjectFlagsContainsSpread } from "../types.js";

export type LiteralCreatorInput =
  | { readonly kind: "object-literal"; readonly node: Node; readonly mode: CheckMode }
  | { readonly kind: "literal-fragment"; readonly node: Node; readonly mode: CheckMode; readonly boundary: Node | null }
  | { readonly kind: "literal-merge"; readonly site: LiteralSpreadSite; readonly left: Type; readonly right: Type;
    readonly flags: ObjectFlags; readonly readonly: boolean }
  | { readonly kind: "literal-partial"; readonly site: LiteralSpreadSite; readonly source: Type; readonly other: Type;
    readonly role: "operand" | "left" | "right"; readonly readonly: boolean };

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
  readonly syntheticOrigin: Symbol | undefined;
  readonly leftSpread: Symbol | undefined;
  readonly rightSpread: Symbol | undefined;
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

export interface LiteralCreationView {
  readonly capability: LiteralCreation;
  readonly node: Node;
  readonly mode: CheckMode;
  readonly creator: LiteralCreatorInput;
  readonly owner: LiteralConstructionOwner | undefined;
  readonly inputs: () => LiteralCreationInput;
}

export class LiteralConstructionOwner {
  readonly #checker: Checker;
  readonly #node: Node;
  readonly #links: TypeNodeLinks;
  #root: Type | undefined;
  #completed = false;

  private constructor(checker: Checker, node: Node, links: TypeNodeLinks) {
    this.#checker = checker;
    this.#node = node;
    this.#links = links;
  }

  static begin(checker: Checker, node: Node, links: TypeNodeLinks): LiteralConstructionOwner {
    return new LiteralConstructionOwner(checker, node, links);
  }

  static complete(owner: LiteralConstructionOwner, root: Type | undefined): void {
    if (owner.#completed) throw new TypeError("An actual native construction question is published only once");
    owner.#root = root;
    owner.#completed = true;
  }

  static read(owner: LiteralConstructionOwner, checker: Checker): { readonly node: Node; readonly root: Type } | undefined {
    const file = GetSourceFileOfNode(owner.#node);
    if (owner.#checker !== checker || file === undefined || checker.program.GetSourceFile(SourceFile_FileName(file)) !== file
      || LinkStore_TryGet(checker.typeNodeLinks, owner.#node) !== owner.#links || !owner.#completed || owner.#root === undefined
      || owner.#root.checker !== checker || owner.#links.resolvedType !== owner.#root)
      return undefined;
    return { node: owner.#node, root: owner.#root };
  }
}

function copyIndex(input: IndexInfo): IndexInfo {
  return { ...input, components: input.components.slice() };
}

export class LiteralCreation {
  readonly #output: Type;
  readonly #checker: Checker;
  readonly #creator: LiteralCreatorInput;
  readonly #input: LiteralCreationInput;
  readonly #owner: LiteralConstructionOwner | undefined;

  private constructor(output: Type, checker: Checker, creator: LiteralCreatorInput, input: LiteralCreationInput,
    owner: LiteralConstructionOwner | undefined) {
    this.#output = output;
    this.#checker = checker;
    this.#creator = "site" in creator ? { ...creator, site: { ...creator.site } } : { ...creator };
    this.#input = input;
    this.#owner = owner;
  }

  static create(checker: Checker, creator: LiteralCreatorInput, symbol: Symbol | undefined,
    members: SymbolTable, calls: readonly Signature[], constructs: readonly Signature[], indexes: readonly IndexInfo[],
    flags: ObjectFlags, pattern: Node | undefined, owner?: LiteralConstructionOwner): Type {
    const output = Checker_newAnonymousType(checker, symbol, members, calls.slice(), constructs.slice(), indexes.slice());
    if (output === undefined) throw new Error("The actual native literal factory returns its fresh output");
    output.objectFlags |= flags;
    if (pattern !== undefined) checker.patternForType.set(output, pattern);
    const values: LiteralMemberInput[] = [];
    for (const member of members.values()) {
      if (member === undefined) throw new Error("The native literal factory supplies dense members");
      const links = LinkStore_TryGet(checker.valueSymbolLinks, member);
      const spread = LinkStore_TryGet(checker.spreadLinks, member);
      values.push({ symbol: member, target: links?.target, flags: member.Flags, checkFlags: member.CheckFlags,
        nameType: links?.nameType, value: links?.resolvedType, declarations: (member.Declarations ?? []).slice(),
        parent: member.Parent, declaration: member.ValueDeclaration,
        syntheticOrigin: LinkStore_TryGet(checker.mappedSymbolLinks, member)?.syntheticOrigin,
        leftSpread: spread?.leftSpread, rightSpread: spread?.rightSpread });
    }
    const input: LiteralCreationInput = { symbol, flags: output.objectFlags, pattern, members: values,
      calls: calls.slice(), constructs: constructs.slice(), indexes: indexes.map(copyIndex) };
    output.derivation = { kind: creator.kind, creation: new LiteralCreation(output, checker, creator, input, owner) };
    return output;
  }

  static read(type: Type): LiteralCreationView | undefined {
    const record = type.derivation;
    if (record?.kind !== "object-literal" && record?.kind !== "literal-fragment"
      && record?.kind !== "literal-merge" && record?.kind !== "literal-partial") return undefined;
    const creation = record.creation;
    if (typeof creation !== "object" || creation === null || !(#output in creation)
      || creation.#output !== type || creation.#checker !== type.checker || record.kind !== creation.#creator.kind) return undefined;
    const literalFactoryFlags = ObjectFlagsAnonymous | ObjectFlagsMembersResolved | ObjectFlagsFreshLiteral
      | ObjectFlagsJSLiteral | ObjectFlagsObjectLiteral | ObjectFlagsObjectLiteralPatternWithComputedProperties | ObjectFlagsPropagatingFlags | ObjectFlagsContainsSpread;
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
        || symbol.ValueDeclaration !== input.declaration || links?.target !== input.target
        || links?.nameType !== input.nameType
        || input.value !== undefined && links?.resolvedType !== input.value) return undefined;
      const spread = LinkStore_TryGet(creation.#checker.spreadLinks, symbol);
      if (LinkStore_TryGet(creation.#checker.mappedSymbolLinks, symbol)?.syntheticOrigin !== input.syntheticOrigin
        || spread?.leftSpread !== input.leftSpread || spread?.rightSpread !== input.rightSpread) return undefined;
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
    const creator = creation.#creator;
    return { capability: creation, node: "site" in creator ? creator.site.node : creator.node, owner: creation.#owner,
      mode: "site" in creator ? creator.site.mode : creator.mode,
      creator: "site" in creator ? { ...creator, site: { ...creator.site } } : { ...creator },
      inputs: () => {
        const input = creation.#input;
        return { ...input, members: input.members.map(member => ({ ...member, declarations: member.declarations.slice() })),
          calls: input.calls.slice(), constructs: input.constructs.slice(), indexes: input.indexes.map(copyIndex) };
      } };
  }
}
