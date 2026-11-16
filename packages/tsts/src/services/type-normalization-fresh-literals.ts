import type { Checker } from "../internal/checker/checker/state.js";
import { LiteralCreation } from "../internal/checker/checker/literal-creation.js";
import type { LiteralCreationInput } from "../internal/checker/checker/literal-creation.js";
import { Checker_newIndexInfo, Checker_newSymbolEx } from "../internal/checker/checker/symbols.js";
import { getPropertyNameFromType } from "../internal/checker/utilities.js";
import type { Type } from "../internal/checker/types.js";
import type { Symbol, SymbolTable } from "../internal/ast/symbol.js";
import { SourceFile_FileName } from "../internal/ast/ast.js";
import { GetSourceFileOfNode } from "../internal/ast/utilities.js";
import { LinkStore_Get } from "../internal/core/linkstore.js";
import { cachedLateBoundSymbolDeclaration, cachedValueTypeSymbol, hasCachedValueTypeKind, reacquireCachedLateBoundSymbol } from "./type-normalization-declarations.js";

function admittedInputs(type: Type, source: Checker, admitted: Map<Type, LiteralCreationInput>): LiteralCreationInput {
  const known = admitted.get(type);
  if (known !== undefined) return known;
  const pending = [type];
  const staged = new Map<Type, LiteralCreationInput>();
  let root: LiteralCreationInput | undefined;
  while (pending.length !== 0) {
    const value = pending.pop();
    if (value === undefined) throw new Error("Actual fresh literal inputs are dense");
    if (staged.has(value) || admitted.has(value)) continue;
    const creation = LiteralCreation.read(value);
    if (creation === undefined || value.checker !== source)
      throw new TypeError("A fresh literal requires its authenticated actual native output");
    const file = GetSourceFileOfNode(creation.node);
    if (file === undefined || source.program.GetSourceFile(SourceFile_FileName(file)) !== file)
      throw new TypeError("A fresh literal retains its actual producing Program node");
    const input = creation.inputs();
    staged.set(value, input);
    if (root === undefined) root = input;
    if (input.calls.length !== 0 || input.constructs.length !== 0)
      throw new TypeError("The actual complete literal factory has no invented signature inputs");
    const checkType = (dependency: Type | undefined): void => {
      if (dependency === undefined || dependency.checker !== source)
        throw new TypeError("Every actual fresh literal Type input belongs to its producing checker");
      if (dependency.derivation?.kind === "object-literal") pending.push(dependency);
      if (hasCachedValueTypeKind(dependency) && cachedValueTypeSymbol(source, dependency) === undefined)
        throw new TypeError("The actual literal value input retains its complete native source cache relation");
    };
    const checkSymbol = (symbol: Symbol | undefined): void => {
      if (symbol !== undefined && symbol.checkerId !== undefined && symbol.checkerId !== source.id)
        throw new TypeError("Every actual fresh literal Symbol input has its actual owner");
    };
    const checkTarget = (symbol: Symbol | undefined): void => {
      checkSymbol(symbol);
      if (symbol?.checkerId !== undefined && cachedLateBoundSymbolDeclaration(source, symbol) === undefined)
        throw new TypeError("The literal Symbol input retains both actual source declaration caches");
    };
    checkTarget(input.symbol);
    for (const member of input.members) {
      checkSymbol(member.symbol);
      checkTarget(member.target);
      checkTarget(member.parent);
      if (member.target === undefined) checkTarget(member.symbol);
      if (member.target !== undefined) checkType(member.value);
      if (member.nameType !== undefined) checkType(member.nameType);
    }
    for (const index of input.indexes) { checkType(index.keyType); checkType(index.valueType); checkTarget(index.indexSymbol); }
  }
  if (root === undefined) throw new Error("The admitted native creation retains its input vector");
  for (const [value, input] of staged) admitted.set(value, input);
  return root;
}

export function reacquireFreshLiteral(producer: Checker, type: Type, normalize: (type: Type) => Type,
  admitted: Map<Type, LiteralCreationInput>): Type {
  const source = type.checker;
  if (source === undefined) throw new TypeError("A fresh literal retains its actual checker");
  const input = admittedInputs(type, source, admitted);
  const creation = LiteralCreation.read(type);
  if (creation === undefined) throw new TypeError("The fresh literal retains its authenticated creation");
  if (source.program.SourceFiles() !== producer.program.SourceFiles())
    throw new TypeError("Fresh literal normalization requires the same actual Program");
  const selectedType = (value: Type | undefined): Type => {
    if (value === undefined) throw new TypeError("An actual literal constructor Type input is present");
    const selected = normalize(value);
    if (selected.checker !== producer) throw new TypeError("The literal constructor consumes only target-owned Types");
    return selected;
  };
  const selectedSymbol = (value: Symbol | undefined): Symbol | undefined => {
    if (value === undefined || value.checkerId === undefined) return value;
    const selected = reacquireCachedLateBoundSymbol(source, producer, value);
    if (selected === undefined) throw new TypeError("The actual native literal symbol retains its cached producer relation");
    return selected;
  };
  const members: SymbolTable = new Map();
  for (const member of input.members) {
    let selected: Symbol | undefined;
    if (member.target === undefined) selected = selectedSymbol(member.symbol);
    else {
      const target = selectedSymbol(member.target);
      if (target === undefined) throw new TypeError("The native literal wrapper retains its real target");
      const value = selectedType(member.value);
      const nameType = member.nameType === undefined ? undefined : selectedType(member.nameType);
      selected = Checker_newSymbolEx(producer, member.flags,
        nameType === undefined ? target.Name : getPropertyNameFromType(nameType), member.checkFlags);
      if (selected === undefined) throw new Error("The native property constructor returns its actual target-owned wrapper");
      selected.Declarations = member.declarations.slice();
      selected.ValueDeclaration = member.declaration;
      selected.Parent = selectedSymbol(member.parent);
      const links = LinkStore_Get(producer.valueSymbolLinks, selected);
      if (links === undefined) throw new Error("The native wrapper has its actual target value links");
      links.target = target;
      links.resolvedType = value;
      if (nameType !== undefined) links.nameType = nameType;
    }
    if (selected === undefined) throw new TypeError("Every actual literal member has a target-owned or genuine shared symbol");
    members.set(selected.Name, selected);
  }
  const indexes = input.indexes.map(index => {
    const selected = Checker_newIndexInfo(producer, selectedType(index.keyType), selectedType(index.valueType),
      index.isReadonly, index.declaration, index.components.slice());
    if (selected === undefined) throw new Error("The native index constructor returns its actual target input");
    selected.indexSymbol = selectedSymbol(index.indexSymbol);
    return selected;
  });
  return LiteralCreation.create(producer, creation.node, creation.mode, selectedSymbol(input.symbol), members,
    [], [], indexes, input.flags, input.pattern);
}
