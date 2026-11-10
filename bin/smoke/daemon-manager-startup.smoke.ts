/** A real hosted child that dies before readiness retains its exit and final diagnostic. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { saveIdpSession } from "@cotal-ai/auth";
import { createHostedManagers } from "../daemon/manager.js";

const home = realpathSync(mkdtempSync(join(tmpdir(), "manager-startup-")));
const oldConfig = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = join(home, "config");
const stamp = join(globalConfigDir(), "seed", "stamp.json");
mkdirSync(join(stamp, ".."), { recursive: true, mode: 0o700 });
writeFileSync(stamp, JSON.stringify({ generation: JSON.parse(readFileSync(resolve("bin/package.json"), "utf8")).version }), { mode: 0o600 });
const oldHome = process.env.COTAL_HOME, oldArgv = process.argv[1], oldExec = [...process.execArgv];
process.env.COTAL_HOME = home;
process.argv[1] = resolve("bin/cotal.ts");
const payload = "if(process.argv.includes('__machine-manager')){process.stderr.write('Error: Cannot find module node-pty (synthetic crash)\\n');setTimeout(()=>process.exit(3),50);}";
process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(payload)}`);
const managers = createHostedManagers(home);
try {
  const idp = "http://127.0.0.1:1";
  recordMesh({ space: "startup-proof", server: "nats://127.0.0.1:1", root: home, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: idp } } });
  saveIdpSession(home, idp, { token: "synthetic-session", sub: "fixture", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const view = await managers.start("startup-proof");
  assert.match(String(view.reason), /code 3/);
  assert.match(String(view.reason), /Cannot find module node-pty \(synthetic crash\)/);
  assert.equal(view.pid, undefined);
  assert.ok(view.lastExit);
  console.log("PASS genuine hosted startup exit: code, final stderr, lastExit and no live PID");
} finally {
  await managers.close();
  process.argv[1] = oldArgv;
  process.execArgv.splice(0, process.execArgv.length, ...oldExec);
  if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  rmSync(home, { recursive: true, force: true });
}
