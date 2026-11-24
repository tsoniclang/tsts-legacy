import { aliasApplication, createProgram, findNodesByKind, propertyRows } from "./type-checker-test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles } from "../index.js";
import type { Node } from "../index.js";
import { Background } from "../go/context.js";
import { Program_GetTypeChecker } from "../internal/compiler/program.js";
import { Checker_getReturnTypeOfSignature } from "../internal/checker/checker/signatures.js";
import { Checker_getConditionalTypeInstantiationWithCapture } from "../internal/checker/checker/inference.js";
import { Node_Text, Node_Type } from "../internal/ast/ast.js";
import { KindTypeAliasDeclaration } from "../internal/ast/generated/kinds.js";
import { attachExtensionHost, attachExtensionHostToProgram, getExtensionHost } from "../extensions/host.js";
import type { NativeCheckerCost } from "../internal/checker/resource-admission.js";
import { newSimpleTypeMapper } from "../internal/checker/mapper.js";
import { Type_AsConditionalType } from "../internal/checker/types.js";
import { withOwnedChecker, withOwnedCheckerAcquisition } from "./checker-ownership.js";
import { createTypeCheckerQueries } from "./type-checker.js";
import { createTypeShapeQueries } from "./type-shape.js";

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

test("a cold composite signature pays before the actual return and child signature reads", () => {
  type Charge = readonly [NativeCheckerCost, number];
  const prepare = () => {
    const { program, index } = createProgram("type Selected = ((value: string) => string) | ((value: string) => number);");
    assert.ok(program !== undefined && index !== undefined);
    attachExtensionHost(program);
    const checker = createTypeCheckerQueries(program, { sourceFile: index });
    const shape = createTypeShapeQueries(program, { sourceFile: index });
    const annotation = Node_Type(findNodesByKind(index, KindTypeAliasDeclaration)[0]);
    const type = checker.getTypeFromTypeNode(annotation)?.type;
    assert.ok(type?.checker !== undefined);
    const owner = type.checker;
    const inventory = shape.getStructuredInventory(type, () => null);
    assert.ok(inventory.kind === "complete" && inventory.value.callSignatureCount === 1);
    const signature = inventory.value.signatures[0];
    assert.ok(signature?.composite !== undefined && signature.checkerId === owner.id);
    assert.equal(signature.resolvedReturnType, undefined, "the actual composite return has not been computed");
    const rows = signature.composite.signatures;
    assert.equal(rows.length, 2);
    const reached: number[] = [];
    for (let position = 0; position < rows.length; position += 1) {
      const original = rows[position];
      Object.defineProperty(rows, position, { get() { reached.push(position); return original; } });
    }
    const acquire = <Stop extends object>(admit: (cost: NativeCheckerCost, units: number) => Stop | null) =>
      withOwnedCheckerAcquisition(program, index, owner, Background(), admit,
        selected => Checker_getReturnTypeOfSignature(selected, signature));
    return { acquire, reached, host: getExtensionHost(program), checker, annotation, signature };
  };
  const completed = prepare();
  const trace: Charge[] = [];
  const answer = completed.acquire((cost, units) => { trace.push([cost, units]); return null; });
  assert.ok(answer.kind === "complete" && answer.value === completed.signature.resolvedReturnType);
  assert.deepEqual(completed.reached, [0, 1]);
  assert.deepEqual(trace.slice(0, 3), [["work", 1], ["retained", 3], ["work", 1]]);
  const warm: Charge[] = [];
  completed.reached.length = 0;
  const repeated = completed.acquire((cost, units) => { warm.push([cost, units]); return null; });
  assert.ok(repeated.kind === "complete" && repeated.value === answer.value);
  assert.deepEqual(warm, [["work", 1]]);
  assert.deepEqual(completed.reached, []);

  for (const field of ["work", "retained"] as const) {
    let maximum = 0;
    for (const [dimension, size] of trace) {
      if (dimension !== field) continue;
      const subject = prepare();
      const refused = { field, maximum };
      let remaining = maximum;
      const paid: Charge[] = [];
      const result = subject.acquire((cost, units) => {
        paid.push([cost, units]);
        if (cost !== field) return null;
        if (remaining < units) return refused;
        remaining -= units;
        return null;
      });
      assert.ok(result.kind === "refused" && result.stop === refused);
      assert.deepEqual(paid, trace.slice(0, paid.length));
      assert.deepEqual(subject.reached, [0, 1].slice(0, subject.reached.length));
      assert.equal(subject.signature.resolvedReturnType, undefined);
      if (maximum === 0) assert.deepEqual(subject.reached, []);
      const provisional = field === "retained" || maximum > 0;
      assert.equal(subject.host?.checkerSessionTerminal, provisional);
      assert.equal(subject.checker.getTypeFromTypeNode(subject.annotation) === undefined, provisional);
      maximum += size;
    }
  }
});

