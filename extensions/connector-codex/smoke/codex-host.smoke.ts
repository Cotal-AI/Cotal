/**
 * Codex host turn-loop smoke (no test runner, no model, no real `codex`) — spins up its OWN
 * nats-server and drives the REAL host process (host-main.ts + MeshAgent + AppServerDriver)
 * against a scripted fake `codex app-server` (fake-codex.mjs, via COTAL_CODEX_BIN). Guards the
 * delivery-loop invariants the connector promises:
 *
 *   1. launch surface: argv carries the operator's -c overrides + the autonomy defaults only
 *      where unset; thread/start carries the cotal_* dynamicTools + the persona/mesh
 *      developerInstructions;
 *   2. wake: a DM drives a real turn carrying the rendered batch;
 *   3. ack-on-completion: a completed turn's batch never redelivers;
 *   4. steer: a directed message arriving mid-turn is steered INTO the live turn;
 *   5. interrupt: an interrupted turn's batch is NOT acked and redelivers on the next turn;
 *   6. failed: a failed turn acks-and-drops (no retry loop) and the loop is not wedged;
 *   7. tools: a model-initiated item/tool/call round-trips into the shared cotal_* surface.
 *
 * Run: pnpm smoke:codex-host
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";

if (process.platform === "win32") {
  console.log("SKIP codex host smoke — the fake-binary shim is POSIX (Windows launch is covered by smoke:windows)");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "codexhost";
const PEER = "codexpeer";
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-codexhost-"));
const FAKE = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const BIN = join(dir, "fake-codex");
writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(BIN, 0o755);
const LOG = join(dir, "fake.log.jsonl");

const HOST_ENTRY = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface LogEntry {
  ev: string;
  argv?: string[];
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}
function logEntries(): LogEntry[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry);
}
function turnStarts(): string[] {
  return logEntries()
    .filter((e) => e.ev === "recv" && e.method === "turn/start")
    .map((e) => ((e.params?.input as { text?: string }[] | undefined) ?? []).map((i) => i.text ?? "").join("\n"));
}
async function waitFor<T>(name: string, get: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${name}`);
    await sleep(100);
  }
}

const nats = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

const operator = new CotalEndpoint({
  space,
  servers,
  card: { name: "operator", kind: "agent", id: "operator" },
  channels: ["team"],
});
operator.on("error", () => {});
let online = false;
operator.on("presence", (e: { type: string; presence: { card: { id: string; name: string } } }) => {
  const c = e.presence.card;
  if ((c.id === PEER || c.name === PEER) && e.type !== "offline") online = true;
});

/** DM the peer by its ROSTER id (principal dot-form) — names are not unicast recipients. */
async function dm(text: string): Promise<void> {
  const id = operator.getRoster().find((p) => p.card.name === PEER)?.card.id;
  if (!id) throw new Error(`peer ${PEER} not in the operator's roster yet`);
  await operator.unicast(id, text);
}

