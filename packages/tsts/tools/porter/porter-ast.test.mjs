import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  repoRoot,
  resolveRepo,
} from "./porter.mjs";
import {
  buildAstGeneratedArtifactStatus,
  buildAstGeneratedFiles,
  buildGeneratedAstSkips,
  emitKinds,
  parseGoFlagFile,
  writeAstGenerated,
} from "./ast-generator.mjs";
import { AstSchema } from "./ast-schema-model.mjs";
import { baseConfig } from "./porter-test-fixtures.mjs";

test("ast-generator: Go flag const evaluation respects Go precedence and complement", () => {
  const source = [
    "package ast",
    "",
    "type SampleFlags uint32",
    "",
    "const (",
    "\tSampleFlagsNone      SampleFlags = 0",
    "\tSampleFlagsA         SampleFlags = 1 << 0",
    "\tSampleFlagsB         SampleFlags = 1 << 1",
    "\tSampleFlagsC         SampleFlags = 1 << 2",
    "\tSampleFlagsAll       SampleFlags = 1<<30 - 1 // trailing comment",
    "\tSampleFlagsAB                    = SampleFlagsA | SampleFlagsB",
    "\tSampleFlagsExcludesA             = SampleFlagsAll & ^SampleFlagsA",
    ")",
  ].join("\n");
  const consts = parseGoFlagFile(source, "SampleFlags").filter((entry) => entry.kind === "const");
  const byName = Object.fromEntries(consts.map((entry) => [entry.name, entry.value]));
  assert.equal(byName.SampleFlagsNone, 0);
  assert.equal(byName.SampleFlagsA, 1);
  assert.equal(byName.SampleFlagsC, 4);
  // Go binds `<<` tighter than `-`, so this is (1<<30)-1, NOT 1<<(30-1).
  assert.equal(byName.SampleFlagsAll, (1 << 30) - 1);
  assert.equal(byName.SampleFlagsAB, 3);
  // `& ^X` is bitwise-AND with the complement of X (uint32).
  assert.equal(byName.SampleFlagsExcludesA, (((1 << 30) - 1) & ~1) >>> 0);
});

test("ast-generator: kinds emit sequential values, markers, and a stringer", () => {
  const schema = {
    ast: {
      kinds: {
        elements: ["Unknown", "EndOfFile", { comment: "A group header" }, "Identifier"],
        markers: [{ name: "FirstNode", value: "Unknown" }],
      },
    },
  };
  const out = emitKinds(schema);
  assert.match(out, /export type Kind = short;/);
  assert.match(out, /export const KindUnknown: Kind = 0;/);
  assert.match(out, /export const KindEndOfFile: Kind = 1;/);
  assert.match(out, /\n\/\/ A group header\n/);
  // The comment-only element does not consume an enum index.
  assert.match(out, /export const KindIdentifier: Kind = 2;/);
  // Markers are aliases of an existing kind, not new values.
  assert.match(out, /export const KindFirstNode: Kind = KindUnknown;/);
  assert.match(out, /export function KindString\(kind: Kind\): string \{/);
});

function astFixtureConfig(root) {
  const rel = (target) => path.relative(repoRoot, target).split(path.sep).join("/");
  const schemaDir = path.join(root, "schema");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    path.join(schemaDir, "ast.json"),
    JSON.stringify({ kinds: { elements: ["Unknown", "EndOfFile"], markers: [] }, bases: {}, nodes: { definitions: {}, aliases: {} } }),
  );
  writeFileSync(path.join(schemaDir, "nodeflags.go"), "package ast\n\ntype NodeFlags uint32\n\nconst (\n\tNodeFlagsNone NodeFlags = 0\n)\n");
  writeFileSync(path.join(schemaDir, "symbolflags.go"), "package ast\n\ntype SymbolFlags uint32\n\nconst (\n\tSymbolFlagsNone SymbolFlags = 0\n)\n");
  writeFileSync(path.join(schemaDir, "protocol.ts"), "export const PROTOCOL_VERSION = 5;\n");
  return {
    tsRoot: rel(path.join(root, "src")),
    astSchemaDir: rel(schemaDir),
    astGeneratedDir: "internal/ast/generated",
    astProtocolInput: rel(path.join(schemaDir, "protocol.ts")),
    astSchemaInputs: [
      rel(path.join(schemaDir, "ast.json")),
      rel(path.join(schemaDir, "nodeflags.go")),
      rel(path.join(schemaDir, "symbolflags.go")),
    ],
  };
}

