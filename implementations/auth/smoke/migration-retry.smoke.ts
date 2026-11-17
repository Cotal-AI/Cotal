import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registry, type Command } from "@cotal-ai/core";
import { homeCotalDir, readMesh } from "@cotal-ai/workspace";
import { importAccountComputerSpace } from "../../cli/src/commands/sync.js";
import { saveIdpSession } from "../src/login.js";
import "../src/commands.js";

if (process.argv[2] === "child") {
  const oldUrl = process.argv[3]!;
  const login = registry.all<Command>("command").find(command => command.name === "login")!;
  const args = { values: { ...(process.argv[4] === "ordinary" ? { idp: oldUrl } : { "migrate-from": oldUrl }), "no-browser": true, plain: true }, positionals: [], raw: [] };
  login.validate?.(args);
  await login.run(args);
} else {
  const home = mkdtempSync("/var/tmp/mretry-");
  chmodSync(home, 0o700);
  const key = join(home, "key.pem"), cert = join(home, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  let mode = "deadline";
  let oldUrl = "", nextUrl = "", issuer = "";
  const requests: string[] = [];
  const bundle = (url: string) => ({ space: "alpha", server: "nats://127.0.0.1:1", tlsRequired: false, sentinelCreds: "fixture", userAuth: { provider: "cotal", idp: { url, issuer, audience: "mesh" }, endpoints: { url: `${new URL(url).origin}/exchange` } } });
  const server = (old: boolean) => createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    requests.push(`${old ? "old" : "new"}:${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/cotal-mesh") res.end(JSON.stringify({ ...bundle(old ? oldUrl : nextUrl), ...(old ? { nativeMigration: { version: 1, origin: new URL(nextUrl).origin } } : {}) }));
    else if (req.url === "/api/auth/device/code") res.end(JSON.stringify({ device_code: "local-device", user_code: "LOCAL", verification_uri: `${issuer}/approve`, verification_uri_complete: `${issuer}/approve`, expires_in: mode === "deadline" ? 0.05 : 5, interval: 1 }));
    else if (req.url === "/api/auth/device/token") { res.statusCode = 400; res.end(JSON.stringify({ error: "expired_token" })); }
    else { res.statusCode = 404; res.end("{}"); }
  });
  const oldServer = server(true), nextServer = server(false);
  for (const instance of [oldServer, nextServer]) await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  issuer = `https://127.0.0.1:${(oldServer.address() as { port: number }).port}`;
  oldUrl = `${issuer}/api/auth`;
  nextUrl = `https://127.0.0.1:${(nextServer.address() as { port: number }).port}/api/auth`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.startsWith("XDG_") && key !== "HOME"));
  process.env.COTAL_HOME = join(home, "cotal");
  const ownerKey = createHash("sha256").update(`${issuer}\0person`).digest("hex");
  saveIdpSession(homeCotalDir(), oldUrl, { token: "old-local-canary", sub: "person", expiresAt: Date.now() / 1000 + 600 });
  writeFileSync(join(homeCotalDir(), "space-catalogs.json"), JSON.stringify({ ver: 1, accounts: { [ownerKey]: { idpUrl: oldUrl, issuer, sub: "person", ownerKey, advertised: true } } }));
  importAccountComputerSpace({ idpUrl: oldUrl, issuer, sub: "person", ownerKey }, { id: "stable-alpha", slug: "alpha", name: "Alpha", kind: "team", role: "member", registration: bundle(oldUrl) });
  const before = readMesh("alpha");
  const sessions = readFileSync(join(homeCotalDir(), "idp-sessions.json"), "utf8");
  try {
    for (const cell of ["deadline", "provider", "cancel", "ordinary"]) {
      mode = cell;
      requests.length = 0;
      let output = "", cancelled = false;
      const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "child", oldUrl, cell], { env: { ...cleanEnv, HOME: home, COTAL_HOME: process.env.COTAL_HOME, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: home, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"] });
      const capture = (chunk: Buffer) => {
        output += chunk.toString();
        if (cell === "cancel" && output.includes("Approval code:") && !cancelled) { cancelled = true; child.kill("SIGINT"); }
      };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => child.on("close", (code, signal) => resolve({ code, signal })));
      clearTimeout(timer);
      console.log(JSON.stringify({ cell, ...result, requests, output }));
      assert.deepEqual(readMesh("alpha"), before);
      assert.equal(readFileSync(join(homeCotalDir(), "idp-sessions.json"), "utf8"), sessions);
      assert.ok(!output.includes("old-local-canary"));
      assert.ok(requests.includes(`${cell === "ordinary" ? "old" : "new"}:/api/auth/device/code`));
      assert.equal(requests.some(request => request.endsWith("/device/token")), cell === "provider" || cell === "ordinary");
      if (cell === "cancel") { assert.equal(result.signal, "SIGINT"); assert.doesNotMatch(output, /run `cotal login` again/); }
      else {
        assert.equal(result.code, 1);
        assert.match(output, /device code expired/);
        assert.ok(output.includes(cell === "ordinary" ? "run `cotal login` again" : `run \`cotal login --migrate-from ${oldUrl}\` again`), output);
      }
    }
  } finally {
    for (const instance of [oldServer, nextServer]) { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); }
  }
  console.log("Live registered migration retry smoke passed");
}