let host: ReturnType<typeof spawn> | undefined;
try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await operator.start();

  // Scrub any ambient COTAL_* (e.g. the invoking agent session's own mesh identity) so the
  // host child sees ONLY the identity this smoke assigns.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
  host = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: PEER,
      COTAL_ID: PEER,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ROLE: "coder",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      FAKE_CODEX_LOG: LOG,
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "high",
      COTAL_CODEX_CONFIG: JSON.stringify({ sandbox_mode: '"read-only"' }),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  // (1) launch surface — argv overrides + thread/start payload.
  const argv = await waitFor("fake argv", () => logEntries().find((e) => e.ev === "argv")?.argv);
  check("child argv: operator -c override wins", argv.join(" ").includes('sandbox_mode="read-only"'), argv);
  check("child argv: autonomy default appended", argv.join(" ").includes('approval_policy="never"'), argv);
  check(
    "child argv: model + effort selectors ride -c",
    argv.join(" ").includes('model="fake-model"') && argv.join(" ").includes('model_reasoning_effort="high"'),
    argv,
  );
  const threadStart = await waitFor(
    "thread/start",
    () => logEntries().find((e) => e.ev === "recv" && e.method === "thread/start")?.params,
  );
  const toolNames = ((threadStart.dynamicTools as { name: string }[] | undefined) ?? []).map((t) => t.name);
  check(
    "thread/start carries the shared cotal_* tools",
    ["cotal_send", "cotal_dm", "cotal_roster", "cotal_status", "cotal_inbox"].every((n) => toolNames.includes(n)),
    toolNames,
  );
  const instructions = String(threadStart.developerInstructions ?? "");
  check(
    "developerInstructions carry the mesh identity",
    instructions.includes(`"${PEER}"`) && instructions.includes(`"${space}"`),
  );

  for (let i = 0; i < 300 && !online; i++) await sleep(100);
  check("codex host peer comes online", online);

  // (2) wake: a DM drives a turn with the rendered batch.
  await dm("hello-one");
  const t1 = await waitFor("turn 1", () => turnStarts().find((t) => t.includes("hello-one")));
  check("DM wakes a turn carrying the rendered batch", t1.includes("DM from operator"), t1);

  // (3) ack-on-completion: the next turn must NOT re-carry hello-one.
  await sleep(500);
  await dm("hello-two");
  const t2 = await waitFor("turn 2", () => turnStarts().find((t) => t.includes("hello-two")));
  check("completed turn's batch never redelivers", !t2.includes("hello-one"), t2);

  // (4) steer: a directed message mid-turn joins the live turn.
  await sleep(500);
  await dm("SLOW block");
  await waitFor("SLOW turn", () => turnStarts().find((t) => t.includes("SLOW block")));
  await dm("steer-payload");
  const steered = await waitFor("steer", () =>
    logEntries().find(
      (e) =>
        e.ev === "recv" &&
        e.method === "turn/steer" &&
        ((e.params?.input as { text?: string }[] | undefined) ?? []).some((i) => (i.text ?? "").includes("steer-payload")),
    ),
  );
  check("directed message steers into the live turn", steered !== undefined);
  await sleep(1500); // let the SLOW turn complete (acks both)
  await dm("post-steer");
  const t4 = await waitFor("post-steer turn", () => turnStarts().find((t) => t.includes("post-steer")));
  check("steered batch acked with its turn", !t4.includes("steer-payload") && !t4.includes("SLOW block"), t4);

  // (5) interrupt: the batch is NOT acked, so the boundary drive redelivers it immediately —
  // a SECOND turn carrying "HANG now" (the fake's HANG is one-shot, so the redelivery completes).
  await sleep(300);
  await dm("HANG now");
  await waitFor("HANG turn", () => turnStarts().find((t) => t.includes("HANG now")));
  const redelivered = await waitFor("redelivery turn", () =>
    turnStarts().filter((t) => t.includes("HANG now")).length >= 2 ? true : undefined,
  );
  check("interrupted turn's batch redelivers", redelivered === true);
  await dm("after-hang");
  await waitFor("after-hang turn", () => turnStarts().find((t) => t.includes("after-hang")));

  // (6) failed: the batch is NOT acked — the backoff timer retries it (the fake's FAIL is
  // one-shot, so the retry completes and acks), and the loop is not wedged afterwards.
  await sleep(300);
  await dm("FAIL this");
  await waitFor("FAIL turn", () => turnStarts().find((t) => t.includes("FAIL this")));
  const retried = await waitFor("failed-turn retry", () =>
    turnStarts().filter((t) => t.includes("FAIL this")).length >= 2 ? true : undefined,
  );
  check("failed turn's batch retries with backoff (never acked-dropped)", retried === true);
  await dm("after-fail");
  const t6 = await waitFor("post-fail turn", () => turnStarts().find((t) => t.includes("after-fail")));
  check("loop released after the failed batch settled", !t6.includes("FAIL this"), t6);

  // (7) dynamic tool round trip into the shared surface.
  await sleep(300);
  await dm("TOOL:roster please");
  const toolReply = await waitFor("tool reply", () =>
    logEntries().find((e) => e.ev === "toolReply"),
  );
  const replyText = JSON.stringify(toolReply.result ?? "");
  check("item/tool/call round-trips (roster shows the operator)", replyText.includes("operator"), replyText);

  // (8) unexpected app-server death mid-turn: the host must EXIT nonzero (a lingering
  // offline-but-connected endpoint would soak redeliveries no turn can run).
  await sleep(300);
  const hostExit = new Promise<number | null>((r) => host!.on("exit", (code) => r(code)));
  await dm("DIE now");
  const exitCode = await Promise.race([hostExit, sleep(15_000).then(() => "timeout" as const)]);
  check("app-server death kills the host nonzero", typeof exitCode === "number" && exitCode !== 0, exitCode);

  console.log(`\nCODEX HOST SMOKE PASSED ✅  (${pass} checks)`);
} finally {
  host?.kill("SIGTERM");
  await operator.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
