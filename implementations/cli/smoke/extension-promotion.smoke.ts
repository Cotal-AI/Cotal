import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { claimUpdateClosureAccess, updateClosureOwner, writeUpdateRecovery } from "@cotal-ai/workspace";
import { reclaimAbandonedExtensionStages, recoverExtensionPromotion, assertStageVerifier, stageExtensions } from "../src/lib/extension-stage.js";

const originalConfig = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.COTAL_HOME;
const roots: string[] = [];
let passed = 0;
try {
const forbidden = mkdtempSync(join(tmpdir(), "promotion-forged-"));
roots.push(forbidden);
assert.throws(() => assertStageVerifier(process.ppid, forbidden, "forged"), /no live prefix writer/);
console.log("forged staged verifier has no mutation authority");
passed++;

if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "promotion-linked-"));
  roots.push(root);
  const physical = join(root, "physical"), linked = join(root, "linked");
  mkdirSync(physical, { mode: 0o700 });
  symlinkSync(physical, linked);
  process.env.XDG_CONFIG_HOME = linked;
  const stage = stageExtensions();
  try {
    writeFileSync(join(stage.prefix, "whole"), "new");
    stage.promote();
    assert.equal(readFileSync(join(physical, "cotal", "extensions", "whole"), "utf8"), "new");
    assert(!existsSync(join(linked, "cotal", ".extensions-promotion.json")));
  } finally { stage.discard(); }
  console.log("promotion through a private symlinked config root preserves its physical prefix");
  passed++;
}

if (process.platform !== "win32") {
  const shared = (path: string): string[] => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return [];
    return [...((info.mode & 0o022) !== 0 ? [path] : []), ...(info.isDirectory() ? readdirSync(path).flatMap(name => shared(join(path, name))) : [])];
  };
  for (const existing of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "promotion-umask-"));
    roots.push(root);
    process.env.XDG_CONFIG_HOME = root;
    if (existing) { mkdirSync(join(root, "cotal", "extensions", "node_modules"), { recursive: true, mode: 0o755 }); writeFileSync(join(root, "cotal", "extensions", "package.json"), "{}", { mode: 0o644 }); }
    const previous = process.umask(0o002);
    try {
      const stage = stageExtensions();
      try { assert.deepEqual(shared(stage.prefix), []); } finally { stage.discard(); }
    } finally { process.umask(previous); }
  }
  console.log("a stage made under a umask of 0002 holds no group or other write, with and without a live prefix");
  passed++;
}

