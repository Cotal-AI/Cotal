import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, statSync, renameSync, writeFileSync } from "node:fs";
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
let registeredName = "", puts = 0, idp = "", hold = false;
const fixture = createServer(async (req, res) => {
  if (hold) return;
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
async function cli(args: string[], op = "name") {
  const child = spawn(process.execPath, ["--import", "tsx", "bin/cotal.ts", "daemon", op, "--daemon-home", machineHome, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, err + out); return out;
}
try {
  const before = puts;
  const reply = await exchangeDesktopRequest({ paths }, { op: "name", name: "  David's computer  " });
  check(reply.ok && !("event" in reply) && "computer" in reply.result && reply.result.computer === "David's computer", "name request trims and reports persisted name");
  const registrationDeadline = Date.now() + 1500;
  while (registeredName !== "David's computer" && Date.now() < registrationDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  check(puts > before && registeredName === "David's computer", "save promptly sends registration name without gating reply");
  check((statSync(join(machineHome, "daemon", "computer-name.json")).mode & 0o777) === 0o600, "name record is private");
  const namePath = join(machineHome, "daemon", "computer-name.json");
  renameSync(namePath, `${namePath}.held`);
  try {
    const statusStarted = Date.now();
    check(daemon.status().computer === "David's computer" && Date.now() - statusStarted < 100, "status uses held name without reading missing record");
  } finally { renameSync(`${namePath}.held`, namePath); }
  for (const name of ["","a\nb", "a".repeat(129)]) {
    const invalid = await exchangeDesktopRequest({ paths }, { op: "name", name });
    check(!invalid.ok, "invalid name refused");
  }
  check(JSON.parse(await cli(["CLI computer", "--json"])).result.computer === "CLI computer", "CLI setter json");
  check((await cli(["--plain"])).includes("CLI computer"), "CLI plain getter");
  check((await cli([])).includes("CLI computer"), "CLI human getter");
  hold = true;
  const started = Date.now();
  const offline = await exchangeDesktopRequest({ paths }, { op: "name", name: "Offline computer" });
  check(offline.ok && Date.now() - started < 1500, "unreachable host rename answers locally within 1500ms");
  check(daemon.status().computer === "Offline computer", "offline save immediately updates status");
  hold = false;
  fixture.closeAllConnections();
  const deadline = Date.now() + 12_000;
  while (registeredName !== "Offline computer" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  check(registeredName === "Offline computer", "next successful heartbeat carries offline name");
  await cli(["CLI computer", "--json"]);
  await daemon.close();
  daemon = await serveDaemon({ paths, version: "test", sessionDir: machineHome });
  const restartDeadline = Date.now() + 12_000;
  while (registeredName !== "CLI computer" && Date.now() < restartDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  check(daemon.status().computer === "CLI computer" && registeredName === "CLI computer", "restart retains name and registers it");
  await daemon.close();
  writeFileSync(join(machineHome, "daemon", "computer-name.json"), "{broken", { mode: 0o600 });
  daemon = await serveDaemon({ paths, version: "test", sessionDir: machineHome });
  check(Boolean(daemon.status().computer), "damaged cosmetic record does not prevent daemon startup");
  check((await cli([], "status")).includes('cotal daemon name "<name>"'), "human status reports one-line name repair remedy");
  check(JSON.parse(await cli(["--json"], "status")).result.computerNameWarning.includes("unreadable"), "JSON status reports damaged name record");
  check(JSON.parse(await cli(["Repaired computer", "--json"])).result.computer === "Repaired computer", "name command replaces damaged record");
  check(!daemon.status().computerNameWarning, "successful repair clears warning");
  await daemon.close();
  daemon = await serveDaemon({ paths, version: "test", sessionDir: machineHome });
  check(daemon.status().computer === "Repaired computer" && !daemon.status().computerNameWarning, "repair survives restart without warning");
} finally { await daemon.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
console.log(`COTAL_SMOKE_SENTINEL cells=${checks} passed=${checks} failed=0`);
