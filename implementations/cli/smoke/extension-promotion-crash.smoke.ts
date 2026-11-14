import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "promotion-crash-"));
const bin = resolve("bin/dist/cotal.js");
try {
  for (const phase of ["old-renamed", "new-promoted"] as const) {
    const home = join(root, phase), config = join(home, "config");
    mkdirSync(home, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 });
    const env = { ...process.env, HOME: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" };
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
    const listed = run(["ext", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const inventory = JSON.parse(listed.stdout).result.items;
    assert.equal(inventory[0].version, "2.0.0");
    assert.equal(readFileSync(join(config, "cotal/extensions/node_modules/promotion-crash-fixture/whole-generation"), "utf8"), "2.0.0");
    assert(!existsSync(join(config, "cotal/.extensions-promotion.json")));
    console.log(`${phase}: actual killed writer recovered complete new prefix through fresh CLI`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
