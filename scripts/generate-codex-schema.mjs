import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = resolve(root, "generated", "codex-app-server");
const tsOut = join(generatedRoot, "ts");
const jsonOut = join(generatedRoot, "json-schema");
const codex = process.env.LOOP_CANVAS_CODEX_BIN || "codex";

function assertGeneratedPath(target) {
  const prefix = `${resolve(root, "generated")}${sep}`.toLowerCase();
  if (!resolve(target).toLowerCase().startsWith(prefix)) {
    throw new Error(`Refusing to modify path outside generated/: ${target}`);
  }
}

function reset(target) {
  assertGeneratedPath(target);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}

function filesUnder(target) {
  const files = [];
  for (const entry of readdirSync(target)) {
    const full = join(target, entry);
    if (statSync(full).isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files.sort();
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

function hashableContents(file) {
  const contents = readFileSync(file);
  if (!file.endsWith(".json")) return contents;
  return JSON.stringify(canonicalizeJson(JSON.parse(contents.toString("utf8"))));
}

reset(tsOut);
reset(jsonOut);
execFileSync(codex, ["app-server", "generate-ts", "--experimental", "--out", tsOut], { stdio: "inherit" });
execFileSync(codex, ["app-server", "generate-json-schema", "--experimental", "--out", jsonOut], { stdio: "inherit" });

const hash = createHash("sha256");
for (const file of [...filesUnder(tsOut), ...filesUnder(jsonOut)]) {
  hash.update(relative(generatedRoot, file).replaceAll("\\", "/"));
  hash.update("\0");
  hash.update(hashableContents(file));
  hash.update("\0");
}

const version = execFileSync(codex, ["--version"], { encoding: "utf8" }).trim();
const manifest = {
  generatedWithCodexCli: version,
  generatedAt: new Date().toISOString(),
  schemaHash: `sha256:${hash.digest("hex")}`,
  experimental: true,
};
writeFileSync(join(generatedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(
  join(root, "packages", "codex-app-server-adapter", "schema-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(manifest, null, 2));
