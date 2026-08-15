/**
 * A REFUSAL MUST REACH THE **REAL OPENCODE HOST** AS A FAILURE.
 *
 * This is the named merge precondition, and it is the one thing the adapter-function cells cannot
 * see: whether OpenCode itself turns a thrown `execute` into a failed tool call, or swallows it.
 *
 * WHAT IS REAL HERE: the real `opencode` binary (`serve`, via the connector's own `dist/serve.js`
 * shim in its shipped COTAL_SERVE_HEADLESS mode), the real `dist/plugin.bundle.js` the connector
 * injects, a real nats-server, and a real model turn. The ONLY stand-in is the model provider —
 * a local, offline OpenAI-compatible server whose turn script is fixed, so no external traffic and
 * no sampling. The tool call it emits is executed by OpenCode, not by this file.
 *
 * REFUTATION CONDITIONS, registered BEFORE any result is cited:
 *  - REFUTED if the host never executes `cotal_disconnect` (no such tool part) — the probe would be
 *    asserting against a turn that never reached the tool, which is a pass by measuring nothing.
 *  - REFUTED if the CONTROL (the first, SUCCEEDING disconnect) also lands in an error state — then
 *    the host errors on everything and the second arm proves nothing about refusals.
 *  - REFUTED if the broker never sees a client connection — the agent would have refused with
 *    `not-connected` on BOTH calls and the two arms would be the same call twice.
 *  - The paired PRE-FIX run (`--bundle <mutant>`, adapter flattening restored) must show the SAME
 *    second call in a NON-error state. If it errors there too, the host, not the adapter, decides,
 *    and the change is not what makes the difference.
 *
 * WHAT THE TWO ARMS PROVED, when this was run against the adapter change that introduced
 * `resolveOrThrow` — same script, same turn, same session, only the bundle differs:
 *
 *   FIXED    call 1 (disconnect, succeeds) → state.status "completed"
 *            call 2 (refusal)              → state.status "error", state.error
 *                                            `Refused [not-connected]: this endpoint is already
 *                                             off the mesh - nothing to disconnect`      5/5
 *   PRE-FIX  call 1                        → "completed"  (identical)
 *            call 2                        → "completed", output `⚠ Refused [not-connected]: …`
 *                                            — a host SUCCESS                            3/5
 *                                            red on exactly OH1 and OH2, as predicted
 *   Broker witness, both arms: connections 1 before the turn → 0 after, cumulative
 *   total_connections 1, so the disconnect was real at the broker and nothing re-dialled.
 *
 * The CONTROL is green in both arms. That is what makes the difference attributable to the adapter
 * rather than to the host.
 *
 * NOT WIRED. This is not part of `pnpm smoke`, `pnpm smoke:ci`, or any gate: it launches an
 * external binary (`opencode`, resolved from PATH by the connector's own shim) and a loopback model
 * provider. It is committed so the apparatus survives, with its provenance, for whoever argues for
 * an E2E stage later.
 *
 * RUN IT (needs `opencode` and `nats-server` on PATH, and the connector built —
 * `pnpm --filter @cotal-ai/connector-opencode build`, which produces dist/plugin.bundle.js and
 * dist/serve.js):
 *
 *   node extensions/connector-opencode/probes/real-host-refusal.mjs
 *   node extensions/connector-opencode/probes/prefix-bundle.mjs /tmp/prefix.bundle.js
 *   node extensions/connector-opencode/probes/real-host-refusal.mjs --bundle /tmp/prefix.bundle.js
 *
 * The first must print OK (5/5). The second must FAIL on OH1 and OH2 and on nothing else — a
 * pre-fix arm that passes means the probe is no longer measuring the adapter.
 *
 * IT STARTS REAL PROCESSES AND CLEANS UP FROM EVERY CATCHABLE PATH. Teardown runs from the
 * `finally` and from SIGINT/SIGTERM/SIGHUP handlers, and is idempotent so both firing is fine.
 * Measured, not asserted: signalled mid-run it left ZERO survivors and removed its scratch, where
 * the same probe with teardown only in the `finally` left a live `opencode serve`, a live
 * `nats-server` and the directory. A SIGKILL still leaks — see README.md for how to confirm what
 * is yours from the process environment.
 *
 * Local-only: loopback broker, loopback provider, loopback opencode server. No external calls.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startProvider, MARKER } from "./offline-provider.mjs";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

const argBundle = process.argv.includes("--bundle") ? process.argv[process.argv.indexOf("--bundle") + 1] : undefined;
const CONNECTOR = fileURLToPath(new URL("../", import.meta.url));
const BUNDLE = resolve(argBundle ?? join(CONNECTOR, "dist", "plugin.bundle.js"));
const SERVE = join(CONNECTOR, "dist", "serve.js");
const LABEL = process.env.PROBE_LABEL ?? (argBundle ? "PRE-FIX" : "FIXED");
for (const [what, p] of [["plugin bundle", BUNDLE], ["serve shim", SERVE]])
  if (!existsSync(p))
    throw new Error(`no ${what} at ${p} — build the connector first (see probes/README.md)`);

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

const NATS_PORT = await freePort();
const MON_PORT = await freePort();
const SERVER = `nats://127.0.0.1:${NATS_PORT}`;
if (SERVER.includes("broker.cotal.ai")) throw new Error(`REFUSING: ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVER)) throw new Error(`REFUSING: ${SERVER} is not loopback`);
console.log(`[safety] broker ${SERVER} — asserted not broker.cotal.ai, loopback only; inherited COTAL_* deleted`);
console.log(`[probe] arm=${LABEL} bundle=${BUNDLE}`);

let pass = 0, fail = 0;
const ran = [];
const check = (name, cond, extra) => {
  ran.push(name);
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, JSON.stringify(extra ?? null)); }
};
const DECLARED = ["OH-broker", "OH-exec", "OH-ctl", "OH1", "OH2"];
const rollCall = () => {
  const hit = (n) => DECLARED.some((id) => n === id || n.startsWith(`${id} `));
  const evaluated = DECLARED.filter((id) => ran.some((n) => n === id || n.startsWith(`${id} `)));
  const missing = DECLARED.filter((id) => !evaluated.includes(id));
  const undeclared = ran.filter((n) => !hit(n));
  console.log(`\n  ROLL CALL: ${DECLARED.length} declared — ${evaluated.length} EVALUATED, ${missing.length} NEVER RAN.`);
  if (missing.length) { console.log(`  ⚠ NEVER RAN: ${missing.join(", ")}`); process.exitCode = 1; }
  if (undeclared.length) { console.log(`  ⚠ UNDECLARED: ${undeclared.join(" | ")}`); process.exitCode = 1; }
  if (!missing.length && !undeclared.length) console.log(`  ✓ all ${DECLARED.length} declared cells were EVALUATED.`);
};

/** EVERYTHING THIS RUN OWNS, so teardown can reach it from ANY exit path.
 *
 *  Cleanup that lives only in a `finally` does not exist on the paths that matter: a SIGTERM, a
 *  closed terminal, or an outer `timeout` kills the runner outside the block and leaves a real
 *  `opencode serve` and a real `nats-server` behind. That is not hypothetical — it is how this
 *  probe's own reconnaissance run leaked a serve. So the registry is filled in as things are
 *  created, the teardown reads it, and both the signal handlers and the `finally` call the SAME
 *  teardown. */
