/** Keep the Windows ownership observer's shipped import graph small on every platform. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "owg-"));
try {
  const log = join(root, "modules.jsonl");
  const hook = join(root, "observe.mjs");
  writeFileSync(hook, `import {registerHooks} from 'node:module'; import {appendFileSync} from 'node:fs'; registerHooks({load(url,context,next){const result=next(url,context);appendFileSync(${JSON.stringify(log)},JSON.stringify(url)+'\\n');return result;}});`);
  const entry = fileURLToPath(new URL("../dist/daemon/ownership-win32.js", import.meta.url));
  const workerSource = `import(${JSON.stringify(pathToFileURL(hook).href)}).then(()=>import(${JSON.stringify(pathToFileURL(entry).href)})).then(m=>{const {parentPort}=require('node:worker_threads');parentPort.postMessage(m.observeWindowsOwnedService({state:${JSON.stringify(root)}},[]));});`;
  const script = `const {Worker}=require('node:worker_threads'); const worker=new Worker(${JSON.stringify(workerSource)},{eval:true}); worker.once('message',m=>{if(m.state!=='not-owned'||m.reason!=='marker-absent')process.exitCode=1;});`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15_000, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), COTAL_DAEMON_NATIVE_SERVICE: "0" } });
  assert.equal(result.error, undefined, "ownership import observation completed");
  assert.equal(result.status, 0, result.stderr);
  const modules = [...new Set(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string))];
  // Baseline live Windows worker loads 1125 modules. The leaf currently loads 25 on Linux.
  const limit = 40;
  assert.ok(modules.length <= limit, `Windows ownership worker imported ${modules.length} modules, limit ${limit}: ${modules.join(", ")}`);
  assert.ok(!modules.some(url => /\/(?:implementations\/(?:cli|manager)|@cotal-ai\/(?:cli|manager))\//.test(url)), "ownership worker must not import CLI or Manager commands");
  console.log(`PASS Windows ownership import graph: ${modules.length}/${limit} modules, no CLI or Manager graph`);

  writeFileSync(log, "");
  const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
  const status = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, cli, "status", "--json"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^cotal_/i.test(key))),
      HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: join(root, "cotal"),
      TMPDIR: root, TMP: root, TEMP: root, DO_NOT_TRACK: "1", COTAL_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(status.error, undefined, "status import observation completed");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).result?.machine?.web?.installed, true, "status recognizes the built-in dashboard without a space");
  const statusModules = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
  const heavyBuiltins = statusModules.filter(url =>
    /\/(?:implementations\/|@cotal-ai\/)(?:acp|linear|web)\/dist\/(?:cli|serve|web|upstream)\.js$/.test(url) ||
    /\/@(?:agentclientprotocol|modelcontextprotocol)\+sdk@/.test(url));
  assert.deepEqual(heavyBuiltins, [], "status must not eagerly load the built-in command and service implementations");
  console.log("PASS status detects built-in web without loading command or service implementations");
} finally { rmSync(root, { recursive: true, force: true }); }