const cleanAstStatus = { missing: [], stale: [], orphan: [], untracked: [], invalid: [] };

test("porter:ast --check detects missing/stale/orphan/untracked/invalid generated files", () => {
  const root = mkdtempSync(path.join(repoRoot, ".temp/porter-test-"));
  try {
    const config = astFixtureConfig(root);
    const genDir = path.join(root, "src/internal/ast/generated");

    writeAstGenerated(config, "rev-fixture-1");
    assert.deepEqual(buildAstGeneratedArtifactStatus(config, "rev-fixture-1"), cleanAstStatus);

    // Missing.
    unlinkSync(path.join(genDir, "kinds.ts"));
    assert.equal(buildAstGeneratedArtifactStatus(config, "rev-fixture-1").missing.length, 1);
    writeAstGenerated(config, "rev-fixture-1", { force: true });

    // Stale.
    const kindsPath = path.join(genDir, "kinds.ts");
    writeFileSync(kindsPath, `${readFileSync(kindsPath, "utf8")}\nexport const sneaky = 1;\n`);
    assert.equal(buildAstGeneratedArtifactStatus(config, "rev-fixture-1").stale.length, 1);
    writeAstGenerated(config, "rev-fixture-1", { force: true });

    // Orphan: well-formed generated file no longer in the expected set.
    const expected = buildAstGeneratedFiles(config, "rev-fixture-1");
    writeFileSync(path.join(genDir, "orphan.ts"), expected.get("internal/ast/generated/kinds.ts"));
    assert.equal(buildAstGeneratedArtifactStatus(config, "rev-fixture-1").orphan.length, 1);
    unlinkSync(path.join(genDir, "orphan.ts"));

    // Untracked: file in the generated dir without @tsgo-generated metadata.
    writeFileSync(path.join(genDir, "loose.ts"), "export const loose = 1;\n");
    assert.equal(buildAstGeneratedArtifactStatus(config, "rev-fixture-1").untracked.length, 1);
    unlinkSync(path.join(genDir, "loose.ts"));

    // Invalid: @tsgo-generated metadata with the wrong kind/generator.
    writeFileSync(
      path.join(genDir, "wrongkind.ts"),
      '// Code generated\n// @tsgo-generated {"schemaVersion":1,"kind":"go-facade","generator":"porter:facades","path":"x","sourceRevision":"r","contentHash":"h"}\n\nexport {}\n',
    );
    assert.equal(buildAstGeneratedArtifactStatus(config, "rev-fixture-1").invalid.length, 1);
    unlinkSync(path.join(genDir, "wrongkind.ts"));

    assert.deepEqual(buildAstGeneratedArtifactStatus(config, "rev-fixture-1"), cleanAstStatus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeAstGenerated honors the safe-write contract and --force", () => {
  const root = mkdtempSync(path.join(repoRoot, ".temp/porter-test-"));
  try {
    const config = astFixtureConfig(root);
    const kindsPath = path.join(root, "src/internal/ast/generated/kinds.ts");
    writeAstGenerated(config, "rev-fixture-2");
    writeFileSync(kindsPath, `${readFileSync(kindsPath, "utf8")}\n// edited\n`);
    assert.throws(() => writeAstGenerated(config, "rev-fixture-2"), /refusing to overwrite/);
    writeAstGenerated(config, "rev-fixture-2", { force: true });
    assert.deepEqual(buildAstGeneratedArtifactStatus(config, "rev-fixture-2"), cleanAstStatus);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ast-generator: a schema input content change makes committed output stale", () => {
  const root = mkdtempSync(path.join(repoRoot, ".temp/porter-test-"));
  try {
    const config = astFixtureConfig(root);
    writeAstGenerated(config, "rev-fixture-3");
    assert.equal(buildAstGeneratedArtifactStatus(config, "rev-fixture-3").stale.length, 0);
    // Changing a declared schema input changes the schemaInputs digest in the header.
    writeFileSync(
      path.join(root, "schema/nodeflags.go"),
      "package ast\n\ntype NodeFlags uint32\n\nconst (\n\tNodeFlagsNone NodeFlags = 0\n\tNodeFlagsLet  NodeFlags = 1 << 0\n)\n",
    );
    assert.ok(buildAstGeneratedArtifactStatus(config, "rev-fixture-3").stale.length >= 1);
    assert.ok(existsSync(path.join(root, "src/internal/ast/generated/kinds.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ast-generator: protocol input drift makes only the protocol artifact stale", () => {
  const root = mkdtempSync(path.join(repoRoot, ".temp/porter-test-"));
  try {
    const config = astFixtureConfig(root);
    writeAstGenerated(config, "rev-protocol-1");
    writeFileSync(path.join(root, "schema/protocol.ts"), "export const PROTOCOL_VERSION = 6;\n");
    assert.deepEqual(
      buildAstGeneratedArtifactStatus(config, "rev-protocol-1").stale.map(({ path: stalePath }) => stalePath),
      ["internal/ast/generated/protocol.ts"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// AST node/data/factory/etc emitter tests (free-fn/adapter model).
// ───────────────────────────────────────────────────────────────────────────

test("ast-schema-model: alias derivation matches ast_generated.go (231 node + 72 union + 23 list)", () => {
  const ast = JSON.parse(readFileSync(resolveRepo("packages/tsts/schema/tsgo/ast.json"), "utf8"));
  const schema = new AstSchema(ast);
  const nodeAliasCount = schema.nodeNames().length
    + schema.nodeNames().reduce((acc, n) => acc + schema.instantiationAliasesOf(n).length, 0);
  assert.equal(nodeAliasCount, 231);
  assert.equal(Object.keys(schema.aliases).length, 72);
  assert.equal(Object.keys(schema.listAliases).length, 23);
});

test("ast-generator: Identifier_as_nodeData resolves FlowNodeData via promotion, not NodeDefault", () => {
  const files = buildAstGeneratedFiles(baseConfig, "rev-ast-1");
  const data = files.get("internal/ast/generated/data.ts");
  assert.ok(data.includes("export interface Identifier extends PrimaryExpressionBase, FlowNodeBase {"));
  // Promotion: Identifier embeds FlowNodeBase, so FlowNodeData -> FlowNodeBase_FlowNodeData.
  assert.match(data, /const Identifier_nodeDataPrototype: nodeData & ThisType<GoPtr<Identifier>> = \{[\s\S]*?FlowNodeData\(\) \{ return FlowNodeBase_FlowNodeData\(this\); \},/);
  // No override -> NodeDefault for DeclarationData (Identifier has no DeclarationBase).
  assert.match(data, /const Identifier_nodeDataPrototype: nodeData & ThisType<GoPtr<Identifier>> = \{[\s\S]*?DeclarationData\(\) \{ return NodeDefault_DeclarationData\(this\); \},/);
  // Leaf nodes still use NodeDefault for VisitEachChild.
  assert.match(data, /const Identifier_nodeDataPrototype: nodeData & ThisType<GoPtr<Identifier>> = \{[\s\S]*?VisitEachChild\(v: GoPtr<NodeVisitor>\): GoPtr<Node> \{ return NodeDefault_VisitEachChild\(this, v\); \},/);
  // Child-bearing nodes get generated VisitEachChild rewrites.
  assert.match(data, /export function ExpressionStatement_VisitEachChild\(receiver: GoPtr<ExpressionStatement>, v: GoPtr<NodeVisitor>\): GoPtr<Node> \{\s*return Factory\.NodeFactory_UpdateExpressionStatement\(generatedVisitorFactory\(v\), receiver, generatedVisitNode\(v, receiver!\.Expression\) as GoPtr<Expression>\);\s*\}/);
  assert.match(data, /const ExpressionStatement_nodeDataPrototype: nodeData & ThisType<GoPtr<ExpressionStatement>> = \{[\s\S]*?VisitEachChild\(v: GoPtr<NodeVisitor>\): GoPtr<Node> \{ return ExpressionStatement_VisitEachChild\(this, v\); \},/);
  // The brand carries the concrete receiver.
  assert.match(data, /get \[goReceiverKey\]\(\): GoPtr<Identifier> \{ return this; \},/);
  assert.match(data, /export function Identifier_as_nodeData\(receiver: GoPtr<Identifier>\): nodeData \{\s*return globalThis\.Object\.setPrototypeOf\(receiver!, Identifier_nodeDataPrototype\) as nodeData;\s*\}/);
  assert.match(data, /export function createIdentifierData\(\): Identifier & nodeData \{\s*return globalThis\.Object\.create\(Identifier_nodeDataPrototype\) as Identifier & nodeData;\s*\}/);
});

test("ast-generator: named concrete nodes expose their generated Name override", () => {
  const files = buildAstGeneratedFiles(baseConfig, "rev-ast-name");
  const data = files.get("internal/ast/generated/data.ts");
  assert.match(data, /export function ParameterDeclaration_Name\(receiver: GoPtr<ParameterDeclaration>\): GoPtr<Node> \{\s*return receiver!\.name;\s*\}/);
  assert.match(data, /const ParameterDeclaration_nodeDataPrototype: nodeData & ThisType<GoPtr<ParameterDeclaration>> = \{[\s\S]*?Name\(\) \{ return ParameterDeclaration_Name\(this\); \},/);
});

test("ast-generator: NewIdentifier and AsIdentifier emit the faithful factory/cast", () => {
  const files = buildAstGeneratedFiles(baseConfig, "rev-ast-2");
  const factory = files.get("internal/ast/generated/factory.ts");
  assert.match(factory, /export interface NodeFactory \{[\s\S]*?AsNodeFactory\(\): GoPtr<NodeFactory>;/);
  assert.match(
    factory,
    /export function NewIdentifier\(receiver: GoPtr<NodeFactory>, text: string\): GoPtr<Node> \{[\s\S]*?const data = createIdentifierData\(\);[\s\S]*?return NodeFactory_newNode\(receiver, KindIdentifier, data\);/,
  );
  const casts = files.get("internal/ast/generated/casts.ts");
  assert.match(casts, /export function AsIdentifier\(n: GoPtr<Node>\): GoPtr<Identifier> \{\s*return n!\.data\[goReceiverKey\] as GoPtr<Identifier>;/);
});

test("ast-generator: target encoder is generated from every pinned concrete kind", () => {
  const files = buildAstGeneratedFiles(baseConfig, "rev-target-encoder");
  const encoder = files.get("internal/ast/generated/encoder.ts");
  const schema = new AstSchema(
    JSON.parse(readFileSync(resolveRepo("packages/tsts/schema/tsgo/ast.json"), "utf8")),
  );
  const dispatch = encoder.slice(
    encoder.indexOf("export function targetAstNodeEncoding"),
    encoder.indexOf("\nfunction encode", encoder.indexOf("export function targetAstNodeEncoding")),
  );
  const cases = dispatch.match(/^    case Kind/gmu) ?? [];
  const concreteKinds = new Set(
    schema.nodeNames().flatMap((owner) => schema.kindTypesOf(owner).kindNames),
  );
  assert.equal(cases.length, concreteKinds.size);
  assert.match(encoder, /readonly list\?: GoPtr<NodeList>;/);
});

test("ast-schema-model: raw string lists are not children; node raw lists are GoPtr<Node>", () => {
  const ast = JSON.parse(readFileSync(resolveRepo("packages/tsts/schema/tsgo/ast.json"), "utf8"));
  const schema = new AstSchema(ast);
  // JSDocText.text is []string (raw) inherited from JSDocCommentBase -> not a child.
  const textField = schema.baseFields("JSDocCommentBase").find((f) => f.name === "text");
  assert.equal(textField.isChild(), false);
  assert.equal(textField.tsReference(), "GoSlice<string>");
});

test("ast-generator: multi-kind and type-parameter Is functions follow ast_generated.go", () => {
  const files = buildAstGeneratedFiles(baseConfig, "rev-ast-3");
  const predicates = files.get("internal/ast/generated/predicates.ts");
  // ForInOrOfStatement is multi-kind -> per-kind Is functions, no IsForInOrOfStatement.
  assert.ok(predicates.includes("export function IsForInStatement("));
  assert.ok(predicates.includes("export function IsForOfStatement("));
  assert.ok(!predicates.includes("export function IsForInOrOfStatement("));
  // Token is a type-parameter node -> a single IsToken switching over TokenSyntaxKind.
  assert.match(predicates, /export function IsToken\(node: GoPtr<Node>\): bool \{\s*switch \(node!\.Kind\)/);
});

test("ast-generator: generatedAstSkips records handWritten without visitEachChild deferral", () => {
  const skips = buildGeneratedAstSkips(baseConfig);
  assert.deepEqual(skips.handWritten, ["SourceFile"]);
  assert.deepEqual(skips.handWrittenVisitor, ["JSDocParameterOrPropertyTag"]);
  assert.deepEqual(skips.visitEachChildDeferred, []);
});
