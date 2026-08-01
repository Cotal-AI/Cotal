/**
 * Codex host turn-loop smoke (no test runner, no model, no real `codex`) — spins up its OWN
 * nats-server and drives the REAL host process (host-main.ts + MeshAgent + AppServerDriver)
 * against a scripted fake `codex app-server` (fake-codex.mjs, via COTAL_CODEX_BIN). Guards the
 * delivery-loop invariants the connector promises:
 *
 *   1. launch surface: argv carries the operator's -c overrides + the autonomy defaults only
 *      where unset; the cotal_* tools are wired as a bearer-authenticated MCP server and
 *      thread/start carries the persona/mesh developerInstructions;
 *   2. wake: a DM drives a real turn carrying the rendered batch;
 *   3. ack-on-completion: a completed turn's batch never redelivers;
 *   4. steer: a directed message arriving mid-turn is steered INTO the live turn;
 *   5. interrupt: an interrupted turn's batch is NOT acked and redelivers immediately;
 *   6. failed: a failed turn's batch is NOT acked — it retries with backoff, and the loop
 *      is released afterwards;
 *   7. tools: a model-initiated MCP tools/call round-trips into the shared cotal_* surface,
 *      and the same call without the bearer token is refused;
 *   8. crash: an unexpected app-server death kills the host nonzero (no wedged endpoint);
 *   9. races: a transiently rejected turn/start retries; a steer whose accept collides with
 *      the turn's completion in ONE chunk never loses the message (it redelivers).
 *
 * Run: pnpm smoke:codex-host
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, seedChannelRegistry, isReachable } from "@cotal-ai/core";

if (process.platform === "win32") {
  // Managed Codex agents are POSIX-only by design (the isolated CODEX_HOME symlinks the
  // operator's auth.json — see docs/connect-codex.md), so there is no Windows Codex case in the
  // suite at all. This skip records that limitation; it is not covered elsewhere.
  console.log("SKIP codex host smoke — managed Codex agents are POSIX-only (symlinked auth.json)");
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
let tuiHostRef: ReturnType<typeof spawn> | undefined;
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
    // No tty: this host runs HEADLESS (no TUI), which is the container / `deploy/` shape. The
    // TUI-attached shape is covered by its own spawn below (COTAL_CODEX_TUI=1).
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
  // The cotal_* surface is an MCP server this host serves, NOT client-provided dynamicTools: a
  // dynamic tool is routed to whoever owns the turn, so it would vanish the moment a human typed
  // into the attached TUI. Assert the child is pointed at the endpoint, that its tools are
  // pre-approved (an elicitation nobody is watching would hang a mesh-driven turn forever), and
  // that the bearer token is passed by env NAME so it never lands in the process table.
  const argvStr = argv.join(" ");
  check("child argv: cotal tools wired as an MCP server", /mcp_servers\.cotal\.url="http:\/\/127\.0\.0\.1:\d+\/mcp"/.test(argvStr), argv);
  check(
    "child argv: MCP bearer passed by env NAME, never by value",
    argvStr.includes('mcp_servers.cotal.bearer_token_env_var="COTAL_MCP_TOKEN"'),
    argv,
  );
  check(
    "child argv: cotal's own tools are pre-approved (no unanswerable elicitation)",
    argvStr.includes('mcp_servers.cotal.default_tools_approval_mode="approve"'),
    argv,
  );
  check("thread/start no longer carries dynamicTools", threadStart.dynamicTools === undefined, threadStart.dynamicTools);
  const childEnv = await waitFor("fake env", () => logEntries().find((e) => e.ev === "env"));
  check("child receives the MCP token, and NOTHING else COTAL_*", childEnv.mcpTokenPresent === true && (childEnv.cotalLeak as string[]).length === 0, childEnv);
  check("MCP token never rides argv by value", !/mcp_servers\.cotal\.bearer_token=/.test(argvStr), argv);
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

  // (7) the cotal_* MCP surface: the app-server calls it ITSELF over loopback HTTP, which is why
  // it works identically on a mesh-driven turn and one typed into the attached TUI.
  await sleep(300);
  await dm("TOOL:roster please");
  const toolReply = await waitFor("tool reply", () =>
    logEntries().find((e) => e.ev === "toolReply"),
  );
  const replyText = JSON.stringify(toolReply.result ?? toolReply.error ?? "");
  check("MCP tools/call round-trips (roster shows the operator)", replyText.includes("operator"), replyText);
  const noAuth = await waitFor("unauthenticated tool call", () => logEntries().find((e) => e.ev === "toolReplyNoAuth"));
  check("MCP endpoint refuses a call with no bearer token", noAuth.httpStatus === 401, noAuth);

  // (9a) transiently rejected turn/start: the batch stays un-acked and the backoff retry
  // re-drives it (the fake rejects the first matching RPC only).
  await sleep(300);
  await dm("REJECTSTART go");
  const restarted = await waitFor("turn/start retry", () =>
    logEntries().filter(
      (e) =>
        e.ev === "recv" &&
        e.method === "turn/start" &&
        ((e.params?.input as { text?: string }[] | undefined) ?? []).some((i) => (i.text ?? "").includes("REJECTSTART")),
    ).length >= 2
      ? true
      : undefined,
  );
  check("rejected turn/start retries with backoff", restarted === true);

  // (9b) steer accept colliding with the turn's completion in ONE chunk. The settle barrier
  // makes the outcome DETERMINISTIC: the server wrote the accept before the terminal event
  // (had completion won, expectedTurnId would have REJECTED the steer), so the turn saw the
  // message — the accepted id is promoted and acked exactly once. Assert: steered, acked (no
  // redelivery), and the loop stays healthy afterwards.
  await sleep(300);
  await dm("RACE hold");
  await waitFor("RACE turn", () => turnStarts().find((t) => t.includes("RACE hold")));
  await dm("race-steer");
  await waitFor("race steer accepted", () =>
    logEntries().find(
      (e) =>
        e.ev === "recv" &&
        e.method === "turn/steer" &&
        ((e.params?.input as { text?: string }[] | undefined) ?? []).some((i) => (i.text ?? "").includes("race-steer")),
    ),
  );
  await sleep(1200); // settle: any (wrong) redelivery would surface here
  check(
    "raced steer is acked exactly once (accept happened-before completion; no redelivery)",
    !turnStarts().some((t) => t.includes("race-steer")),
  );
  await dm("post-race");
  await waitFor("post-race turn", () => turnStarts().find((t) => t.includes("post-race")));
  check("loop healthy after the raced steer", true);

  // (9c) turn/start response + turn/started + turn/completed in ONE chunk: the response-side
  // continuation must NOT resurrect the just-completed turn (which would wedge the loop busy
  // forever). Proof: the NEXT DM must still drive a turn.
  await sleep(300);
  await dm("SAMECHUNK once");
  await waitFor("same-chunk turn", () => turnStarts().find((t) => t.includes("SAMECHUNK")));
  await sleep(500);
  await dm("after-samechunk");
  const t9c = await waitFor("post-samechunk turn", () => turnStarts().find((t) => t.includes("after-samechunk")));
  check("same-chunk terminal does not wedge the loop (next DM drives)", t9c !== undefined);

  // (10) transport: the app-server runs as an AUTHENTICATED loopback websocket LISTENER, not a
  // private stdio pipe. The listener is what makes the real Codex TUI attachable to this very
  // thread; the capability token is what stops any OTHER local process from driving the agent
  // through it (the listener has no auth of its own).
  const argvText = argv.join(" ");
  check("child argv: the app-server listens on a loopback websocket", argvText.includes("--listen ws://127.0.0.1:0"), argv);
  check(
    "child argv: the listener demands a capability token",
    argvText.includes("--ws-auth capability-token") && argvText.includes("--ws-token-file"),
    argv,
  );
  check("the host connected with a valid token", logEntries().some((e) => e.ev === "connected"));
  check(
    "no unauthenticated connection was ever accepted",
    !logEntries().some((e) => e.ev === "unauthorized"),
    logEntries().filter((e) => e.ev === "unauthorized"),
  );
  const tokenPath = argv[argv.indexOf("--ws-token-file") + 1];
  check(
    "the token file is owner-only (0600)",
    (statSync(tokenPath).mode & 0o777) === 0o600,
    (statSync(tokenPath).mode & 0o777).toString(8),
  );
  check(
    "the thread is primed, so the TUI can attach before the first mesh turn",
    logEntries().some((e) => e.ev === "recv" && e.method === "thread/inject_items"),
  );

  // (8) unexpected app-server death mid-turn. The manager RETIRES a lifecycle on process exit
  // (freeSlot → deprovision) rather than restarting it, and a same-name successor gets a fresh
  // delivery frontier — so a host that exited here would STRAND the un-acked in-flight batch.
  // The host must instead restart the CHILD on the same mesh lifecycle and re-drive that batch.
  // Proof: the host stays alive, a SECOND app-server process boots, and the same message text
  // starts a new turn that completes — end to end, not just "the host exited nonzero".
  await sleep(300);
  const boots = () => logEntries().filter((e) => e.ev === "argv").length;
  const bootsBefore = boots();
  const startsBefore = turnStarts().filter((t) => t.includes("DIE now")).length;
  let hostExited: number | null | "alive" = "alive";
  host!.on("exit", (code) => (hostExited = code));
  await dm("DIE now");
  await waitFor("app-server death recorded", () => logEntries().find((e) => e.ev === "died"));
  await waitFor("app-server respawned (second boot)", () => (boots() > bootsBefore ? true : undefined));
  check("host SURVIVES the app-server crash (lifecycle preserved)", hostExited === "alive", hostExited);
  // The un-acked batch re-drives into the NEW thread — this is the redelivery the docs promise.
  await waitFor(
    "crashed batch re-driven on the restarted thread",
    () => (turnStarts().filter((t) => t.includes("DIE now")).length > startsBefore ? true : undefined),
  );
  check("un-acked crashed batch redelivers to the SAME incarnation", true);
  // ...and the loop is healthy afterwards: a fresh DM still drives a turn on the new thread.
  await dm("post-crash");
  const t8 = await waitFor("post-crash turn", () => turnStarts().find((t) => t.includes("post-crash")));
  check("turn loop healthy after the restart", t8 !== undefined);
  check("host still alive after recovery", hostExited === "alive", hostExited);
  // The MCP endpoint belongs to the HOST, not the app-server, so it outlives the crash — and the
  // brand-new child must still be able to authenticate to it (fresh process, same bearer env).
  const toolRepliesBefore = logEntries().filter((e) => e.ev === "toolReply").length;
  await dm("TOOL:roster after crash");
  const postCrashTool = await waitFor("tool reply on the restarted app-server", () =>
    logEntries().filter((e) => e.ev === "toolReply").length > toolRepliesBefore
      ? logEntries().filter((e) => e.ev === "toolReply").at(-1)
      : undefined,
  );
  check(
    "cotal tools still reachable after an app-server restart (endpoint outlives the child)",
    JSON.stringify(postCrashTool.result ?? postCrashTool.error ?? "").includes("operator"),
    postCrashTool,
  );

  // (8b) the restart budget is BOUNDED: a codex that dies every incarnation is a crash loop, and
  // the host must give up loudly rather than respawn forever (an endless silent respawn would
  // hold a live mesh identity in front of a Codex that can never run a turn).
  const looper = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: "looppeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      FAKE_CODEX_DIE_ALWAYS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let loopErr = "";
  looper.stderr!.setEncoding("utf8");
  looper.stderr!.on("data", (d: string) => (loopErr += d));
  const loopExit = await Promise.race([
    new Promise<number | null>((r) => looper.on("exit", (code) => r(code))),
    sleep(30_000).then(() => "timeout" as const),
  ]);
  check("crash LOOP is fatal, not an endless respawn", typeof loopExit === "number" && loopExit !== 0, {
    loopExit,
    err: loopErr.slice(-200),
  });
  check(
    "the fatal names the crash loop, and only the bounded number of restarts were attempted",
    /crashes in \d+s/.test(loopErr) && (loopErr.match(/restarting it \(/g) ?? []).length === 3,
    { restarts: (loopErr.match(/restarting it \(/g) ?? []).length, err: loopErr.slice(-300) },
  );

  // (10) auth honesty: a codex reporting NO credentials (and no OPENAI_API_KEY) must refuse to
  // join the mesh at startup — never advertise online and fail only at the first model turn.
  const noauthLog = join(dir, "noauth.log.jsonl");
  const noauthEnv: NodeJS.ProcessEnv = { ...cleanEnv };
  delete noauthEnv.OPENAI_API_KEY;
  const noauth = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...noauthEnv,
      COTAL_SPACE: space,
      COTAL_NAME: "noauthpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      FAKE_CODEX_LOG: noauthLog,
      FAKE_CODEX_NOAUTH: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let noauthErr = "";
  noauth.stderr!.setEncoding("utf8");
  noauth.stderr!.on("data", (d: string) => (noauthErr += d));
  let noauthEverOnline = false;
  const onNoauthPresence = (e: { type: string; presence: { card: { name: string } } }): void => {
    if (e.presence.card.name === "noauthpeer" && e.type !== "offline") noauthEverOnline = true;
  };
  operator.on("presence", onNoauthPresence);
  const noauthExit = await Promise.race([
    new Promise<number | null>((r) => noauth.on("exit", (code) => r(code))),
    sleep(20_000).then(() => "timeout" as const),
  ]);
  await sleep(500); // let any (erroneous) presence propagate
  operator.off("presence", onNoauthPresence);
  check(
    "unauthenticated codex refuses to join the mesh (fatal at startup)",
    typeof noauthExit === "number" && noauthExit !== 0 && /no credentials/.test(noauthErr),
    { noauthExit, err: noauthErr.slice(-200) },
  );
  check("unauthenticated codex NEVER advertised online (auth validated before presence)", !noauthEverOnline);
  // A refused launch must not strand its app-server. Unlike the old stdio child, a LISTENING
  // app-server is not tied to the host's lifetime — nothing closes when the host's pipes do — so
  // a fatal that skipped the explicit teardown would orphan a codex holding a port and the
  // agent's isolated home, once per failed launch.
  const orphanPid = (
    !existsSync(noauthLog)
      ? []
      : readFileSync(noauthLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { ev: string; pid?: number })
  ).find((e) => e.ev === "argv")?.pid;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && orphanPid && alive(orphanPid); i++) await sleep(100);
  check(
    "a refused launch takes its app-server down with it (no orphaned codex)",
    orphanPid !== undefined && !alive(orphanPid),
    { orphanPid },
  );

  // (12) the Codex TUI. `cotal spawn --agent codex` must land the operator in Codex proper,
  // attached to the SAME thread the mesh drives — not a private session of its own, which would
  // be mute on the mesh. Proven on the wire: the host launches `codex resume --remote <url>` with
  // the thread id it started, and hands the capability token by ENV NAME rather than on argv
  // (argv is world-readable in the process table). Then the operator closes the UI, and the agent
  // must leave the mesh cleanly rather than linger headless with nobody watching.
  const tuiLog = join(dir, "tui.log.jsonl");
  let tuiOnline = false;
  let tuiDeparted = false;
  const onTuiPresence = (e: { type: string; presence: { card: { name: string } } }): void => {
    if (e.presence.card.name !== "tuipeer") return;
    if (e.type === "offline") tuiDeparted = true;
    else tuiOnline = true;
  };
  operator.on("presence", onTuiPresence);
  const tuiHost = (tuiHostRef = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: "tuipeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      FAKE_CODEX_LOG: tuiLog,
      COTAL_CODEX_TUI: "1", // force the TUI path: this smoke has no tty to detect
      FAKE_CODEX_TUI_EXIT: "1", // ...and the "operator quit the UI" path
    },
    stdio: ["ignore", "ignore", "inherit"],
  }));
  const tuiEntries = (): LogEntry[] =>
    !existsSync(tuiLog)
      ? []
      : readFileSync(tuiLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as LogEntry);
  const tuiLaunch = await waitFor("codex TUI launch", () => tuiEntries().find((e) => e.ev === "tui"), 30_000);
  const tuiArgv = (tuiLaunch.argv ?? []) as string[];
  const startedThread = tuiEntries().find((e) => e.ev === "recv" && e.method === "thread/start");
  check("the host launches the real Codex TUI (codex resume --remote)", tuiArgv[0] === "resume" && tuiArgv.includes("--remote"), tuiArgv);
  check(
    "the TUI is pointed at the app-server the host drives",
    /^ws:\/\/127\.0\.0\.1:\d+$/.test(tuiArgv[tuiArgv.indexOf("--remote") + 1] ?? ""),
    tuiArgv,
  );
  check(
    "the TUI resumes the host's OWN thread (not a private one)",
    startedThread !== undefined && tuiArgv[tuiArgv.length - 1] === "t_fake",
    tuiArgv,
  );
  check(
    "the capability token reaches the TUI by env name, never on argv",
    typeof (tuiLaunch as { tokenFromEnv?: string | null }).tokenFromEnv === "string" &&
      !tuiArgv.some((a) => a === (tuiLaunch as { tokenFromEnv?: string }).tokenFromEnv),
    tuiArgv,
  );
  check("the TUI never sits on the interactive update gate", tuiArgv.includes("check_for_update_on_startup=false"), tuiArgv);
  const tuiExit = await Promise.race([
    new Promise<number | null>((r) => tuiHost.on("exit", (code) => r(code))),
    sleep(20_000).then(() => "timeout" as const),
  ]);
  await sleep(500);
  operator.off("presence", onTuiPresence);
  check("closing the Codex TUI exits the host cleanly", tuiExit === 0, { tuiExit });
  check("closing the Codex TUI leaves the mesh (departure published)", tuiOnline && tuiDeparted, { tuiOnline, tuiDeparted });

  // (11) cooperative shutdown must complete the CLEAN MESH LEAVE before the process exits.
  // shutdown() kills the child ITSELF, so the child's `closed` event fires while that promise is
  // still running — and the closed handler must not race it to process.exit. Pinned rather than
  // raced: this peer's fake dies the instant it is interrupted, so `closed` lands while
  // shutdown() is still inside interrupt()/stop(), strictly BEFORE it publishes offline. A
  // closed-handler exit would therefore always win, and the endpoint would never depart.
  const shutLog = join(dir, "shut.log.jsonl");
  let shutOnline = false;
  let offlineWhileAlive = false;
  let shutHost: ReturnType<typeof spawn> | undefined;
  const onBye = (e: { type: string; presence: { card: { name: string } } }): void => {
    if (e.presence.card.name !== "shutpeer") return;
    if (e.type !== "offline") {
      shutOnline = true;
      return;
    }
    // The real assertion: the departure was published while the process was STILL ALIVE. A
    // closed-handler exit that beat the offline publish cannot produce this, and neither can a
    // presence TTL expiring after the process is long gone.
    offlineWhileAlive = shutHost?.exitCode === null && shutHost?.signalCode === null;
  };
  operator.on("presence", onBye);
  shutHost = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: "shutpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      COTAL_CODEX_PROMPT: "SLOW shutdown-window", // a turn is live the moment it is ready
      FAKE_CODEX_LOG: shutLog,
      FAKE_CODEX_DIE_ON_INTERRUPT: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const shutEntries = (): LogEntry[] =>
    existsSync(shutLog)
      ? readFileSync(shutLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry)
      : [];
  // JOIN BARRIER, not optional: if the operator never saw this peer online, core treats its
  // departure as a first-seen-offline stale snapshot and records it QUIETLY, emitting no offline
  // presence event — so the assertion below would fail on a healthy leave. Wait for the join.
  await waitFor("shutdown: peer seen online by the operator", () => (shutOnline ? true : undefined));
  await waitFor("shutdown: a turn is live", () =>
    shutEntries().find((e) => e.ev === "recv" && e.method === "turn/start"),
  );
  shutHost.kill("SIGTERM");
  const shutdownExit = await Promise.race([
    new Promise<number | null>((r) => shutHost!.on("exit", (code) => r(code))),
    sleep(15_000).then(() => "timeout" as const),
  ]);
  await sleep(700); // let the departure propagate to the operator
  operator.off("presence", onBye);
  check("shutdown: the child really did die first (ordering pinned)", !!shutEntries().find((e) => e.ev === "died"));
  check("cooperative shutdown exits cleanly (0)", shutdownExit === 0, shutdownExit);
  check(
    "cooperative shutdown leaves the mesh while STILL ALIVE (child death never short-circuits it)",
    offlineWhileAlive,
  );

  // (11b) ...but the clean leave is BOUNDED. Interrupting the live turn ends it, and that
  // boundary would re-drive the un-acked batch into a child being stopped; with an unreachable
  // broker the departure never completes either. A peer that never exits just waits for the
  // manager to SIGKILL it. So: shut down a peer whose broker is already gone and require a
  // prompt exit anyway.
  const hangLog = join(dir, "hang.log.jsonl");
  const hangHost = spawn(TSX, [HOST_ENTRY], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: "hangpeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      COTAL_CODEX_PROMPT: "SLOW hang-window",
      FAKE_CODEX_LOG: hangLog,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor("bounded shutdown: a turn is live", () =>
    existsSync(hangLog) && readFileSync(hangLog, "utf8").includes('"turn/start"') ? true : undefined,
  );
  nats.kill("SIGKILL"); // the broker is gone before the shutdown starts
  await sleep(300);
  const hangStart = Date.now();
  hangHost.kill("SIGTERM");
  const hangExit = await Promise.race([
    new Promise<number | null>((r) => hangHost.on("exit", (code) => r(code))),
    sleep(20_000).then(() => "timeout" as const),
  ]);
  check(
    "shutdown with the broker gone still exits promptly (bounded, no wait-for-SIGKILL)",
    hangExit === 0 && Date.now() - hangStart < 15_000,
    { hangExit, ms: Date.now() - hangStart },
  );

  console.log(`\nCODEX HOST SMOKE PASSED ✅  (${pass} checks)`);
} finally {
  host?.kill("SIGTERM");
  tuiHostRef?.kill("SIGTERM");
  // Case (11b) kills the broker on purpose, so bound the operator's own drain — teardown must
  // never be the thing that hangs the smoke.
  await Promise.race([operator.stop().catch(() => {}), sleep(3_000)]);
  nats.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
