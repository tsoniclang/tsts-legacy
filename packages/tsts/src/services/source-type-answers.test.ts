import { propertyAccess } from "./type-checker-test-support.js";
import { propertyRows } from "./type-checker-test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompilerSessionFromFiles, createCompilerSessionFromProgram, type ResolvedSourceTypeInfo } from "../index.js";
import { getExtensionHost } from "../extensions/index.js";
import { findNodes, testCoreDeclarations, testNoLibCompilerOptions } from "../extensions/source-provider-test-support.js";
import { getDiagnosticRunMembers } from "./diagnostic-run-members.js";
import { Program_GetTypeCheckerForFileExclusive } from "../internal/compiler/program.js";
import { CheckerLifetimeDiagnostics, WithCheckerLifetime } from "../internal/core/context.js";
import { CheckModeContextual, CheckModeInferential, CheckModeNormal, CheckModeTypeOnly } from "../internal/checker/checker/state.js";
import { Checker_checkExpressionEx } from "../internal/checker/checker/syntax-checking.js";
import { maxSerializationLevel } from "../internal/checker/checker.js";
import { Background } from "../go/context.js";
import { AsBinaryExpression } from "../internal/ast/generated/casts.js";
import { Node_Arguments, Node_Expression, Node_Type, SourceFile_Text } from "../internal/ast/ast.js";
import { LinkStore_TryGet } from "../internal/core/linkstore.js";
import { Diagnostic_End, Diagnostic_Pos, type Diagnostic } from "../internal/ast/diagnostic.js";

test("bounded storage settles original wrapper evidence before completing the shared occurrence cache", () => {
  const open = () => {
    const session = createCompilerSessionFromFiles({ currentDirectory: "/storage", includeBundledLibraries: false,
      files: { "/storage/core.d.ts": testCoreDeclarations,
        "/storage/source.ts": "export function store(value:boolean) { const fixed:boolean=true; ((fixed))=value; }" },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true } });
    const checked = session.checkSource();
    const sourceFile = checked.getSourceFile("/storage/source.ts");
    assert.ok(sourceFile);
    const source = checked.getSourceFileQueries(sourceFile);
    const [binary] = findNodes(sourceFile, source.ast.children, source.ast.is.IsBinaryExpression);
    const left = AsBinaryExpression(binary)?.Left;
    assert.ok(left);
    const diagnostic = checked.diagnostics.flatMap(root => {
      assert.ok(root);
      return getDiagnosticRunMembers(root);
    }).find(root => root.code === 2588);
    assert.ok(diagnostic);
    return { source, left, diagnostic };
  };
  const actual = open();
  const charges: [cost: "work" | "retained", units: number][] = [];
  const acquired = actual.source.checker.acquireResolvedStorage(actual.left, (cost, units) => {
    charges.push([cost, units]);
    return null;
  });
  if (acquired.kind !== "complete") assert.fail("The actual target needs its completed storage answer.");
  assert.equal(acquired.value.expression === actual.left, true);
  assert.equal(actual.source.ast.kindName(acquired.value.storageExpression), "KindIdentifier");
  assert.equal(acquired.value.writable, false);
  assert.equal(acquired.value.type.causes[0] === actual.diagnostic, true);
  assert.equal(actual.source.checker.getResolvedStorageInfo(actual.left) === acquired.value, true);
  const original = { resource: "storage" };
  const cachedRefusal = actual.source.checker.acquireResolvedStorage(actual.left, () => original);
  assert.equal(cachedRefusal.kind === "refused" && cachedRefusal.stop === original, true);
  assert.equal(actual.source.checker.getResolvedStorageInfo(actual.left) === acquired.value, true);
  for (const [cut, expected] of charges.entries()) {
    const trial = open();
    let reached = 0;
    const refused = trial.source.checker.acquireResolvedStorage(trial.left, (cost, units) => {
      if (reached++ !== cut) return null;
      assert.deepEqual([cost, units], expected, `cut ${cut}`);
      return original;
    });
    assert.equal(reached, cut + 1);
    assert.equal(refused.kind === "refused" && refused.stop === original, true);
  }
  assert.equal(open().source.checker.acquireResolvedStorage(actual.left,
    () => assert.fail("a foreign wrapper cannot reach storage admission")).kind, "unavailable");
});

test("selected signatures retain the actual passive mapping of a direct parameter return", () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/mapped-return", includeBundledLibraries: false,
    files: { "/mapped-return/core.d.ts": testCoreDeclarations,
      "/mapped-return/source.ts": `interface Template<Value> { at(): Value; }
        interface Holder<Left, Right> { left: Template<Left>; right: Template<Right>; }
        interface Holder<Left, Right> { }` }, compilerOptions: { ...testNoLibCompilerOptions, strict: true } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/mapped-return/source.ts");
  assert.ok(file);
  const { ast, checker } = checked.getSourceFileQueries(file);
  const actualMethod = findNodes(file, ast.children, node => ast.kindName(node) === "KindMethodSignature")[0];
  assert.ok(actualMethod);
  const annotation = Node_Type(actualMethod);
  const formals = findNodes(file, ast.children, node => ast.kindName(node) === "KindPropertySignature");
  assert.equal(formals.length, 2);
  const originals = checker.getTypeFromTypeNode(annotation);
  const returned = [];
  for (const formal of formals) {
    const type = checker.getTypeFromTypeNode(Node_Type(formal))?.type;
    const method = checker.getPropertyOfType(type, "at");
    const signatures = checker.getCallSignaturesOfType(checker.getTypeOfSymbol(method));
    assert.equal(signatures.length, 1);
    const signature = signatures[0];
    const result = checker.acquireSourceType({ kind: "signature-return", signature }, () => null);
    if (result.kind !== "complete") throw new Error("The selected method has its actual native return.");
    const { type: selected, projectedReturn } = result.value;
    assert.ok(projectedReturn);
    assert.equal(projectedReturn.kind, "parameter");
    assert.equal(projectedReturn.declaration === actualMethod && projectedReturn.annotation === annotation, true);
    assert.equal(projectedReturn.original === originals?.type && projectedReturn.selected === selected && selected !== originals?.type, true);
    assert.equal(result.value.typeSource, undefined, "the original annotation is not the selected parameter's source");
    assert.equal(checker.getSymbolDeclarations(checker.getTypeSymbol(selected)).length, 2);
    returned.push(selected);
  }
  assert.equal(returned[0] !== returned[1], true, "equal method syntax is not a single selected binder");
});

test("a tuple receiver result retains the actual passive mapping of its own written this", () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/self-result", includeBundledLibraries: false,
    files: { "/self-result/core.d.ts": testCoreDeclarations,
      "/self-result/source.ts": `
        interface Array<T> {
          move(target: number, start: number): this;
          unchanged(): [];
        }
        declare const empty: [];
        declare const populated: [number];
        const first = empty.move(0, 0);
        const second = populated.move(0, 0);
        const other = populated.unchanged();
      ` }, compilerOptions: { ...testNoLibCompilerOptions, strict: true } });
  const checked = session.checkSource();
  assert.equal(checked.diagnostics.length, 0);
  const file = checked.getSourceFile("/self-result/source.ts");
  assert.ok(file);
  const { ast, checker } = checked.getSourceFileQueries(file);
  const methods = findNodes(file, ast.children, node => ast.kindName(node) === "KindMethodSignature");
  const declaration = methods.find(node => ast.text(ast.name(node)) === "move");
  assert.ok(declaration);
  const calls = findNodes(file, ast.children, ast.is.IsCallExpression);
  assert.equal(calls.length, 3);
  for (let index = 0; index < calls.length; ++index) {
    const invocation = calls[index];
    const signature = checker.getResolvedSignature(invocation);
    const request = { kind: "signature-return", signature } as const;
    const trace: [string, number][] = [];
    const result = checker.acquireSourceType(request, (axis, count) => { trace.push([axis, count]); return null; });
    assert.equal(result.kind, "complete");
    if (result.kind !== "complete") throw new Error("A selected method requires its actual native result.");
    const projected = result.value.projectedReturn;
    if (index === 2) assert.equal(projected, undefined);
    else {
      assert.equal(projected?.kind, "receiver");
      assert.equal(projected?.declaration === declaration && projected.annotation === Node_Type(declaration), true);
      assert.equal(projected?.selected === result.value.type && projected.selected !== projected.original, true);
      assert.equal(checked.getSourceFileQueries(file).typeShape.getTupleInfo(result.value.type)?.elements.length, index);
      const stop = { cap: "selected receiver tuple" };
      for (let cut = 0; cut < trace.length; ++cut) {
        let reached = 0;
        const refused = checker.acquireSourceType(request, (axis, count): typeof stop | null => {
          assert.deepEqual([axis, count], trace[reached]);
          return reached++ === cut ? stop : null;
        });
        assert.equal(refused.kind === "refused" && refused.stop === stop, true);
        assert.equal(reached, cut + 1);
      }
    }
  }
});

test("paid source typing retains genuine primitive binary results in their owning checker and reuses them linearly", () => {
  const create = (terms: number) => {
    const source = "export function sum(value: number): number { return " + Array.from({ length: terms }, () => "value").join(" + ") + "; }";
    const session = createCompilerSessionFromFiles({ currentDirectory: "/binary-answers", includeBundledLibraries: false,
      files: { "/binary-answers/core.d.ts": testCoreDeclarations, "/binary-answers/main.ts": source },
      compilerOptions: { ...testNoLibCompilerOptions, strict: true } });
    const checked = session.checkSource();
    assert.equal(checked.diagnostics.length, 0);
    const file = checked.getSourceFile("/binary-answers/main.ts");
    assert.ok(file);
    const { ast, checker } = checked.getSourceFileQueries(file);
    const nodes = findNodes(file, ast.children, ast.is.IsBinaryExpression);
    assert.equal(nodes.length, terms - 1);
    return { checker, nodes, session };
  };
  for (const size of [8, 32, 128]) {
    const { checker, nodes } = create(size);
    let work = 0;
    let retained = 0;
    const acquire = (node: typeof nodes[number]) => checker.acquireSourceType({ kind: "expression", node }, (axis, units) => {
      if (axis === "work") work += units;
      else retained += units;
      return null;
    });
    const root = nodes[0];
    const first = acquire(root);
    assert.equal(first.kind, "complete");
    assert.equal(first.kind === "complete" && first.value.causes.length === 0, true);
    assert.equal(retained >= nodes.length - 1, true);
    const beforeChildren = work;
    const beforeRetained = retained;
    for (const child of nodes.slice(1)) {
      const answer = acquire(child);
      assert.equal(answer.kind === "complete" && first.kind === "complete" && answer.value.type === first.value.type, true);
    }
    assert.equal(work - beforeChildren, 3 * (nodes.length - 1));
    assert.equal(retained, beforeRetained);
    assert.equal(work < size * 12, true);
  }
  const stopped = create(8);
  const original = { limit: "binary expression native admission" };
  const early = stopped.checker.acquireSourceType({ kind: "expression", node: stopped.nodes[0] }, () => original);
  assert.equal(early.kind === "refused" && early.stop === original, true);
  const late = stopped.checker.acquireSourceType({ kind: "expression", node: stopped.nodes[0] }, axis => axis === "retained" ? original : null);
  assert.equal(late.kind === "refused" && late.stop === original, true);
  assert.equal(stopped.session.program?.compilerCheckerPool?.checkers.every(checker => checker?.wasCanceled === true), true);
  assert.deepEqual(stopped.checker.acquireSourceType({ kind: "expression", node: stopped.nodes[0] }, () => assert.fail("terminal checker reached a paid getter")),
    { kind: "unavailable" });
});

