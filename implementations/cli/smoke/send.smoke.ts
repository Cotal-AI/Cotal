/**
 * One-shot send commands (`cotal send dm|msg|ask`) — live end-to-end through the real CLI parser,
 * transient endpoint, and broker. The suite owns an OS-assigned open JetStream broker and passes
 * its address explicitly to every participant, so it cannot borrow or collide with an ambient mesh.
 *
 * Isolation: every CLI child gets a sandboxed HOME / XDG_CONFIG_HOME / TMPDIR / COTAL_HOME, and
 * inherited COTAL_* is stripped. COTAL_SKIP_CONNECTOR_SEED is a reconcile skip, not a store fence;
 * the seed store follows XDG_CONFIG_HOME (via globalConfigDir()), not COTAL_HOME.
 *
 * Run: pnpm smoke:send
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, isReachable, type CotalMessage, type Delivery } from "@cotal-ai/core";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const EXPECTED = 21;
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
};

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", storeDir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url));

const home = mkdtempSync(join(tmpdir(), "cotal-send-home-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"), { recursive: true });
const xdg = join(home, "xdg");
mkdirSync(xdg);
const tmp = mkdtempSync(join(tmpdir(), "cotal-send-tmp-"));
const releaseTmp = teardownPathOnSignal(tmp);

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];
const isolatedEnv: NodeJS.ProcessEnv = {
  ...cleanEnv,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: tmp,
  COTAL_HOME: join(home, ".cotal"),
  XDG_CONFIG_HOME: xdg,
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NO_COLOR: "1",
};

const run = (
  args: string[],
  extra: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cli, ...args],
      { cwd: root, env: { ...isolatedEnv, ...extra } },
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
const got: Array<{ route: string; text: string; from: string }> = [];
bob.on("message", (message: CotalMessage, delivery: Delivery) => {
  const text = message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
  const route = message.to ? "DM" : message.toService ? `ANY:${message.toService}` : `#${message.channel ?? ""}`;
  got.push({ route, text, from: message.from.name });
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

  const noIdentityDmText = `noid-u-${randomUUID().slice(0, 6)}`;
  const noIdentityMsgText = `noid-m-${randomUUID().slice(0, 6)}`;
  const noIdentityAskText = `noid-a-${randomUUID().slice(0, 6)}`;
  const noIdentityDm = await run(["send", "dm", "bob", noIdentityDmText, ...target]);
  const noIdentityMsg = await run(["send", "msg", "general", noIdentityMsgText, ...target]);
  const noIdentityAsk = await run(["send", "ask", "reviewer", noIdentityAskText, ...target]);
  await wait(700);

  check("`cotal send dm` without COTAL_NAME exits non-zero", noIdentityDm.code !== 0, noIdentityDm);
  check("`cotal send dm` refusal names COTAL_NAME", /COTAL_NAME/.test(noIdentityDm.stderr), noIdentityDm.stderr);
  check("`cotal send dm` without COTAL_NAME delivers nothing", !got.some((m) => m.text === noIdentityDmText), got);
  check("`cotal send msg` without COTAL_NAME exits non-zero", noIdentityMsg.code !== 0, noIdentityMsg);
  check("`cotal send msg` refusal names COTAL_NAME", /COTAL_NAME/.test(noIdentityMsg.stderr), noIdentityMsg.stderr);
  check("`cotal send msg` without COTAL_NAME delivers nothing", !got.some((m) => m.text === noIdentityMsgText), got);
  check("`cotal send ask` without COTAL_NAME exits non-zero", noIdentityAsk.code !== 0, noIdentityAsk);
  check("`cotal send ask` refusal names COTAL_NAME", /COTAL_NAME/.test(noIdentityAsk.stderr), noIdentityAsk.stderr);
  check("`cotal send ask` without COTAL_NAME delivers nothing", !got.some((m) => m.text === noIdentityAskText), got);

  const nameOnly = await run(["send", "dm", "bob", `nameonly-${randomUUID().slice(0, 6)}`, ...target], { COTAL_NAME: "alice" });
  check("`cotal send dm` with COTAL_NAME but no COTAL_ID exits non-zero", nameOnly.code !== 0, nameOnly);

  const callerEnv = { COTAL_NAME: "alice", COTAL_ID: "alice_send" };
  const dm = await run(["send", "dm", "bob", unicastText, ...target], callerEnv);
  const msg = await run(["send", "msg", "general", multicastText, ...target], callerEnv);
  const ask = await run(["send", "ask", "reviewer", anycastText, ...target], callerEnv);
  await wait(700);

  check("`cotal send dm` exits 0", dm.code === 0, dm.stderr);
  check("`cotal send msg` exits 0", msg.code === 0, msg.stderr);
  check("`cotal send ask` exits 0", ask.code === 0, ask.stderr);
  check("bob received the DM from the declared caller", got.some((m) => m.route === "DM" && m.text === unicastText && m.from === "alice"), got);
  check("bob received the #general broadcast from the declared caller", got.some((m) => m.route === "#general" && m.text === multicastText && m.from === "alice"), got);
  check("bob received the anycast to reviewer from the declared caller", got.some((m) => m.route === "ANY:reviewer" && m.text === anycastText && m.from === "alice"), got);

  const missing = await run(["send", "dm", "nobody-here", "x", ...target], callerEnv);
  check("`cotal send dm` to an absent agent exits non-zero", missing.code !== 0, missing.code);
  check("`cotal send dm` to an absent agent says 'no agent'", /no agent/i.test(missing.stderr), missing.stderr);

} finally {
  await bob.stop().catch(() => {});
  await killAndAwaitExit(broker);
  check("the owned broker exits before its JetStream tree is removed", broker.exitCode !== null || broker.signalCode !== null);
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
  releaseHome();
  releaseTmp();
}

check(`every scenario cell ran — ${EXPECTED} expected`, pass + fail === EXPECTED, { pass, fail, expected: EXPECTED });
console.log(`\nsend smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
