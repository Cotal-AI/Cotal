/** Drive the actual manager-start child through a loopback IdP. The authority endpoint refuses
 * deliberately: these cells prove proof-read recovery and no authority replay, not full startup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import { createCalloutAuth } from "../../auth/src/callout.js";
import { saveIdpSession } from "@cotal-ai/auth";
import { createSuite } from "@cotal-ai/smoke-kit";
import { persistRemoteUserEntry } from "../src/commands/meshes-add.js";

const { check, finish } = createSuite();
const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
const parentHome = process.env.COTAL_HOME;
const packet = process.env.TOKEN_RETRY_EVIDENCE;
const observed: unknown[] = [];

for (const limited of [false, true]) {
  const home = mkdtempSync(join(tmpdir(), "cotal-manager-token-"));
  const root = join(home, "project");
  mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
  process.env.COTAL_HOME = join(home, ".cotal");
  const space = `token-${limited ? "limited" : "control"}`;
  const auth = await createSpaceAuth(space);
  let tokenRequests = 0, authorityRequests = 0;
  const requestTimes: number[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/auth/token") {
      tokenRequests++;
      requestTimes.push(Date.now());
      if (limited && tokenRequests === 2) {
        res.writeHead(429, { "content-type": "application/json", "x-retry-after": "1" });
        res.end(JSON.stringify({ error: "test-local rate limit" }));
      } else {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const token = `${encode({ alg: "none" })}.${encode({ sub: "fixture", exp: Math.floor(Date.now() / 1000) + 600 })}.fixture`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token }));
      }
    } else if (req.url === "/manager-service-authority") {
      authorityRequests++;
      req.resume();
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "NATIVE_FIXTURE_AUTHORITY_STOP" }));
    } else {
      req.resume();
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const idp = `${base}/api/auth`;
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    saveIdpSession(process.env.COTAL_HOME!, idp, { token: "test-local-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "fixture" });
    persistRemoteUserEntry(space, "nats://127.0.0.1:1", root, {
      space, server: "nats://127.0.0.1:1", tlsRequired: false,
      userAuth: { provider: "cotal", idp: { url: idp, issuer: base, audience: base }, endpoints: { url: base } },
      sentinelCreds: (await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub })).sentinelCreds,
    }, false, false);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: process.env.COTAL_HOME,
      COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_IDP_TIMEOUT_MS: "5000", DO_NOT_TRACK: "1", NO_COLOR: "1" };
    child = spawn(process.execPath, [bin, "manager", "start", "--space", space, "--json", "--no-input"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const timer = setTimeout(() => { child?.kill("SIGTERM"); }, 15000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", resolve);
    }).finally(() => clearTimeout(timer));
    const label = limited ? "one native 429" : "unlimited control";
    observed.push({ label, code, tokenRequests, authorityRequests, requestTimes, output });
    check(`${label}: real manager child reaches the deliberately refusing authority`, output.includes("NATIVE_FIXTURE_AUTHORITY_STOP"), output);
    check(`${label}: authority preparation is sent exactly once`, authorityRequests === 1, authorityRequests);
    check(`${label}: controller keeps its unknown-outcome failure`, code !== 0 && output.includes("OPERATION_UNKNOWN"), { code, output });
    check(`${label}: proof reads match preflight plus the native child`, tokenRequests === (limited ? 3 : 2), tokenRequests);
    if (limited) check("the child retry honors native seconds", requestTimes.length === 3 && requestTimes[2]! - requestTimes[1]! >= 950, requestTimes);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
if (parentHome === undefined) delete process.env.COTAL_HOME;
else process.env.COTAL_HOME = parentHome;
if (packet) writeFileSync(packet, JSON.stringify(observed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
finish();