test("a cold native conditional admits its argument, branch and cache before returning a completed result", () => {
  type Charge = readonly [NativeCheckerCost, number];
  const prepare = () => {
    const { program, index } = createProgram("type Choose<Value> = Value extends string ? boolean : number; type Actual = string;");
    assert.ok(program !== undefined && index !== undefined);
    attachExtensionHost(program);
    const checker = createTypeCheckerQueries(program, { sourceFile: index });
    const [declaration, selected] = findNodesByKind(index, KindTypeAliasDeclaration);
    const annotation = Node_Type(declaration);
    const template = checker.getTypeFromTypeNode(annotation)?.type;
    const input = checker.getTypeFromTypeNode(Node_Type(selected))?.type;
    const root = Type_AsConditionalType(template)?.root;
    const owner = template?.checker;
    assert.ok(root?.node !== undefined && input !== undefined && owner !== undefined);
    assert.equal(root.outerTypeParameters.length, 1);
    const parameter = root.outerTypeParameters[0];
    assert.ok(parameter !== undefined);
    const mapper = newSimpleTypeMapper(parameter, input);
    const reads: { readonly field: string; readonly after: number }[] = [];
    const charges: Charge[] = [];
    const trueBranch = root.node.TrueType;
    const falseBranch = root.node.FalseType;
    Object.defineProperty(root.outerTypeParameters, 0, { get() {
      reads.push({ field: "parameter", after: charges.length });
      return parameter;
    } });
    Object.defineProperty(root.node, "TrueType", { get() {
      reads.push({ field: "true", after: charges.length });
      return trueBranch;
    } });
    Object.defineProperty(root.node, "FalseType", { get() {
      reads.push({ field: "false", after: charges.length });
      return falseBranch;
    } });
    const acquire = <Stop extends object>(admit: (cost: NativeCheckerCost, units: number) => Stop | null) =>
      withOwnedCheckerAcquisition(program, index, owner, Background(), (cost, units) => {
        charges.push([cost, units]);
        return admit(cost, units);
      }, checker => Checker_getConditionalTypeInstantiationWithCapture(checker, template, mapper, false, undefined, undefined));
    return { root, reads, charges, acquire, host: getExtensionHost(program), checker, annotation };
  };

  const cold = prepare();
  const initial = cold.root.instantiations.size;
  const result = cold.acquire(() => null);
  assert.ok(result.kind === "complete" && result.value !== undefined);
  assert.equal(cold.checker.typeToString(result.value), "boolean");
  assert.equal(cold.root.instantiations.size, initial + 1);
  assert.deepEqual(cold.reads.map(read => read.field), ["parameter", "parameter", "true", "true", "true"]);
  for (let position = 1; position < cold.reads.length; position += 1) {
    const previous = cold.reads[position - 1];
    const current = cold.reads[position];
    assert.ok(previous !== undefined && current !== undefined && previous.after < current.after);
  }
  const admittedArgument: readonly Charge[] = [["work", 1], ["work", 1], ["work", 1], ["work", 1], ["retained", 2]];
  assert.deepEqual(cold.charges.slice(0, admittedArgument.length), admittedArgument);
  assert.deepEqual(cold.charges.at(-1), ["retained", 1]);
  const trace = cold.charges.slice();
  const readTrace = cold.reads.slice();
  cold.charges.length = 0;
  cold.reads.length = 0;
  const warm = cold.acquire(() => null);
  assert.ok(warm.kind === "complete" && warm.value === result.value);
  assert.deepEqual(cold.charges, [...admittedArgument, ["work", 3], ["work", 1]]);
  assert.deepEqual(cold.reads.map(read => read.field), ["parameter"]);
  assert.equal(cold.root.instantiations.size, initial + 1);

  for (const field of ["work", "retained"] as const) {
    let maximum = 0;
    for (const [cost, units] of trace) {
      if (cost !== field) continue;
      const subject = prepare();
      const before = subject.root.instantiations.size;
      const original = { field, maximum };
      let remaining = maximum;
      const denied = subject.acquire((dimension, size) => {
        if (dimension !== field) return null;
        if (remaining < size) return original;
        remaining -= size;
        return null;
      });
      assert.ok(denied.kind === "refused" && denied.stop === original);
      assert.deepEqual(subject.charges, trace.slice(0, subject.charges.length));
      assert.deepEqual(subject.reads, readTrace.filter(read => read.after < subject.charges.length));
      assert.equal(subject.root.instantiations.size, before);
      if (subject.reads.some(read => read.field === "true")) {
        assert.equal(subject.host?.checkerSessionTerminal, true);
        assert.equal(subject.checker.getTypeFromTypeNode(subject.annotation), undefined);
      } else if (subject.charges.length === 1) {
        assert.equal(subject.host?.checkerSessionTerminal, false);
      }
      maximum += units;
    }
  }
});

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
      const member = propertyRows(reader.typeShape, bases[0]).find(property => property.name === "value");
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
      const application = aliasApplication(reader.typeShape, alias);
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
  assert.equal(aliasApplication(reader.typeShape, foreign.annotation("/case/first.mts", "alias")) === undefined, true,
    "a foreign alias application remains unavailable without actual Program ownership");
  assert.equal(reader.typeShape.getInstantiatedBaseTypes(undefined) === undefined && reader.checker.getAwaitedType(undefined) === undefined, true,
    "absence does not acquire an owner");
});

