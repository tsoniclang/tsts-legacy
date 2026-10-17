import assert from "node:assert/strict";
import test from "node:test";
import { attachExtensionHost, attachExtensionHostToProgram, getExtensionHost } from "../extensions/host.js";
import { Node_Text, Node_Type } from "../internal/ast/ast.js";
import { Node_Name } from "../internal/ast/spine.js";
import { KindClassDeclaration, KindTypeAliasDeclaration } from "../internal/ast/generated/kinds.js";
import type { Type } from "../internal/checker/types.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { createTypeShapeQueries } from "./type-shape.js";
import { assertCleanSemanticDiagnostics, createProgram, findNodesByKind } from "./type-checker-test-support.js";

function checked(source: string) {
  const { program, index } = createProgram(`${source}\nexport {};`, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const types = createTypeShapeQueries(program, { sourceFile: index });
  const checker = createTypeCheckerQueries(program, { sourceFile: index });
  const aliases = findNodesByKind(index, KindTypeAliasDeclaration);
  const type = (name: string): Type => {
    const declaration = aliases.find(node => Node_Text(Node_Name(node)) === name);
    const selected = checker.getTypeFromTypeNode(Node_Type(declaration));
    assert.ok(selected !== undefined, `${name}: actual checked alias type`);
    return selected;
  };
  const bases = (value: Type): readonly Type[] => {
    const selected = types.getInstantiatedBaseTypes(value);
    assert.ok(selected !== undefined, "the actual class/interface has an available native base query");
    assert.equal(Object.isFrozen(selected), true, "base inventories are immutable, not new mutable checker state");
    return selected;
  };
  const property = (value: Type, name: string): Type => {
    const selected = types.getPropertyInfos(value).find(entry => entry.name === name);
    assert.ok(selected !== undefined, `${name}: actual native member resolution`);
    return selected.type;
  };
  const argumentsOf = (value: Type): readonly Type[] => {
    const bindings = types.getTypeReferenceArgumentInfos(value);
    assert.ok(bindings !== undefined, "actual native class/interface argument bindings are available");
    return bindings.map(binding => binding.argument);
  };
  return { program, index, types, checker, type, bases, property, argumentsOf };
}

for (const memberFirst of [false, true]) {
  test(`instantiated indexed bases agree with native member resolution, member first ${memberFirst}`, () => {
    const source = checked(`
class Holder<Value> { value!: Value; get(): Value { return this.value; } }
class Derived<Input extends unknown[]> extends Holder<Input[0]> { own = 1; }
type Deferred = Derived<[Promise<number>]>;
type Ordinary = Derived<[number]>;
type Aliased = Deferred;
`);
    for (const [name, promised] of [["Deferred", true], ["Ordinary", false], ["Aliased", true]] as const) {
      const receiver = source.type(name);
      const before = memberFirst ? source.property(receiver, "value") : undefined;
      const bases = source.bases(receiver);
      assert.equal(bases.length, 1, `${name}: one immediate actual base`);
      const base = bases[0]!;
      const arguments_ = source.argumentsOf(base);
      assert.equal(arguments_.length, 1, `${name}: no raw derived or synthetic this argument enters the base binding`);
      const actual = source.property(receiver, "value");
      assert.equal(arguments_[0] === actual, true, `${name}: Holder.Value is the identical effective inherited payload`);
      assert.equal(source.property(base, "value") === actual, true, `${name}: base and receiver use the same native specialization`);
      if (before !== undefined) assert.equal(before === actual, true, `${name}: querying bases preserves already resolved members`);
      assert.equal(source.bases(receiver)[0] === base, true, `${name}: repeated queries preserve actual native type identity`);
      if (promised) {
        assert.equal(source.types.isTypeReference(actual), true, `${name}: the actual Promise type is not reduced to its result`);
        assert.equal(source.types.isNumberLike(source.argumentsOf(actual)[0]), true, `${name}: Promise's actual number argument is retained`);
      } else {
        assert.equal(source.types.isNumberLike(actual), true, `${name}: ordinary numeric inheritance does not acquire Promise storage`);
      }
    }
    assert.equal(source.bases(source.type("Deferred"))[0] === source.bases(source.type("Ordinary"))[0], false,
      "distinct concrete instantiations never reuse the raw declaration base");
  });
}

test("generic bases retain the actual indexed type parameter until a concrete instantiation exists", () => {
  const source = checked(`
class Holder<Value> { value!: Value; }
class Derived<Input extends unknown[]> extends Holder<Input[0]> {}
type Generic<Input extends unknown[]> = Derived<Input>;
`);
  const receiver = source.type("Generic");
  const base = source.bases(receiver)[0]!;
  const payload = source.argumentsOf(base)[0]!;
  const indexed = source.types.getIndexedAccessComponents(payload);
  assert.ok(indexed !== undefined, "the genuinely generic indexed base is not invented as concrete");
  assert.equal(indexed.objectType === source.argumentsOf(receiver)[0], true, "the actual caller type parameter owns the deferred lookup");
  assert.equal(source.types.getNumericLiteralTypeValue(indexed.indexType), 0, "the canonical checker preserves the exact tuple index");
  assert.equal(source.property(receiver, "value") === payload, true, "native members and the deferred base have identical indexed evidence");
});

test("native base instantiation preserves defaults and outer versus local parameter identities", () => {
  const source = checked(`
class DefaultHolder<Value = number> { value!: Value; }
class DefaultDerived extends DefaultHolder { own = true; }
type Defaulted = DefaultDerived;
function make<Outer>(input: Outer) {
  class Holder<Local = number> { outer!: Outer; local!: Local; }
  class Derived extends Holder<string> { own = input; }
  return new Derived();
}
const text = make("text");
const numeric = make(7);
type Text = typeof text;
type Numeric = typeof numeric;
`);
  assert.equal(source.types.isNumberLike(source.argumentsOf(source.bases(source.type("Defaulted"))[0]!)[0]), true,
    "the native checker fills the authored omitted default");
  for (const [name, isText] of [["Text", true], ["Numeric", false]] as const) {
    const receiver = source.type(name);
    const base = source.bases(receiver)[0]!;
    const bindings = source.types.getTypeReferenceArgumentInfos(base);
    assert.ok(bindings !== undefined, `${name}: exact nested-class base bindings`);
    assert.equal(bindings.length, 2, `${name}: outer and local bindings exclude native this padding`);
    assert.equal(bindings[0]!.scope, "outer", `${name}: outer parameter scope is retained`);
    assert.equal(bindings[1]!.scope, "local", `${name}: local parameter scope is retained`);
    assert.equal(bindings[0]!.parameter === bindings[1]!.parameter, false, `${name}: parameters are declaration identities, not positions by spelling`);
    assert.equal(bindings[0]!.argument === source.property(receiver, "outer"), true, `${name}: the outer actual is the inherited native field type`);
    assert.equal(bindings[1]!.argument === source.property(receiver, "local"), true, `${name}: the local actual is the inherited native field type`);
    assert.equal(source.types.isStringLike(bindings[0]!.argument), isText, `${name}: no cross-instantiation capture`);
    assert.equal(source.types.isStringLike(bindings[1]!.argument), true, `${name}: explicitly specialized local string is preserved`);
  }
});

test("polymorphic this is specialized by the same native base-member operation", () => {
  const source = checked(`
class Holder<Value> { value!: Value; self!: this; copy(): this { return this; } }
class Derived extends Holder<number> { own = 1; }
type Receiver = Derived;
`);
  const receiver = source.type("Receiver");
  const base = source.bases(receiver)[0]!;
  assert.equal(source.property(base, "self") === source.property(receiver, "self"), true,
    "base specialization keeps the identical native polymorphic-this member");
  const baseCopy = source.types.getSignatureInfos(source.property(base, "copy"), "call")[0];
  const receiverCopy = source.types.getSignatureInfos(source.property(receiver, "copy"), "call")[0];
  assert.ok(baseCopy !== undefined && receiverCopy !== undefined, "both actual native inherited method signatures exist");
  assert.equal(baseCopy.returnType === receiverCopy.returnType, true, "native this return specialization remains identical");
  assert.equal(source.argumentsOf(base).length, 1, "native this is not reported as an authored local type argument");
});

test("memberful multiple interface bases preserve native order, signatures and indexes", () => {
  const source = checked(`
interface Left<Value> { left: Value; }
interface Right<Value> { right: Value; }
interface Both<Value> extends Left<Value[]>, Right<Value> { own: Value; }
interface Callable<Value> { (value: Value): Value; new(value: Value): { value: Value }; readonly [index: number]: Value; }
interface Invocable<Value> extends Callable<Value> { own: Value; }
type Record = Both<string>;
type FunctionRecord = Invocable<number>;
`);
  const receiver = source.type("Record");
  const bases = source.bases(receiver);
  assert.equal(bases.length, 2, "both immediate native interface bases are returned");
  assert.equal(source.argumentsOf(bases[0]!)[0] === source.property(receiver, "left"), true, "first authored native base uses its exact array specialization");
  assert.equal(source.argumentsOf(bases[1]!)[0] === source.property(receiver, "right"), true, "second native base retains its own exact scalar specialization");
  assert.equal(source.types.isArrayLike(source.argumentsOf(bases[0]!)[0]), true, "the existing native array type is not re-evaluated from heritage syntax");
  const invocable = source.type("FunctionRecord");
  const base = source.bases(invocable)[0]!;
  const payload = source.argumentsOf(base)[0]!;
  const call = source.types.getSignatureInfos(invocable, "call")[0];
  const construct = source.types.getSignatureInfos(invocable, "construct")[0];
  assert.ok(call !== undefined && construct?.returnType !== undefined, "existing native member resolution keeps both signature kinds");
  assert.equal(call.parameters[0]?.type === payload && call.returnType === payload, true, "call parameters and return use the same native mapping");
  assert.equal(source.property(construct.returnType, "value") === payload, true, "construct return uses the same native mapping");
  assert.equal(source.types.getIndexInfos(invocable)[0]?.valueType === payload, true, "the inherited native index uses the same mapping");
});

test("same-spelled base declarations and their actual instantiations remain distinct", () => {
  const source = checked(`
class Holder<Value> { value!: Value; }
class Derived extends Holder<number> {}
function make() {
  class Holder<Value> { value!: Value; }
  class Derived extends Holder<number> {}
  return new Derived();
}
type Global = Derived;
const local = make();
type Local = typeof local;
`);
  const globalBase = source.bases(source.type("Global"))[0]!;
  const localBase = source.bases(source.type("Local"))[0]!;
  assert.equal(globalBase === localBase, false, "identically spelled bases have separate native type identities");
  assert.equal(source.checker.getTypeSymbol(globalBase) === source.checker.getTypeSymbol(localBase), false,
    "actual declaration symbols, never names, select a base");
  assert.equal(source.types.isNumberLike(source.argumentsOf(globalBase)[0]), true, "global base keeps the genuine shared numeric primitive");
  assert.equal(source.types.isNumberLike(source.argumentsOf(localBase)[0]), true, "local base keeps its own genuine specialization");
});

test("no-base classes are immutable empty lists while non-class and absent types remain unavailable", () => {
  const source = checked(`
class Plain { value = 1; }
interface Empty {}
type Class = Plain;
type Interface = Empty;
type Number = number;
type Text = string;
type Object = { value: number };
type Tuple = [number];
type Union = Plain | string;
type Unknown = unknown;
type Never = never;
`);
  for (const name of ["Class", "Interface"]) assert.equal(source.bases(source.type(name)).length, 0, `${name}: actual no-base declaration`);
  for (const name of ["Number", "Text", "Object", "Tuple", "Union", "Unknown", "Never"]) {
    assert.equal(source.types.getInstantiatedBaseTypes(source.type(name)) === undefined, true, `${name}: no invented class/base interpretation`);
  }
  assert.equal(source.types.getInstantiatedBaseTypes(undefined) === undefined, true, "an absent input is not an empty successful class query");
  const classes = findNodesByKind(source.index, KindClassDeclaration);
  assert.equal(classes.length, 1, "the empty result still comes from a real class with members");
});

test("instantiated base queries validate actual source identity and same-program or shared-host type ownership", () => {
  const text = "class Holder<Value> { value!: Value; } class Derived extends Holder<number> {} type Value = Derived;";
  const first = createProgram(text);
  const second = createProgram(text);
  const foreign = createProgram(text);
  const unattached = createProgram(text);
  attachExtensionHost(first.program!);
  attachExtensionHostToProgram(first.program!, second.program!, { bindCompilerProgram: false });
  attachExtensionHost(foreign.program!);
  for (const source of [first, second, foreign, unattached]) assertCleanSemanticDiagnostics(source.program, source.index);
  const read = (source: typeof first) => {
    const checker = createTypeCheckerQueries(source.program, { sourceFile: source.index });
    const types = createTypeShapeQueries(source.program, { sourceFile: source.index });
    const declaration = findNodesByKind(source.index, KindTypeAliasDeclaration)[0];
    const type = checker.getTypeFromTypeNode(Node_Type(declaration));
    assert.ok(type !== undefined, "each real source program owns an actual derived type");
    return { types, type };
  };
  const local = read(first);
  const shared = read(second);
  const unrelated = read(foreign);
  const withoutHost = read(unattached);
  const localBase = local.types.getInstantiatedBaseTypes(local.type)?.[0];
  const sharedBase = shared.types.getInstantiatedBaseTypes(shared.type)?.[0];
  assert.equal(localBase !== undefined && sharedBase !== undefined, true, "both actual owner checkers specialize their own bases");
  assert.equal(local.types.getInstantiatedBaseTypes(unrelated.type) === undefined, true, "an unrelated checker is not accepted by carrying a Type pointer");
  assert.equal(local.types.getInstantiatedBaseTypes(withoutHost.type) === undefined, true, "an unattached foreign program cannot borrow the query's actual extension host");
  assert.equal(getExtensionHost(first.program!) === getExtensionHost(second.program!), true, "the actual configured extension host is shared");
  assert.equal(local.types.getInstantiatedBaseTypes(shared.type)?.[0] === sharedBase, true, "the admitted shared-host type uses its actual owner's canonical base");
  assert.equal(shared.types.getInstantiatedBaseTypes(local.type)?.[0] === localBase, true, "shared-host ownership is symmetric");
  const invalidContext = createTypeShapeQueries(first.program, { sourceFile: second.index });
  assert.equal(invalidContext.getInstantiatedBaseTypes(local.type) === undefined, true, "a same-spelled foreign consumer source is refused before querying the checker");
  assert.equal(local.types.getInstantiatedBaseTypes(unrelated.type) === undefined, true, "repeated foreign queries never add state or a fallback");
});
