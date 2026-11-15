import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram } from "../index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import type { Checker } from "../internal/checker/checker/state.js";
import { CachedTypeKindArrayLiteralType, CheckModeInferential, getTypeListKey, UnionReductionNone } from "../internal/checker/checker/state.js";
import type { Type, TypeDerivation } from "../internal/checker/types.js";
import type { Node } from "../internal/ast/spine.js";
import { TypeFlagsUnion, Type_AsObjectType, Type_AsStructuredType, Type_AsTypeReference, Type_Target, Type_Types } from "../internal/checker/types.js";
import { Checker_cloneTypeReference, Checker_getUnionTypeEx, Checker_newAnonymousType } from "../internal/checker/checker/types.js";
import { Checker_checkExpressionCached } from "../internal/checker/checker/syntax-checking.js";
import { GetNodeId } from "../internal/ast/utilities.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { createTypeNormalization } from "./type-normalization.js";
import { reacquireLiteralGraph } from "./type-normalization-spreads.js";

type Event = Extract<TypeDerivation, { readonly kind: "object-literal" | "literal-fragment" | "literal-merge" | "literal-partial" }>;
function eventOf(type: Type): Event | undefined {
  const event = type.derivation;
  return event?.kind === "object-literal" || event?.kind === "literal-fragment" || event?.kind === "literal-merge" || event?.kind === "literal-partial" ? event : undefined;
}
function inputs(event: Event): readonly Type[] {
  return event.kind === "literal-merge" ? [event.left, event.right] : event.kind === "literal-partial" ? [event.source, event.other] : [];
}
function siteOf(event: Event) {
  return event.kind === "object-literal" ? { node: event.node, mode: event.mode, boundary: null }
    : event.kind === "literal-fragment" ? event : event.site;
}
function fixture(checkers: number) {
  const source = `export declare const choice:{a:number}|{b:string};
    export declare const other:{c:boolean}|{d:null};
    export declare const maybe:{}|{optional:string};
    export const single={...choice}; export const trailing={...choice,x:1};
    export const leading={x:1,...choice}; export const both={x:1,...choice,y:2};
    export const twice={...choice,...choice}; export const cross={...choice,...other};
    export const chunks={p:1,...choice,q:2,...other,r:3}; export const empty={...choice,...{}};
    export const optional={...choice,...maybe}; export const nested={...{...choice,p:1},...choice};
    export const repeated={...choice,...other,...choice,...other}; export const optionalTwice={...maybe,...maybe};
    type A={a:number};type B={b:string};type C={c:boolean};type AB=A|B;type BC=B|C;type Joined=AB|BC;
    export declare const aliased:Joined; export const named={...aliased,flag:true};
    export const namedTwice={...aliased,...aliased};
    export const interleavedEmpty={...choice,...{},p:1,...{},...choice};
    export const nestedEmpty={...{...choice,...{}},p:1,...{...{},...choice}};
    export const immutable={...choice,...maybe,tail:true} as const;
    export const arrayInputs=[{slot:{x:1}},{slot:{y:2}}];`;
  const session = createCompilerSessionFromFiles({ currentDirectory: "/spread-events", includeBundledLibraries: false,
    files: { "/spread-events/core.d.ts": testCoreDeclarations, "/spread-events/use.ts": source,
      "/spread-events/other.ts": "export const other=1;", "/spread-events/last.ts": "export const last=2;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/spread-events/use.ts");
  const program = session.program;
  if (file === undefined || program === undefined) throw new Error("The actual spread fixture retains its Program and file");
  const view = checked.getSourceFileQueries(file);
  const nodes = findNodes(file, view.ast.children, view.ast.is.IsObjectLiteralExpression);
  const arrays = findNodes(file, view.ast.children, view.ast.is.IsArrayLiteralExpression);
  const owners: Checker[] = [];
  for (const owner of program.compilerCheckerPool!.checkers) {
    if (owner === undefined) throw new Error("The actual checker pool is dense");
    owners.push(owner);
  }
  assert.equal(owners.length, checkers);
  assert.equal(createCompilerSessionFromProgram(program, session.host, session.config).program === program, true);
  return { owners, nodes, arrays };
}

function events(root: Type): readonly Type[] {
  const seen = new Set<Type>();
  const result: Type[] = [];
  const pending = [root];
  for (const type of pending) {
    if (seen.has(type)) continue;
    seen.add(type);
    const event = eventOf(type);
    if (event !== undefined) { result.push(type); pending.push(...inputs(event)); }
    if ((type.flags & TypeFlagsUnion) !== 0) for (const member of Type_Types(type) ?? []) {
      if (member === undefined) throw new Error("The actual native union retains its members");
      pending.push(member);
    }
  }
  return result;
}

function history(producer: Checker) {
  const normal = createTypeNormalization(producer);
  const known = new Map<Type, string>();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const read = (type: Type): string => {
    const previous = known.get(type);
    if (previous !== undefined) return previous;
    const event = eventOf(type);
    let result: string;
    if (event !== undefined) {
      const site = siteOf(event);
      const at = [String(GetNodeId(site.node)), site.mode, site.boundary === null ? null : String(GetNodeId(site.boundary))];
      result = hash(event.kind === "object-literal" || event.kind === "literal-fragment" ? [event.kind, at] : event.kind === "literal-merge"
        ? [event.kind, at, event.site.phase, read(event.left), read(event.right), event.flags, event.readonly]
        : [event.kind, at, event.site.phase, event.role, read(event.source), read(event.other), event.readonly]);
    } else if (type.alias === undefined && (type.flags & TypeFlagsUnion) !== 0) {
      const members: string[] = [];
      for (const member of Type_Types(type) ?? []) {
        if (member === undefined) throw new Error("The actual construction input union retains its members");
        members.push(read(member));
      }
      result = hash(["native-union-input", members.sort()]);
    } else result = hash(["native-cached-input", normal.type(type).id]);
    known.set(type, result);
    return result;
  };
  return read;
}

for (const checkers of [1, 4]) test(`actual cached literal graphs retain their exact fresh events with ${checkers} checkers`, () => {
  const current = fixture(checkers);
  for (const source of current.owners) for (const producer of current.owners) {
    const label = history(producer);
    const expected = new Map<Type, Type>();
    for (const node of current.nodes) {
      const target = Checker_checkExpressionCached(producer, node);
      const original = Checker_checkExpressionCached(source, node);
      if (target === undefined || original === undefined) throw new Error("Both real producers retain their actual cached literal");
      const selected = new Map<string, Type>();
      for (const value of events(target)) {
        const key = label(value);
        const previous = selected.get(key);
        const event = eventOf(value);
        const before = previous === undefined ? undefined : eventOf(previous);
        const site = event === undefined ? undefined : siteOf(event);
        assert.equal(previous === undefined || previous === value, true,
          JSON.stringify({ law: "one native construction history within the actual cached question", checker: producer.id,
            current: value.id, previous: previous?.id, kind: event?.kind,
            node: site === undefined ? null : String(GetNodeId(site.node)),
            cached: site === undefined ? null : LinkStore_TryGet(producer.typeNodeLinks, site.node)?.resolvedType?.id,
            root: { node: String(GetNodeId(node)), type: target.id },
            inputs: event === undefined ? [] : inputs(event).map(type => type.id),
            priorInputs: before === undefined ? [] : inputs(before).map(type => type.id) }));
        selected.set(key, value);
      }
      for (const value of events(original)) {
        const counterpart = selected.get(label(value));
        const event = eventOf(value);
        const site = event === undefined ? undefined : siteOf(event);
        assert.equal(counterpart !== undefined, true, JSON.stringify({ law: "the same cached question retains its independent construction history",
          source: source.id, producer: producer.id, question: String(GetNodeId(node)), root: original.id, target: target.id,
          value: value.id, kind: event?.kind, site: site === undefined ? null : String(GetNodeId(site.node)),
          input: event === undefined ? [] : inputs(event).map(type => ({ id: type.id, label: label(type) })),
          possible: events(target).filter(other => {
            const recipe = eventOf(other);
            const at = recipe === undefined ? undefined : siteOf(recipe);
            return recipe?.kind === event?.kind && at?.node === site?.node && at?.boundary === site?.boundary;
          }).slice(0, 8).map(other => { const recipe = eventOf(other); return { id: other.id,
            input: recipe === undefined ? [] : inputs(recipe).map(type => ({ id: type.id, label: label(type) })) }; }) }));
        if (counterpart === undefined) throw new Error("The independent construction oracle retains its matched event");
        const previous = expected.get(value);
        assert.equal(previous === undefined || previous === counterpart, true,
          "the same actual input pointer has pointer-compatible ownership across cached questions");
        expected.set(value, counterpart);
      }
    }
    for (const ordered of [[...expected.keys()], [...expected.keys()].reverse()]) {
      const normalized = createTypeNormalization(producer);
      for (const original of ordered) {
        const selected = expected.get(original);
        assert.equal(selected !== undefined, true, "the actual target has this independent native construction history");
        assert.equal(normalized.type(original) === selected, true, "the answer is the actual cached native event output");
        assert.equal(normalized.type(original) === selected, true);
      }
      for (const node of current.nodes) {
        const original = Checker_checkExpressionCached(source, node);
        const target = Checker_checkExpressionCached(producer, node);
        if (original === undefined) throw new Error("The actual source literal retains its cached output");
        assert.equal(normalized.type(original) === target, true);
      }
    }
  }
});

test("copied and crossed spread recipes cannot query a target before actual source graph membership", () => {
  const current = fixture(4);
  const source = current.owners[0];
  const target = current.owners[1];
  if (source === undefined || target === undefined) throw new Error("The actual fixture retains two producers");
  const actual: Type[] = [];
  for (const node of current.nodes) {
    const value = Checker_checkExpressionCached(source, node);
    if (value !== undefined) actual.push(...events(value));
  }
  const producer = new Proxy(target, { get(owner, key, receiver) {
    if (key === "typeNodeLinks" || key === "cachedTypes") assert.fail("invalid source evidence cannot read a target cache");
    return Reflect.get(owner, key, receiver);
  } });
  let exercised = 0;
  for (const original of actual) {
    const recipe = eventOf(original);
    if (recipe === undefined) continue;
    const clone = Checker_newAnonymousType(source, original.symbol, new Map(), [], [], []);
    if (clone === undefined) throw new Error("The actual native clone constructor retains its producer");
    const site = siteOf(recipe);
    const changes: Event[] = [recipe, recipe.kind === "object-literal" || recipe.kind === "literal-fragment" ? { ...recipe, mode: CheckModeInferential }
      : { ...recipe, site: { ...site, phase: recipe.site.phase === "properties" ? "spread" : "properties" } }];
    if (recipe.kind === "literal-partial") changes.push({ ...recipe, role: recipe.role === "left" ? "right" : "left", other: original });
    if (recipe.kind === "literal-merge") changes.push({ ...recipe, left: recipe.right, right: recipe.left });
    for (const changed of changes) {
      clone.derivation = changed;
      assert.equal(reacquireLiteralGraph(producer, clone, () => assert.fail("invalid source cannot normalize an input"),
        () => assert.fail("invalid source cannot seed a memo")), undefined);
      exercised++;
    }
  }
  assert.equal(exercised > 20, true);
});

test("absent and ambiguous completed source questions reject before any target work", () => {
  const current = fixture(4);
  const source = current.owners[0];
  const target = current.owners[1];
  if (source === undefined || target === undefined) throw new Error("The actual fixture retains two producers");
  let selected: { readonly value: Type; readonly node: typeof current.nodes[number] } | undefined;
  for (const node of current.nodes) {
    const root = Checker_checkExpressionCached(source, node);
    if (root === undefined) throw new Error("The source question has its completed answer");
    for (const value of events(root)) {
      const event = eventOf(value);
      const site = event === undefined ? undefined : siteOf(event);
      if (site !== undefined && site.node !== node) selected = { value, node: site.node };
    }
  }
  if (selected === undefined) throw new Error("The actual nested literal has an ancestor-owned construction");
  const actual = selected;
  const unread = new Proxy(target, { get(owner, key, receiver) {
    if (key === "typeNodeLinks" || key === "cachedTypes") assert.fail("ambiguous or absent ownership cannot read the target");
    return Reflect.get(owner, key, receiver);
  } });
  const reject = () => assert.equal(reacquireLiteralGraph(unread, actual.value,
    () => assert.fail("source ownership must precede normalization"), () => assert.fail("source ownership must precede memo writes")), undefined);
  const saved = new Map(source.typeNodeLinks.entries);
  try {
    for (let node: Node | undefined = actual.node; node !== undefined; node = node.Parent) source.typeNodeLinks.entries.delete(node);
    reject();
  } finally {
    for (const [node, links] of saved) source.typeNodeLinks.entries.set(node, links);
  }
  const original = source.typeNodeLinks.entries.get(actual.node);
  if (original === undefined) throw new Error("The separately queried nested literal retains its actual completed links");
  try {
    source.typeNodeLinks.entries.set(actual.node, { ...original, resolvedType: actual.value });
    reject();
  } finally {
    source.typeNodeLinks.entries.set(actual.node, original);
  }
  assert.equal(source.typeNodeLinks.entries.size, saved.size);
  for (const [node, links] of saved) assert.equal(source.typeNodeLinks.entries.get(node) === links, true);
  const foreign = fixture(1).owners[0];
  if (foreign === undefined) throw new Error("The unrelated Program retains its native producer");
  assert.throws(() => reacquireLiteralGraph(foreign, actual.value,
    () => assert.fail("a foreign Program cannot normalize an input"), () => assert.fail("a foreign Program cannot seed a memo")),
  error => error instanceof TypeError);
});

test("duplicate complete native event coordinates reject before target access", () => {
  const current = fixture(4);
  const source = current.owners[0];
  const target = current.owners[1];
  if (source === undefined || target === undefined) throw new Error("The actual fixture retains two producers");
  const node = current.nodes[0];
  if (node === undefined) throw new Error("The actual fixture retains its first literal");
  const root = Checker_checkExpressionCached(source, node);
  if (root === undefined) throw new Error("The actual source question has its cached answer");
  const value = events(root).find(type => type.derivation?.kind === "literal-merge");
  if (value === undefined) throw new Error("The actual cached spread retains a fresh merge");
  const recipe = eventOf(value);
  if (recipe === undefined) throw new Error("The actual fresh merge retains its construction record");
  const clone = Checker_newAnonymousType(source, value.symbol, new Map(), [], [], []);
  if (clone === undefined) throw new Error("The independent native clone retains its producer");
  clone.derivation = recipe;
  clone.objectFlags = value.objectFlags;
  const duplicate = Checker_getUnionTypeEx(source, [value, clone], UnionReductionNone, undefined, undefined);
  const links = LinkStore_TryGet(source.typeNodeLinks, node);
  if (duplicate === undefined || links === undefined) throw new Error("The malformed relation has actual native union and link carriers");
  const original = links.resolvedType;
  const unread = new Proxy(target, { get(owner, key, receiver) {
    if (key === "typeNodeLinks" || key === "cachedTypes") assert.fail("nonunique source construction coordinates cannot read the target");
    return Reflect.get(owner, key, receiver);
  } });
  try {
    links.resolvedType = duplicate;
    assert.equal(reacquireLiteralGraph(unread, value, () => assert.fail("duplicate source coordinates cannot normalize inputs"),
      () => assert.fail("duplicate source coordinates cannot seed a memo")), undefined);
  } finally { links.resolvedType = original; }
});

test("a cold target question is queried only after complete source admission", () => {
  const current = fixture(4);
  const source = current.owners[0];
  const node = current.nodes[0];
  if (source === undefined || node === undefined) throw new Error("The actual fixture retains its source producer and literal");
  const root = Checker_checkExpressionCached(source, node);
  if (root === undefined) throw new Error("The actual source question is complete");
  const producer = current.owners.find(owner => owner !== source && LinkStore_TryGet(owner.typeNodeLinks, node)?.resolvedType === undefined);
  if (producer === undefined) throw new Error("The actual native pool retains an unqueried target question");
  const value = events(root).find(type => type.derivation?.kind === "literal-merge");
  if (value === undefined) throw new Error("The actual cached spread retains a fresh merge");
  const recipe = eventOf(value);
  if (recipe === undefined) throw new Error("The actual fresh merge retains its construction record");
  const clone = Checker_newAnonymousType(source, value.symbol, new Map(), [], [], []);
  if (clone === undefined) throw new Error("The independent native clone retains its producer");
  clone.derivation = recipe;
  const before = LinkStore_TryGet(producer.typeNodeLinks, node);
  assert.equal(reacquireLiteralGraph(producer, clone, () => assert.fail("a copied recipe cannot normalize inputs"),
    () => assert.fail("a copied recipe cannot seed a memo")), undefined);
  assert.equal(LinkStore_TryGet(producer.typeNodeLinks, node) === before && before?.resolvedType === undefined, true);
  const normalize = createTypeNormalization(producer);
  const result = normalize.type(value);
  const target = LinkStore_TryGet(producer.typeNodeLinks, node)?.resolvedType;
  if (target === undefined) throw new Error("The admitted source event initializes its actual target question");
  const label = history(producer);
  const candidates = events(target).filter(type => label(type) === label(value));
  assert.equal(candidates.length === 1 && candidates[0] === result, true,
    "the answer is the sole independently matched event inside that exact newly cached question");
  assert.equal(normalize.type(root) === target && normalize.type(value) === result, true);
});

test("one target graph walk seeds later actual event requests without rewriting caches or recipes", () => {
  const current = fixture(4);
  const source = current.owners[0];
  const producer = current.owners[1];
  if (source === undefined || producer === undefined) throw new Error("The actual fixture retains two producers");
  let selected: { readonly root: Type; readonly target: Type } | undefined;
  for (const node of current.nodes) {
    const root = Checker_checkExpressionCached(source, node);
    const target = Checker_checkExpressionCached(producer, node);
    if (root === undefined || target === undefined) throw new Error("Both producers retain their complete question");
    if (events(root).length > 20) selected = { root, target };
  }
  if (selected === undefined) throw new Error("The actual Cartesian literal retains a multi-event graph");
  const originals = events(selected.root);
  const targets = events(selected.target);
  const sourceLinks = new Map([...source.typeNodeLinks.entries].map(([node, value]) => [node, { value, type: value?.resolvedType }]));
  const targetLinks = new Map([...producer.typeNodeLinks.entries].map(([node, value]) => [node, { value, type: value?.resolvedType }]));
  const recipes = new Map(originals.map(type => [type, type.derivation]));
  const descriptors = new Map(targets.map(type => [type, Object.getOwnPropertyDescriptor(type, "derivation")]));
  let reads = 0;
  try {
    for (const type of targets) {
      const value = type.derivation;
      Object.defineProperty(type, "derivation", { configurable: true, get() { reads++; return value; } });
    }
    const normalize = createTypeNormalization(producer);
    const first = originals[0];
    if (first === undefined) throw new Error("The actual source graph retains an independent event");
    normalize.type(first);
    assert.equal(reads, targets.length * 2, "each target event is entered and exited by one graph traversal");
    const initialReads = reads;
    for (const type of [...originals].reverse()) {
      const value = normalize.type(type);
      assert.equal(targets.includes(value), true);
      assert.equal(normalize.type(type) === value, true);
    }
    assert.equal(normalize.type(selected.root) === selected.target, true);
    assert.equal(reads, initialReads, "the existing invocation memo serves every later leaf and root without a second graph walk");
  } finally {
    for (const [type, descriptor] of descriptors) {
      if (descriptor === undefined) delete type.derivation;
      else Object.defineProperty(type, "derivation", descriptor);
    }
  }
  for (const [owner, saved] of [[source, sourceLinks], [producer, targetLinks]] as const) {
    assert.equal(owner.typeNodeLinks.entries.size, saved.size);
    for (const [node, before] of saved) {
      const after = owner.typeNodeLinks.entries.get(node);
      assert.equal(after === before.value && after?.resolvedType === before.type, true);
    }
  }
  for (const [type, recipe] of recipes) assert.equal(type.derivation === recipe, true);
});

test("array clone and stored member input admission rejects missing or copied native prefixes before target work", () => {
  const current = fixture(4);
  const source = current.owners[0];
  const producer = current.owners[1];
  const node = current.arrays[0];
  if (source === undefined || producer === undefined || node === undefined) throw new Error("The actual fixture retains its array and two producers");
  const root = Checker_checkExpressionCached(source, node);
  if (root === undefined) throw new Error("The native array literal retains its actual completed cached clone");
  const data = Type_AsTypeReference(root);
  const values = data?.resolvedTypeArguments;
  const reference = values === undefined ? undefined : Type_AsObjectType(Type_Target(root))?.instantiations.get(getTypeListKey(values));
  if (data === undefined || values === undefined || reference === undefined) throw new Error("The native clone retains its actual raw reference and constructor inputs");
  const key = { kind: CachedTypeKindArrayLiteralType, typeId: reference.id };
  assert.equal(source.cachedTypes.get(key) === root, true);
  const union = values[0];
  const parent = union === undefined ? undefined : Type_Types(union)?.[0];
  const members = parent === undefined ? undefined : Type_AsStructuredType(parent)?.members;
  if (members === undefined) throw new Error("The actual array constructor input retains the native literal's stored member map");
  const member = [...members.values()].find(value => value !== undefined
    && LinkStore_TryGet(source.valueSymbolLinks, value)?.resolvedType?.derivation?.kind === "object-literal");
  const links = member === undefined ? undefined : LinkStore_TryGet(source.valueSymbolLinks, member);
  const child = links?.resolvedType;
  const arrayLinks = LinkStore_TryGet(source.typeNodeLinks, node);
  if (member === undefined || links === undefined || child === undefined || arrayLinks === undefined)
    throw new Error("The already-produced field links retain the actual nested creation input");
  const unread = new Proxy(producer, { get(owner, name, receiver) {
    if (name === "typeNodeLinks" || name === "cachedTypes") assert.fail("a missing native source prefix cannot read a target cache");
    return Reflect.get(owner, name, receiver);
  } });
  const reject = () => assert.equal(reacquireLiteralGraph(unread, child, () => assert.fail("native prefix admission precedes input normalization"),
    () => assert.fail("native prefix admission precedes memo writes")), undefined);
  try { source.cachedTypes.delete(key); reject(); }
  finally { source.cachedTypes.set(key, root); }
  try { source.cachedTypes.set(key, reference); reject(); }
  finally { source.cachedTypes.set(key, root); }
  const clone = Checker_cloneTypeReference(source, root);
  if (clone === undefined) throw new Error("The independent native array clone completes");
  assert.equal(clone !== root, true);
  try { arrayLinks.resolvedType = clone; reject(); }
  finally { arrayLinks.resolvedType = root; }
  try { data.resolvedTypeArguments = new Array(values.length); reject(); }
  finally { data.resolvedTypeArguments = values; }
  try { source.valueSymbolLinks.entries.delete(member); reject(); }
  finally { source.valueSymbolLinks.entries.set(member, links); }
  const foreign = producer.stringType;
  if (foreign === undefined) throw new Error("The other actual checker retains its native scalar");
  try { links.resolvedType = foreign; reject(); }
  finally { links.resolvedType = child; }
  assert.equal(arrayLinks.resolvedType === root && data.resolvedTypeArguments === values
    && source.cachedTypes.get(key) === root && source.valueSymbolLinks.entries.get(member) === links && links.resolvedType === child, true);
  const result = createTypeNormalization(producer).type(child);
  const target = LinkStore_TryGet(producer.typeNodeLinks, node)?.resolvedType;
  const targetUnion = Type_AsTypeReference(target)?.resolvedTypeArguments?.[0];
  if (targetUnion === undefined) throw new Error("The admitted native question retains its target constructor input");
  const recipe = eventOf(child);
  const expected: Type[] = [];
  for (const value of Type_Types(targetUnion) ?? []) {
    for (const symbol of Type_AsStructuredType(value)?.members?.values() ?? []) {
      if (symbol === undefined) continue;
      const type = LinkStore_TryGet(producer.valueSymbolLinks, symbol)?.resolvedType;
      const event = type === undefined ? undefined : eventOf(type);
      if (type !== undefined && recipe?.kind === "object-literal" && event?.kind === "object-literal"
        && recipe.node === event.node && recipe.mode === event.mode) expected.push(type);
    }
  }
  assert.equal(expected.length === 1 && expected[0] === result, true,
    "the answer is the actual stored target member input, not a rechecked nested literal or a property-name guess");
});
