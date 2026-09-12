import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(toolDir, "..", "..");
const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const workspaceTempRoot = join(packageRoot, "..", "..", ".temp");

const failures = [];

function fail(message) {
  failures.push(message);
}

function collectExportTargets(value, path = "exports") {
  if (typeof value === "string") {
    return [{ path, target: value }];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => {
    const childPath = key.startsWith(".") ? `${path}[${JSON.stringify(key)}]` : `${path}.${key}`;
    return collectExportTargets(nested, childPath);
  });
}

function packagePath(target) {
  return join(packageRoot, target.replace(/^\.\//, ""));
}

const publicTargets = [
  { path: "main", target: packageJson.main },
  { path: "types", target: packageJson.types },
  ...collectExportTargets(packageJson.exports),
  ...Object.entries(packageJson.bin ?? {}).map(([name, target]) => ({ path: `bin.${name}`, target })),
].filter((entry) => typeof entry.target === "string");

for (const entry of publicTargets) {
  if (entry.target.startsWith("./src/") || entry.target.startsWith("src/")) {
    fail(`${entry.path} points at source instead of dist: ${entry.target}`);
  }
  if (entry.target.startsWith("./") && !existsSync(packagePath(entry.target))) {
    fail(`${entry.path} target does not exist: ${entry.target}`);
  }
}

if (!existsSync(join(packageRoot, "dist", "src", "index.js"))) {
  fail("missing built JS entry: dist/src/index.js");
}
if (!existsSync(join(packageRoot, "dist", "src", "index.d.ts"))) {
  fail("missing built type entry: dist/src/index.d.ts");
}
if (!existsSync(join(packageRoot, "dist", "src", "cli", "index.js"))) {
  fail("missing built CLI entry: dist/src/cli/index.js");
}

const bundledIndexPath = join(packageRoot, "dist", "src", "internal", "bundled", "libs_generated.js");
const bundledLibraryRoot = join(packageRoot, "dist", "src", "internal", "bundled", "libs");
let bundledLibraryNames = [];
if (!existsSync(bundledIndexPath)) {
  fail("missing built bundled-library index: dist/src/internal/bundled/libs_generated.js");
} else {
  const generated = await import(pathToFileURL(bundledIndexPath).href);
  bundledLibraryNames = [...generated.LibNames];
}
if (!existsSync(bundledLibraryRoot)) {
  fail("missing built bundled-library directory: dist/src/internal/bundled/libs");
} else {
  const physicalNames = readdirSync(bundledLibraryRoot)
    .filter((name) => name.endsWith(".d.ts"))
    .sort((left, right) => left.localeCompare(right));
  if (physicalNames.length !== bundledLibraryNames.length
    || physicalNames.some((name, index) => name !== bundledLibraryNames[index])) {
    fail("built bundled-library resources do not exactly match the generated LibNames index");
  }
}

const npmCommand = process.env.npm_execpath ? process.execPath : "npm";
mkdirSync(workspaceTempRoot, { recursive: true });
const isolatedRoot = mkdtempSync(join(workspaceTempRoot, "package-check-"));
const npmArgs = process.env.npm_execpath
  ? [process.env.npm_execpath, "pack", "--json", "--ignore-scripts", "--pack-destination", isolatedRoot]
  : ["pack", "--json", "--ignore-scripts", "--pack-destination", isolatedRoot];
const pack = spawnSync(npmCommand, npmArgs, {
  cwd: packageRoot,
  encoding: "utf8",
});

if (pack.status !== 0 || pack.signal !== null) {
  fail(`npm pack --dry-run failed${pack.signal === null ? "" : ` with ${pack.signal}`}:\n${pack.stderr || pack.stdout}`);
} else {
  const output = JSON.parse(pack.stdout);
  const files = output[0]?.files?.map((file) => file.path) ?? [];
  for (const file of files) {
    if (file.startsWith("src/") || file === "tsonic.package.json" || file === "tsonic.json") {
      fail(`package includes source-only artifact: ${file}`);
    }
  }
  for (const requiredFile of [
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/cli/index.js",
    "dist/src/internal/bundled/libs_generated.js",
    ...bundledLibraryNames.map((name) => `dist/src/internal/bundled/libs/${name}`),
    "package.json",
  ]) {
    if (!files.includes(requiredFile)) {
      fail(`packed artifact is missing required file: ${requiredFile}`);
    }
  }

  if (failures.length === 0) {
    const tarballName = output[0]?.filename;
    if (typeof tarballName !== "string" || !existsSync(join(isolatedRoot, tarballName))) {
      fail("npm pack did not produce the reported tarball");
    } else {
      verifyInstalledPackage(isolatedRoot, join(isolatedRoot, tarballName));
    }
  }
}

if (failures.length > 0) {
  console.error("Built package contract check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Built package contract OK for ${relative(process.cwd(), packageRoot) || "."}`);

function verifyInstalledPackage(root, tarballPath) {
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const installArgs = process.env.npm_execpath
    ? [process.env.npm_execpath, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarballPath]
    : ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarballPath];
  const install = spawnSync(npmCommand, installArgs, { cwd: root, encoding: "utf8" });
  if (install.status !== 0 || install.signal !== null) {
    fail(`isolated packed-package install failed${install.signal === null ? "" : ` with ${install.signal}`}:\n${install.stderr || install.stdout}`);
    return;
  }

  const proofPath = join(root, "default-library-proof.mjs");
  writeFileSync(proofPath, `
import { createCompilerSessionFromFiles, formatDiagnostics } from "@tsonic/tsts";
import assert from "node:assert/strict";
import {
  AsSourceFile,
  defaultTargetAstEncodingLimits,
  encodeTargetSourceFileForPrinting,
  TargetAstEncodingError,
} from "@tsonic/tsts/target-ast";

const session = createCompilerSessionFromFiles({
  currentDirectory: "/project",
  files: {
    "/project/index.ts": "export const values = [1, 2, 3]; export const first: number = values[0]!; export const count: number = values.length;",
  },
  rootFiles: ["/project/index.ts"],
  compilerOptions: {
    module: "esnext",
    moduleResolution: "bundler",
    target: "es2025",
    strict: true,
  },
});
const checked = session.checkSource();
const diagnostics = checked.diagnostics.filter((diagnostic) => diagnostic !== undefined);
if (diagnostics.length !== 0) {
  throw new Error(formatDiagnostics(diagnostics, "/project"));
}
if (!checked.sourceFiles.some((sourceFile) => checked.ast.getFileName(sourceFile) === "bundled:///libs/lib.es5.d.ts")) {
  throw new Error("The isolated packed compiler did not load its bundled default library.");
}
console.log("isolated packed default-library proof passed");
const sourceNode = checked.sourceFiles.find((sourceFile) => checked.ast.getFileName(sourceFile) === "/project/index.ts");
const sourceFile = AsSourceFile(sourceNode);
assert.ok(sourceFile);
const encoded = encodeTargetSourceFileForPrinting(sourceFile);
const limits = { ...defaultTargetAstEncodingLimits, maximumEncodedBytes: encoded.length };
assert.deepEqual(encodeTargetSourceFileForPrinting(sourceFile, limits), encoded);
assert.throws(() => encodeTargetSourceFileForPrinting(sourceFile, {
  ...limits, maximumEncodedBytes: encoded.length - 1,
}), TargetAstEncodingError);
console.log("isolated packed target AST budget proof passed");
`);
  const proof = spawnSync(process.execPath, [proofPath], { cwd: root, encoding: "utf8" });
  if (proof.status !== 0 || proof.signal !== null) {
    fail(`isolated packed-package default-library proof failed${proof.signal === null ? "" : ` with ${proof.signal}`}:\n${proof.stderr || proof.stdout}`);
  }
}
