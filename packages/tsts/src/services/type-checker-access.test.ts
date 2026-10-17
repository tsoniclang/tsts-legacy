import { test } from "node:test";
import assert from "node:assert/strict";
import { Node_Text, Node_Type } from "../internal/ast/ast.js";
import { Node_Name } from "../internal/ast/spine.js";
import { attachExtensionHost, attachExtensionHostToProgram, getExtensionHost } from "../extensions/host.js";
import {
  KindClassDeclaration,
  KindCallExpression,
  KindComputedPropertyName,
  KindElementAccessExpression,
  KindForOfStatement,
  KindFunctionDeclaration,
  KindGetAccessor,
  KindMethodDeclaration,
  KindPropertyAssignment,
  KindPropertyAccessExpression,
  KindSetAccessor,
  KindTypeAliasDeclaration,
  KindVariableDeclaration,
} from "../internal/ast/generated/kinds.js";
import { TypeFlagsNumber, TypeFlagsNumberLiteral, TypeFlagsString } from "../internal/checker/types.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import {
  assertCleanSemanticDiagnostics,
  createProgram,
  findNodesByKind,
  findPropertyAccessByName,
} from "./type-checker-test-support.js";

test("global value lookup retains actual library and alias signature identity through local shadows", () => {
  const { program, index } = createProgram(`
    const direct = String(1);
    const convert = String;
    const indirect = convert(2);
    function local(String: (value: number) => string): string { return String(3); }
    export {};
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const globalString = queries.getGlobalValueSymbol("String");
  assert.equal(globalString !== undefined, true, "the completed configured library has a global String value");
  assert.equal(queries.getGlobalValueSymbol("String") === globalString, true, "repeat lookup is the identical checked symbol, not a synthetic symbol store");
  const calls = findNodesByKind(index, KindCallExpression);
  assert.equal(calls.length, 3, "direct, aliased and actual local-shadow calls");
  const callDeclarations = calls.map(call => queries.getSignatureDeclaration(queries.getResolvedCallInfo(call)?.selectedSignature));
  const globalType = queries.getTypeOfSymbol(globalString);
  const declarations = queries.getCallSignaturesOfType(globalType).map(signature => queries.getSignatureDeclaration(signature));
  assert.equal(callDeclarations[0] !== undefined && declarations.includes(callDeclarations[0]), true, "direct String uses the actual global call signature");
  assert.equal(callDeclarations[1] === callDeclarations[0], true, "a real alias preserves the selected library declaration");
  assert.equal(callDeclarations[2] !== undefined && !declarations.includes(callDeclarations[2]), true, "a local String parameter is not the global constructor by spelling");
  assert.equal(queries.isDefaultLibraryDeclaration(callDeclarations[0]), true, "the actual configured library owns the selected String signature");
  assert.equal(queries.isDefaultLibraryDeclaration(callDeclarations[2]), false, "a real local shadow is not a default-library declaration");
  assert.equal(queries.isDefaultLibraryDeclaration(undefined), false, "absence has no manufactured library origin");
  const foreign = createProgram("const value = String(1);", { noLib: false });
  assertCleanSemanticDiagnostics(foreign.program, foreign.index);
  const foreignQueries = createTypeCheckerQueries(foreign.program, { sourceFile: foreign.index });
  const foreignCall = findNodesByKind(foreign.index, KindCallExpression)[0];
  const foreignDeclaration = foreignQueries.getSignatureDeclaration(foreignQueries.getResolvedCallInfo(foreignCall)?.selectedSignature);
  assert.equal(foreignQueries.isDefaultLibraryDeclaration(foreignDeclaration), true, "the foreign program owns its genuine library declaration");
  assert.equal(queries.isDefaultLibraryDeclaration(foreignDeclaration), false, "the same library filename never admits a foreign declaration identity");
  assert.equal(queries.getGlobalValueSymbol("__P01_unknown_global__") === undefined, true, "unknown global value remains absent");
});

test("global value lookup distinguishes native user globals, module declarations and foreign source identity", () => {
  for (const initializer of [
    'function String(value: number): string { return "custom"; }',
    'var String = (value: number): string => "custom";',
  ]) {
    const { program, index } = createProgram(`${initializer}\ninterface OnlyType { readonly value: number; }`);
    assertCleanSemanticDiagnostics(program, index);
    const queries = createTypeCheckerQueries(program, { sourceFile: index });
    const declarations = findNodesByKind(index, KindFunctionDeclaration).concat(findNodesByKind(index, KindVariableDeclaration));
    const declaration = declarations.find(node => Node_Text(Node_Name(node)) === "String");
    assert.equal(declaration !== undefined, true, "the actual native user global declaration exists");
    assert.equal(queries.getGlobalValueSymbol("String") === queries.getSymbolAtLocation(Node_Name(declaration)), true,
      "a real native user global is returned as its actual symbol, not labelled as a builtin");
    assert.equal(queries.isDefaultLibraryDeclaration(declaration), false, "native user globals never acquire a default-library origin");
    assert.equal(queries.getGlobalValueSymbol("OnlyType") === undefined, true, "a type-only global is not manufactured into a value");
    const foreign = createProgram(initializer);
    const foreignQueries = createTypeCheckerQueries(program, { sourceFile: foreign.index });
    assert.equal(foreignQueries.getGlobalValueSymbol("String") === undefined, true,
      "a foreign checked source file is refused even when its filename matches");
    assert.equal(foreignQueries.isDefaultLibraryDeclaration(declaration), false, "a foreign consumer context cannot query library ownership");
  }
  const { program, index } = createProgram('function String(value: number): string { return "custom"; } export {};');
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  assert.equal(queries.getGlobalValueSymbol("String") === undefined, true, "a module-local declaration is not a global");
});

test("awaited queries use the existing checked Promise and thenable semantics without type-name inference", () => {
  const { program, index } = createProgram(`
    type Primitive = number;
    type Nested = Promise<Promise<number>>;
    type Thenable = { then(resolve: (value: string) => unknown): unknown };
    type Optional = Promise<number> | undefined;
    export {};
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const aliases = findNodesByKind(index, KindTypeAliasDeclaration);
  for (const [position, expected] of ["number", "number", "string", "number | undefined"].entries()) {
    const type = queries.getTypeFromTypeNode(Node_Type(aliases[position]));
    assert.equal(type !== undefined, true, `awaited input ${position} is an actual checked type`);
    const awaited = queries.getAwaitedType(type);
    assert.equal(queries.typeToString(awaited), expected, `awaited input ${position} uses the checker result`);
    assert.equal(queries.getAwaitedType(type) === awaited, true, `awaited input ${position} retains exact checker result identity`);
    if (position === 0) assert.equal(awaited === type, true, "an ordinary value remains its identical native type");
  }
  assert.equal(queries.getAwaitedType(undefined) === undefined, true, "an absent type has no invented awaited value");
  const shadow = createProgram("class Promise<Value> { value!: Value; } type Ordinary = Promise<number>; export {};");
  assertCleanSemanticDiagnostics(shadow.program, shadow.index);
  const shadowQueries = createTypeCheckerQueries(shadow.program, { sourceFile: shadow.index });
  const shadowAlias = findNodesByKind(shadow.index, KindTypeAliasDeclaration)[0];
  const shadowType = shadowQueries.getTypeFromTypeNode(Node_Type(shadowAlias));
  assert.equal(shadowType !== undefined && shadowQueries.getAwaitedType(shadowType) === shadowType, true,
    "a user class called Promise is not unwrapped by its name");
});

test("awaited queries reject foreign types and admit only the actual same-program or shared extension host", () => {
  const first = createProgram("type Value = number;");
  const second = createProgram("type Value = number;");
  const unrelated = createProgram("type Value = number;");
  for (const checked of [first, second, unrelated]) assertCleanSemanticDiagnostics(checked.program, checked.index);
  const firstQueries = createTypeCheckerQueries(first.program, { sourceFile: first.index });
  const secondQueries = createTypeCheckerQueries(second.program, { sourceFile: second.index });
  const unrelatedQueries = createTypeCheckerQueries(unrelated.program, { sourceFile: unrelated.index });
  const typeOf = (queries: typeof firstQueries, index: typeof first.index) =>
    queries.getTypeFromTypeNode(Node_Type(findNodesByKind(index, KindTypeAliasDeclaration)[0]));
  const firstType = typeOf(firstQueries, first.index);
  const secondType = typeOf(secondQueries, second.index);
  const unrelatedType = typeOf(unrelatedQueries, unrelated.index);
  assert.equal(firstType !== undefined && firstQueries.getAwaitedType(firstType) === firstType, true, "the real source program owns its primitive type");
  assert.equal(secondType !== undefined && firstQueries.getAwaitedType(secondType) === undefined, true,
    "a foreign type carrying its own checker is refused before that checker runs");
  const invalidContext = createTypeCheckerQueries(first.program, { sourceFile: second.index });
  assert.equal(invalidContext.getAwaitedType(firstType) === undefined, true, "a foreign consumer context cannot accept an otherwise local type");
  attachExtensionHost(first.program!);
  attachExtensionHostToProgram(first.program!, second.program!, { bindCompilerProgram: false });
  attachExtensionHost(unrelated.program!);
  assert.equal(getExtensionHost(first.program!) === getExtensionHost(second.program!), true, "the existing extension API proves a shared actual host");
  assert.equal(getExtensionHost(first.program!) !== getExtensionHost(unrelated.program!), true, "another extension host is not the same owner");
  assert.equal(firstQueries.getAwaitedType(secondType) === secondType, true, "a checked type from the same actual extension host retains its own checker and identity");
  assert.equal(firstQueries.getAwaitedType(unrelatedType) === undefined, true, "an unrelated attached extension host remains foreign");
  assert.equal(secondQueries.getAwaitedType(firstType) === firstType, true, "the actual shared-host contract is symmetric");
});

test("effective property names expose one checked string, numeric or unique-symbol identity", () => {
  const { program, index } = createProgram(`
    const key = "constant";
    declare const unique: unique symbol;
    const value = { plain: 1, ["literal"]: 2, [key]: 3, [0x3635c9adc5dea00000]: 4, [-0]: 5, [unique]: 6 };
    function dynamic(key: string) { return { [key]: 7 }; }
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const properties = findNodesByKind(index, KindPropertyAssignment);
  assert.equal(properties.length, 7, "six static properties and one dynamic property");
  const expected = [["string", "plain"], ["string", "literal"], ["string", "constant"],
    ["numeric", "1e+21"], ["numeric", "0"], ["unique-symbol", undefined]] as const;
  for (const [position, [kind, name]] of expected.entries()) {
    const nameNode = Node_Name(properties[position]);
    const selected = queries.getEffectivePropertyName(nameNode);
    assert.equal(selected?.kind, kind, `property ${position} keeps its checked name category`);
    if (name !== undefined) assert.equal(selected?.name, name, `property ${position} keeps its canonical checked spelling`);
    else assert.equal(typeof selected?.name, "string", "the unique symbol keeps its actual checked identity, not a string field");
    assert.equal(selected !== undefined && Object.isFrozen(selected), true, `property ${position} has immutable evidence`);
    assert.equal(queries.getEffectivePropertyName(nameNode) === selected, true, `property ${position} is computed once at this query boundary`);
  }
  assert.equal(queries.getEffectivePropertyName(Node_Name(properties[6])) === undefined, true, "a broad runtime string has no static name");
  assert.equal(queries.getEffectivePropertyName(Node_Name(properties[6])) === undefined, true, "a completed absence stays absent");
  assert.equal(queries.getEffectivePropertyName(undefined) === undefined, true, "an absent node has no fabricated identity");
});

test("effective numeric property-name types never depend on a property's value type", () => {
  const { program, index } = createProgram(`
    const text: { [key: number]: string } = { 9007199254740993: "value" };
    const numeric: { [key: number]: number } = { 9007199254740993: 7 };
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const properties = findNodesByKind(index, KindPropertyAssignment);
  assert.equal(properties.length, 2, "both actual checked contexts participate");
  for (const [position, property] of properties.entries()) {
    const name = Node_Name(property);
    const selected = queries.getEffectivePropertyName(name);
    assert.equal(selected?.kind, "numeric", `property ${position} has numeric checked key evidence`);
    assert.equal((selected?.type.flags ?? 0) & TypeFlagsNumberLiteral, TypeFlagsNumberLiteral,
      `property ${position} retains its already-computed checked numeric literal type`);
    assert.equal(queries.getEffectivePropertyName(name)?.type === selected?.type, true,
      `property ${position} never recomputes its checked key type`);
  }
  assert.equal((queries.getTypeAtLocation(Node_Name(properties[0]))?.flags ?? 0) & TypeFlagsString, TypeFlagsString,
    "the generic location query answers the value-type question and cannot be a key-type substitute");
});

test("effective names preserve actual bound member identities and completed object-literal names", () => {
  const { program, index } = createProgram(`
    class Holder { [+1] = 1; [-0] = 2; }
    interface Contract { [+1]: number; [-0]: number; }
    type Shape = { [+1]: number; [-0]: number; };
    const object = { [-0]: 3 };
    const { [-0]: value } = object;
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const names = findNodesByKind(index, KindComputedPropertyName);
  assert.equal(names.length, 8, "all bound, object-literal and binding names are actual checked syntax");
  for (const [position, expected] of ["+1", "-0", "+1", "-0", "+1", "-0", "0", "0"].entries()) {
    const selected = queries.getEffectivePropertyName(names[position]);
    assert.equal(selected?.kind, "numeric", `name ${position} retains its checked numeric literal type`);
    assert.equal(selected?.name, expected, `name ${position} uses its actual checked identity at the one boundary`);
    assert.equal(queries.getEffectivePropertyName(names[position]) === selected, true,
      `name ${position} never reparses a signed token on a consumer path`);
  }
});

test("object element evidence selects completed canonical symbols by exact declaration membership", () => {
  const { program, index } = createProgram(`
    interface Holder { [0]: number; }
    const ordinary: Holder = { 0: 7 };
    const computed: Holder = { [-0]: 7 };
    const inferred = { [-0]: 7 };
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const properties = findNodesByKind(index, KindPropertyAssignment);
  assert.equal(properties.length, 3, "ordinary, contextual negative zero and inferred negative zero");
  const infos = properties.map(property => queries.getResolvedObjectLiteralElementInfo(property));
  for (const [position, property] of properties.entries()) {
    const info = infos[position];
    assert.equal(info !== undefined, true, `element ${position} has exact completed evidence`);
    assert.equal(queries.getSymbolName(info?.sourceElementSymbol), "0", `element ${position} uses the canonical checked name`);
    assert.equal(queries.getSymbolDeclarations(info?.sourceElementSymbol).includes(property), true,
      `element ${position} belongs to that exact completed source property`);
    assert.equal(queries.typeToString(info?.sourceSelectedType), "number", `element ${position} keeps the checked property type`);
    assert.equal(queries.getResolvedObjectLiteralElementInfo(property) === info, true,
      `element ${position} is memoized by exact identity`);
    assert.equal(Object.isFrozen(info), true, `element ${position} publishes immutable evidence`);
  }
  assert.equal(infos[0]?.sourceSelectedSymbol === infos[1]?.sourceSelectedSymbol, true,
    "ordinary and negative zero select the same contextual member");
  assert.equal(infos[2]?.sourceSelectedDeclaration === properties[2], true,
    "an inferred negative-zero member selects its exact own declaration");
});

test("canonical object element symbols preserve generic, mapped, union and indexed contextual types", () => {
  const { program, index } = createProgram(`
    function generic<T>(input: T): { value: T } { return { value: input }; }
    type Mapped = { [Key in "value"]: number };
    const mapped: Mapped = { value: 1 };
    const union: { kind: "number"; value: number } | { kind: "string"; value: string } = { kind: "number", value: 1 };
    interface Callbacks { [name: string]: () => number; }
    const indexed: Callbacks = { run() { return 2; } };
  `);
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const properties = findNodesByKind(index, KindPropertyAssignment);
  assert.equal(properties.length, 4, "generic, mapped and both discriminated-union members");
  const expected = ["T", "number", '"number"', "number"];
  for (const [position, property] of properties.entries()) {
    const info = queries.getResolvedObjectLiteralElementInfo(property);
    assert.equal(info !== undefined, true, `context ${position} retains exact evidence`);
    assert.equal(queries.typeToString(info?.sourceSelectedType), expected[position], `context ${position} keeps the checker-selected type`);
    assert.equal(queries.getSymbolDeclarations(info?.sourceElementSymbol).includes(property), true,
      `context ${position} keeps exact source declaration membership`);
  }
  const method = findNodesByKind(index, KindMethodDeclaration)[0];
  const info = queries.getResolvedObjectLiteralElementInfo(method);
  assert.equal(info !== undefined, true, "an indexed callback has evidence without a named contextual property");
  assert.equal(info?.sourceSelectedSymbol === undefined, true, "the contextual index is not a fabricated named symbol");
  assert.equal(info?.sourceSelectedDeclarations.length, 0, "the contextual index has no named declarations");
  assert.equal(queries.typeToString(info?.sourceSelectedType), "() => number", "the index signature still supplies the checked function type");
});

test("property selection uses the selected symbol with distinct read and write types", () => {
  const { program, index } = createProgram(`
    class Model {
      get value(): string {
        return "";
      }

      set value(next: number) {}
    }

    declare const model: Model;
    const read = model.value;
    model.value = 1;
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const valueAccesses = findNodesByKind(index, KindPropertyAccessExpression)
    .filter((node) => Node_Text(Node_Name(node)) === "value");
  assert.equal(valueAccesses.length, 2);
  const readAccess = valueAccesses[0];
  const writeAccess = valueAccesses[1];
  const selectedSymbol = queries.getSymbolAtLocation(Node_Name(readAccess));
  const readInfo = queries.getResolvedPropertyAccessInfo(readAccess);
  const writeInfo = queries.getResolvedPropertyAccessInfo(writeAccess);

  assert.equal(queries.getSymbolName(selectedSymbol), "value");
  assert.equal((queries.getTypeOfSymbol(selectedSymbol)?.flags ?? 0) & TypeFlagsString, TypeFlagsString);
  assert.equal((queries.getWriteTypeOfSymbol(selectedSymbol)?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(readInfo?.accessMode, "read");
  assert.equal((readInfo?.sourceReadType?.flags ?? 0) & TypeFlagsString, TypeFlagsString);
  assert.equal(readInfo?.sourceWriteType === undefined, true);
  assert.equal(writeInfo?.accessMode, "write");
  assert.equal(writeInfo?.sourceReadType === undefined, true);
  assert.equal((writeInfo?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(
    readInfo?.selectedSymbol === writeInfo?.selectedSymbol,
    "Read and write access must retain the exact selected property symbol.",
  );
  assert.equal(readInfo?.selectedReadDeclaration?.Kind, KindGetAccessor);
  assert.equal(readInfo?.selectedWriteDeclaration, undefined);
  assert.equal(writeInfo?.selectedReadDeclaration, undefined);
  assert.equal(writeInfo?.selectedWriteDeclaration?.Kind, KindSetAccessor);
  const repeatedRead = queries.getResolvedPropertyAccessInfo(readAccess);
  assert.ok(
    repeatedRead === readInfo,
    "Repeated property queries must retain the exact resolved access result.",
  );
  assert.equal(repeatedRead?.accessMode, readInfo?.accessMode);
  assert.ok(
    repeatedRead?.selectedSymbol === readInfo?.selectedSymbol,
    "Repeated property queries must retain exact selected-symbol identity.",
  );
  assert.ok(
    repeatedRead?.selectedDeclaration === readInfo?.selectedDeclaration,
    "Repeated property queries must retain exact selected-declaration identity.",
  );
  assert.ok(
    repeatedRead?.selectedReadDeclaration === readInfo?.selectedReadDeclaration,
    "Repeated property queries must retain exact selected read-declaration identity.",
  );
  assert.ok(
    repeatedRead?.sourceReadType === readInfo?.sourceReadType,
    "Repeated property queries must retain exact checker result-type identity.",
  );
  assertCleanSemanticDiagnostics(program, index);
});

test("receiver evidence identifies the intrinsic global object without spelling inference", () => {
  const { program, index } = createProgram(`
    const direct = globalThis.Number;
    const parenthesized = (globalThis).Number;
    const element = globalThis["Number"];
    function local(globalThis: { Number: number }): number { return globalThis.Number; }
    const alias = globalThis;
    const indirect = alias.Number;
    export {};
  `, { noLib: false });
  assertCleanSemanticDiagnostics(program, index);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const properties = findNodesByKind(index, KindPropertyAccessExpression);
  assert.equal(properties.length, 4);
  const expected = ["global-object", "global-object", undefined, undefined];
  for (const [index, node] of properties.entries()) {
    const info = queries.getResolvedPropertyAccessInfo(node);
    assert.equal(info?.receiver.intrinsic, expected[index]);
    assert.equal(queries.getResolvedPropertyAccessInfo(node), info);
    assert.ok(Object.isFrozen(info?.receiver));
  }
  const element = findNodesByKind(index, KindElementAccessExpression)[0];
  const info = queries.getResolvedElementAccessInfo(element);
  assert.equal(info?.receiver.intrinsic, "global-object");
  assert.equal(queries.getResolvedElementAccessInfo(element), info);
});

test("property access info preserves compound read-write and optional-chain roles", () => {
  const { program, index } = createProgram(`
    class Counter {
      value = 0;
      advance(): void {}
    }

    declare const counter: Counter;
    declare const optionalCounter: Counter | undefined;
    counter.value += 1;
    optionalCounter?.advance();
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const valueAccess = findPropertyAccessByName(index, "value", () => true);
  const advanceAccess = findPropertyAccessByName(index, "advance", () => true);
  const valueInfo = queries.getResolvedPropertyAccessInfo(valueAccess);
  const advanceInfo = queries.getResolvedPropertyAccessInfo(advanceAccess);

  assert.equal(valueInfo?.accessMode, "read-write");
  assert.equal((valueInfo?.sourceReadType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal((valueInfo?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(valueInfo?.optionalChain, false);
  assert.equal(advanceInfo?.optionalChain, true);
  assert.equal(advanceInfo?.callCallee, true);
  assertCleanSemanticDiagnostics(program, index);
});

test("property access info distinguishes the exact receiver value from its selected type owner", () => {
  const { program, index } = createProgram(`
    class Counter {
      static value = 1;
    }

    const Alias = Counter;
    const direct = Counter.value;
    const aliased = Alias.value;
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindPropertyAccessExpression)
    .filter((node) => Node_Text(Node_Name(node)) === "value");
  assert.equal(accesses.length, 2);
  const direct = queries.getResolvedPropertyAccessInfo(accesses[0]);
  const aliased = queries.getResolvedPropertyAccessInfo(accesses[1]);

  assert.equal(direct?.receiver.valueDeclaration?.Kind, KindClassDeclaration);
  assert.equal(aliased?.receiver.valueDeclaration?.Kind, KindVariableDeclaration);
  assert.notEqual(direct?.receiver.valueSymbol, aliased?.receiver.valueSymbol);
  assert.ok(
    direct?.selectedDeclaration === aliased?.selectedDeclaration,
    "Both accesses must retain the same exact selected static field declaration.",
  );
  assertCleanSemanticDiagnostics(program, index);
});

test("property access info retains both exact accessor declarations for read-write operations", () => {
  const { program, index } = createProgram(`
    class Counter {
      private stored = 0;

      get value(): number {
        return this.stored;
      }

      set value(next: number) {
        this.stored = next;
      }
    }

    declare const counter: Counter;
    counter.value += 1;
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const access = findPropertyAccessByName(index, "value", () => true);
  const selected = queries.getResolvedPropertyAccessInfo(access);

  assert.equal(selected?.accessMode, "read-write");
  assert.equal(selected?.selectedReadDeclaration?.Kind, KindGetAccessor);
  assert.equal(selected?.selectedWriteDeclaration?.Kind, KindSetAccessor);
  assert.notEqual(
    selected?.selectedReadDeclaration,
    selected?.selectedWriteDeclaration,
  );
  assertCleanSemanticDiagnostics(program, index);
});

test("element access info preserves mapped declarations and proven tuple ordinals", () => {
  const { program, index } = createProgram(`
    type Dictionary<Key extends string, Value> = {
      [Property in Key]: Value;
    };

    declare const dictionary: Dictionary<string, number>;
    declare const key: string;
    dictionary[key];

    declare const pair: readonly [string, number];
    const one = 1 as const;
    pair[one];
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindElementAccessExpression);
  assert.equal(accesses.length, 2);

  const mapped = queries.getResolvedElementAccessInfo(accesses[0]);
  assert.ok(mapped?.accessMode === "read", "Mapped element access must be a checked read.");
  assert.equal(mapped?.selectedSymbol === undefined, true);
  assert.ok(mapped?.selectedDeclaration !== undefined);
  assert.equal(mapped?.selectedElementIndex, undefined);
  assert.equal(mapped.sourceReadType.flags & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(mapped.receiver.symbol !== undefined);
  assert.ok(mapped.receiver.declaration !== undefined);
  assert.ok(
    mapped.receiver.symbol ===
      queries.getLexicallyResolvedSymbol(mapped.receiver.expression),
    "Element receiver evidence must retain the exact lexically selected symbol.",
  );

  const tuple = queries.getResolvedElementAccessInfo(accesses[1]);
  assert.ok(tuple?.accessMode === "read", "Tuple element access must be a checked read.");
  assert.equal(tuple?.selectedElementIndex, 1);
  assert.equal(tuple.sourceReadType.flags & TypeFlagsNumber, TypeFlagsNumber);

  assertCleanSemanticDiagnostics(program, index);
  const repeatedMapped = queries.getResolvedElementAccessInfo(accesses[0]);
  assert.ok(
    repeatedMapped === mapped,
    "Repeated mapped-element queries must retain the exact resolved access result.",
  );
  assert.ok(
    repeatedMapped?.selectedDeclaration === mapped?.selectedDeclaration,
    "Repeated mapped-element queries must retain exact selected-declaration identity.",
  );
  assert.ok(
    repeatedMapped?.sourceReadType === mapped?.sourceReadType,
    "Repeated mapped-element queries must retain exact checker read-type identity.",
  );
  assert.equal(repeatedMapped?.selectedElementIndex, mapped?.selectedElementIndex);

  const repeatedTuple = queries.getResolvedElementAccessInfo(accesses[1]);
  assert.ok(
    repeatedTuple === tuple,
    "Repeated tuple-element queries must retain the exact resolved access result.",
  );
  assert.ok(
    repeatedTuple?.selectedDeclaration === tuple?.selectedDeclaration,
    "Repeated tuple-element queries must retain exact selected-declaration identity.",
  );
  assert.ok(
    repeatedTuple?.sourceReadType === tuple?.sourceReadType,
    "Repeated tuple-element queries must retain exact checker read-type identity.",
  );
  assert.equal(repeatedTuple?.selectedElementIndex, tuple?.selectedElementIndex);
});

test("named index access retains the exact index, writability and immutable selection", () => {
  const { program, index } = createProgram(`
    type Dictionary<Value> = { [Key in string]: Value };
    declare const mapped: Dictionary<number>;
    mapped.answer = 1;
    mapped.answer++;
    const value = mapped.answer;
    declare const indexed: { [key: string]: number; fixed: number };
    const dynamic = indexed.answer;
    const fixed = indexed.fixed;
    declare const readonly: { readonly [key: string]: number };
    const immutable = readonly.answer;
    declare const patterned: { [key: \`entry_\${string}\`]: number; [key: string]: string | number };
    const pattern = patterned.entry_first;
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindPropertyAccessExpression);
  const mapped = accesses.slice(0, 3).map(access => queries.getResolvedPropertyAccessInfo(access));
  assert.deepEqual(mapped.map(selection => selection?.accessMode), ["write", "read-write", "read"]);
  for (const selection of mapped) {
    assert.ok(selection?.selectedIndex);
    assert.equal(selection.selectedIndex.readonly, false);
    assert.equal(selection.writable, true);
    assert.equal(selection.selectedIndex.declaration, undefined);
    assert.ok(Object.isFrozen(selection) && Object.isFrozen(selection.selectedIndex));
    assert.ok(Object.isFrozen(selection.selectedIndex.components));
  }
  const dynamic = queries.getResolvedPropertyAccessInfo(accesses[3]);
  assert.ok(dynamic?.selectedIndex?.declaration);
  assert.equal(dynamic.selectedIndex.readonly, false);
  assert.equal(queries.getResolvedPropertyAccessInfo(accesses[4])?.selectedIndex, undefined);
  const immutable = queries.getResolvedPropertyAccessInfo(accesses[5]);
  assert.ok(immutable?.selectedIndex);
  assert.equal(immutable.selectedIndex.readonly, true);
  assert.equal(immutable.writable, false);
  const pattern = queries.getResolvedPropertyAccessInfo(accesses[6]);
  assert.ok(pattern?.selectedIndex?.valueType);
  assert.equal(pattern.selectedIndex.valueType.flags & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(queries.getResolvedPropertyAccessInfo(accesses[0]), mapped[0]);
  assertCleanSemanticDiagnostics(program, index);
});

test("element access exposes no fixed tuple ordinal without one exact checker proof", () => {
  const { program, index } = createProgram(`
    declare const pair: readonly [string, number];
    declare const general: number;
    pair[general];

    declare const ambiguous: 0 | 1;
    pair[ambiguous];

    declare const mixed: readonly [string, number] | readonly string[];
    mixed[general];

    declare const rest: readonly [string, ...number[]];
    rest[2];
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindElementAccessExpression);
  assert.equal(accesses.length, 4);

  for (const access of accesses) {
    const selected = queries.getResolvedElementAccessInfo(access);
    assert.equal(selected?.accessMode, "read");
    assert.equal(selected?.selectedElementIndex, undefined);
  }
  assertCleanSemanticDiagnostics(program, index);
});

test("element access info distinguishes read, write, and read-write index operations", () => {
  const { program, index } = createProgram(`
    interface Values {
      [key: string]: number;
    }

    declare const values: Values;
    declare const key: string;
    const read = values[key];
    values[key] = 1;
    values[key] += 2;
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const accesses = findNodesByKind(index, KindElementAccessExpression);
  assert.equal(accesses.length, 3);

  const read = queries.getResolvedElementAccessInfo(accesses[0]);
  const write = queries.getResolvedElementAccessInfo(accesses[1]);
  const readWrite = queries.getResolvedElementAccessInfo(accesses[2]);
  assert.equal(read?.accessMode, "read");
  assert.equal(write?.accessMode, "write");
  assert.equal(readWrite?.accessMode, "read-write");
  assert.equal((read?.sourceReadType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(read?.sourceWriteType, undefined);
  assert.equal(write?.sourceReadType, undefined);
  assert.equal((write?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal((readWrite?.sourceReadType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal((readWrite?.sourceWriteType?.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(
    read?.selectedDeclaration === write?.selectedDeclaration
      && write?.selectedDeclaration === readWrite?.selectedDeclaration,
    "Every access mode must retain the exact selected index-signature declaration.",
  );
  assertCleanSemanticDiagnostics(program, index);
});

test("element access info preserves optional-chain source selection", () => {
  const { program, index } = createProgram(`
    interface Values {
      [key: string]: number;
    }

    declare const values: Values | undefined;
    declare const key: string;
    values?.[key];
  `);
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const access = findNodesByKind(index, KindElementAccessExpression)[0];
  const selected = queries.getResolvedElementAccessInfo(access);

  assert.equal(selected?.accessMode, "read");
  assert.equal(selected?.optionalChain, true);
  assert.equal(selected?.selectedSymbol, undefined);
  assert.ok(selected?.selectedDeclaration !== undefined);
  assert.equal(queries.typeToString(selected?.sourceReadType), "number | undefined");
  assertCleanSemanticDiagnostics(program, index);
});

test("iteration info preserves declaration and assignment element selection", () => {
  const { program, index } = createProgram(`
    declare const values: readonly number[];
    let existing = 0;

    for (const value of values) {
      value;
    }

    for (existing of values) {
      existing;
    }
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const statements = findNodesByKind(index, KindForOfStatement);
  assert.equal(statements.length, 2);

  const declaration = queries.getResolvedIterationInfo(statements[0]);
  const assignment = queries.getResolvedIterationInfo(statements[1]);
  assert.equal(declaration?.iterationKind, "for-of");
  assert.equal(assignment?.iterationKind, "for-of");
  assert.equal((declaration?.sourceElementType.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.ok(
    assignment?.sourceElementType === declaration?.sourceElementType,
    "Declaration and assignment iteration must retain the same selected element type.",
  );
  assert.equal(Object.isFrozen(declaration), true);
  assert.equal(Object.isFrozen(declaration?.mechanism), true);
  assertCleanSemanticDiagnostics(program, index);
  const repeatedDeclaration = queries.getResolvedIterationInfo(statements[0]);
  assert.ok(
    repeatedDeclaration === declaration,
    "Repeated declaration iteration queries must retain the exact resolved iteration result.",
  );
  assert.equal(repeatedDeclaration?.iterationKind, declaration?.iterationKind);
  assert.ok(
    repeatedDeclaration?.sourceIterableType === declaration?.sourceIterableType,
    "Repeated declaration iteration queries must retain exact iterable-type identity.",
  );
  assert.ok(
    repeatedDeclaration?.sourceElementType === declaration?.sourceElementType,
    "Repeated declaration iteration queries must retain exact element-type identity.",
  );
  assert.equal(repeatedDeclaration?.mechanism.kind, declaration?.mechanism.kind);

  const repeatedAssignment = queries.getResolvedIterationInfo(statements[1]);
  assert.ok(
    repeatedAssignment === assignment,
    "Repeated assignment iteration queries must retain the exact resolved iteration result.",
  );
  assert.equal(repeatedAssignment?.iterationKind, assignment?.iterationKind);
  assert.ok(
    repeatedAssignment?.sourceIterableType === assignment?.sourceIterableType,
    "Repeated assignment iteration queries must retain exact iterable-type identity.",
  );
  assert.ok(
    repeatedAssignment?.sourceElementType === assignment?.sourceElementType,
    "Repeated assignment iteration queries must retain exact element-type identity.",
  );
  assert.equal(repeatedAssignment?.mechanism.kind, assignment?.mechanism.kind);
});

test("iteration info preserves for-await-of element and protocol evidence", () => {
  const { program, index } = createProgram(`
    async function consume(values: AsyncIterable<number>): Promise<void> {
      for await (const value of values) {
        value;
      }
    }
  `, { noLib: false });
  const queries = createTypeCheckerQueries(program, { sourceFile: index });
  const statements = findNodesByKind(index, KindForOfStatement);
  assert.equal(statements.length, 1);

  const selection = queries.getResolvedIterationInfo(statements[0]);
  assert.equal(selection?.iterationKind, "for-await-of");
  assert.equal((selection?.sourceElementType.flags ?? 0) & TypeFlagsNumber, TypeFlagsNumber);
  assert.equal(selection?.mechanism.kind, "asynchronous-iterator-protocol");
  assertCleanSemanticDiagnostics(program, index);
});
