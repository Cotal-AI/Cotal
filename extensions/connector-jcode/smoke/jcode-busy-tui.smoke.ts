import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { BRIDGE_RECOVERY_WINDOW_MS } from "../src/host.js";

// Real host with a fake bridge: a busy TUI survives successful same-bridge recovery.
// A reconnect that never answers or permanently refuses must end within a bound and name why.
const root = mkdtempSync("/tmp/cjbusy-");
const port = await freePort();
assert.notEqual(port, 4222);
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const marker = "BUSY_TUI_ACK_LAPSE";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
let pass = 0;
let stderr = "";
async function waitFor(name: string, predicate: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`timed out waiting for ${name}: ${stderr}`);
    await sleep(50);
  }
}
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, `${name}: ${stderr}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const broker = spawn("nats-server", ["-js", "-n", SMOKE_BROKER_TOKEN, "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, SMOKE_BROKER_TOKEN)], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
let complete = false;
try {
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "auth.json"), "owned-smoke-login");
  const shim = join(root, "bin", "jcode");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o700);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  for (const mode of ["success", "silent", "refusal"] as const) {
    console.log(`\nSame-bridge reconnect: ${mode}`);
    const cell = join(root, mode);
    mkdirSync(cell);
    const log = join(cell, "fake.jsonl");
    const entries = (): Array<{ ev: string; pid?: number; mode?: string; content?: string; frame?: { req?: string; content?: string } }> =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const space = `jcodebusy${mode}`;
    await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
    const operator = new CotalEndpoint({ space, servers, card: { id: "operator", name: "operator", kind: "agent" }, channels: ["team"] });
    operator.on("error", () => {});
    let peer: string | undefined;
    operator.on("presence", (event) => {
      if (event.type !== "offline" && event.presence.card.name === "busyseat") peer = event.presence.card.id;
    });
    let child: ChildProcess | undefined;
    stderr = "";
    try {
      await operator.start();
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key.startsWith("JCODE_") || key.startsWith("FAKE_JCODE_")) delete env[key];
      child = spawn(tsx, [host], {
        cwd: cell,
        env: {
          ...env, PATH: `${join(root, "bin")}:${env.PATH ?? ""}`, JCODE_HOME: join(root, "source"),
          FAKE_JCODE_LOG: log, FAKE_JCODE_DAEMON: "1", FAKE_JCODE_SESSION_STATE: join(cell, "session.json"),
          FAKE_JCODE_BUSY_MODEL: "1", FAKE_JCODE_BUSY_AFTER_READINESS: "1", FAKE_JCODE_BUSY_AFTER_READINESS_STATUS: "1",
          FAKE_JCODE_BUSY_HOLD_MS: "180000", FAKE_JCODE_STEER_BLACKHOLE: "1", FAKE_JCODE_SWALLOW_QUEUED_SEND: marker,
          FAKE_JCODE_STEER_REFUSE: marker,
          FAKE_JCODE_STEER_REFUSE_EXCEPT: "UNANSWERED_AFTER_PRESERVE",
          FAKE_JCODE_RECONNECT_HELLO: mode, FAKE_JCODE_REATTACH_BUSY: "1",
          FAKE_JCODE_ACCEPT_BEFORE_RECOVERY: mode === "success" ? "ACCEPTED_NATIVE_COPY" : "",
          FAKE_JCODE_BUSY_RELEASE_FILE: join(cell, "busy-release"),
          COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_ID: "busyseat", COTAL_NAME: "busyseat",
          COTAL_SUBSCRIBE: "team", COTAL_ALLOW_SUBSCRIBE: "team", COTAL_ALLOW_PUBLISH: "team",
          COTAL_JCODE_HOME: cell, COTAL_JCODE_TUI: "1", COTAL_JCODE_PROMPT: "Owned kickoff after busy window",
          COTAL_JCODE_REQUEST_TIMEOUT_MS: "1000", COTAL_CONTROL_SOCKET: join(cell, "control.sock"), COTAL_CONTROL_TOKEN: "owned-control",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      await waitFor("joined busy seat", () => Boolean(peer) && entries().some((entry) => entry.ev === "busy_after_readiness_status"));
      check(`${mode}: attached TUI and native daemon are live before the probe`, entries().some((entry) => entry.ev === "tui") && entries().some((entry) => entry.ev === "daemon") && child!.exitCode === null);
      const daemon = entries().find((entry) => entry.ev === "daemon")!.pid!;
      if (mode === "success") {
        await operator.unicast(peer!, "ACCEPTED_NATIVE_COPY");
        await waitFor("native queued copy accepted before recovery", () => entries().some((entry) => entry.ev === "accepted_native_copy"));
      }
      await operator.unicast(peer!, marker);
      if (mode === "success") {
        await waitFor("connection-only recovery", () => stderr.includes("recovered private Harness connection"));
        check("busy acknowledgement lapse replaces only the API connection", stderr.includes("replacing only the Harness API connection"));
        check("the private bridge process was not relaunched", entries().filter((entry) => entry.ev === "argv").length === 1);
        check("the same native daemon remains alive", alive(daemon));
        await waitFor("one-shot queued-tier stop", () => stderr.includes("queued-turn acknowledgement remains ambiguous"), 40_000);
        check("spent acknowledgement recovery keeps the host alive", child.exitCode === null && child.signalCode === null);
        check("the unacknowledged batch remains explicitly owed", stderr.includes("automatic message(s) stay queued and UN-ACKED for redelivery"));
        check("a repeated timeout does not terminate the private daemon", alive(daemon));
        const acceptedRequests = () => entries().filter((entry) => ["send_message", "soft_interrupt"].includes(entry.frame?.req ?? "") && entry.frame?.content?.includes("ACCEPTED_NATIVE_COPY"));
        check("accepted native queued copy is not redriven by client-only recovery", acceptedRequests().length === 1);
        const unanswered = "UNANSWERED_AFTER_PRESERVE";
        const countUnanswered = () => entries().filter((entry) => entry.frame?.req === "soft_interrupt" && entry.frame.content?.includes(unanswered)).length;
        await operator.unicast(peer!, unanswered);
        await waitFor("unanswered post-preserve steer", () => countUnanswered() === 1);
        await waitFor("post-preserve request timeout", () => stderr.split("soft interrupt failed").length >= 3, BRIDGE_RECOVERY_WINDOW_MS + 15_000);
        await operator.unicast(peer!, "SECOND_POST_LATCH_WAKE");
        await waitFor("new post-latch message gets its own steer", () => entries().some((entry) => entry.frame?.req === "soft_interrupt" && entry.frame.content?.includes("SECOND_POST_LATCH_WAKE")));
        check("timed-out steer stays reserved during the same native busy turn", countUnanswered() === 1);
        writeFileSync(join(cell, "busy-release"), "release");
        await waitFor("unanswered batch redelivered at boundary", () => entries().some((entry) => entry.ev === "turn_run" && entry.content?.includes(unanswered)));
        check("turn boundary releases unanswered work without losing delivery", entries().some((entry) => entry.ev === "turn_run" && entry.content?.includes(unanswered)));
      } else {
        await waitFor("connection-only recovery attempt", () => stderr.includes("replacing only the Harness API connection"));
        const began = Date.now();
        // A missing production deadline fails this wait even if a terminal diagnostic would be correct.
        const bound = (mode === "silent" ? BRIDGE_RECOVERY_WINDOW_MS : 0) + 15_000;
        await waitFor(`${mode} terminal host exit within ${bound}ms`, () => child!.exitCode !== null || child!.signalCode !== null, bound);
        const elapsed = Date.now() - began;
        check(`${mode}: bounded recovery ends the host with exit 1`, child.exitCode === 1 && child.signalCode === null && elapsed < bound);
        check(`${mode}: fake exercised the failed same-bridge handshake`, entries().some((entry) => entry.ev === "reconnect_hello" && entry.mode === mode));
        // Exact cause text is required independently of the exit/bound assertion above.
        const cause = mode === "silent" ? `same-bridge recovery window expired after ${BRIDGE_RECOVERY_WINDOW_MS}ms` : "same-bridge recovery permanently refused";
        check(`${mode}: terminal diagnostic names the failed same-bridge cause`, stderr.includes(`${cause}; ending seat and stopping private Jcode tree`));
        check(`${mode}: failed reconnect does not launch a replacement tree`, entries().filter((entry) => entry.ev === "argv").length === 1 && !stderr.includes("recovered private Harness connection"));
        await waitFor("terminal shutdown stops the original daemon", () => !alive(daemon), 10_000);
        check(`${mode}: terminal shutdown stops the original daemon`, !alive(daemon));
        if (mode === "silent") check("unanswered handshake uses the bounded recovery window", elapsed >= BRIDGE_RECOVERY_WINDOW_MS - 2_000);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), sleep(15_000)]);
      }
      assert.ok(!child || child.exitCode !== null || child.signalCode !== null, "host must exit before fixture cleanup");
      await operator.stop().catch(() => {});
    }
  }
  complete = true;
  console.log(`\nJCODE BUSY TUI RECOVERY PASSED (${pass} checks)`);
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
  if (complete) rmSync(root, { recursive: true, force: true });
  else console.log(`FAILED FIXTURE RETAINED: ${root}`);
}