test("shared-host queries acquire their actual originating program lease", () => {
  const { program: requestProgram, index: requestSource } = createProgram("type Value = { value: number };");
  const { program: ownerProgram, index: ownerSource } = createProgram("type Value = { value: string };");
  assert.ok(requestProgram !== undefined && ownerProgram !== undefined);
  attachExtensionHost(requestProgram);
  attachExtensionHostToProgram(requestProgram, ownerProgram, { bindCompilerProgram: false });
  const [requestChecker, releaseRequest] = Program_GetTypeChecker(requestProgram, Background());
  releaseRequest();
  const alias = findNodesByKind(ownerSource, KindTypeAliasDeclaration)[0];
  const owner = createTypeCheckerQueries(ownerProgram, { sourceFile: ownerSource })
    .getTypeFromTypeNode(Node_Type(alias))?.type.checker;
  const requestPool = requestProgram.checkerPool;
  const ownerPool = ownerProgram.checkerPool;
  assert.ok(owner !== undefined && requestChecker !== undefined && requestPool !== undefined && ownerPool !== undefined);
  const trace: string[] = [];
  const requestById = requestPool.GetCheckerById;
  const ownerById = ownerPool.GetCheckerById;
  requestPool.GetCheckerById = (context, id) => {
    trace.push("request pool");
    return requestById(context, id);
  };
  let crossed = false;
  ownerPool.GetCheckerById = (context, id) => {
    trace.push("owner pool");
    const [selected, release] = ownerById(context, id);
    return [crossed ? requestChecker : selected, () => { trace.push("owner release"); release(); }];
  };
  const read = () => withOwnedChecker(requestProgram, requestSource, owner, Background(), current => {
    trace.push("read");
    return current === owner;
  });
  try {
    assert.equal(withOwnedChecker(requestProgram, ownerSource, owner, Background(), () => false), undefined);
    assert.deepEqual(trace, [], "the requester must authenticate the exact source before acquiring either pool");
    assert.equal(read(), true);
    assert.deepEqual(trace, ["owner pool", "read", "owner release"]);
    trace.length = 0;
    crossed = true;
    assert.equal(read(), undefined, "a crossed exact handle is not authorized by the shared host");
    assert.deepEqual(trace, ["owner pool", "owner release"]);
    trace.length = 0;
    crossed = false;
    const failure = new Error("real owner operation failure");
    assert.throws(() => withOwnedChecker(requestProgram, requestSource, owner, Background(), () => { throw failure; }),
      error => error === failure);
    assert.deepEqual(trace, ["owner pool", "owner release"]);
  } finally {
    requestPool.GetCheckerById = requestById;
    ownerPool.GetCheckerById = ownerById;
  }
});

