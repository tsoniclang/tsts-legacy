import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import type { Node } from "../index.js";
import { Background } from "../go/context.js";
import { Program_GetTypeChecker } from "../internal/compiler/program.js";
import { Node_Text } from "../internal/ast/ast.js";

function open(checkers: number) {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/case", rootFiles: ["/case/first.mts", "/case/second.mts"],
    files: {
      "/case/first.mts": `class Holder<Value> { value!: Value; } class Derived extends Holder<number> {}
        export let value: Derived; export let awaited: Promise<Promise<number>>;
        class Indexed<Input extends unknown[]> extends Holder<Input[0]> {}
        export function inspect<Input extends unknown[]>() { let indexed!: Indexed<Input>; }
        type Alias<Value> = { value: Value }; export let alias: Alias<number>;`,
      "/case/second.mts": `class Holder<Value> { value!: Value; } class Derived extends Holder<string> {}
        export let value: Derived; export let awaited: Promise<Promise<string>>;
        class Indexed<Input extends unknown[]> extends Holder<Input[0]> {}
        export function inspect<Input extends unknown[]>() { let indexed!: Indexed<Input>; }
        type Alias<Value> = { value: Value }; export let alias: Alias<string>;`,
    }, compilerOptions: { checkers, strict: true, target: "es2024", module: "nodenext", moduleResolution: "nodenext" } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0, "the actual generic bases and awaited types check normally");
  const view = (fileName: string) => {
    const file = checked.getSourceFile(fileName);
    if (file === undefined) throw new Error("The actual file belongs to this program");
    return checked.getSourceFileQueries(file);
  };
  const annotation = (fileName: string, variable: string) => {
    const source = view(fileName);
    const pending: Node[] = [source.sourceFile];
    while (pending.length !== 0) {
      const node = pending.pop();
      if (node === undefined) throw new Error("The syntax worklist is dense");
      if (source.ast.kindName(node) === "KindVariableDeclaration" && Node_Text(source.ast.name(node)) === variable) {
        const syntax = source.ast.typeNode(node);
        if (syntax === undefined) throw new Error("The selected variable has an authored annotation");
        const answer = source.checker.getTypeFromTypeNode(syntax);
        if (answer === undefined) throw new Error("The actual annotation has its native type answer");
        return answer.type;
      }
      source.ast.forEachChild(node, child => { if (child !== undefined) pending.push(child); });
    }
    throw new Error("The actual selected variable exists");
  };
  return { session, view, annotation };
}

for (const checkers of [1, 4]) test(`type consumers admit actual program pool members with ${checkers} checkers`, () => {
  const current = open(checkers);
  const reader = current.view("/case/second.mts");
  const [api, release] = Program_GetTypeChecker(current.session.program, Background());
  let distinct = 0;
  try {
    for (const [fileName, expected] of [["/case/first.mts", "number"], ["/case/second.mts", "string"]] as const) {
      const value = current.annotation(fileName, "value");
      if (value.checker !== api) distinct += 1;
      const bases = reader.typeShape.getInstantiatedBaseTypes(value);
      assert.equal(bases !== undefined && bases.length === 1, true, "actual file-owned generic bases are available");
      if (bases === undefined || bases[0] === undefined) throw new Error("The actual derived type has one selected base");
      const member = reader.typeShape.getPropertyInfos(bases[0]).find(property => property.name === "value");
      assert.equal(member !== undefined && reader.checker.typeToString(member.type) === expected, true,
        "the base operation uses the actual producer and its selected generic argument");
      const awaited = current.annotation(fileName, "awaited");
      const result = reader.checker.getAwaitedType(awaited);
      assert.equal(result !== undefined && reader.checker.typeToString(result) === expected, true,
        "awaited evaluation uses the same native owner without host-wrapper identity");
      assert.equal(reader.checker.getAwaitedType(awaited) === result, true, "the native owner preserves its own exact cache result");
      const indexed = current.annotation(fileName, "indexed");
      const indexedBases = reader.typeShape.getInstantiatedBaseTypes(indexed);
      const payload = indexedBases?.[0] === undefined ? undefined
        : reader.typeShape.getTypeReferenceArgumentInfos(indexedBases[0])?.[0]?.argument;
      const components = reader.typeShape.getIndexedAccessComponents(payload);
      assert.equal(components !== undefined && components.objectType === reader.typeShape.getTypeArguments(indexed)[0], true,
        "the unary indexed reader preserves the actual deferred parameter rather than refusing its producer");
      if (components === undefined) throw new Error("The genuine generic base retains its deferred indexed type");
      assert.equal(reader.typeShape.getNumericLiteralTypeValue(components.indexType) === 0, true,
        "the native deferred indexed key is unchanged");
      const alias = current.annotation(fileName, "alias");
      const application = reader.typeShape.getTypeAliasApplication(alias);
      assert.equal(application !== undefined && application.result === alias &&
        reader.checker.typeToString(application.bindings[0]?.argument) === expected, true,
      "the unary alias reader retains the actual input's native owner, result and supplied argument");
    }
  } finally { release(); }
  if (checkers === 4) assert.equal(distinct > 0, true, "the proof actually exercises a non-API file checker");
  const foreign = open(checkers);
  assert.equal(reader.typeShape.getInstantiatedBaseTypes(foreign.annotation("/case/first.mts", "value")) === undefined, true,
    "a same-spelled foreign program cannot borrow actual pool membership");
  assert.equal(reader.checker.getAwaitedType(foreign.annotation("/case/first.mts", "awaited")) === undefined, true,
    "a foreign type cannot make its own checker an admitted local owner");
  const foreignIndexed = foreign.annotation("/case/first.mts", "indexed");
  const foreignBase = foreign.view("/case/first.mts").typeShape.getInstantiatedBaseTypes(foreignIndexed)?.[0];
  const foreignPayload = foreignBase === undefined ? undefined
    : foreign.view("/case/first.mts").typeShape.getTypeReferenceArgumentInfos(foreignBase)?.[0]?.argument;
  assert.equal(foreignPayload !== undefined && reader.typeShape.getIndexedAccessComponents(foreignPayload) === undefined, true,
    "a genuine foreign indexed type cannot borrow this Program's checker membership");
  assert.equal(reader.typeShape.getTypeAliasApplication(foreign.annotation("/case/first.mts", "alias")) === undefined, true,
    "a foreign alias application remains unavailable without actual Program ownership");
  assert.equal(reader.typeShape.getInstantiatedBaseTypes(undefined) === undefined && reader.checker.getAwaitedType(undefined) === undefined, true,
    "absence does not acquire an owner");
});
