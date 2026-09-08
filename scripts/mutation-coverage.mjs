#!/usr/bin/env node
/**
 * Report how many executed smoke-suite cells have been observed failing under a mutation.
 *
 * With no paths, configs are discovered from this checkout's index. Every config is examined even
 * when an earlier one is refused or cannot be parsed. The final summary names the checkout HEAD and
 * exits non-zero if any config was not graded.
 *
 *   node scripts/mutation-coverage.mjs                     # every config in the tree
 *   node scripts/mutation-coverage.mjs <config.json> …     # just these
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { dirname, extname, relative, resolve } from "node:path";
import { parseSuiteSources } from "./mutation-suite-metadata.mjs";

const args = process.argv.slice(2);
const configs = args.length
  ? args
  : execSync("git ls-files '*/mutations/*.json' '*.mutations.json'", { encoding: "utf8" }).split("\n").filter(Boolean);

if (configs.length === 0) {
  console.error("no mutation configs found under any mutations/ directory");
  process.exit(1);
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
let cells = 0, named = 0, mutations = 0, unkillable = 0;
let examined = 0, graded = 0, refused = 0, unparsed = 0, failed = 0;
const rows = [];
const probes = [];
const tools = [];
const refusals = [];
const REQUIRED = ["name", "file", "find", "expectRed", "cell"];
const REQUIRED_MAY_BE_EMPTY = ["replace"];
const packageRoot = (p) => p.split("/").slice(0, 2).join("/");
const quoted = (s) => `["'\`]${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`;
const referencesRoot = (source, root) =>
  new RegExp([quoted(root), root.split("/").map(quoted).join("\\s*,\\s*")].join("|")).test(source);

const validStringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");

const candidateFiles = (path) => {
  const out = [path];
  if ([".js", ".mjs", ".cjs"].includes(extname(path))) {
    out.push(path.slice(0, -extname(path).length) + ".ts");
    out.push(path.slice(0, -extname(path).length) + ".mts");
    out.push(path.slice(0, -extname(path).length) + ".cts");
  }
  out.push(resolve(path, "index.ts"), resolve(path, "index.mts"), resolve(path, "index.js"));
  return [...new Set(out)].find(existsSync);
};

const relativeImports = (source) => {
  const found = [];
  const re = /(?:import\s+(?:[^"'()]*?\s+from\s+)?|import\s*\(|export\s+[^"']*?\s+from\s+)["']([^"']+)["']/g;
  for (const match of source.matchAll(re)) found.push(match[1]);
  return found;
};

const manifestByName = new Map();
for (const path of execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (typeof manifest.name === "string") manifestByName.set(manifest.name, { path, manifest });
  } catch { /* malformed manifests are diagnosed when their config is examined */ }
}
const entryPackageCache = new Map();

/** Package imports reachable from a declared repo entrypoint, plus first-party package dependencies. */
const entryPackages = (entry) => {
  if (entryPackageCache.has(entry)) return entryPackageCache.get(entry);
  const packages = new Set();
  const seenFiles = new Set();
  const seenPackages = new Set();
  const visitPackage = (name) => {
    if (seenPackages.has(name)) return;
    seenPackages.add(name);
    const found = manifestByName.get(name);
    if (!found) return;
    packages.add(name);
    for (const dependency of Object.keys({ ...found.manifest.dependencies, ...found.manifest.optionalDependencies })) {
      if (dependency === "cotal-ai" || dependency.startsWith("@cotal-ai/")) visitPackage(dependency);
    }
  };
  const visitFile = (path) => {
    const actual = candidateFiles(path);
    if (!actual || seenFiles.has(actual)) return;
    seenFiles.add(actual);
    const source = readFileSync(actual, "utf8");
    for (const specifier of relativeImports(source)) {
      if (specifier.startsWith(".")) visitFile(resolve(dirname(actual), specifier));
      else if (specifier === "cotal-ai" || specifier.startsWith("@cotal-ai/")) visitPackage(specifier.split("/").slice(0, 2).join("/"));
    }
  };
  visitFile(resolve(entry));
  entryPackageCache.set(entry, packages);
  return packages;
};

const pathReference = (suite, entry) => {
  const rel = relative(dirname(suite), entry).replaceAll("\\", "/");
  const forms = [entry, rel, rel.startsWith(".") ? rel : `./${rel}`];
  const relativePieces = rel.split("/").map(quoted).join("\\s*,\\s*");
  const repoPieces = entry.split("/").map(quoted).join("\\s*,\\s*");
  return new RegExp([...forms.map(quoted), relativePieces, repoPieces].join("|"));
};