for (const state of ["prepared", "old-renamed", "new-promoted"] as const) {
  const root = mkdtempSync(join(tmpdir(), "promotion-state-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  const config = join(root, "cotal"); mkdirSync(config, { mode: 0o700 });
  const live = join(config, "extensions"), wrapper = join(config, ".extensions.stage-Ab1234"), stage = `${wrapper}.ready`, old = join(config, ".extensions.rollback-proof");
  mkdirSync(live); writeFileSync(join(live, "whole"), "old");
  mkdirSync(wrapper, { mode: 0o700 }); mkdirSync(stage); writeFileSync(join(stage, "whole"), "new");
  const stat = lstatSync(stage), oldStat = lstatSync(live);
  writeFileSync(join(config, ".extensions-promotion.json"), JSON.stringify({ v: 1, root: live, stage, old,
    oldIdentity: { dev: String(oldStat.dev), ino: String(oldStat.ino), birth: oldStat.birthtimeMs },
    stageIdentity: { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs } }), { mode: 0o600 });
  reclaimAbandonedExtensionStages();
  assert.ok(existsSync(wrapper), "cleanup leaves the wrapper of a journaled stage alone");
  assert.equal(readFileSync(join(stage, "whole"), "utf8"), "new", "cleanup leaves a journaled ready copy alone");
  if (state !== "prepared") renameSync(live, old);
  if (state === "new-promoted") renameSync(stage, live);
  recoverExtensionPromotion();
  assert.equal(readFileSync(join(live, "whole"), "utf8"), "new");
  assert(!existsSync(stage) && !existsSync(old));
  assert(!existsSync(join(config, ".extensions-promotion.json")));
  console.log(`promotion ${state}: complete verified new prefix recovered`);
  passed++;
}
if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "promotion-ordinary-stage-"));
  roots.push(root);
  const configRoot = join(root, "config"), cotalHome = join(root, "cotal-home");
  mkdirSync(configRoot, { mode: 0o700 });
  mkdirSync(cotalHome, { mode: 0o700 });
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.COTAL_HOME = cotalHome;
  const config = join(configRoot, "cotal");
  mkdirSync(join(config, "extensions"), { recursive: true, mode: 0o755 });
  chmodSync(root, 0o755);
  chmodSync(configRoot, 0o755);
  chmodSync(config, 0o755);
  writeFileSync(join(config, "extensions", "package.json"), "{}");
  const mode755 = join(config, ".extensions.stage-Mo0755");
  mkdirSync(join(mode755, "config/cotal"), { recursive: true, mode: 0o755 });
  const worldWritable = join(config, ".extensions.stage-Mo0777");
  mkdirSync(worldWritable, { mode: 0o755 });
  chmodSync(worldWritable, 0o777);
  reclaimAbandonedExtensionStages();
  assert.ok(!existsSync(mode755), "cleanup removes an ordinary 0755 stage directory");
  assert.ok(existsSync(worldWritable), "cleanup refuses a world-writable stage directory under a searchable config root");
  chmodSync(config, 0o700);
  chmodSync(configRoot, 0o700);
  chmodSync(root, 0o700);
  assert.equal(readFileSync(join(config, "extensions", "package.json"), "utf8"), "{}");

  const repo = resolve(".");
  const installed = join(root, "prefix/lib/node_modules/cotal-ai");
  mkdirSync(installed, { recursive: true, mode: 0o700 });
  cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
  cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
  const entry = realpathSync.native(join(installed, "dist/cotal.js"));
  const version = (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string }).version;
  const key = createHash("sha256").update(entry).digest("hex");
  const sets = join(configRoot, "cotal/installs", key, "sets");
  const selected = join(sets, version, "cotal");
  const previous = join(sets, "0.0.0-prev", "cotal");
  mkdirSync(selected, { recursive: true, mode: 0o700 });
  mkdirSync(previous, { recursive: true, mode: 0o700 });
  mkdirSync(join(selected, "extensions"), { mode: 0o755 });
  mkdirSync(join(previous, "extensions"), { mode: 0o755 });
  writeFileSync(join(previous, "extensions", "package.json"), "{}");
  const prevStage = join(previous, ".extensions.stage-Ab12Cd");
  mkdirSync(join(prevStage, "config/cotal"), { recursive: true, mode: 0o755 });
  const snapshot = join(previous, ".update-snapshot-Ab12Cd");
  mkdirSync(snapshot, { mode: 0o700 });
  const selection = JSON.stringify({ v: 1, entry, version, root: selected, snapshot });
  for (const path of [join(sets, "current.json"), join(sets, version, "selection.json")]) writeFileSync(path, selection, { mode: 0o600 });

  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
  const runInInstalled = (code: string, extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    process.argv[1] = ${JSON.stringify(entry)};
    Object.defineProperty(globalThis, Symbol.for("cotal.execution.started"), { value: true });
    Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), { value: Object.freeze({ logicalEntry: ${JSON.stringify(entry)}, loadedEntry: ${JSON.stringify(entry)} }) });
    ${code}
  `], { cwd: repo, env: { ...cleanEnv, HOME: root, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: configRoot, ...extra }, encoding: "utf8", timeout: 30_000 });

  const stageModule = new URL("../src/lib/extension-stage.ts", import.meta.url).href;
  const workspaceModule = new URL("../../../packages/workspace/dist/index.js", import.meta.url).href;
  const releaseClosure = claimUpdateClosureAccess();
  try {
    const owner = updateClosureOwner();
    writeUpdateRecovery({
      previous: "0.0.0-prev", target: version, installed: version, phase: "verified-ready",
      reason: "smoke", snapshot, owner,
    });
    const closureEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("COTAL_UPDATE_CLOSURE_")));
    const bound = runInInstalled(
      `const { inheritConnectorConfig } = await import(${JSON.stringify(workspaceModule)}); inheritConnectorConfig(); const { reclaimReplacedExtensionStages } = await import(${JSON.stringify(stageModule)}); reclaimReplacedExtensionStages(${JSON.stringify(version)});`,
      { ...closureEnv, COTAL_UPDATE_PARENT: String(process.pid) },
    );
    assert.equal(bound.status, 0, bound.stderr);
    assert.ok(!existsSync(prevStage), "bound target reconciliation reclaims an ordinary 0755 stage from the replaced set");
    assert.equal(readFileSync(join(previous, "extensions", "package.json"), "utf8"), "{}", "replaced set extensions remain intact");
  } finally {
    rmSync(join(cotalHome, "update-recovery.json"), { force: true });
    releaseClosure();
  }

  mkdirSync(join(prevStage, "config/cotal"), { recursive: true, mode: 0o755 });
  const standalone = runInInstalled(`const { reclaimPreviousExtensionStages } = await import(${JSON.stringify(stageModule)}); reclaimPreviousExtensionStages();`);
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.ok(!existsSync(prevStage), "previous-set cleanup reclaims an ordinary 0755 stage after update completion");
  assert.equal(readFileSync(join(previous, "extensions", "package.json"), "utf8"), "{}");
  console.log("ordinary 0755 extension stages are reclaimed in active, bound-replaced, and previous sets while unsafe descendants stay untouched");
  passed++;
}

emitSentinel({ passed, failed: 0 });
} finally {
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
  if (originalHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = originalHome;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
