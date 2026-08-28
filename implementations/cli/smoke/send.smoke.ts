/**
 * One-shot send commands (`cotal send dm|msg|ask`) — live end-to-end through the real CLI parser,
 * transient endpoint, and broker. The suite owns an OS-assigned open JetStream broker and passes
 * its address explicitly to every participant, so it cannot borrow or collide with an ambient mesh.
 *
 * Run: pnpm smoke:send
 */
import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, isReachable, type CotalMessage, type Delivery } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", storeDir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url));

const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cli, ...args],
      { cwd: root },
      (err, stdout, stderr) =>
        resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });

const space = `sendsmoke-${randomUUID().slice(0, 8)}`;
const bob = new CotalEndpoint({
  space,
  servers,
  card: { name: "bob", role: "reviewer", kind: "agent" },
  channels: ["general"],
  heartbeatMs: 500,
  ttlMs: 10_000,
});
const got: string[] = [];
bob.on("message", (message: CotalMessage, delivery: Delivery) => {
  const text = message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
  const kind = message.to ? "DM" : message.toService ? `ANY:${message.toService}` : `#${message.channel ?? ""}`;
  got.push(`${kind}:${text}`);
  delivery.ack();
});
bob.on("error", (error: Error) => console.error("! bob:", error.message));

try {
  check("the subprocess entry is the repository's real bin/cotal.ts", existsSync(cli), cli);

  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await isReachable(servers);
    if (!ready) await wait(100);
  }
  check("the owned broker is ready before any endpoint connects", ready, servers);

  await bob.start();
  await wait(800);

  const unicastText = `u-${randomUUID().slice(0, 6)}`;
  const multicastText = `m-${randomUUID().slice(0, 6)}`;
  const anycastText = `a-${randomUUID().slice(0, 6)}`;
  const target = ["--space", space, "--server", servers];

  const dm = await run(["send", "dm", "bob", unicastText, ...target]);
  const msg = await run(["send", "msg", "general", multicastText, ...target]);
  const ask = await run(["send", "ask", "reviewer", anycastText, ...target]);
  await wait(700);

  check("`cotal send dm` exits 0", dm.code === 0, dm.stderr);
  check("`cotal send msg` exits 0", msg.code === 0, msg.stderr);
  check("`cotal send ask` exits 0", ask.code === 0, ask.stderr);
  check("bob received the DM", got.includes(`DM:${unicastText}`), got);
  check("bob received the #general broadcast", got.includes(`#general:${multicastText}`), got);
  check("bob received the anycast to reviewer", got.includes(`ANY:reviewer:${anycastText}`), got);

  const missing = await run(["send", "dm", "nobody-here", "x", ...target]);
  check("`cotal send dm` to an absent agent exits non-zero", missing.code !== 0, missing.code);
  check("`cotal send dm` to an absent agent says 'no agent'", /no agent/i.test(missing.stderr), missing.stderr);

  console.log(`\nsend smoke: ${pass} checks passed`);
} finally {
  await bob.stop().catch(() => {});
  broker.kill("SIGTERM");
  rmSync(storeDir, { recursive: true, force: true });
  releaseBroker();
}