/** The declaration is evidence only when the suite passes that entrypoint to a Node/tsx/pty subprocess. */
const spawnsEntrypoint = (suite, entry, source) => {
  const reference = pathReference(suite, entry);
  const aliases = [];
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=([^;\n]+(?:\n[^;]+)?);/g)) {
    if (reference.test(match[2])) aliases.push(match[1]);
  }
  const token = aliases.length ? `(?:${aliases.join("|")}|${reference.source})` : reference.source;
  return new RegExp(`(?:spawn(?:Sync|Proc)?|pty\\.spawn)\\s*\\([^;]*?\\[[^\\]]*?${token}`, "s").test(source);
};

const packageName = (file) => {
  const manifest = resolve(packageRoot(file), "package.json");
  if (!existsSync(manifest)) return undefined;
  return JSON.parse(readFileSync(manifest, "utf8")).name;
};

const buildsPackage = (command, name) => {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:pnpm\\s+build|--filter\\s+${escaped}(?:\\.\\.\\.)?[^&;\\n]*\\bbuild\\b)`).test(command);
};

const executedWitness = (suite, source, command, mutation, executes) => {
  for (const entry of executes) {
    if (!spawnsEntrypoint(suite, entry, source)) continue;
    if (resolve(entry) === resolve(mutation.file)) return true;
    const name = packageName(mutation.file);
    if (name && buildsPackage(command, name) && entryPackages(entry).has(name)) return true;
  }
  return false;
};

const assertGradable = (configPath, cfg, suites, mutation) => {
  for (const suite of suites) {
    const source = readFileSync(suite, "utf8");
    if (resolve(mutation.file) === resolve(suite)) return;
    if (packageRoot(mutation.file) === packageRoot(suite) && source.includes("../src/")) return;
    const assembled = (cfg.assembles ?? []).find((root) => mutation.file === root || mutation.file.startsWith(root + "/"));
    if (assembled !== undefined && referencesRoot(source, assembled)) return;
    if (executedWitness(suite, source, cfg.command, mutation, cfg.executes ?? [])) return;
  }
  throw new Error(
    `mutation "${mutation.name}" targets ${mutation.file}, which none of [${suites.join(", ")}] imports by source path, ` +
    `reaches through a declared assembled tree, nor reaches through a declared subprocess entrypoint. A by-name ` +
    `import resolves that package to dist. Use a suite in ${packageRoot(mutation.file)} that reaches into ../src, ` +
    `declare the copied source tree in "assembles", declare the spawned repo entrypoint in "executes" with the ` +
    `target package built by the command, or record the mutation as unkillable with its reason.`,
  );
};

const lastMatch = (output, re) => [...output.matchAll(re)].at(-1);
const progressCount = (output, pattern) => (output.match(new RegExp(pattern, "gm")) ?? []).length;

const parseSummary = (cfg, output) => {
  const tallied = lastMatch(output, /(\d+) passed, (\d+) failed/g);
  if (tallied) return { executed: Number(tallied[1]), failures: Number(tallied[2]) };
  const checks = lastMatch(output, /(?:(\d+)\s*\/\s*)?(\d+) checks passed/g);
  if (checks) {
    const executed = Number(checks[2]);
    if (checks[1] !== undefined && Number(checks[1]) !== executed) return undefined;
    return { executed, failures: 0 };
  }
  if (typeof cfg.completionMarker === "string") {
    const line = output.split(/\r?\n/).filter((candidate) => candidate.includes(cfg.completionMarker)).at(-1);
    const fraction = line?.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (fraction && Number(fraction[1]) === Number(fraction[2])) return { executed: Number(fraction[2]), failures: 0 };
  }
  if (typeof cfg.progressPattern === "string" && Number.isInteger(cfg.minTicks) && cfg.minTicks > 0) {
    const completed = typeof cfg.completionMarker === "string"
      ? output.includes(cfg.completionMarker)
      : /(?:^|\n)[^\n]*(?:PASSED|\bOK\b)[^\n]*(?:\n|$)/.test(output);
    const executed = progressCount(output, cfg.progressPattern);
    if (completed && executed >= cfg.minTicks) return { executed, failures: 0 };
  }
  return undefined;
};

const validate = (path, cfg) => {
  const gradesTool = cfg.grades === "tool";
  const suites = parseSuiteSources(process.cwd(), path, cfg.suite);
  if (typeof cfg.command !== "string" || cfg.command === "") throw new Error('is missing "command"');
  if (!Array.isArray(cfg.mutations)) throw new Error('is missing a "mutations" array');
  for (const key of ["assembles", "executes"]) {
    if (cfg[key] !== undefined && !validStringArray(cfg[key])) throw new Error(`"${key}" must be an array of non-empty repo paths`);
  }
  const required = gradesTool ? REQUIRED.filter((key) => key !== "cell") : REQUIRED;
  for (const mutation of cfg.mutations) {
    for (const key of required) {
      if (typeof mutation[key] !== "string" || mutation[key] === "") throw new Error(`mutation "${mutation.name ?? "(unnamed)"}" is missing "${key}"`);
    }
    for (const key of REQUIRED_MAY_BE_EMPTY) {
      if (typeof mutation[key] !== "string") throw new Error(`mutation "${mutation.name ?? "(unnamed)"}" is missing "${key}"`);
    }
    if (!gradesTool) assertGradable(path, cfg, suites, mutation);
  }
  return { gradesTool, suites };
};

for (const path of configs) {
  examined++;
  let cfg;
  let gradesTool;
  let suites;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
    ({ gradesTool, suites } = validate(path, cfg));
  } catch (error) {
    refused++;
    const reason = error instanceof Error ? error.message : String(error);
    refusals.push([path, reason]);
    console.error(`REFUSED ${path}: ${reason}`);
    continue;
  }

  let output;
  try {
    output = execSync(cfg.command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    failed++;
    console.error(`FAILED ${path}: command exited ${error.status ?? "without a status"}: ${cfg.command}`);
    const transcript = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (transcript) console.error(transcript);
    continue;
  }

  const summary = parseSummary(cfg, output);
  if (!summary) {
    unparsed++;
    console.error(`UNPARSED ${path}: command completed but printed no trustworthy executed-cell total`);
    continue;
  }
  if (summary.failures !== 0) {
    failed++;
    console.error(`FAILED ${path}: suite is already red (${summary.failures} failed); coverage over red is not graded`);
    continue;
  }

  const executed = summary.executed;
  const suiteLabel = suites.join(", ");
  if (gradesTool) {
    tools.push([path, cfg.mutations.length, executed]);
    graded++;
    continue;
  }
  if (cfg.kind === "unasserted-probe") {
    probes.push([suiteLabel, cfg.mutations.length, executed]);
    graded++;
    continue;
  }
  const distinct = new Set(cfg.mutations.map((mutation) => mutation.cell));
  if (distinct.size > executed) {
    failed++;
    console.error(`FAILED ${path}: names ${distinct.size} distinct cells but the suite ran ${executed}`);
    continue;
  }
  if (distinct.size !== cfg.mutations.length) console.log(`  note: ${path} has ${cfg.mutations.length} mutations naming ${distinct.size} distinct cells`);
  cells += executed;
  named += distinct.size;
  mutations += cfg.mutations.length;
  unkillable += (cfg.unkillable ?? []).length;
  rows.push([suiteLabel, executed, distinct.size]);
  graded++;
}

const width = Math.max(5, ...rows.map((row) => row[0].length));
for (const [suite, executed, distinct] of rows) {
  console.log(`${suite.padEnd(width)}  ${String(distinct).padStart(3)} / ${String(executed).padStart(3)} cells observed failing`);
}
if (rows.length) console.log(`${"TOTAL".padEnd(width)}  ${named} / ${cells} = ${Math.round((named / cells) * 100)}%`);
console.log(`${mutations} mutations run, ${unkillable} recorded unkillable by construction and not run.`);
if (rows.length) {
  console.log("A lower bound: a mutation may redden more cells than the one it names, and those are not claimed here.");
  console.log("The ratio measures guards authors aimed at, not every guard that exists.");
}
if (probes.length) {
  console.log("\nUnasserted-guard probes:");
  for (const [suite, count, executed] of probes) console.log(`  ${suite}  ${count} probes against a suite of ${executed} cells`);
}
if (tools.length) {
  console.log("\nInstrument configs:");
  for (const [path, count, executed] of tools) console.log(`  ${path}  ${count} mutations against a self-test of ${executed} cells`);
}
if (refusals.length) {
  console.error("\nRefused configs:");
  for (const [path, reason] of refusals) console.error(`  ${path}: ${reason}`);
}
console.log(
  `MUTATION COVERAGE SUMMARY head=${head} enumerated=${configs.length} examined=${examined} graded=${graded} ` +
  `refused-with-reason=${refused} unparsed=${unparsed} command-failed=${failed}`,
);
if (refused || unparsed || failed || examined !== configs.length || graded !== configs.length) process.exitCode = 1;
