import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, mintLifecycleUid, seedChannelRegistry } from "@cotal-ai/core";
import { checkSteerReplies } from "./steer-reply-controls.js";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// A timed-out request is still live at the native session. Exercise the shipped host and SDK
// before any recovery, and distinguish that unanswered handover from a correlated refusal.
const root = mkdtempSync("/tmp/cjsteer-");
const port = await freePort();
assert.notEqual(port, 4222);
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Entry = { ev: string; content?: string; frame?: { req?: string; content?: string } };
let pass = 0;
let stderr = "";
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, `${name}: ${stderr}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
async function waitFor(name: string, predicate: () => boolean, within = 20_000): Promise<void> {
  const deadline = Date.now() + within;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name}: ${stderr}`);
    await sleep(50);
  }
}
const broker = spawn("nats-server", ["-js", "-n", SMOKE_BROKER_TOKEN, "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, SMOKE_BROKER_TOKEN)], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
let complete = false;
try {
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source/auth.json"), "owned-smoke-login");
  const shim = join(root, "bin/jcode");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o700);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  for (const mode of ["timeout", "refusal", "accepted", "late-ok", "late-error"] as const) {
    const cell = join(root, mode);
    mkdirSync(cell);
    const log = join(cell, "fake.jsonl");
    const entries = (): Entry[] => existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
    const requests = (marker: string, req?: string): Entry[] => entries().filter((e) =>
      e.ev === "request" && ["soft_interrupt", "send_message"].includes(e.frame?.req ?? "")
      && (!req || e.frame?.req === req) && e.frame?.content?.includes(marker));
    const marker = `STEER_${mode.toUpperCase()}_OWNED`;
    const space = `steer${mode.replaceAll("-", "")}`;
    await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
    const operator = new CotalEndpoint({ space, servers, card: { id: "operator", name: "operator", kind: "agent" }, channels: ["team"] });
    operator.on("error", () => {});
    let peer: string | undefined;
    operator.on("presence", (event) => {
      if (event.type !== "offline" && event.presence.card.name === "steerseat") peer = event.presence.card.id;
    });
    let child: ChildProcess | undefined;
    stderr = "";
    try {
      await operator.start();
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(COTAL_|JCODE_|FAKE_JCODE_)/.test(key)) delete env[key];
      child = spawn(tsx, [host], {
        cwd: cell,
        env: {
          ...env, HOME: cell, XDG_CONFIG_HOME: join(cell, "config"), COTAL_HOME: join(cell, "cotal"),
          PATH: `${join(root, "bin")}:${env.PATH ?? ""}`, JCODE_HOME: join(root, "source"),
          FAKE_JCODE_LOG: log, FAKE_JCODE_BUSY_MODEL: "1", FAKE_JCODE_BUSY_AFTER_READINESS: "1",
          FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1", FAKE_JCODE_BUSY_RELEASE_FILE: join(cell, "boundary"),
          FAKE_JCODE_STEER_BLACKHOLE: mode === "timeout" ? "1" : "",
          FAKE_JCODE_STEER_REFUSE: mode === "refusal" ? "1" : "",
          FAKE_JCODE_STEER_LATE_REPLY_FILE: mode.startsWith("late-") ? join(cell, "late-reply") : "",
          FAKE_JCODE_STEER_LATE_ERROR: mode === "late-error" ? "1" : "",
          COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_ID: "steerseat", COTAL_NAME: "steerseat",
          COTAL_LIFECYCLE_UID: mintLifecycleUid(), COTAL_SUBSCRIBE: "team", COTAL_ALLOW_SUBSCRIBE: "team", COTAL_ALLOW_PUBLISH: "team",
          COTAL_JCODE_HOME: cell, COTAL_JCODE_TUI: "1", COTAL_JCODE_PROMPT: "Owned kickoff after native turn",
          COTAL_JCODE_REQUEST_TIMEOUT_MS: "1000", COTAL_CONTROL_SOCKET: join(cell, "control.sock"), COTAL_CONTROL_TOKEN: "owned-control",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      await waitFor("joined busy seat", () => Boolean(peer) && entries().some((e) => e.ev === "busy_after_readiness_status"));
      check(`${mode}: live attached seat starts before any recovery`, child.exitCode === null && entries().some((e) => e.ev === "tui"));
      await operator.unicast(peer!, marker);
      await waitFor("soft interrupt request", () => requests(marker, "soft_interrupt").length === 1);
      if (mode.startsWith("late-")) {
        await waitFor("SDK timeout before late reply", () => stderr.includes("soft interrupt failed: timeout:"));
        check(`${mode}: unanswered marker is reserved before its reply`, requests(marker, "send_message").length === 0);
        writeFileSync(join(cell, "late-reply"), "reply");
        await waitFor("late correlated reply", () => entries().some((e) => e.ev === "late_steer_reply"));
        await sleep(100);
      } else if (mode === "refusal") {
        await waitFor("refusal fallback while still busy", () => requests(marker, "send_message").length === 1);
        check("a correlated non-timeout refusal still serves owed work before the boundary", stderr.includes("invalid_request") && !entries().some((e) => e.ev === "turn_run" && e.content?.includes(marker)));
      } else {
        if (mode === "timeout") await waitFor("SDK timeout", () => stderr.includes("soft interrupt failed: timeout:"));
        const later = `LATER_WAKE_${mode.toUpperCase()}`;
        await operator.unicast(peer!, later);
        await waitFor("later wake gets its own steer", () => requests(later, "soft_interrupt").length === 1);
        await sleep(4_000);
        check(`${mode}: later wakes do not re-offer the original marker`, requests(marker).length === 1);
        check(`${mode}: no queued-turn copy is written while native work stays busy`, requests(marker, "send_message").length === 0);
        check(`${mode}: no bridge replacement was needed`, entries().filter((e) => e.ev === "argv").length === 1 && !stderr.includes("recovered private Harness connection"));
      }
      writeFileSync(join(cell, "boundary"), "release");
      if (mode !== "accepted" && mode !== "late-ok") {
        await waitFor("owed message runs at boundary", () => entries().some((e) => e.ev === "turn_run" && e.content?.includes(marker)));
        await sleep(500);
        check(`${mode}: boundary serves the owed marker once`, entries().filter((e) => e.ev === "turn_run" && e.content?.includes(marker)).length === 1);
      } else {
        await waitFor("post-boundary kickoff", () => entries().some((e) => e.ev === "turn_run"));
        check(`${mode}: clean native boundary does not redrive the accepted steer`, requests(marker, "send_message").length === 0);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), sleep(15_000)]);
      }
      assert.ok(!child || child.exitCode !== null || child.signalCode !== null, "host exits before cleanup");
      await operator.stop().catch(() => {});
    }
  }
  await checkSteerReplies(root, check);
  complete = true;
  console.log(`\nJCODE STEER TIMEOUT PASSED (${pass} checks)`);
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
  if (complete) rmSync(root, { recursive: true, force: true });
  else console.log(`FAILED FIXTURE RETAINED: ${root}`);
}