for (const checkers of [1, 4]) test(`completed type answers preserve their exact authored source with ${checkers} checkers`, () => {
  const files = {
    "/answers/core.d.ts": testCoreDeclarations,
    "/answers/seed.ts": "export type Exact = 9007199254740993; export type Nearby = 9007199254740992;",
    "/answers/barrel.ts": "export type { Exact as Forward, Nearby } from './seed.js';",
    "/answers/main.ts": "import type { Forward, Nearby } from './barrel.js'; export type First = Forward;"
      + " export type Second = Nearby; export type Wrap = ((First)); export type Local = (-0.1); export type Missing = Absent;",
  };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const diagnostics = session.getDiagnostics("all").flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  const seed = checked.getSourceFile("/answers/seed.ts");
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(seed && file);
  const { ast, checker } = checked.getSourceFileQueries(file);
  const authored = findNodes(seed, ast.children, ast.is.IsTypeAliasDeclaration).map(Node_Type);
  const occurrences = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration).map(Node_Type);
  const [first, second, wrap, local, missing] = occurrences.map(checker.getTypeFromTypeNode);
  assert.ok(first && second && wrap && local && missing);
  assert.equal(first.type === second.type, true, "the two actual authored sources collide in native type identity");
  assert.equal(authored[0] !== undefined && first.typeSource === authored[0] && wrap.typeSource === authored[0], true);
  assert.equal(authored[1] !== undefined && second.typeSource === authored[1] && authored[0] !== authored[1], true);
  assert.equal(local.typeSource === Node_Type(occurrences[3]) && ast.kindName(local.typeSource) === "KindLiteralType", true);
  assert.equal(checker.getTypeFromTypeNode(authored[0])?.typeSource === undefined, true, "a direct root needs no forwarded anchor");
  const original = diagnostics.find(diagnostic => diagnostic.file === file && Diagnostic_Pos(diagnostic) === SourceFile_Text(file).indexOf("Absent"));
  assert.equal(missing.typeSource === undefined && original !== undefined && missing.causes[0] === original, true);
  assert.equal(checker.getTypeFromTypeNode(occurrences[0])?.typeSource === first.typeSource, true, "warm reads retain the same source");
});

for (const checkers of [1, 4]) test(`closed indexed annotations retain only their actual required property sources with ${checkers} checkers`, () => {
  const files = {
    "/indexed/core.d.ts": testCoreDeclarations,
    "/indexed/padding.ts": "export type Padding = 1;",
    "/indexed/more.ts": "export type More = 2;",
    "/indexed/forward.ts": 'import type { Joined } from "./main.js"; export type Alias = Joined; export type Wrap = ((Alias));',
    "/indexed/main.ts": "export type Large = { left: 9007199254740993; right: 9007199254740992 }['left'];"
      + " export type Side = { left: 9007199254740993; right: 9007199254740992 }['right'];"
      + " export type Joined = { left: 9007199254740993; right: 9007199254740992 }['left' | 'right'];"
      + " export type Optional = { left?: 9007199254740993 }['left'];"
      + " export type Tuple = [-0.1][0]; export type Pattern = { [key: string]: -0.1 }['left'];"
      + " export type Fraction = -0.1; export type Indirect = { value: Fraction }['value'];"
      + " export type OtherJoined = { left: 9007199254740992; right: 9007199254740993 }['right' | 'left'];"
      + " export type Three = { first: 0; second: 1; third: 2 }['third' | 'first' | 'second'];"
      + " export type Partial = { left: 1; right?: 2 }['left' | 'right'];"
      + " export type Missing = { left: 1; right: 2 }['left' | 'missing'];"
      + " export type Open<Keys> = { left: 1; right: 2 }[Keys];",
  };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/indexed", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/indexed/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const annotations = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration).map(Node_Type);
  const [large, side, joined, optional, tuple, pattern, fraction, indirect, otherJoined, three, partial, missing, open] =
    annotations.map(checker.getTypeFromTypeNode);
  assert.ok(large && side && joined && optional && tuple && pattern && fraction && indirect && otherJoined && three && partial && missing && open);
  const property = (annotation: typeof annotations[number], ordinal: number) => {
    const object = ast.as.AsIndexedAccessTypeNode(annotation)?.ObjectType;
    assert.ok(object);
    const members = findNodes(object, ast.children, ast.is.IsPropertySignatureDeclaration);
    return Node_Type(members[ordinal]);
  };
  const left = property(annotations[0], 0);
  const right = property(annotations[1], 1);
  assert.equal(large.type === side.type && large.type === joined.type, true, "the native result alone cannot distinguish those sources");
  assert.equal(left !== undefined && large.typeSource === left, true);
  assert.equal(right !== undefined && side.typeSource === right, true);
  assert.equal(otherJoined.type === joined.type, true);
  for (const other of [joined, otherJoined, three, optional, tuple, pattern]) assert.equal(other.typeSource, undefined);
  for (const other of [large, side, optional, tuple, pattern, partial, missing, open]) assert.equal(other.indexedRead, undefined);
  for (const [answer, ordinal, names] of [
    [joined, 2, ["left", "right"]], [otherJoined, 8, ["left", "right"]], [three, 9, ["first", "second", "third"]],
  ] as const) {
    const annotation = annotations[ordinal];
    const keyNode = ast.as.AsIndexedAccessTypeNode(annotation)?.IndexType;
    assert.ok(keyNode);
    const keyType = checker.getTypeFromTypeNode(keyNode)?.type;
    assert.ok(keyType);
    const keys = typeShape.getUnionOrIntersectionTypes(keyType).map(typeShape.getStringLiteralTypeValue);
    const properties = keys.map(key => {
      const own = names.findIndex(name => name === key);
      assert.ok(own >= 0);
      return property(annotation, own);
    });
    assert.ok(answer.indexedRead);
    assert.equal(answer.indexedRead.annotation === annotation, true);
    assert.equal(answer.indexedRead.properties.length, names.length);
    assert.equal(answer.indexedRead.properties.every((source, index) => source === properties[index]), true);
    assert.equal(checker.getTypeFromTypeNode(annotation)?.indexedRead === answer.indexedRead, true);
  }
  assert.equal(joined.indexedRead !== otherJoined.indexedRead, true);
  const forward = checked.getSourceFile("/indexed/forward.ts");
  assert.ok(forward);
  const context = WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics);
  const [originOwner, releaseOrigin] = Program_GetTypeCheckerForFileExclusive(session.program, context, file);
  try {
    assert.ok(originOwner);
    assert.equal(LinkStore_TryGet(originOwner.typeNodeLinks, annotations[2])?.resolvedTypeSource === joined.indexedRead, true);
  } finally { releaseOrigin(); }
  const [foreignOwner, releaseForeign] = Program_GetTypeCheckerForFileExclusive(session.program, context, forward);
  try {
    assert.ok(foreignOwner);
    assert.equal(foreignOwner === originOwner, checkers === 1);
  } finally { releaseForeign(); }
  const foreignChecker = checked.getSourceFileQueries(forward).checker;
  for (const node of findNodes(forward, ast.children, ast.is.IsTypeAliasDeclaration)) {
    const answer = foreignChecker.getTypeFromTypeNode(Node_Type(node));
    assert.ok(answer);
    assert.equal(answer.indexedRead === joined.indexedRead && answer.causes.length === 0, true);
  }
  assert.equal(indirect.typeSource === annotations[6] && indirect.type === fraction.type, true);
});

for (const checkers of [1, 4]) test(`structural inventories carry only their actual required property sources with ${checkers} checkers`, () => {
  const files = {
    "/members/core.d.ts": testCoreDeclarations,
    "/members/padding.ts": "export type Padding = 1;",
    "/members/more.ts": "export type More = 2;",
    "/members/main.ts": "export type Exact = 9007199254740993; export type Nearby = 9007199254740992;"
      + " export type Required = { left: Exact; right: Nearby }; export type Optional = { left?: Exact };"
      + " interface Template<Item> { left: Item; } export type Applied = Template<Exact>;"
      + " export type Combined = { left: Exact; upper: true } | { left: Nearby; lower: false };"
      + " export type Accessor = { get left(): Exact };",
  };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/members", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/members/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const annotations = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration).map(Node_Type);
  const [exact, nearby, required, optional, applied, combined, accessor] = annotations.map(checker.getTypeFromTypeNode);
  assert.ok(exact && nearby && required && optional && applied && combined && accessor);
  assert.equal(exact.type === nearby.type && annotations[0] !== annotations[1], true);
  const [left, right] = propertyRows(typeShape, required.type);
  assert.ok(left && right && annotations[0] && annotations[1]);
  assert.deepEqual([left.name, right.name], ["left", "right"]);
  assert.equal(left.type === right.type && left.typeSource === annotations[0] && right.typeSource === annotations[1], true);
  assert.equal(typeShape.isUnion(combined.type) && typeShape.getTypeReferenceTarget(applied.type) !== undefined, true);
  for (const other of [optional, applied, combined, accessor]) {
    const member = propertyRows(typeShape, other.type).find(info => info.name === "left");
    assert.ok(member);
    assert.equal(member.typeSource === undefined, true);
  }
});

for (const checkers of [1, 4]) test(`original signatures retain their own completed annotations with ${checkers} checkers`, () => {
  const files = {
    "/signature/core.d.ts": testCoreDeclarations,
    "/signature/padding.ts": "export type Padding = 1;",
    "/signature/more.ts": "export type More = 2;",
    "/signature/main.ts": "export type Exact = 9007199254740993; export type Nearby = 9007199254740992;"
      + " export declare function original(required: Exact, optional?: Exact): Nearby;"
      + " declare function independent<Item>(value: Item): Item; export const selected = independent(1 as const);",
  };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/signature", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/signature/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const [exact, nearby] = findNodes(file, ast.children, ast.is.IsTypeAliasDeclaration).map(Node_Type);
  const [declaration] = findNodes(file, ast.children, ast.is.IsFunctionDeclaration);
  assert.ok(exact && nearby && declaration);
  const original = checker.getSignatureFromDeclaration(declaration);
  assert.ok(original);
  const returned = checker.getReturnTypeOfSignature(original);
  const shaped = typeShape.getReturnTypeOfSignature(original);
  const aggregate = typeShape.getDeclarationSignatureInfo(declaration);
  const [required, optional] = typeShape.getSignatureParameterInfos(original);
  assert.ok(returned && shaped && aggregate && required && optional);
  assert.equal(returned.typeSource === nearby && shaped.typeSource === nearby && aggregate.returnType?.typeSource === nearby, true);
  assert.equal(required.typeSource === exact && required.type === returned.type && optional.typeSource === undefined, true);
  assert.equal(checker.getReturnTypeOfSignature({ ...original })?.typeSource === undefined, true);
  const [call] = findNodes(file, ast.children, ast.is.IsCallExpression);
  const selected = checker.getResolvedSignature(call);
  assert.equal(selected?.target !== undefined, true);
  assert.equal(checker.getReturnTypeOfSignature(selected)?.typeSource === undefined, true);
  assert.equal(typeShape.getSignatureParameterInfos(selected)[0]?.typeSource === undefined, true);
});

