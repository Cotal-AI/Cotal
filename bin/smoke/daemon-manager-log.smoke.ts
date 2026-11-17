import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { globalConfigDir } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { saveIdpSession } from "@cotal-ai/auth";
import { createHostedManagers, daemonManagerRoot } from "../daemon/manager.js";

// The real createHostedManagers spawn runs the verified shipped CLI entry. A child-only
// preload emits synthetic diagnostics before that entry starts, with real separated writes.
const home = realpathSync(mkdtempSync(join(tmpdir(), "manager-log-")));
const oldConfig = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(home, "config");
const stamp = join(globalConfigDir(), "seed", "stamp.json");
mkdirSync(join(stamp, ".."), { recursive: true, mode: 0o700 });
writeFileSync(stamp, JSON.stringify({ generation: JSON.parse(readFileSync(resolve("bin/package.json"), "utf8")).version }), { mode: 0o600 });
const oldHome = process.env.COTAL_HOME;
const oldArgv = process.argv[1];
const oldExec = [...process.execArgv];
process.env.COTAL_HOME = home;
process.argv[1] = resolve("bin/cotal.ts");
const jwt = "eyJhbGciOiJub25lIn0.c3ludGhldGlj.c2lnbmF0dXJl";
const payload = `if(process.argv.includes('__machine-manager')) {\nprocess.stdout.write('stdout '+${JSON.stringify(jwt.slice(0, 13))});\nsetTimeout(()=>{process.stdout.write(${JSON.stringify(jwt.slice(13))}+'\\n');process.stderr.write('✗ stderr '+${JSON.stringify(jwt.slice(0, 20))});},50);\nsetTimeout(()=>{process.stderr.write(${JSON.stringify(jwt.slice(20))}+'\\n');process.send?.({kind:'manager-refusal',reason:'IPC '+${JSON.stringify(jwt)},terminal:true,status:403});},100);\nawait new Promise(r=>setTimeout(r,180));\nfor(let i=0;i<140;i++) { if(!process.stdout.write('rotation '+ 'x'.repeat(8000)+'\\n')) await new Promise(r=>process.stdout.once('drain',r)); }\nprocess.stdout.write('oversized '+ 'x'.repeat(17000)+${JSON.stringify(jwt)}+'\\n');\nprocess.stdout.write('trailing '+${JSON.stringify(jwt)});\nawait new Promise(r=>setTimeout(r,50));process.exit(1);\n}`;
process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(payload)}`);
const managers = createHostedManagers(home);
try {
  const idp = "http://127.0.0.1:1";
  recordMesh({ space: "log-proof", server: "nats://127.0.0.1:1", root: home, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: idp } } });
  saveIdpSession(home, idp, { token: "synthetic-session", sub: "fixture", expiresAt: Math.floor(Date.now()/1000)+3600 });
  const status = await managers.start("log-proof");
  const root = daemonManagerRoot("log-proof", home);
  const log = readFileSync(join(root, "manager.log"), "utf8");
  const rotated = readFileSync(join(root, "manager.log.1"), "utf8");
  assert.match(rotated, /stdout/);
  assert.match(rotated, /stderr/);
  assert.match(log, /oversized Manager log line omitted/);
  assert.match(log, /trailing <redacted>/);
  for (const name of ["manager.log", "manager.log.1"]) {
    const st = statSync(join(root, name));
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(st.size <= 1024 * 1024);
  }
  assert.match(String(status.reason), /IPC <redacted>/);
  assert.equal(statSync(join(root, "manager.log")).mode & 0o777, 0o600);
  const disk = readdirSync(join(home, "daemon"), { recursive: true }).map(String).filter(p => p.endsWith(".json") || p.endsWith(".log") || p.endsWith(".log.1")).map(p => readFileSync(join(home, "daemon", p), "utf8")).join("\n");
  assert.equal((disk + JSON.stringify(status) + JSON.stringify(managers.status("log-proof"))).includes(jwt), false, "raw split stdout/stderr JWT or IPC JWT escaped to disk/status");
  console.log("PASS genuine hosted child: split stdout/stderr and IPC JWT private and redacted");
} finally {
  await managers.close();
  process.argv[1] = oldArgv;
  process.execArgv.splice(0, process.execArgv.length, ...oldExec);
  if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  rmSync(home, { recursive: true, force: true });
}