const owned = { scratch: undefined, nats: undefined, serve: undefined, prov: undefined };

/** IDEMPOTENT BY CONSTRUCTION: both paths can now fire — a signal during the normal exit, or a
 *  handler that runs and then falls through to the `finally`. The first call memoizes the promise
 *  and every later call awaits that same one, so nothing is killed twice and nobody returns before
 *  the teardown that is actually running has finished. Each step is independently guarded: a dead
 *  pid, an already-closed server and a missing directory are all normal here. */
let teardownRun;
const teardown = () => (teardownRun ??= (async () => {
  const reap = async (child) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone, or never a group leader */ }
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(150);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone between the two signals */ }
    }
  };
  await reap(owned.serve);
  await reap(owned.nats);
  try { owned.prov?.close(); } catch { /* already closed */ }
  await sleep(300);
  if (owned.scratch) { try { rmSync(owned.scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
})());

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`\n[probe] ${sig} — tearing down (serve, broker, scratch) before exit`);
    void teardown().then(() => process.exit(sig === "SIGINT" ? 130 : 143));
  });
}

const scratch = mkdtempSync(join(tmpdir(), "cotal-ochost-"));
owned.scratch = scratch;
const home = join(scratch, "home");
const wsroot = join(scratch, "ws");
mkdirSync(join(home, ".cache", "opencode"), { recursive: true });
mkdirSync(wsroot, { recursive: true });
const realModels = join(process.env.HOME, ".cache", "opencode", "models.json");
if (existsSync(realModels)) cpSync(realModels, join(home, ".cache", "opencode", "models.json"));

writeFileSync(join(scratch, "nats.conf"), `port: ${NATS_PORT}\nhttp_port: ${MON_PORT}\njetstream { store_dir: "${scratch}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(scratch, "nats.conf")], { stdio: "ignore", detached: true });
owned.nats = nats;

const prov = await startProvider([
  { tool: "cotal_disconnect", args: {} },
  { tool: "cotal_disconnect", args: {} },
  { text: "both calls made" },
]);
owned.prov = prov;

const config = {
  $schema: "https://opencode.ai/config.json",
  permission: "allow",
  plugin: [BUNDLE],
  provider: {
    probe: {
      npm: "@ai-sdk/openai-compatible",
      name: "probe",
      options: { baseURL: prov.url, apiKey: "local" },
      models: { "probe-model": { name: "probe-model", tools: true } },
    },
  },
  model: "probe/probe-model",
};

const serveEnv = {
  PATH: process.env.PATH,
  HOME: home,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  COTAL_SERVE_HEADLESS: "1",
  COTAL_OPENCODE_HOME: wsroot,
  COTAL_SPACE: "ochost",
  COTAL_NAME: "subject",
  COTAL_ROLE: "worker",
  COTAL_SERVERS: SERVER,
  COTAL_SUBSCRIBE: "general",
  COTAL_ALLOW_SUBSCRIBE: "general",
  COTAL_ALLOW_PUBLISH: "general",
  COTAL_CAPABILITIES: "connection",
};

const serve = spawn(process.execPath, [SERVE], { cwd: wsroot, env: serveEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
owned.serve = serve;
let handshake;
let serveLog = "";
const onData = (d) => {
  const s = d.toString();
  serveLog += s;
  const m = s.match(/\[cotal-serve\] (\{.*\})/);
  if (m && !handshake) handshake = JSON.parse(m[1]);
};
serve.stdout.on("data", onData);
serve.stderr.on("data", onData);

const varz = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${MON_PORT}/varz`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return undefined; }
};