for (const checkers of [1, 4]) test(`failed imported value uses borrow the published terminal binding with ${checkers} checkers`, () => {
  const files: Record<string, string> = {
    "/answers/core.d.ts": testCoreDeclarations,
    "/answers/provider.ts": "export const value: boolean = true;",
    "/answers/alias-0.ts": "export { missing as exported } from './provider.js';",
    "/answers/local.ts": "export { absent as local };",
    "/answers/left.ts": "export { value } from './right.js';",
    "/answers/right.ts": "export { value } from './left.js';",
    "/answers/filtered.ts": "// @ts-expect-error\nimport { missing } from './provider.js'; export function read():boolean{return missing;}",
  };
  const count = 24;
  for (let position = 1; position <= count; position += 1)
    files[`/answers/alias-${position}.ts`] = `export { exported } from './alias-${position - 1}.js';`;
  files["/answers/main.ts"] = "import { missing } from './provider.js'; import { value as gone } from './absent.js';"
    + `import { exported } from './alias-${count}.js'; import { local } from './local.js';`
    + "import { value as cycle } from './left.js'; import { value as healthy } from './provider.js';"
    + "export function direct():boolean{return ((missing));} export function missingModule():boolean{return gone;}"
    + "export function transitive():boolean{return exported;} export function fromLocal():boolean{return local;}"
    + "export function circular():boolean{return cycle;} export function good():boolean{return healthy;}";
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files), includeBundledLibraries: false,
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const program = session.program;
  assert.equal(program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  const filtered = checked.getSourceFile("/answers/filtered.ts");
  const terminal = checked.getSourceFile("/answers/alias-0.ts");
  const local = checked.getSourceFile("/answers/local.ts");
  assert.ok(file && filtered && terminal && local);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  const returned = findNodes(file, ast.children, ast.is.IsReturnStatement);
  const expected = [[file, 2305, "missing"], [file, 2307, "'./absent.js'"],
    [terminal, 2305, "missing"], [local, 2304, "absent"]] as const;
  assert.equal(returned.length, expected.length + 2);
  for (const [position, [owner, code, token]] of expected.entries()) {
    const node = Node_Expression(returned[position]);
    const answer = checker.getTypeAtLocation(node);
    const cause = answer?.causes[0];
    assert.equal(answer?.causes[0]?.code, code, `binding ${position}: ${ast.kindName(node)}`);
    assert.equal(typeShape.isError(answer?.type), true, `unchanged recovery type ${position}`);
    assert.equal(cause?.file === owner, true, `diagnostic owner ${position}`);
    assert.equal(Diagnostic_Pos(cause), SourceFile_Text(owner).indexOf(token), `exact failing token ${position}`);
    assert.equal(cause !== undefined && before.includes(cause), true, `original published member ${position}`);
    const repeated = checker.getTypeAtLocation(node);
    assert.equal(repeated !== undefined && repeated.type === answer?.type && repeated.causes[0] === cause, true);
  }
  const cycle = checker.getTypeAtLocation(Node_Expression(returned[expected.length]));
  const healthy = checker.getTypeAtLocation(Node_Expression(returned[expected.length + 1]));
  assert.equal(cycle !== undefined && typeShape.isError(cycle.type) && cycle.causes[0] === undefined, true);
  assert.equal(healthy !== undefined && !typeShape.isError(healthy.type) && healthy.causes[0] === undefined, true);
  const [filteredReturn] = findNodes(filtered, ast.children, ast.is.IsReturnStatement);
  const uncited = checker.getTypeAtLocation(Node_Expression(filteredReturn));
  assert.equal(uncited !== undefined && typeShape.isError(uncited.type) && uncited.causes[0] === undefined, true);
  const after = members();
  assert.equal(after.length === before.length && after.every((original, position) => original === before[position]), true);
});

