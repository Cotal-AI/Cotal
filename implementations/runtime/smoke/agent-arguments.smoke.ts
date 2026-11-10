/** Agent arguments through the shipped CLI against an isolated static-auth broker. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel, killAndAwaitExit, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}agent-arguments-`));
const home = join(root, "home");
const space = "agentargs";
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
teardownOnSignal(broker);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
env.COTAL_HOME = home;
env.COTAL_SKIP_CONNECTOR_SEED = "1";
env.COTAL_TELEMETRY = "off";
const exec = promisify(execFile);
const cli = async (...args: string[]) => {
  try {
    const r = await exec(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("bin/cotal.ts"), "run", ...args], { env, timeout: 60_000 });
    return { code: 0, text: r.stdout + r.stderr };
  } catch (e) {
    const r = e as { code: number; stdout: string; stderr: string };
    if (typeof r.code !== "number") throw e;
    return { code: r.code, text: r.stdout + r.stderr };
  }
};
let failed = 0;
let passedCases = 0;
try {
  const creds = await mintCreds(auth, newIdentity(), "probe");
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await isReachable(servers, { creds });
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, "private broker ready");
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  saveSpaceAuth(authDir(root), auth);
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = home;
  try { recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() }); }
  finally {
    if (previousHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = previousHome;
  }
  const cases = [
    ["ask", 'await ask("bob", { name: "q", schema: {} })'],
    ["turn", 'await turn("bob", { name: "q" })'],
    ["monitor", 'await monitor("bob")'],
    ["replied", 'await wait(replied("bob"), { name: "q" })'],
    ["down", 'await wait(down("bob"), { name: "q" })'],
    ["notify", 'await notify(["bob"], { decision: "ok", outcome: "done" })'],
    ["message", 'await wait(message(channel("test"), { from: "bob" }), { name: "q" })'],
    ["conclave", 'await conclave(["bob"], async (room) => {}, { name: "q" })'],
    ["pure", 'log("sum", 1 + 2)'],
    ["handle", 'await monitor({ agent: "bob#uid", persona: "default" })'],
  ] as const;
  for (const [name, source] of cases) {
    const file = join(root, `${name}.cotal.js`);
    writeFileSync(file, source);
    const valid = await cli("validate", file);
    assert.equal(valid.code, 0, `${name}: valid syntax: ${valid.text}`);
    const started = await cli("start", "--local", "--space", space, "--file", file, "--admit-read", "none", "--admit-publish", "none");
    const id = /starting run (run-[0-9a-f]+)/.exec(started.text)?.[1];
    assert(id, `${name}: run recorded: ${started.text}`);
    const shown = await cli("show", id, "--local", "--space", space);
    assert.equal(shown.code, 0, `${name}: show: ${shown.text}`);
    console.log(`CASE ${name}: start exit ${started.code}\n${shown.text}`);
    const control = name === "pure" || name === "handle";
    const passed = control
      ? started.code === 0 && shown.text.includes("Recorded state: completed")
      : started.code === 5 && shown.text.includes("L3050") && shown.text.includes(`\`${name}\``) && shown.text.includes("handle") && !shown.text.includes("TypeError") && !shown.text.includes("lastIndexOf");
    if (!passed) { failed++; console.error(`FAIL ${name}: ${control ? "control completes" : "argument requires an agent handle"}`); }
    else passedCases++;
  }
} finally {
  await killAndAwaitExit(broker);
  console.log(`Evidence retained at ${root}`);
}
emitSentinel({ passed: passedCases, failed });
process.exitCode = failed ? 1 : 0;
