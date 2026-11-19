import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { recoverExtensionPromotion, assertStageVerifier, stageExtensions } from "../src/lib/extension-stage.js";

const originalConfig = process.env.XDG_CONFIG_HOME;
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
    const live = join(root, "cotal", "extensions");
    const metadata = ["package.json", "package-lock.json"];
    if (existing) {
      mkdirSync(join(live, "node_modules"), { recursive: true, mode: 0o755 });
      for (const name of metadata) writeFileSync(join(live, name), "{}", { mode: 0o400 });
    }
    const previous = process.umask(0o002);
    try {
      const stage = stageExtensions();
      try {
        assert.deepEqual(shared(stage.prefix), []);
        if (existing) for (const name of metadata) {
          assert.equal(lstatSync(join(stage.prefix, name)).mode & 0o777, 0o600);
          assert.equal(lstatSync(join(live, name)).mode & 0o777, 0o400);
        }
      } finally { stage.discard(); }
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
  const live = join(config, "extensions"), stage = join(config, ".extensions.stage-proof.ready"), old = join(config, ".extensions.rollback-proof");
  mkdirSync(live); writeFileSync(join(live, "whole"), "old");
  mkdirSync(stage); writeFileSync(join(stage, "whole"), "new");
  const stat = lstatSync(stage), oldStat = lstatSync(live);
  writeFileSync(join(config, ".extensions-promotion.json"), JSON.stringify({ v: 1, root: live, stage, old,
    oldIdentity: { dev: String(oldStat.dev), ino: String(oldStat.ino), birth: oldStat.birthtimeMs },
    stageIdentity: { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs } }), { mode: 0o600 });
  if (state !== "prepared") renameSync(live, old);
  if (state === "new-promoted") renameSync(stage, live);
  recoverExtensionPromotion();
  assert.equal(readFileSync(join(live, "whole"), "utf8"), "new");
  assert(!existsSync(stage) && !existsSync(old));
  assert(!existsSync(join(config, ".extensions-promotion.json")));
  console.log(`promotion ${state}: complete verified new prefix recovered`);
  passed++;
}
emitSentinel({ passed, failed: 0 });
} finally {
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