for (const checkers of [1, 4]) test(`a missing property retains its exact original report with ${checkers} checkers`, () => {
  const text = "import * as ns from './provider.js'; export function fromNamespace():boolean{return ns.missing;}"
    + "export function absent(arg:{value:boolean}):boolean{arg.missing; return ((arg.absent));}"
    + "export function misspelled(arg:{value:boolean}):boolean{return arg.vaule;}"
    + "export function good(arg:{value:boolean}):boolean{return arg.value;}"
    + "export function filtered(arg:{value:boolean}):boolean{\n// @ts-expect-error\nreturn arg.missing;}";
  const files = { "/answers/core.d.ts": testCoreDeclarations, "/answers/main.ts": text,
    "/answers/provider.ts": "export const value: boolean = true;", "/answers/other.ts": "export const other=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const selected = findNodes(file, ast.children, ast.is.IsPropertyAccessExpression);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  const codes = [2339, 2339, 2339, 2551];
  assert.equal(selected.length, codes.length + 2);
  const actual: Diagnostic[] = [];
  for (const [position, code] of codes.entries()) {
    const node = selected[position];
    const answer = checker.getTypeAtLocation(node);
    assert.ok(answer?.causes[0] && node);
    assert.equal(typeShape.isError(answer.type), true);
    assert.equal(answer.causes[0].code, code);
    assert.equal(answer.causes[0].file === file && before.includes(answer.causes[0]), true);
    const property = ast.name(node);
    assert.ok(property);
    const range = ast.authoredRange(property);
    assert.equal(range.kind, "authored");
    if (range.kind !== "authored") throw new Error("A written property retains its original range.");
    assert.equal(Diagnostic_Pos(answer.causes[0]), range.start);
    assert.equal(Diagnostic_End(answer.causes[0]), range.end);
    assert.equal(propertyAccess(checker, node) === undefined, true);
    assert.equal(checker.getTypeAtLocation(node)?.causes[0] === answer.causes[0], true);
    actual.push(answer.causes[0]);
  }
  assert.equal(new Set(actual).size, codes.length, "the same missing text at two sites is not the same original");
  const [wrapped] = findNodes(file, ast.children, ast.is.IsParenthesizedExpression);
  assert.ok(wrapped);
  assert.equal(checker.getTypeAtLocation(wrapped)?.causes[0] === actual[2], true);
  const healthy = checker.getTypeAtLocation(selected[codes.length]);
  assert.ok(healthy);
  assert.equal(!typeShape.isError(healthy.type) && healthy.causes[0] === undefined, true);
  assert.equal(propertyAccess(checker, selected[codes.length])?.kind, "member");
  const filtered = checker.getTypeAtLocation(selected[codes.length + 1]);
  assert.ok(filtered);
  assert.equal(typeShape.isError(filtered.type) && filtered.causes[0] === undefined, true);
  const after = members();
  assert.equal(after.length === before.length && after.every((original, index) => original === before[index]), true);
});

for (const checkers of [1, 4]) test(`a failed property receiver retains one original through nested reads with ${checkers} checkers`, () => {
  const depth = 24;
  const files = { "/answers/core.d.ts": testCoreDeclarations,
    "/answers/main.ts": `export function chain(arg:{value:boolean}):boolean{return arg.missing${".next".repeat(depth)};}`
      + "export function wrapped(arg:{value:boolean}):boolean{return ((arg.absent!)).next;}"
      + "export function unresolved():boolean{return missingName.next;}"
      + "export function tolerated(arg:any):boolean{return arg.missing.next;}"
      + "export function filtered(arg:{value:boolean}):boolean{\n// @ts-expect-error\nreturn arg.missing.next;}",
    "/answers/other.ts": "export const other=true;", "/answers/third.ts": "export const third=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  const [chain, wrapped, unresolved, tolerated, filtered] = findNodes(file, ast.children, ast.is.IsFunctionDeclaration);
  assert.ok(chain && wrapped && unresolved && tolerated && filtered);
  const accesses = findNodes(chain, ast.children, ast.is.IsPropertyAccessExpression);
  assert.equal(accesses.length, depth + 1);
  const terminal = accesses.at(-1);
  const original = checker.getTypeAtLocation(terminal);
  assert.ok(original?.causes[0] && terminal);
  assert.equal(original.causes[0].code, 2339);
  assert.equal(original.causes[0].file === file && before.includes(original.causes[0]), true);
  const originalType = original.type;
  const owner = originalType.checker;
  assert.ok(owner);
  for (const node of accesses.slice(0, -1)) {
    assert.ok(node);
    const answer = checker.getTypeAtLocation(node);
    assert.equal(answer?.type === originalType && answer.causes[0] === original.causes[0], true);
    assert.equal(LinkStore_TryGet(owner.typeNodeLinks, node)?.resolvedTypeSource === terminal, true,
      "every dependent read points to the same native source without replaying the chain");
    assert.equal(propertyAccess(checker, node) === undefined, true);
  }
  const [outer, inner] = findNodes(wrapped, ast.children, ast.is.IsPropertyAccessExpression);
  const wrappedOriginal = checker.getTypeAtLocation(inner);
  const wrappedAnswer = checker.getTypeAtLocation(outer);
  assert.ok(wrappedOriginal?.causes[0]);
  assert.equal(wrappedAnswer?.causes[0] === wrappedOriginal.causes[0] && wrappedAnswer.type === wrappedOriginal.type, true);
  assert.equal(wrappedOriginal.causes[0] === original.causes[0], false);
  const read = (root: typeof unresolved) => checker.getTypeAtLocation(Node_Expression(findNodes(root, ast.children, ast.is.IsReturnStatement)[0]));
  const unresolvedRead = read(unresolved);
  assert.ok(unresolvedRead?.causes[0]);
  assert.equal(unresolvedRead.causes[0].code, 2304);
  assert.equal(before.includes(unresolvedRead.causes[0]), true);
  const successful = read(tolerated);
  assert.ok(successful);
  assert.equal(!typeShape.isError(successful.type) && successful.causes[0] === undefined, true);
  const suppressed = read(filtered);
  assert.ok(suppressed);
  assert.equal(typeShape.isError(suppressed.type) && suppressed.causes[0] === undefined, true);
  const after = members();
  assert.equal(after.length === before.length && after.every((member, index) => member === before[index]), true);
});

for (const checkers of [1, 4]) test(`an ordinary call on a failed callee keeps the original without entering overload selection with ${checkers} checkers`, () => {
  const files = { "/answers/core.d.ts": testCoreDeclarations,
    "/answers/main.ts": "function value(arg:boolean):boolean{return arg;}"
      + "export function missing(arg:{value:boolean}):boolean{return ((arg.missing)) (unknownArgument);}"
      + "export function unresolved():boolean{return unknownCallee(true);}"
      + "export function nullable(callee:(()=>boolean)|undefined):boolean{return callee();}"
      + "export function rejected():boolean{return value();}"
      + "export function good():boolean{return value(true);}"
      + "export function filtered():boolean{\n// @ts-expect-error\nreturn unknownCallee(true);}",
    "/answers/other.ts": "export const other=true;", "/answers/third.ts": "export const third=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  const [missing, unresolved, nullable, rejected, healthy, filtered] = findNodes(file, ast.children, ast.is.IsCallExpression);
  assert.ok(missing && unresolved && nullable && rejected && healthy && filtered);
  for (const [node, code] of [[missing, 2339], [unresolved, 2304]] as const) {
    const callee = Node_Expression(node);
    const input = checker.getTypeAtLocation(callee);
    const result = checker.getTypeAtLocation(node);
    assert.ok(result?.causes[0] && callee);
    assert.equal(result.causes[0].code, code);
    assert.equal(result.causes[0] === input?.causes[0] && result.type === input.type && typeShape.isError(result.type), true);
    assert.equal(result.causes[0].file === file && before.includes(result.causes[0]), true);
    const owner = result.type.checker;
    assert.ok(owner);
    assert.equal(LinkStore_TryGet(owner.typeNodeLinks, node)?.resolvedTypeSource === callee, true);
    assert.equal(checker.getResolvedCallInfo(node) === undefined, true);
    assert.equal(checker.getTypeAtLocation(node)?.causes[0] === result.causes[0], true);
  }
  const argument = checker.getTypeAtLocation(Node_Arguments(missing)?.[0]);
  assert.ok(argument?.causes[0]);
  assert.equal(argument.causes[0].code, 2304);
  assert.equal(before.includes(argument.causes[0]), true);
  assert.equal(argument.causes[0] === checker.getTypeAtLocation(missing)?.causes[0], false);
  const suppressed = checker.getTypeAtLocation(filtered);
  assert.ok(suppressed);
  assert.equal(typeShape.isError(suppressed.type) && suppressed.causes[0] === undefined, true);
  const after = members();
  assert.equal(after.length === before.length && after.every((member, index) => member === before[index]), true);
  assert.equal(checker.getTypeAtLocation(nullable)?.causes[0], undefined);
  assert.equal(checker.getTypeAtLocation(rejected)?.causes[0], undefined);
  assert.equal(checker.getResolvedCallInfo(rejected)?.kind, "conditional-candidates");
  assert.equal(checker.getResolvedCallInfo(healthy)?.kind, "applicable");
});

for (const checkers of [1, 4]) test(`a genuinely noncallable invocation retains its own actual report on ${checkers} checkers`, () => {
  const files = { "/answers/core.d.ts": testCoreDeclarations + "\ninterface Function { readonly length: number; }",
    "/answers/main.ts": "function pass(value:boolean):boolean{return value;}"
      + "export function invalid(value:boolean):boolean{return value(missingOperand);}"
      + "export function unchecked(value:any):boolean{return value(true);}"
      + "export function healthy():boolean{return pass(true);}"
      + "export function filtered(value:boolean):boolean{\n// @ts-expect-error\nreturn value(true);}",
    "/answers/other.ts": "export const other=true;", "/answers/third.ts": "export const third=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const [invalid, unchecked, healthy, filtered] = findNodes(file, ast.children, ast.is.IsCallExpression);
  assert.ok(invalid && unchecked && healthy && filtered);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  const answer = checker.getTypeAtLocation(invalid);
  assert.ok(answer);
  assert.equal(typeShape.isError(answer.type), true);
  assert.equal(answer.causes[0]?.code, 2349);
  assert.equal(answer.causes[0] !== undefined && before.includes(answer.causes[0]), true);
  const callee = checker.getTypeAtLocation(Node_Expression(invalid));
  assert.equal(callee !== undefined && !typeShape.isError(callee.type) && callee.causes[0] === undefined, true);
  const argument = checker.getTypeAtLocation(Node_Arguments(invalid)?.[0]);
  assert.equal(argument?.causes[0]?.code, 2304);
  assert.equal(argument?.causes[0] !== undefined && before.includes(argument.causes[0]), true);
  assert.equal(checker.getTypeAtLocation(invalid)?.causes[0] === answer.causes[0], true);
  assert.equal(checker.getResolvedCallInfo(invalid) === undefined, true);
  assert.equal(checker.getResolvedCallInfo(unchecked)?.kind, "untyped");
  assert.equal(checker.getTypeAtLocation(unchecked)?.causes[0], undefined);
  assert.equal(checker.getResolvedCallInfo(healthy)?.kind, "applicable");
  const suppressed = checker.getTypeAtLocation(filtered);
  assert.equal(suppressed !== undefined && typeShape.isError(suppressed.type) && suppressed.causes[0] === undefined, true);
  const after = members();
  assert.equal(after.length === before.length && after.every((original, index) => original === before[index]), true);
});

for (const checkers of [1, 4]) test(`binary recovery retains only its actual contributing operands on ${checkers} checkers`, () => {
  const files = { "/answers/core.d.ts": testCoreDeclarations,
    "/answers/main.ts": "export function addLeft():number{return missingAddLeft + 1;}"
      + "export function addRight():number{return 1 + missingAddRight;}"
      + "export function andLeft(arg:{value:boolean}):boolean{return arg.missing && true;}"
      + "export function andRight(flag:boolean):boolean{return flag && missingAndRight;}"
      + "export function assignment(value:boolean):boolean{return value = missingAssignment;}"
      + "export function sequence():boolean{return (missingFirst(), missingSecond);}"
      + "export function compound():number{const fixed:number=0; return fixed += 1;}"
      + "export function logical():boolean{const fixed:boolean=true; return fixed &&= true;}"
      + "export function healthy():boolean{const fixed:boolean=true; return fixed = false;}"
      + "export function both():boolean{return missingLeft && missingRight;}"
      + "export function filtered():boolean{\n// @ts-expect-error\nreturn missingFiltered && true;}",
    "/answers/other.ts": "export const other=true;", "/answers/third.ts": "export const third=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const published = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = published();
  const expressions = findNodes(file, ast.children, ast.is.IsBinaryExpression);
  const originals = [["left", 2304], ["right", 2304], ["left", 2339], ["right", 2304], ["right", 2304], ["right", 2304],
    ["left", 2588], ["left", 2588]] as const;
  assert.equal(expressions.length, originals.length + 3);
  for (const [index, [side, code]] of originals.entries()) {
    const node = expressions[index];
    const binary = AsBinaryExpression(node);
    assert.ok(binary);
    const operand = side === "left" ? binary.Left : binary.Right;
    const input = checker.getTypeAtLocation(operand);
    const answer = checker.getTypeAtLocation(node);
    assert.equal(answer?.causes.length, 1, `binary ${index} has only its actual contributing original`);
    assert.equal(answer?.causes[0]?.code, code, `binary ${index}`);
    assert.equal(answer !== undefined && typeShape.isError(answer.type) && answer.causes[0] === input?.causes[0], true);
    assert.equal(answer?.causes[0] !== undefined && before.includes(answer.causes[0]), true);
    assert.equal(checker.getTypeAtLocation(node)?.causes[0] === answer?.causes[0], true);
  }
  const healthy = checker.getTypeAtLocation(expressions[originals.length]);
  assert.equal(healthy !== undefined && !typeShape.isError(healthy.type) && healthy.causes.length === 0, true);
  const both = AsBinaryExpression(expressions[originals.length + 1]);
  const left = checker.getTypeAtLocation(both?.Left)?.causes[0];
  const right = checker.getTypeAtLocation(both?.Right)?.causes[0];
  const two = checker.getTypeAtLocation(expressions[originals.length + 1]);
  assert.equal(left !== undefined && right !== undefined && left !== right && before.includes(left) && before.includes(right), true);
  assert.equal(two !== undefined && typeShape.isError(two.type) && two.causes.length === 2
    && two.causes[0] === left && two.causes[1] === right, true);
  const filtered = checker.getTypeAtLocation(expressions[originals.length + 2]);
  assert.equal(filtered !== undefined && typeShape.isError(filtered.type) && filtered.causes.length === 0, true);
  const after = published();
  assert.equal(after.length === before.length && after.every((original, index) => original === before[index]), true);
});

for (const checkers of [1, 4]) test(`a binary source answer retains ordered, distinct originals across files with ${checkers} checkers`, () => {
  const text = "import { rejected } from './bridge.js';"
    + "export function leftFirst():boolean{return (rejected && leftMissing) && rejected;}"
    + "export function rightFirst():boolean{return rightMissing && (rejected && rejected);}"
    + "export function sum():number{return rejected + numberMissing;}"
    + "export function partial():boolean{return rejected && (\n// @ts-expect-error\nfiltered\n);}"
    + "export function comma():boolean{return (missingCallee(), rejected);}";
  const files = { "/answers/core.d.ts": testCoreDeclarations, "/answers/main.ts": text,
    "/answers/bridge.ts": "export { absent as rejected } from './provider.js';",
    "/answers/provider.ts": "export const actual:boolean=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  const bridge = checked.getSourceFile("/answers/bridge.ts");
  assert.ok(file && bridge);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  const foreign = before.find(row => row.file === bridge && row.code === 2305);
  const local = (token: string): Diagnostic | undefined =>
    before.find(row => row.file === file && row.code === 2304 && Diagnostic_Pos(row) === text.indexOf(token));
  assert.equal(foreign !== undefined && before.length === 5, true);
  const left = local("leftMissing");
  const right = local("rightMissing");
  const number = local("numberMissing");
  assert.equal(left !== undefined && right !== undefined && number !== undefined && local("missingCallee") !== undefined, true);
  const selections = [[foreign, left], [right, foreign], [foreign, number], [foreign], [foreign]];
  const returns = findNodes(file, ast.children, ast.is.IsReturnStatement);
  for (const [index, roots] of selections.entries()) {
    const expression = Node_Expression(returns[index]);
    const answer = checker.getTypeAtLocation(expression);
    assert.equal(answer !== undefined && typeShape.isError(answer.type) && answer.causes.length === roots.length
      && answer.causes.every((row, ordinal) => row === roots[ordinal]), true, `actual original identities at return ${index}`);
  }
  const after = members();
  assert.equal(after.length === before.length && after.every((row, index) => row === before[index]), true);
});

for (const [checkers, strictNullChecks] of [[1, true], [4, false]] as const)
test(`native selection joins retain only actual union inputs on ${checkers} checkers, strict null: ${strictNullChecks}`, () => {
  const cases = [
    ["flag || missingOrRight", ["missingOrRight"]],
    ["missingOrLeft || missingOrValue", ["missingOrLeft", "missingOrValue"]],
    ["maybe ?? missingCoalesceRight", ["missingCoalesceRight"]],
    ["missingCoalesceLeft ?? missingCoalesceValue", ["missingCoalesceLeft", "missingCoalesceValue"]],
    ["flag ? missingTrue : missingFalse", ["missingTrue", "missingFalse"]],
    ["missingTest ? missingBranch : false", ["missingBranch"]],
    ["independentTest ? true : false", []],
    ["missingAndLeft && missingAndRight", strictNullChecks ? ["missingAndLeft", "missingAndRight"] : ["missingAndRight"]],
  ] as const;
  const text = cases.map(([expression], index) =>
    `export function test${index}(flag:boolean,maybe:boolean|null):boolean{return ${expression};}`).join("\n");
  const files = { "/answers/core.d.ts": testCoreDeclarations, "/answers/main.ts": text,
    "/answers/other.ts": "export const other=true;", "/answers/third.ts": "export const third=true;" };
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
    includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, strictNullChecks, checkers } });
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/main.ts");
  assert.ok(file);
  const { ast, checker, typeShape } = checked.getSourceFileQueries(file);
  const members = () => session.getDiagnostics("all").flatMap(root => {
    assert.ok(root);
    return getDiagnosticRunMembers(root);
  });
  const before = members();
  assert.equal(before.length, 13);
  const returns = findNodes(file, ast.children, ast.is.IsReturnStatement);
  assert.equal(returns.length, cases.length);
  for (const [index, [expression, names]] of cases.entries()) {
    const value = checker.getTypeAtLocation(Node_Expression(returns[index]));
    assert.equal(value !== undefined && typeShape.isError(value.type) === (names.length > 0), true, expression);
    assert.equal(value?.causes.length, names.length, expression);
    for (const [ordinal, name] of names.entries()) {
      const original: Diagnostic | undefined = before.find(row => row.file === file && Diagnostic_Pos(row) === text.indexOf(name));
      assert.equal(original?.code, 2304, name);
      assert.equal(value?.causes[ordinal] === original, true, name);
    }
  }
  const after = members();
  assert.equal(after.length === before.length && after.every((row, index) => row === before[index]), true);
});

for (const checkers of [1, 4]) test(`only a completed binary check can retain a failed operand on ${checkers} checkers`, () => {
  for (const mode of [CheckModeTypeOnly, CheckModeContextual, CheckModeInferential, CheckModeNormal]) {
    const files = { "/answers/core.d.ts": testCoreDeclarations,
      "/answers/main.ts": "export function compound():number{const fixed:number=0; return fixed += 1;}",
      "/answers/other.ts": "export const other=true;", "/answers/third.ts": "export const third=true;" };
    const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", files, rootFiles: Object.keys(files),
      includeBundledLibraries: false, compilerOptions: { ...testNoLibCompilerOptions, strict: true, noCheck: true, checkers } });
    assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
    const checked = session.checkSource();
    const file = checked.getSourceFile("/answers/main.ts");
    assert.ok(file);
    const { ast } = checked.getSourceFileQueries(file);
    const [node] = findNodes(file, ast.children, ast.is.IsBinaryExpression);
    assert.ok(node);
    const [owner, release] = Program_GetTypeCheckerForFileExclusive(session.program,
      WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), file);
    try {
      assert.ok(owner);
      const saved = owner.serializationLevel;
      try {
        if (mode === CheckModeNormal) owner.serializationLevel = maxSerializationLevel;
        assert.equal(Checker_checkExpressionEx(owner, node, mode) === owner.errorType, true);
        assert.equal(LinkStore_TryGet(owner.typeNodeLinks, node)?.resolvedTypeSource, undefined);
      } finally { owner.serializationLevel = saved; }
      assert.equal(Checker_checkExpressionEx(owner, node, CheckModeNormal) === owner.errorType, true);
      const left = AsBinaryExpression(node)?.Left;
      assert.ok(left);
      assert.equal(LinkStore_TryGet(owner.typeNodeLinks, node)?.resolvedTypeSource === left, true);
      assert.equal(LinkStore_TryGet(owner.typeNodeLinks, left)?.resolutionFailure?.code, 2588);
    } finally { release(); }
  }
});

