import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") {
  skipSuite("extension promotion killed-writer fixture: not run on Windows, requires SIGKILL");
} else {
const root = mkdtempSync(join(tmpdir(), "promotion-crash-"));
const bin = resolve("bin/dist/cotal.js");
const counted = countedAssert(assert);
const check: typeof assert = counted.assert;
try {
  for (const phase of ["old-renamed", "new-promoted"] as const) {
    const home = join(root, phase), config = join(home, "config");
    mkdirSync(home, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" };
    const run = (args: string[], extra = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: home, env: { ...env, ...extra }, encoding: "utf8", timeout: 120000 });
    const source = (version: string) => {
      const dir = join(home, `source-${version}`); mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "promotion-crash-fixture", version, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
      writeFileSync(join(dir, "index.js"), 'import {registry} from "@cotal-ai/core"; registry.register({kind:"command",name:"promotion-crash-fixture",summary:"fixture",run:async()=>{}});');
      writeFileSync(join(dir, "whole-generation"), version);
      return dir;
    };
    const first = run(["ext", "add", source("1.0.0")]);
    assert.equal(first.status, 0, first.stderr);
    const hook = join(home, "crash.cjs");
    writeFileSync(hook, `const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const original=fs.renameSync;fs.renameSync=function(from,to){const r=original.apply(this,arguments);if(${JSON.stringify(phase)}==='old-renamed'?String(to).includes('.extensions.rollback-'):String(from).endsWith('.ready')&&String(to).endsWith('extensions'))process.kill(process.pid,'SIGKILL');return r;};syncBuiltinESMExports();`);
    const crashed = run(["ext", "add", source("2.0.0")], { NODE_OPTIONS: `--require=${hook}` });
    assert.equal(crashed.signal, "SIGKILL", `${phase}: reached actual directory publication`);
    const journal = join(config, "cotal/.extensions-promotion.json");
    const journalBytes = readFileSync(journal);
    const { old, stage, root: live } = JSON.parse(journalBytes.toString("utf8")) as { old: string; stage: string; root: string };
    const before = [old, stage, live].map(path => existsSync(path));
    for (const args of [["version"], ["--version"], ["-V"]]) {
      const version = run(args);
      check.equal(version.status, 4, version.stdout + version.stderr);
      check.match(version.stdout, /^cotal-ai \S+\n$/);
      check.match(version.stderr, /extension promotion.*\.extensions-promotion\.json/);
    }
    const json = run(["-j", "-V"]);
    check.equal(json.status, 4, json.stdout + json.stderr);
    check.equal(json.stderr, "");
    const report = JSON.parse(json.stdout);
    check.equal(report.completeness, "partial");
    check.equal(report.result.reconciliation.source, "promotion");
    check.deepEqual(readFileSync(journal), journalBytes);
    check.deepEqual([old, stage, live].map(path => existsSync(path)), before);
    chmodSync(join(old, "node_modules/promotion-crash-fixture"), 0o500);
    const recovery = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { recoverExtensionPromotion } from ${JSON.stringify(new URL("../src/lib/extension-stage.ts", import.meta.url).href)};
      if (!recoverExtensionPromotion(true)) process.exit(1);
    `], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert(!existsSync(old), "read-only rollback tree is removed after recovery");
    const listed = run(["ext", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const inventory = JSON.parse(listed.stdout).result.items;
    assert.equal(inventory[0].version, "2.0.0");
    assert.equal(readFileSync(join(config, "cotal/extensions/node_modules/promotion-crash-fixture/whole-generation"), "utf8"), "2.0.0");
    assert(!existsSync(join(config, "cotal/.extensions-promotion.json")));
    console.log(`${phase}: actual killed writer recovered complete new prefix through fresh CLI`);
  }
  emitSentinel({ passed: 2 + counted.cells(), failed: 0 });
} finally { rmSync(root, { recursive: true, force: true }); }
}
