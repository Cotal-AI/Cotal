/**
 * The manager package must install every package its shipped Node entrypoint loads at runtime.
 *
 * The 0.33.9 tarball imported `@nats-io/transport-node`, `@nats-io/kv`, and
 * `@nats-io/jetstream` from `dist/`, but declared all three only as devDependencies. A fresh strict
 * install therefore stopped at the first missing package before the CLI could print its version.
 *
 * This cell derives the requirement from the built publication surface rather than restating a
 * boolean. It follows relative ESM imports from `dist/index.js`, collects the external packages that
 * graph actually loads, and requires every one to be installed by a production dependency field.
 * Browser-only bundle sources and type-only imports are not in that built runtime graph.
 *
 * Run: pnpm smoke:manager-runtime-deps
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const PKG_DIR = join(REPO, "implementations", "manager");
const MANIFEST = join(PKG_DIR, "package.json");
const DIST = join(PKG_DIR, "dist");
const ENTRY = join(DIST, "index.js");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

type Manifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageName = (specifier: string): string => {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
};

const staticSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) out.push(match[1]);
  }
  return out;
};

const relativeModule = (from: string, specifier: string): string | undefined => {
  const target = resolve(dirname(from), specifier);
  const candidates = extname(target) ? [target] : [`${target}.js`, join(target, "index.js")];
  return candidates.find((candidate) => existsSync(candidate));
};

console.log("manager-runtime-deps: published Node import closure");
check("manager dist entry exists", existsSync(ENTRY), relative(REPO, ENTRY));

const queue = existsSync(ENTRY) ? [ENTRY] : [];
const visited = new Set<string>();
const external = new Set<string>();
while (queue.length > 0) {
  const file = queue.shift()!;
  if (visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const specifier of staticSpecifiers(source)) {
    if (specifier.startsWith("node:") || specifier.startsWith("#")) continue;
    if (specifier.startsWith(".")) {
      const target = relativeModule(file, specifier);
      check(`relative runtime import resolves: ${relative(DIST, file)} -> ${specifier}`, target !== undefined);
      if (target) queue.push(target);
      continue;
    }
    external.add(packageName(specifier));
  }
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
const production = { ...manifest.dependencies, ...manifest.optionalDependencies };
for (const dependency of [...external].sort()) {
  check(
    `published manager runtime dependency is installed: ${dependency}`,
    production[dependency] !== undefined,
    manifest.devDependencies?.[dependency] !== undefined
      ? `${dependency} is declared only in devDependencies`
      : `${dependency} is absent from dependencies and optionalDependencies`,
  );
}

check(
  "published manager runtime closure includes the three direct NATS packages used by its Node entrypoint",
  ["@nats-io/jetstream", "@nats-io/kv", "@nats-io/transport-node"].every((dependency) => external.has(dependency)),
  [...external].sort().join(", "),
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
