import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { saveIdpSession } from "@cotal-ai/auth";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { exchangeDesktopRequest } from "../daemon/desktop.js";
const root = mkdtempSync(join(tmpdir(), "ownacct-name-"));
Object.assign(process.env, { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: join(root, "cotal"), XDG_RUNTIME_DIR: join(root, "rt") });
for (const dir of [process.env.HOME!, process.env.COTAL_HOME!, process.env.XDG_RUNTIME_DIR!]) mkdirSync(dir, { recursive: true, mode: 0o700 });
let registeredName = "", puts = 0, idp = "";
const fixture = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const machine = req.url?.match(/^\/api\/cli\/machines\/([0-9a-f-]+)(\/spaces)?$/);
  if (!machine) { res.writeHead(404); res.end("{}"); return; }
  if (req.method === "PUT") {
    let body = ""; for await (const chunk of req) body += chunk;
    registeredName = JSON.parse(body).name; puts++;
    res.end(JSON.stringify({ v: 1, machine: { id: machine[1], lastSeenAt: new Date().toISOString() } }));
  } else res.end(JSON.stringify({ v: 1, machineId: machine[1], revision: 1, bindingRevisions: {}, account: { idpUrl: idp, issuer: new URL(idp).origin, sub: "owner" }, spaces: [] }));
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
idp = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/api/auth`;
const machineHome = join(root, "machine"); mkdirSync(machineHome, { mode: 0o700 });
saveIdpSession(machineHome, idp, { token: "fixture", sub: "owner", expiresAt: Date.now() / 1000 + 3600 });
const paths = daemonPathsFor(machineHome, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR });
let daemon = await serveDaemon({ paths, version: "test", sessionDir: machineHome });
let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log(`ok ${label}`); }
async function cli(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", "name", "--daemon-home", machineHome, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, err + out); return out;
}
try {
  const before = puts;
  const reply = await exchangeDesktopRequest({ paths }, { op: "name", name: "  David's computer  " });
  check(reply.ok && !("event" in reply) && "computer" in reply.result && reply.result.computer === "David's computer", "name request trims and reports persisted name");
  check(puts > before && registeredName === "David's computer", "save immediately sends registration name");
  check((statSync(join(machineHome, "daemon", "computer-name.json")).mode & 0o777) === 0o600, "name record is private");
  for (const name of ["", "a\nb", "a".repeat(129)]) {
    const invalid = await exchangeDesktopRequest({ paths }, { op: "name", name });
    check(!invalid.ok, "invalid name refused");
  }
  check(JSON.parse(await cli(["CLI computer", "--json"])).result.computer === "CLI computer", "CLI setter json");
  check((await cli(["--plain"])).includes("CLI computer"), "CLI plain getter");
  check((await cli([])).includes("CLI computer"), "CLI human getter");
  await daemon.close();
  daemon = await serveDaemon({ paths, version: "test", sessionDir: machineHome });
  await new Promise(resolve => setTimeout(resolve, 100));
  check(daemon.status().computer === "CLI computer" && registeredName === "CLI computer", "restart retains name and registers it");
} finally { await daemon.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
console.log(`COTAL_SMOKE_SENTINEL cells=${checks} passed=${checks} failed=0`);