for (const [description, source, expectedProperties, callCount, indexReadonly] of [
  ["union", `
    interface First { head: string; tail: bigint; }
    interface Second { head: number; tail: string; }
    interface Third { head: boolean; tail: number; }
    type Combined = First | Second | Third;
  `, ["head", "tail"], 0, []],
  ["mapped remapping", 'type Combined = { readonly [Key in "head" | "tail" | "extra" as `field_${Key}`]: Key };', ["field_extra", "field_head", "field_tail"], 0, []],
  ["union overload", `
    interface First { head: string; (value: string): "a"; (value: number): "b"; }
    interface Second { head: string; (value: string): "c"; (value: number): "d"; }
    type Combined = First | Second;
  `, ["head"], 2, []],
  ["union combined signature", `
    interface First { head: string; (value: { left: string }): "a"; }
    interface Second { head: string; (value: { right: number }): "b"; }
    type Combined = First | Second;
  `, ["head"], 1, []],
  ["union compatible index", `
    interface First { head: string; [key: string]: string; }
    interface Second { head: number; readonly [key: string]: number; }
    type Combined = First | Second;
  `, ["head"], 0, [true]],
  ["union missing index", `
    interface First { head: string; [key: string]: string; }
    interface Second { head: number; [key: number]: number; }
    type Combined = First | Second;
  `, ["head"], 0, []],
] as const) test(`cold ${description} admission returns the original stop and retires the actual cohort before releasing it`, () => {
  const prepare = () => {
    const { program, index } = createProgram(source);
    assert.ok(program !== undefined && index !== undefined);
    attachExtensionHost(program);
    const checker = createTypeCheckerQueries(program, { sourceFile: index });
    const shape = createTypeShapeQueries(program, { sourceFile: index });
    const alias = findNodesByKind(index, KindTypeAliasDeclaration)[0];
    const annotation = Node_Type(alias);
    const type = checker.getTypeFromTypeNode(annotation)?.type;
    assert.ok(type !== undefined && type.checker !== undefined);
    return { program, shape, checker, annotation, type };
  };
  type Charge = readonly [NativeCheckerCost, number];
  const cold = prepare();
  const trace: Charge[] = [];
  let receipt = trace;
  const complete = cold.shape.getStructuredInventory(cold.type, (cost, units) => { receipt.push([cost, units]); return null; });
  assert.equal(complete.kind, "complete");
  assert.equal(complete.value.callSignatureCount, callCount);
  assert.deepEqual(complete.value.indexes.map(index => index.readonly), indexReadonly);
  const warm: Charge[] = [];
  const repeated = cold.shape.getStructuredInventory(cold.type, (cost, units) => { warm.push([cost, units]); return null; });
  assert.equal(repeated.kind, "complete");
  assert.equal(repeated.value.signatures === complete.value.signatures, true);
  assert.ok(trace.length > warm.length, "an independently completed native cache does not replay cold preparation");
  const rowCosts: Charge[] = [];
  receipt = rowCosts;
  const row = complete.value.properties.next();
  assert.ok(row.kind === "complete" && row.value !== null && rowCosts.length > 1);
  const otherRow = repeated.value.properties.next();
  assert.ok(otherRow.kind === "complete" && otherRow.value?.symbol === row.value.symbol);
  assert.deepEqual(propertyRows(cold.shape, cold.type).map(property => property.name).sort(), expectedProperties);

  let terminalCuts = 0;
  let cleanCuts = 0;
  for (const dimension of ["work", "retained"] as const) {
    const cuts: number[] = [];
    let used = 0;
    for (const [cost, units] of trace) {
      if (cost !== dimension) continue;
      cuts.push(used);
      used += units;
    }
    for (const maximum of cuts) {
      const subject = prepare();
      const stop = { dimension, maximum };
      const pool = subject.program.checkerPool;
      const host = getExtensionHost(subject.program);
      assert.ok(pool !== undefined && host !== undefined);
      const foreign = createProgram("type Member = number;");
      assert.ok(foreign.program !== undefined && foreign.index !== undefined);
      attachExtensionHostToProgram(subject.program, foreign.program, { bindCompilerProgram: false });
      const sibling = createTypeCheckerQueries(foreign.program, { sourceFile: foreign.index });
      const siblingAnnotation = Node_Type(findNodesByKind(foreign.index, KindTypeAliasDeclaration)[0]);
      assert.ok(sibling.getTypeFromTypeNode(siblingAnnotation)?.type !== undefined);
      const acquire = pool.GetCheckerById;
      const actual: Charge[] = [];
      let remaining = maximum;
      let releasedTerminal = false;
      pool.GetCheckerById = (context, id) => {
        const [checker, release] = acquire(context, id);
        return [checker, () => { releasedTerminal = host.checkerSessionTerminal; release(); }];
      };
      try {
        const refused = subject.shape.getStructuredInventory(subject.type, (cost, units) => {
          actual.push([cost, units]);
          if (cost !== dimension) return null;
          if (remaining < units) return stop;
          remaining -= units;
          return null;
        });
        assert.ok(refused.kind === "refused" && refused.stop === stop, `${dimension} ${maximum}`);
        assert.deepEqual(actual, trace.slice(0, actual.length), `${dimension} ${maximum}: same reached native prefix`);
        if (dimension === "work" && maximum === 0) assert.equal(releasedTerminal, false, "a stop before native work cannot have changed its session");
        if (releasedTerminal) {
          terminalCuts += 1;
          assert.equal(subject.checker.getTypeFromTypeNode(subject.annotation), undefined);
          assert.equal(sibling.getTypeFromTypeNode(siblingAnnotation), undefined);
          assert.equal(subject.shape.getStructuredInventory(subject.type, () => assert.fail("A terminal view cannot restart acquisition.")).kind, "unavailable");
        } else {
          cleanCuts += 1;
          assert.equal(subject.checker.getTypeFromTypeNode(subject.annotation)?.type === subject.type, true);
        }
      } finally {
        pool.GetCheckerById = acquire;
      }
    }
  }
  assert.ok(terminalCuts > 0 && cleanCuts > 0);
});