function fixture(checkers: number, wrapped = false) {
  const target = (name: string): string => wrapped ? `((${name}))` : name;
  const session = createCompilerSessionFromFiles({ currentDirectory: "/answers", includeBundledLibraries: false,
    files: { "/answers/core.d.ts": testCoreDeclarations,
      "/answers/use.ts": "import { value as imported } from './provider.js';"
        + `export function store():boolean{const fixed:boolean=true;${target("fixed")}=false;${target("fixed")}=true;return fixed;}`
        + `export function writable(value:boolean):boolean{${target("value")}=false;return value;}`
        + `export let own:boolean=true;export function setOwn(){${target("own")}=false;}`
        + `export function setImported(){${target("imported")}=false;}export const unrelated:Missing=1;`,
      "/answers/reader.ts": "export const reader=1;", "/answers/provider.ts": "export let value:boolean=true;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/answers/use.ts");
  const readerFile = checked.getSourceFile("/answers/reader.ts");
  const providerFile = checked.getSourceFile("/answers/provider.ts");
  const program = session.program;
  if (file === undefined || readerFile === undefined || providerFile === undefined || program === undefined)
    throw new Error("The real original source and reader belong to the same checked Program");
  assert.equal(program.compilerCheckerPool?.checkers.length, checkers);
  const source = checked.getSourceFileQueries(file);
  const reader = checked.getSourceFileQueries(readerFile);
  const binaries = findNodes(file, source.ast.children, source.ast.is.IsBinaryExpression);
  assert.equal(binaries.length, 5);
  const [providerDeclaration] = findNodes(providerFile, source.ast.children, source.ast.is.IsVariableDeclaration);
  if (providerDeclaration === undefined) throw new Error("The actual provider declares the imported variable");
  const members = () => session.getDiagnostics("all").flatMap(root => {
    if (root === undefined) throw new Error("The actual published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  assert.equal(createCompilerSessionFromProgram(program, session.host, session.config).program === program, true);
  return { session, source, reader, program, file, binaries, members, providerDeclaration };
}

for (const checkers of [1, 4]) for (const wrapped of [false, true])
test(`public node, storage and delegated contextual answers keep one original owner with ${checkers} checkers (wrapped: ${wrapped})`, () => {
  const current = fixture(checkers, wrapped);
  const published = current.members();
  const causes: Diagnostic[] = [];
  for (const queries of [current.source, current.reader]) for (const node of current.binaries) {
    const binary = AsBinaryExpression(node);
    if (binary?.Left === undefined || binary.Right === undefined) throw new Error("The actual assignment has both operands");
    const answer = queries.checker.getTypeAtLocation(binary.Left);
    const storage = queries.checker.getResolvedStorageInfo(binary.Left);
    const contextual = queries.checker.getContextualType(binary.Right);
    if (answer === undefined || storage === undefined || contextual === undefined)
      throw new Error("The same checked assignment supplies all three native answers");
    assert.equal("flags" in answer, false, "The naked Type API is replaced, not retained as an overload");
    const [owner, release] = Program_GetTypeCheckerForFileExclusive(current.program,
      WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), current.file);
    try { assert.equal(answer.type.checker === owner && contextual.type.checker === owner, true); }
    finally { release(); }
    assert.equal(storage.type.type === answer.type && storage.type.causes[0] === answer.causes[0], true,
      "Storage consumes the same actual type/cause pair, not an independent error resolver");
    const target = current.source.ast.text(storage.storageExpression);
    const leaf = queries.checker.getTypeAtLocation(storage.storageExpression);
    assert.equal(storage.expression === binary.Left && (storage.storageExpression !== binary.Left) === wrapped, true);
    assert.equal(leaf !== undefined && leaf.type === answer.type && leaf.causes[0] === answer.causes[0], true,
      "The actual transparent expression follows only its enclosed answer");
    if (target === "imported") assert.equal(storage.declaration === current.providerDeclaration, true,
      "An immutable import binding still identifies its actual mutable target declaration");
    if (target === "fixed" || target === "imported") {
      assert.equal(storage.writable, false);
      assert.equal(current.source.typeShape.isError(answer.type), true);
      if (answer.causes[0] === undefined) throw new Error("The native assignment failure retains its cause");
      assert.equal(published.includes(answer.causes[0]), true,
        "The cause is the original published native diagnostic object");
      assert.equal(contextual.type === answer.type && contextual.causes[0] === answer.causes[0], true,
        "Only the actual delegated contextual branch transports its input's original cause");
      causes.push(answer.causes[0]);
      const right = queries.checker.getTypeAtLocation(binary.Right);
      const whole = queries.checker.getTypeAtLocation(node);
      assert.equal(right !== undefined && !queries.typeShape.isError(right.type) && right.causes[0] === undefined, true);
      assert.equal(whole !== undefined && !queries.typeShape.isError(whole.type) && whole.causes[0] === undefined, true,
        "The ordinary RHS and Binary answer cannot borrow the failed LHS's cause");
    } else {
      assert.equal(answer.causes[0] === undefined && contextual.causes[0] === undefined && storage.writable, true);
    }
  }
  assert.equal(causes.length, 6);
  assert.equal(new Set(causes.slice(0, 3)).size, 3, "Distinct authored failures remain distinct");
  assert.equal(causes.slice(0, 3).every((cause, index) => cause === causes[index + 3]), true,
    "Each wrapper borrows the identical original");
  const after = current.members();
  assert.equal(after.length === published.length && after.every((value, index) => value === published[index]), true,
    "Repeated public reads do not add or replace native diagnostics");
  const foreign = fixture(checkers);
  const foreignNode = foreign.binaries[0];
  assert.equal(current.reader.checker.getTypeAtLocation(foreignNode) === undefined, true);
  assert.equal(current.reader.checker.getContextualType(foreignNode) === undefined, true);
  assert.equal(current.reader.checker.getResolvedStorageInfo(foreignNode) === undefined, true);
});

for (const checkers of [1, 4]) test(`unresolved value reads keep their own filtered name-resolution answer with ${checkers} checkers`, () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/name-answers", includeBundledLibraries: false,
    files: { "/name-answers/core.d.ts": testCoreDeclarations, "/name-answers/other.ts": "export const other = true;",
      "/name-answers/reader.ts": "export const reader = false;",
      "/name-answers/use.ts": "export function outside(gate: boolean): boolean { for (let expired = gate; gate; ) break; return expired; }\n"
        + "export function distinct(): boolean { return ((missing!))!; }\n"
        + "export function hidden(): boolean {\n// @ts-ignore\nreturn suppressed!; }\n"
        + "export function present(value: boolean): boolean { return value!; }" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/name-answers/use.ts");
  const other = checked.getSourceFile("/name-answers/reader.ts");
  const program = session.program;
  if (file === undefined || other === undefined || program === undefined) throw new Error("The actual source, reader and Program are present");
  assert.equal(program.compilerCheckerPool?.checkers.length, checkers);
  const members = () => session.getDiagnostics("all").flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  const published = members();
  const source = checked.getSourceFileQueries(file);
  const [binding, outside] = findNodes(file, source.ast.children,
    node => source.ast.is.IsIdentifier(node) && source.ast.text(node) === "expired");
  const [missing] = findNodes(file, source.ast.children, node => source.ast.is.IsIdentifier(node) && source.ast.text(node) === "missing");
  const [suppressed] = findNodes(file, source.ast.children, node => source.ast.is.IsIdentifier(node) && source.ast.text(node) === "suppressed");
  const assertions = findNodes(file, source.ast.children, source.ast.is.IsNonNullExpression);
  if (binding === undefined || outside === undefined || missing === undefined || suppressed === undefined)
    throw new Error("The authored binding and all three value uses are present");
  assert.equal(assertions.length, 4);
  for (const reader of [checked.getSourceFileQueries(other), source]) {
    const valid = reader.checker.getTypeAtLocation(binding);
    const answers: readonly (ResolvedSourceTypeInfo | undefined)[] = [outside, missing, suppressed]
      .map(node => reader.checker.getTypeAtLocation(node));
    const wrapped = assertions.map(assertion => ({
      name: findNodes(assertion, source.ast.children, source.ast.is.IsIdentifier)[0],
      answer: reader.checker.getTypeAtLocation(assertion),
    }));
    const [owner, release] = Program_GetTypeCheckerForFileExclusive(program,
      WithCheckerLifetime(Background(), CheckerLifetimeDiagnostics), file);
    try {
      if (owner === undefined) throw new Error("The native file checker owns the actual value read");
      assert.equal(valid !== undefined && valid.type !== owner.errorType && valid.causes[0] === undefined, true);
      const causes: readonly Diagnostic[] = [outside, missing, suppressed].map(node => {
        const links = LinkStore_TryGet(owner.symbolNodeLinks, node);
        if (links === undefined || links.resolvedSymbol !== owner.unknownSymbol || links.resolutionFailure === undefined)
          throw new Error("The same name-resolution occurrence owns its actual failure");
        return links.resolutionFailure;
      });
      assert.equal(new Set(causes).size, 3);
      assert.deepEqual(causes.map(cause => published.includes(cause)), [true, true, false]);
      for (const [index, answer] of answers.entries()) {
        assert.equal(answer?.type === owner.errorType, true, `read ${index}`);
        assert.equal(answer?.causes[0] === (index === 2 ? undefined : causes[index]), true, `published cause ${index}`);
      }
      for (const { name, answer } of wrapped) {
        if (name === undefined) throw new Error("The native assertion has its actual identifier operand");
        const text = source.ast.text(name);
        assert.equal(answer !== undefined, true, text);
        assert.equal(answer?.type === owner.errorType, name === missing || name === suppressed, text);
        assert.equal(answer?.causes[0] === (name === missing ? causes[1] : undefined), true, text);
      }
    } finally { release(); }
  }
  const after = members();
  assert.equal(after.length === published.length && after.every((value, index) => value === published[index]), true);
});

for (const checkers of [1, 4]) test(`type operators and tuples retain their own published grammar diagnostic with ${checkers} checkers`, () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/operators", includeBundledLibraries: false,
    files: { "/operators/core.d.ts": testCoreDeclarations, "/operators/other.ts": "export const other = true;",
      "/operators/reader.ts": "export const reader = true;",
      "/operators/use.ts": "export type Bad = unique symbol; "
        + "export interface Fields { readonly good: unique symbol; bad: unique symbol; } "
        + "export type BadReadonly = readonly number; export type Keys = keyof Fields;"
        + "export type BadRequired = [boolean?, string]; export type BadRest = [...number[], ...string[]];"
        + "export type BadOptional = [...number[], string?]; export type Good = [boolean, string?];"
        + "export type Unrelated = Missing;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/operators/use.ts");
  const readerFile = checked.getSourceFile("/operators/reader.ts");
  if (file === undefined || readerFile === undefined) throw new Error("The authored operators and reader are present");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const source = checked.getSourceFileQueries(file);
  const reader = checked.getSourceFileQueries(readerFile);
  const typeNodes = findNodes(file, source.ast.children, node => {
    const kind = source.ast.kindName(node);
    return kind === "KindTypeOperator" || kind === "KindTupleType";
  });
  const diagnostics = () => session.getDiagnostics("all").flatMap(root => {
    if (root === undefined) throw new Error("The published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  const published = diagnostics();
  const expected = [1335, undefined, 1330, 1354, undefined, 1257, 1265, 1266, undefined];
  assert.equal(typeNodes.length, expected.length);
  assert.deepEqual(published.map(root => root.code).sort((left, right) => left - right), [1257, 1265, 1266, 1330, 1335, 1354, 2304]);
  for (const queries of [source, reader]) for (const [ordinal, typeNode] of typeNodes.entries()) {
    const answer = queries.checker.getTypeFromTypeNode(typeNode);
    const shape = queries.typeShape.getTypeFromTypeNode(typeNode);
    if (answer === undefined || shape === undefined) throw new Error("An actual annotation retains its native answer");
    const code = expected[ordinal];
    assert.equal(answer.causes[0] === (code === undefined ? undefined : published.find(diagnostic => diagnostic.code === code)), true,
      `The queried node has its own original cause at ordinal ${ordinal}`);
    assert.equal(shape.type === answer.type && shape.causes[0] === answer.causes[0], true);
    assert.equal(source.typeShape.isError(answer.type), false, "The original native recovery type is not replaced");
  }
  const after = diagnostics();
  assert.equal(after.length === published.length && after.every((value, index) => value === published[index]), true,
    "Public reads do not repeat native grammar diagnostics");
});

for (const checkers of [1, 4]) test(`transparent annotation wrappers borrow only their actual original with ${checkers} checkers`, () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/wrappers", includeBundledLibraries: false,
    files: { "/wrappers/core.d.ts": testCoreDeclarations, "/wrappers/other.ts": "export const other = true;",
      "/wrappers/reader.ts": "export const reader = true;",
      "/wrappers/use.ts": "export type First = (([boolean?, string]));"
        + "export type Second = ([boolean?, string]); export type Readonly = readonly [boolean?, string];"
        + "export type Healthy = ((readonly [boolean, string])); export type OwnError = readonly ([boolean?, string]);"
        + "export type PrimitiveFirst = (readonly number); export type PrimitiveSecond = ((readonly number));" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/wrappers/use.ts");
  const reader = checked.getSourceFile("/wrappers/reader.ts");
  if (file === undefined || reader === undefined) throw new Error("The authored wrappers and reader are present");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const source = checked.getSourceFileQueries(file);
  const declarations = findNodes(file, source.ast.children, node => source.ast.kindName(node) === "KindTypeAliasDeclaration");
  assert.equal(declarations.length, 7);
  const diagnostics = () => session.getDiagnostics("all").flatMap(root => {
    if (root === undefined) throw new Error("The published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  const published = diagnostics();
  assert.deepEqual(published.map(root => root.code).sort((left, right) => left - right), [1257, 1257, 1257, 1257, 1354, 1354, 1354]);
  for (const queries of [source, checked.getSourceFileQueries(reader)]) {
    const originals: Diagnostic[] = [];
    const recoveredTypes = [];
    for (const [index, declaration] of declarations.entries()) {
      const root = Node_Type(declaration);
      if (root === undefined) throw new Error("The actual declaration has a type annotation");
      let inner = root;
      const ownerKind = index < 5 ? "KindTupleType" : "KindTypeOperator";
      while (source.ast.kindName(inner) !== ownerKind) {
        const child = Node_Type(inner);
        if (child === undefined) throw new Error("The transparent wrapper has its authored operand");
        inner = child;
      }
      const rootAnswer = queries.checker.getTypeFromTypeNode(root);
      const shapeAnswer = queries.typeShape.getTypeFromTypeNode(root);
      const innerAnswer = queries.checker.getTypeFromTypeNode(inner);
      if (rootAnswer === undefined || innerAnswer === undefined || shapeAnswer === undefined)
        throw new Error("The native checker has completed both wrapper and operand");
      assert.equal(rootAnswer.type === innerAnswer.type, true, "The wrapper borrows the actual native annotation type");
      assert.equal(shapeAnswer.type === rootAnswer.type && shapeAnswer.causes[0] === rootAnswer.causes[0], true);
      if (index === 3) assert.equal(rootAnswer.causes[0] === undefined && innerAnswer.causes[0] === undefined, true);
      else {
        const original = index === 4 ? published.find(root => root.code === 1354) : innerAnswer.causes[0];
        if (original === undefined) throw new Error("The actual native diagnostic was published");
        assert.equal(original.code, index < 3 ? 1257 : 1354);
        assert.equal(published.includes(original) && rootAnswer.causes[0] === original, true, `original pointer for wrapper ${index}`);
        if (index === 4) assert.equal(innerAnswer.causes[0]?.code, 1257, "The outer original wins over its own operand's error");
        originals.push(original);
        recoveredTypes.push(rootAnswer.type);
      }
    }
    assert.equal(recoveredTypes.at(-2) === recoveredTypes.at(-1), true, "Two separately invalid annotations recover to the same native number type");
    assert.equal(new Set(originals).size, 6, "Their originals must not be coalesced by recovered type");
  }
  const after = diagnostics();
  assert.equal(after.length === published.length && after.every((root, index) => root === published[index]), true);
});

for (const checkers of [1, 4]) for (const wrapped of [false, true])
test(`finalized source answers admit only original published run members with ${checkers} checkers (wrapped: ${wrapped})`, () => {
  const target = wrapped ? "((fixed))" : "fixed";
  const session = createCompilerSessionFromFiles({ currentDirectory: "/publication", includeBundledLibraries: false,
    files: { "/publication/core.d.ts": testCoreDeclarations, "/publication/other.ts": "export const other = true;",
      "/publication/reader.ts": "export const reader = true;",
      "/publication/use.ts": "// @ts-expect-error\nexport type Suppressed = readonly [boolean?, string];\n"
        + "export type Reported = readonly [boolean?, string];\n"
        + `export function store() { const fixed: boolean = true;\n// @ts-expect-error\n${target} = false;\n${target} = true; }` },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  session.ensureChecked();
  const program = session.program;
  const open = program === undefined ? undefined : getExtensionHost(program)?.getCompilerQueryContext();
  const file = open?.getSourceFile("/publication/use.ts");
  if (program === undefined || open === undefined || file === undefined) throw new Error("The actual source is checked before publication");
  assert.equal(program.compilerCheckerPool?.checkers.length, checkers);
  const source = open.getSourceFileQueries(file);
  const declarations = findNodes(file, source.ast.children, node => source.ast.kindName(node) === "KindTypeAliasDeclaration");
  const binaries = findNodes(file, source.ast.children, source.ast.is.IsBinaryExpression);
  assert.equal(declarations.length, 2);
  assert.equal(binaries.length, 2);
  const types = declarations.map(declaration => Node_Type(declaration));
  const left = binaries.map(node => AsBinaryExpression(node)?.Left);
  const right = binaries.map(node => AsBinaryExpression(node)?.Right);
  const annotationBefore = types.map(node => source.checker.getTypeFromTypeNode(node));
  const storageBefore = left.map(node => source.checker.getResolvedStorageInfo(node));
  assert.deepEqual(annotationBefore.map(answer => answer?.causes[0]?.code), [1257, 1257]);
  assert.deepEqual(storageBefore.map(answer => answer?.type.causes[0]?.code), [2588, 2588]);
  assert.equal(annotationBefore[0]?.causes[0] !== annotationBefore[1]?.causes[0], true);
  assert.equal(storageBefore[0]?.type.causes[0] !== storageBefore[1]?.type.causes[0], true);

  const checked = session.checkSource();
  assert.equal(checked.program === program && checked.getSourceFileQueries(file) === source, true,
    "Publication updates evidence for the same already-issued source facade");
  const published = checked.diagnostics.flatMap(root => {
    if (root === undefined) throw new Error("The published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  assert.deepEqual(published.map(diagnostic => diagnostic.code), [1257, 2588]);
  assert.equal(published[0] === annotationBefore[1]?.causes[0] && published[1] === storageBefore[1]?.type.causes[0], true);
  assert.equal(published.some(diagnostic => diagnostic === annotationBefore[0]?.causes[0] || diagnostic === storageBefore[0]?.type.causes[0]), false);
  const reader = checked.getSourceFile("/publication/reader.ts");
  if (reader === undefined) throw new Error("The other source-file view is present");
  for (const queries of [source, checked.getSourceFileQueries(reader)]) for (const index of [0, 1]) {
    const cause = index === 0 ? undefined : published[0];
    const annotation = queries.checker.getTypeFromTypeNode(types[index]);
    const shape = queries.typeShape.getTypeFromTypeNode(types[index]);
    assert.equal(annotation !== undefined && annotation.type === annotationBefore[index]?.type && annotation.causes[0] === cause, true,
      `annotation original at ${index}`);
    assert.equal(shape !== undefined && shape.type === annotation?.type && shape.causes[0] === cause, true);
    const lhs = queries.checker.getTypeAtLocation(left[index]);
    const contextual = queries.checker.getContextualType(right[index]);
    const storage = queries.checker.getResolvedStorageInfo(left[index]);
    const storageCause = index === 0 ? undefined : published[1];
    assert.equal(lhs !== undefined && lhs.type === storageBefore[index]?.type.type && lhs.causes[0] === storageCause, true);
    assert.equal(contextual !== undefined && contextual.type === lhs?.type && contextual.causes[0] === storageCause, true);
    assert.equal(storage !== undefined && storage.type.type === lhs?.type && storage.type.causes[0] === storageCause, true);
    assert.equal(storage === queries.checker.getResolvedStorageInfo(left[index]), true, "The finalized storage answer remains memoized");
  }
  const reopened = createCompilerSessionFromProgram(program, session.host, session.config).checkSource();
  assert.equal(reopened.program === program && reopened.getSourceFileQueries(file) === source, true);
  assert.equal(reopened.getSourceFileQueries(file).checker.getTypeFromTypeNode(types[1])?.causes[0] === published[0], true);
});

test("a filtered readonly report does not hide its actual published operand diagnostic", () => {
  const session = createCompilerSessionFromFiles({ currentDirectory: "/nested", includeBundledLibraries: false,
    files: { "/nested/core.d.ts": testCoreDeclarations, "/nested/use.ts":
      "// @ts-expect-error\nexport type Nested = readonly (\n  [boolean?, string]);" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/nested/use.ts");
  if (file === undefined) throw new Error("The actual source is present");
  const source = checked.getSourceFileQueries(file);
  const [outer] = findNodes(file, source.ast.children, node => source.ast.kindName(node) === "KindTypeOperator");
  const tuple = Node_Type(Node_Type(outer));
  assert.equal(source.ast.kindName(tuple), "KindTupleType");
  const operand = source.checker.getTypeFromTypeNode(tuple);
  const result = source.checker.getTypeFromTypeNode(outer);
  const shape = source.typeShape.getTypeFromTypeNode(outer);
  assert.deepEqual(checked.diagnostics.map(root => root?.code), [1257]);
  assert.equal(operand?.causes[0] !== undefined && result?.causes[0] === operand.causes[0] && shape?.causes[0] === operand.causes[0], true);
  assert.equal(operand?.type !== undefined && result?.type === operand.type && shape?.type === operand.type, true);
});

for (const checkers of [1, 4]) test(`bare alias chains retain the exact defining diagnostic with ${checkers} checkers`, () => {
  const length = 48;
  const chain = Array.from({ length }, (_, index) => {
    const target = index + 1 === length ? "Imported" : `Link${index + 1}`;
    return `export type Link${index} = ${index % 2 === 0 ? target : `((${target}))`};`;
  }).join("\n");
  const session = createCompilerSessionFromFiles({ currentDirectory: "/borrowed-alias", includeBundledLibraries: false,
    files: { "/borrowed-alias/core.d.ts": testCoreDeclarations, "/borrowed-alias/other.ts": "export const other = true;",
      "/borrowed-alias/origin.ts": "export type Terminal = readonly [boolean?, string];\n"
        + "// @ts-expect-error\nexport type Hidden = readonly [boolean?, string];",
      "/borrowed-alias/use.ts": "import type {Terminal as Imported, Hidden as Muted} from './origin.js';\n"
        + chain + "\nexport type Empty = Imported<>; export type WrongArity = Imported<boolean>;"
        + "export type Quiet = Muted; export type Healthy = boolean; export type Good = Healthy;"
        + "export type CycleA = CycleB; export type CycleB = CycleA;" },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const use = checked.getSourceFile("/borrowed-alias/use.ts");
  const origin = checked.getSourceFile("/borrowed-alias/origin.ts");
  if (use === undefined || origin === undefined) throw new Error("The alias use and actual defining file are present");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const originalReader = checked.getSourceFileQueries(origin);
  const useReader = checked.getSourceFileQueries(use);
  const [definition, hidden] = originalReader.ast.statements(origin);
  const anchor = Node_Type(definition);
  const original = originalReader.checker.getTypeFromTypeNode(anchor);
  if (anchor === undefined || original?.causes[0] === undefined) throw new Error("The actual defining tuple has an original");
  assert.equal(original.causes[0].code, 1257);
  assert.equal(originalReader.checker.getTypeFromTypeNode(Node_Type(hidden))?.causes[0], undefined);
  const published = checked.diagnostics.flatMap(root => {
    if (root === undefined) throw new Error("The published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  assert.equal(published.includes(original.causes[0]) && original.causes[0].file === origin, true);
  const declarations = useReader.ast.statements(use).filter(useReader.ast.is.IsTypeAliasDeclaration);
  assert.equal(declarations.length, length + 7);
  const request = { kind: "annotation" as const, node: Node_Type(declarations[0]) };
  const stop = { reason: "source acquisition limit" };
  const admitted: { cost: "work" | "retained"; units: number }[] = [];
  const settled = useReader.checker.acquireSourceType(request, (cost, units) => {
    admitted.push({ cost, units });
    return null;
  });
  if (settled.kind !== "complete") throw new Error("The paid read must complete its genuine source traversal.");
  assert.equal(settled.value.causes.length, 1);
  assert.equal(settled.value.causes[0] === original.causes[0], true);
  assert.equal(admitted.some(row => row.cost === "retained"), true);
  assert.equal(admitted.filter(row => row.cost === "work").length > 2, true);
  for (let cut = 0; cut < admitted.length; cut += 1) {
    let reached = 0;
    const result = useReader.checker.acquireSourceType(request, (cost, units) => {
      assert.deepEqual({ cost, units }, admitted[reached]);
      return reached++ === cut ? stop : null;
    });
    assert.equal(result.kind === "refused" && result.stop === stop, true, String(cut));
    assert.equal(reached, cut + 1);
  }
  let useOwner;
  for (const declaration of declarations.slice(0, length)) {
    const rhs = Node_Type(declaration);
    const answer = useReader.checker.getTypeFromTypeNode(rhs);
    const shape = originalReader.typeShape.getTypeFromTypeNode(rhs);
    const atLocation = useReader.checker.getTypeAtLocation(rhs);
    if (answer === undefined || rhs === undefined) throw new Error("The actual alias use has a selected type");
    assert.equal(answer.causes[0] === original.causes[0] && shape?.causes[0] === original.causes[0] && atLocation?.causes[0] === original.causes[0], true);
    assert.equal(answer.type === shape?.type && answer.type === atLocation?.type && !("borrowedFrom" in answer), true);
    const owner = answer.type.checker;
    if (owner === undefined) throw new Error("The selected alias type retains its native owner");
    useOwner = owner;
    let reference = rhs;
    while (useReader.ast.kindName(reference) === "KindParenthesizedType") {
      const child = Node_Type(reference);
      if (child === undefined) throw new Error("An authored wrapper has its type child");
      reference = child;
    }
    const link = LinkStore_TryGet(owner.typeNodeLinks, reference);
    assert.equal(link?.resolvedType === answer.type && link.resolvedTypeSource === anchor, true,
      "Every native link names the terminal report-capable RHS, not a prefix to replay");
  }
  assert.equal(useOwner === original.type.checker, checkers === 1);
  const [empty, arity, quiet, healthy, good, cycleA, cycleB] = declarations.slice(length);
  assert.equal(published.some(diagnostic => diagnostic.code === 1099), true);
  for (const declaration of [empty, cycleA, cycleB]) {
    const rhs = Node_Type(declaration);
    const answer = useReader.checker.getTypeFromTypeNode(rhs);
    if (rhs === undefined || answer?.type.checker === undefined) throw new Error("The actual recovery answer retains its owner");
    assert.equal(LinkStore_TryGet(answer.type.checker.typeNodeLinks, rhs)?.resolvedTypeSource, undefined);
    assert.equal(answer.causes[0] === original.causes[0], false);
  }
  assert.equal(useReader.checker.getTypeFromTypeNode(Node_Type(arity))?.causes[0]?.code, 2315);
  assert.equal(useReader.checker.getTypeFromTypeNode(Node_Type(quiet))?.causes[0], undefined);
  assert.equal(useReader.checker.getTypeFromTypeNode(Node_Type(good))?.type ===
    useReader.checker.getTypeFromTypeNode(Node_Type(healthy))?.type, true);
  const foreign = createCompilerSessionFromFiles({ currentDirectory: "/foreign", files: { "/foreign/use.ts": "type Other = boolean;" },
    compilerOptions: testNoLibCompilerOptions }).checkSource();
  const foreignFile = foreign.getSourceFile("/foreign/use.ts");
  if (foreignFile === undefined) throw new Error("A different actual Program is present");
  assert.equal(foreign.getSourceFileQueries(foreignFile).checker.getTypeFromTypeNode(Node_Type(declarations[0])), undefined);
});

for (const checkers of [1, 4]) test(`type argument grammar keeps its actual published ranges with ${checkers} checkers`, () => {
  const text = "export type Base = boolean; export type Id<T> = T;\n"
    + "export type Empty = ((Base</* λ */>));\nexport type Trailing = Id<boolean,>;\n"
    + "export type Both = Missing<>;\n// @ts-expect-error\nexport type Suppressed = Base<>;\n"
    + "export type Bare = Base; export type Applied = Id<boolean>;\n"
    + "// @ts-expect-error\nexport type GrammarOnly = Missing<\n  boolean,>;\n"
    + "export type NameOnly = Missing<\n  boolean\n  // @ts-expect-error\n  ,>;";
  const session = createCompilerSessionFromFiles({ currentDirectory: "/type-arguments", includeBundledLibraries: false,
    files: { "/type-arguments/core.d.ts": testCoreDeclarations, "/type-arguments/other.ts": "export const other = true;",
      "/type-arguments/reader.ts": "export const reader = true;", "/type-arguments/use.ts": text },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/type-arguments/use.ts");
  const readerFile = checked.getSourceFile("/type-arguments/reader.ts");
  if (file === undefined || readerFile === undefined) throw new Error("Both checked files are present");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const source = checked.getSourceFileQueries(file);
  const types = source.ast.statements(file).map(declaration => Node_Type(declaration));
  const published = checked.diagnostics.flatMap(root => {
    if (root === undefined) throw new Error("The published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  const bytes = Buffer.from(text);
  assert.deepEqual(published.map(diagnostic => [diagnostic.code,
    bytes.subarray(Diagnostic_Pos(diagnostic), Diagnostic_End(diagnostic)).toString()]),
  [[1099, "</* λ */>"], [1009, ","], [2304, "Missing"], [1099, "<>"], [1009, ","], [2304, "Missing"]]);
  assert.equal(types.length, 10);
  for (const queries of [source, checked.getSourceFileQueries(readerFile)]) {
    const expected = [undefined, undefined, published[0], published[1], published[2], undefined, undefined, undefined,
      published[4], published[5]];
    for (const [index, type] of types.entries()) {
      const answer = queries.checker.getTypeFromTypeNode(type);
      const shape = queries.typeShape.getTypeFromTypeNode(type);
      const atLocation = queries.checker.getTypeAtLocation(type);
      assert.equal(answer !== undefined && answer.causes[0] === expected[index] && shape?.causes[0] === expected[index]
        && atLocation?.causes[0] === expected[index] && shape?.type === answer.type && atLocation?.type === answer.type,
      true, `exact authored original at ordinal ${index}`);
    }
    const healthy = queries.checker.getTypeFromTypeNode(types[0]);
    for (const index of [2, 3, 5, 6, 7])
      assert.equal(queries.checker.getTypeFromTypeNode(types[index])?.type === healthy?.type, true,
        "Only evidence changes, not the native recovery type");
  }
  const after = session.getDiagnostics("all").flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  assert.equal(after.length === published.length && after.every((root, index) => root === published[index]), true);
});

for (const checkers of [1, 4]) test(`circular aliases retain their own completed original with ${checkers} checkers`, () => {
  const local = "import type {Remote as Imported} from './origin.js';\n"
    + "export type One = Two; export type Two = (One); export type LocalUse = One; export type ForeignUse = Imported;\n"
    + "// @ts-expect-error\nexport type Muted = (Muted);\nexport type MutedUse = Muted;\n"
    + "export type Independent = Missing; export type Operator = keyof Operator;\n"
    + "// @ts-expect-error\nexport type MutedWithGrammar = MutedWithGrammar<\n  boolean,>;\n"
    + "export type Forward = Deferred; export type Deferred = (Deferred);\n"
    + "export interface Grounded { next: Grounded | null; }";
  const remote = "export type Remote = (Remote);";
  const session = createCompilerSessionFromFiles({ currentDirectory: "/circular-alias", includeBundledLibraries: false,
    files: { "/circular-alias/core.d.ts": testCoreDeclarations, "/circular-alias/extra.ts": "export const extra = true;",
      "/circular-alias/use.ts": local, "/circular-alias/origin.ts": remote },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const use = checked.getSourceFile("/circular-alias/use.ts");
  const origin = checked.getSourceFile("/circular-alias/origin.ts");
  if (use === undefined || origin === undefined) throw new Error("Both files are present");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const useReader = checked.getSourceFileQueries(use);
  const originReader = checked.getSourceFileQueries(origin);
  const diagnostics = checked.diagnostics.flatMap(root => {
    if (root === undefined) throw new Error("The published diagnostic inventory is dense");
    return getDiagnosticRunMembers(root);
  });
  const ranges = diagnostics.map(diagnostic => [diagnostic.code, Buffer.from(diagnostic.file === origin ? remote : local)
    .subarray(Diagnostic_Pos(diagnostic), Diagnostic_End(diagnostic)).toString()]);
  assert.deepEqual(ranges, [[2456, "Remote"], [2456, "One"], [2456, "Two"], [2304, "Missing"], [2456, "Operator"], [1009, ","],
    [2456, "Deferred"]]);
  const declarations = useReader.ast.statements(use).filter(useReader.ast.is.IsTypeAliasDeclaration);
  const types = declarations.map(declaration => Node_Type(declaration));
  const remoteRhs = Node_Type(originReader.ast.statements(origin)[0]);
  const expected = [diagnostics[1], diagnostics[2], diagnostics[1], diagnostics[0], undefined, undefined,
    diagnostics[3], diagnostics[4], diagnostics[5], diagnostics[6], diagnostics[6]];
  assert.equal(types.length, expected.length);
  for (const reader of [useReader, originReader]) {
    for (const [index, rhs] of types.entries()) {
      const answer = reader.checker.getTypeFromTypeNode(rhs);
      const shape = reader.typeShape.getTypeFromTypeNode(rhs);
      const location = reader.checker.getTypeAtLocation(rhs);
      assert.equal(answer !== undefined && answer.causes[0] === expected[index]
        && shape?.type === answer.type && shape.causes[0] === expected[index]
        && location?.type === answer.type && location.causes[0] === expected[index], true, `actual owner at ordinal ${index}`);
      if (index < 6) assert.equal(answer?.type === answer?.type.checker?.errorType, true);
      if (index === 0 || index === 1) {
        assert.equal(rhs !== undefined && answer?.type.checker !== undefined, true);
        if (rhs !== undefined && answer?.type.checker !== undefined)
          assert.equal(LinkStore_TryGet(answer.type.checker.typeNodeLinks, rhs)?.resolvedTypeSource, undefined,
            "A failed declaration is a terminal, not a successful borrowed RHS");
      }
    }
    const original = reader.checker.getTypeFromTypeNode(remoteRhs);
    const foreign = reader.checker.getTypeFromTypeNode(types[3]);
    assert.equal(original?.causes[0] === diagnostics[0] && foreign?.causes[0] === original?.causes[0], true);
    assert.equal(foreign?.type.checker === original?.type.checker, checkers === 1);
    const inner = reader.checker.getTypeFromTypeNode(Node_Type(types[10]));
    assert.equal(inner !== undefined && inner.causes[0] === diagnostics[6] && reader.typeShape.isError(inner.type), true,
      "A reference encountered before the declaration completed retains that declaration's original");
    const grounded = useReader.ast.statements(use).find(useReader.ast.is.IsInterfaceDeclaration);
    const groundedMember = useReader.ast.children(grounded).find(node => useReader.ast.kindName(node) === "KindPropertySignature");
    const valid = reader.checker.getTypeFromTypeNode(Node_Type(groundedMember));
    assert.equal(valid !== undefined && valid.causes[0] === undefined && !reader.typeShape.isError(valid.type), true);
  }
  const after = session.getDiagnostics("all").flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  assert.equal(after.length === diagnostics.length && after.every((root, index) => root === diagnostics[index]), true);
});

for (const checkers of [1, 4]) test(`failed indexed types retain reports even when the result recovers with ${checkers} checkers`, () => {
  const text = "export type Tuple = [boolean]; export type Negative = Tuple[-1]; export type Outside = Tuple[2];"
    + "export type Ready = Tuple[0]; export type Dict = { [key:string]: boolean }; declare const key: unique symbol;"
    + "export type WrongIndex = Dict[typeof key]; export type ReadyIndex = Dict[string];";
  const session = createCompilerSessionFromFiles({ currentDirectory: "/indexed-recovery", includeBundledLibraries: false,
    files: { "/indexed-recovery/core.d.ts": testCoreDeclarations, "/indexed-recovery/extra.ts": "export const extra = true;",
      "/indexed-recovery/other.ts": "export type Other = boolean;", "/indexed-recovery/index.ts": text },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const file = checked.getSourceFile("/indexed-recovery/index.ts");
  if (file === undefined) throw new Error("The actual indexed type file exists");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const reader = checked.getSourceFileQueries(file);
  const diagnostics = checked.diagnostics.flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code), [2514, 2493, 2538]);
  assert.equal(diagnostics.every(diagnostic => diagnostic.file === file), true);
  const source = reader.ast.statements(file).filter(reader.ast.is.IsTypeAliasDeclaration);
  const slots = [[1, diagnostics[0], "undefined"], [2, diagnostics[1], "undefined"], [3, undefined, "boolean"],
    [5, diagnostics[2], "boolean"], [6, undefined, "boolean"]] as const;
  for (const [index, expected, description] of slots) {
    const rhs = Node_Type(source[index]);
    const answer = reader.checker.getTypeFromTypeNode(rhs);
    const at = reader.checker.getTypeAtLocation(rhs);
    assert.equal(answer !== undefined && answer.causes[0] === expected && at?.type === answer.type && at.causes[0] === expected,
      true, `actual recovered answer at ordinal ${index}`);
    assert.equal(reader.typeShape.typeToString(answer?.type), description);
  }
});

for (const checkers of [1, 4]) test(`a single failed indexed type retains its exact checker report with ${checkers} checkers`, () => {
  const originText = "\uFEFF// 😀\r\ninterface Model { ready: string; }\r\n"
    + 'export type Missing = Model["absent"];\r\n'
    + "export type NoIndex = Model[number];\r\n"
    + "export type Invalid = Model[boolean];\r\n"
    + '// @ts-expect-error\r\nexport type Quiet = Model["absent"];\r\n'
    + 'export type Ready = Model["ready"];\r\n'
    + 'export type Several = Model["other" | "unknown"];\r\n';
  const useText = "import type {Missing as Selected, Quiet} from './origin.js';\n"
    + "export type Forward = ((Selected)); export type Hidden = Quiet;";
  const session = createCompilerSessionFromFiles({ currentDirectory: "/indexed-original", includeBundledLibraries: false,
    files: { "/indexed-original/core.d.ts": testCoreDeclarations, "/indexed-original/extra.ts": "export const extra = true;",
      "/indexed-original/use.ts": useText, "/indexed-original/origin.ts": originText },
    compilerOptions: { ...testNoLibCompilerOptions, strict: true, checkers } });
  const checked = session.checkSource();
  const origin = checked.getSourceFile("/indexed-original/origin.ts");
  const use = checked.getSourceFile("/indexed-original/use.ts");
  if (origin === undefined || use === undefined) throw new Error("Both source owners exist");
  assert.equal(session.program?.compilerCheckerPool?.checkers.length, checkers);
  const originReader = checked.getSourceFileQueries(origin);
  const useReader = checked.getSourceFileQueries(use);
  const diagnostics = checked.diagnostics.flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  const sourceBytes = Buffer.from(SourceFile_Text(origin));
  assert.deepEqual(diagnostics.map(diagnostic => [diagnostic.code, sourceBytes
    .subarray(Diagnostic_Pos(diagnostic), Diagnostic_End(diagnostic)).toString()]),
  [[2339, '"absent"'], [2537, "number"], [2538, "boolean"], [2339, '"other" | "unknown"'], [2339, '"other" | "unknown"']]);
  assert.equal(diagnostics.every(diagnostic => diagnostic.file === origin), true);
  const origins = originReader.ast.statements(origin).filter(originReader.ast.is.IsTypeAliasDeclaration);
  const uses = useReader.ast.statements(use).filter(useReader.ast.is.IsTypeAliasDeclaration);
  for (const [index, node] of [...origins, ...uses].entries()) {
    const rhs = Node_Type(node);
    const reader = index < origins.length ? originReader : useReader;
    const answer = reader.checker.getTypeFromTypeNode(rhs);
    const shape = reader.typeShape.getTypeFromTypeNode(rhs);
    const at = reader.checker.getTypeAtLocation(rhs);
    const expected = index < 3 ? diagnostics[index] : index === origins.length ? diagnostics[0] : undefined;
    assert.equal(answer !== undefined && answer.causes[0] === expected
      && shape?.type === answer.type && shape.causes[0] === expected && at?.type === answer.type && at.causes[0] === expected,
    true, `exact original at ordinal ${index}`);
    if (answer === undefined) throw new Error("The indexed type answer exists");
    assert.equal(reader.typeShape.isError(answer.type), index !== 4);
  }
  const after = session.getDiagnostics("all").flatMap(root => root === undefined ? [] : getDiagnosticRunMembers(root));
  assert.equal(after.length === diagnostics.length && after.every((root, index) => root === diagnostics[index]), true);
});
