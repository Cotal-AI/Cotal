import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// Real-host regression for a live-measured sequence: an attached TUI keeps working while
// queued-message acknowledgement lapses. Recovery must not stop its private daemon tree.
const root = mkdtempSync("/tmp/cjbusy-");
const port = await freePort();
assert.notEqual(port, 4222);
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const log = join(root, "fake.jsonl");
const marker = "BUSY_TUI_ACK_LAPSE";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const entries = (): Array<{ ev: string; pid?: number; frame?: { req?: string } }> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
async function waitFor(name: string, predicate: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`timed out waiting for ${name}: ${stderr}`);
    await sleep(50);
  }
}
let pass = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, `${name}: ${stderr}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const broker = spawn("nats-server", ["-js", "-n", SMOKE_BROKER_TOKEN, "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, SMOKE_BROKER_TOKEN)], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
let child: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let stderr = "";
try {
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "auth.json"), "owned-smoke-login");
  const shim = join(root, "bin", "jcode");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o700);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcodebusy", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({ space: "jcodebusy", servers, card: { id: "operator", name: "operator", kind: "agent" }, channels: ["team"] });
  operator.on("error", () => {});
  let peer: string | undefined;
  operator.on("presence", (event) => {
    if (event.type !== "offline" && event.presence.card.name === "busyseat") peer = event.presence.card.id;
  });
  await operator.start();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key.startsWith("JCODE_")) delete env[key];
  child = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env, PATH: `${join(root, "bin")}:${env.PATH ?? ""}`, JCODE_HOME: join(root, "source"),
      FAKE_JCODE_LOG: log, FAKE_JCODE_DAEMON: "1", FAKE_JCODE_SESSION_STATE: join(root, "session.json"),
      FAKE_JCODE_BUSY_MODEL: "1", FAKE_JCODE_BUSY_AFTER_READINESS: "1", FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1",
      FAKE_JCODE_BUSY_HOLD_MS: "90000", FAKE_JCODE_STEER_BLACKHOLE: "1", FAKE_JCODE_SWALLOW_QUEUED_SEND: marker,
      COTAL_SPACE: "jcodebusy", COTAL_SERVERS: servers, COTAL_ID: "busyseat", COTAL_NAME: "busyseat",
      COTAL_SUBSCRIBE: "team", COTAL_ALLOW_SUBSCRIBE: "team", COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root, COTAL_JCODE_TUI: "1", COTAL_JCODE_PROMPT: "Owned kickoff after busy window",
      COTAL_JCODE_REQUEST_TIMEOUT_MS: "1000", COTAL_CONTROL_SOCKET: join(root, "control.sock"), COTAL_CONTROL_TOKEN: "owned-control",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await waitFor("joined busy seat", () => Boolean(peer) && entries().some((entry) => entry.ev === "busy_after_readiness_status"));
  check("attached TUI and native daemon are live before the probe", entries().some((entry) => entry.ev === "tui") && entries().some((entry) => entry.ev === "daemon") && child!.exitCode === null);
  const daemon = entries().find((entry) => entry.ev === "daemon")!.pid!;
  await operator.unicast(peer!, marker);
  await waitFor("connection-only recovery", () => stderr.includes("recovered private Harness connection"));
  check("busy acknowledgement lapse replaces only the API connection", stderr.includes("replacing only the Harness API connection"));
  check("the private bridge process was not relaunched", entries().filter((entry) => entry.ev === "argv").length === 1);
  check("the same native daemon remains alive", (() => { try { process.kill(daemon, 0); return true; } catch { return false; } })());
  await waitFor("one-shot queued-tier stop", () => stderr.includes("queued-turn acknowledgement remains ambiguous"), 40_000);
  check("spent acknowledgement recovery keeps the host alive", child.exitCode === null && child.signalCode === null);
  check("the unacknowledged batch remains explicitly owed", stderr.includes("automatic message(s) stay queued and UN-ACKED for redelivery"));
  check("a repeated timeout does not terminate the private daemon", (() => { try { process.kill(daemon, 0); return true; } catch { return false; } })());
  console.log(`\nJCODE BUSY TUI RECOVERY PASSED (${pass} checks)`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(15_000)]);
  }
  assert.ok(!child || child.exitCode !== null || child.signalCode !== null, "host must exit before fixture cleanup");
  await operator?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  releaseBroker();
  if (pass === 7) rmSync(root, { recursive: true, force: true });
  else console.log(`FAILED FIXTURE RETAINED: ${root}`);
}