const summary = { arm: LABEL, tools: [] };

try {
  for (let i = 0; i < 400 && !handshake; i++) await sleep(500);
  if (!handshake) throw new Error(`the connector's headless serve never handshook.\n--- serve output ---\n${serveLog.slice(-4000)}`);
  console.log(`[probe] serve up: port=${handshake.port} plugin-session=${handshake.session}`);

  // The mesh link must be REAL before the first disconnect, or both calls refuse identically.
  let v;
  for (let i = 0; i < 120; i++) { v = await varz(); if ((v?.connections ?? 0) >= 1) break; await sleep(500); }
  check("OH-broker the broker sees the agent's client connection before the turn, so the two calls below are a connected→disconnected pair and not the same refusal twice",
    (v?.connections ?? 0) >= 1, { connections: v?.connections, total: v?.total_connections });

  const auth = "Basic " + Buffer.from(`opencode:${handshake.password}`).toString("base64");
  const api = async (path, init, timeoutMs = 180_000) => {
    const res = await fetch(`http://127.0.0.1:${handshake.port}${path}`, {
      ...init,
      headers: { authorization: auth, "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, text, json };
  };

  const preTurn = await varz();
  console.log(`[probe] broker connections immediately before the turn: ${preTurn?.connections}`);
  const made = await api("/session", { method: "POST", body: "{}" });
  const sid = made.json?.id;
  if (!sid) throw new Error(`could not create a session: ${made.status} ${made.text.slice(0, 300)}`);

  const turn = await api(`/session/${encodeURIComponent(sid)}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: `${MARKER} Call the cotal_disconnect tool now, then call it again.` }] }),
  });
  // The turn spans several assistant messages (one per step), and the POST returns only the last —
  // read the whole thread back, which is also what any host UI would render.
  const thread = await api(`/session/${encodeURIComponent(sid)}/message`, {}, 30_000);
  const parts = (Array.isArray(thread.json) ? thread.json : []).flatMap((m) => m.parts ?? []);
  const calls = parts.filter((p) => p.type === "tool" && p.tool === "cotal_disconnect");
  summary.turnStatus = turn.status;
  summary.tools = calls.map((c) => ({
    status: c.state?.status,
    error: c.state?.error,
    output: typeof c.state?.output === "string" ? c.state.output.slice(0, 300) : c.state?.output,
  }));
  console.log(`[probe] provider turns=${prov.turns()} tool parts=${calls.length}`);
  console.log(`[probe] ${JSON.stringify(summary.tools, null, 2)}`);

  check("OH-exec the REAL OpenCode host executed cotal_disconnect twice in one turn, so the cells below measure the host and not this file",
    calls.length >= 2, { parts: parts.map((p) => `${p.type}:${p.tool ?? ""}`), status: thread.status, body: thread.text.slice(0, 400) });

  const [first, second] = calls;
  check("OH-ctl CONTROL: the SUCCEEDING disconnect completes at the REAL OpenCode host — so OH1's arms can differ",
    first?.state?.status === "completed", first?.state);

  check("OH1 the REFUSAL is an ERROR at the REAL OpenCode host — before the adapter change it resolved as ordinary content and the host called it a success",
    second?.state?.status === "error", second?.state);

  // Read `state.error`, NOT the whole state: in the PRE-FIX arm the same text sits in `state.output`
  // on a COMPLETED call, so a cell that greps the whole object passes in both arms and discriminates
  // nothing.
  check("OH2 the named condition arrives in the host's ERROR field, so a caller that reads only failures still gets it",
    /\[not-connected\]/.test(String(second?.state?.error ?? "")), second?.state);

  const after = await varz();
  summary.varz = { before: v?.connections, after: after?.connections, totalAfter: after?.total_connections };
  console.log(`[probe] broker connections before=${v?.connections} after=${after?.connections} (cumulative total=${after?.total_connections})`);
} catch (e) {
  fail++;
  console.log("PROBE ERROR:", e.message);
  process.exitCode = 1;
} finally {
  rollCall();
  console.log(`\nREAL-OPENCODE-HOST [${LABEL}] ${fail === 0 && !process.exitCode ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  console.log(`[summary] ${JSON.stringify(summary)}`);
  console.log(`--- serve output (tail) ---\n${serveLog.slice(-2500)}`);
  await teardown(); // the SAME teardown the signal handlers call
  process.exit(process.exitCode ?? (fail ? 1 : 0));
}
