/**
 * A `once` task through both OpenCode plugins, against a fake OpenCode server and a scripted manager.
 *
 * A once task is handed to OpenCode at most once. The drive claims it right before the submission,
 * confirms it when the submission lands, and releases it when the submission fails, which seals it
 * and reports `turn-unconfirmed`. A claimed task is not offered to a native prompt meanwhile, and a
 * native prompt that carries a pending task confirms it. The 1.x plugin registers its own teardown
 * as the exit a once seat takes when its report cannot land.
 *
 * The manager is the agent's `managerInvoke`, replaced for the run: `turn-pending` serves the rows
 * below and `turn-unconfirmed` records each report. The mesh is a real nats-server.
 *
 * Run: pnpm smoke:opencode-once
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "@cotal-ai/connector-core";
import { bootPlugin, bootPlugin2, fakeOpenCode2Context, disposeInProcess } from "./_boot-plugin.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5_000) => {
  for (let i = 0; i < ms / 50 && !cond(); i++) await sleep(50);
};

// ── The scripted manager.
type Row = { goalId: string; payload: string; acceptedAt: number; once: true };
const onceRow = (goalId: string, prompt: string): Row => ({
  goalId, payload: JSON.stringify({ context: prompt, once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true,
});
const pending = new Map<string, Row[]>();
const reports: Array<{ name: string; goalId: unknown }> = [];
const agents = new Map<string, MeshAgent>();
const nameOf = (a: MeshAgent) => (a as unknown as { config: { name: string } }).config.name;
(MeshAgent.prototype as unknown as { managerInvoke: (this: MeshAgent, command: string, args?: Record<string, unknown>) => Promise<unknown> }).managerInvoke =
  async function (command, args) {
    const name = nameOf(this);
    agents.set(name, this);
    if (command === "turn-pending") return { ok: true, data: { turns: [...(pending.get(name) ?? [])], notices: true } };
    if (command === "turn-unconfirmed") {
      reports.push({ name, goalId: args?.goalId });
      pending.set(name, (pending.get(name) ?? []).filter((r) => r.goalId !== args?.goalId));
      return { ok: true, data: { goalId: args?.goalId, state: "failed" } };
    }
    return { ok: false, error: `unscripted manager command ${command}`, code: "refused" };
  };
const pull = (name: string) => (agents.get(name) as unknown as { requestTurnPull(): void }).requestTurnPull();
const offer = (name: string, row: Row) => { pending.set(name, [...(pending.get(name) ?? []), row]); pull(name); };

const registry = () => (globalThis as Record<symbol, { handoffs: Map<string, { state: string }>; exit?: () => void }>)[Symbol.for("cotal.once-handoff")];
const stateOf = (uid: string, goalId: string) => registry()?.handoffs.get(`${uid}:${goalId}`)?.state ?? "pending";

// ── The fake OpenCode server: 1.x and 2.x routes, each submission recorded. `next` scripts the
// answer to the next submission: a status, and an optional hold before it.
const SID = "ses_once";
const SID2 = "ses_once2";
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
const prompts: string[] = [];
let next: { status: number; hold?: Promise<void> } | undefined;
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/session") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: SID }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/session") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: SID2 } }));
      return;
    }
    if (req.method === "POST" && (req.url === `/session/${SID}/prompt_async` || req.url === `/api/session/${SID2}/prompt`)) {
      const body = JSON.parse(raw) as { parts?: { text?: string }[]; text?: string };
      prompts.push(body.text ?? body.parts?.map((p) => p.text ?? "").join("\n") ?? "");
      const answer = next ?? { status: 204 };
      next = undefined;
      await answer.hold;
      res.writeHead(answer.status).end();
      return;
    }
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocUrl = `http://127.0.0.1:${(oc.address() as { port: number }).port}`;

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "oconce";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const managerInstance = mintLifecycleUid();
const seatEnv = (name: string, uid: string) => {
  for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
  Object.assign(process.env, {
    COTAL_NAME: name, COTAL_ID: name.toLowerCase(), COTAL_SPACE: space, COTAL_SERVERS: servers,
    COTAL_ROLE: "generalist", COTAL_LIFECYCLE_UID: uid, COTAL_MANAGER_INSTANCE: managerInstance,
    COTAL_OPENCODE_SERVER_URL: ocUrl, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "test-secret",
  });
};
const TASK = "started this seat for one task";
const pub = new CotalEndpoint({ space, servers, card: { name: "Pubby", kind: "agent", id: "pubby" }, channels: [] });
pub.on("error", () => {});

type Hooks = Awaited<ReturnType<typeof bootPlugin>>;
let hooks: Hooks | undefined;
let dispose2: (() => Promise<void>) | void = undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await pub.start();

  // ── 1.x
  const uid = mintLifecycleUid();
  seatEnv("Una", uid);
  pending.set("Una", [onceRow("g1", "write the release note")]);
  hooks = await bootPlugin();
  const fire = (event: unknown) => hooks!.event!({ event } as never);
  const chatMessage = (text: string) => {
    const output = { parts: [{ type: "text", text }] };
    return (hooks as unknown as { "chat.message": (i: unknown, o: typeof output) => Promise<void> })["chat.message"]({ sessionID: SID }, output).then(() => output.parts[0]!.text);
  };

  await until(() => prompts.length >= 1);
  check("1.x: a once task pending at boot drives one submission that carries it", prompts.length === 1 && prompts[0]!.includes(TASK) && prompts[0]!.includes("write the release note"), prompts);
  await until(() => stateOf(uid, "g1") === "confirmed");
  check("1.x: the landed submission confirms the handoff", stateOf(uid, "g1") === "confirmed", stateOf(uid, "g1"));

  await fire({ type: "session.idle", properties: { sessionID: SID } });
  const unaId = pub.getRoster().find((p) => p.card.name === "Una")?.card.id;
  if (!unaId) throw new Error("once-handoff: Una not in the roster");
  await pub.unicast(unaId, "a later dm");
  await until(() => prompts.length >= 2);
  check("1.x: a later drive does not carry the confirmed task again", prompts.length === 2 && prompts[1]!.includes("a later dm") && !prompts[1]!.includes(TASK), prompts);
  await fire({ type: "session.idle", properties: { sessionID: SID } });
  check("1.x: a native prompt does not carry the confirmed task again", !(await chatMessage("human prompt")).includes(TASK));
  await fire({ type: "session.idle", properties: { sessionID: SID } });

  next = { status: 500 };
  const beforeFail = prompts.length;
  offer("Una", onceRow("g2", "fails to submit"));
  await until(() => reports.some((r) => r.goalId === "g2"));
  check("1.x: a failed submission seals the task it carried", stateOf(uid, "g2") === "sealed", stateOf(uid, "g2"));
  check("1.x: ...and reports it to the manager once", reports.filter((r) => r.goalId === "g2").length === 1, reports);
  await sleep(2_500);
  check("1.x: the retry after the failure does not submit the sealed task again", prompts.slice(beforeFail).filter((p) => p.includes("fails to submit")).length === 1, prompts.slice(beforeFail));

  await fire({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  const beforeBusy = prompts.length;
  offer("Una", onceRow("g3", "taken by a native prompt"));
  await sleep(500);
  check("1.x: a once task offered while a turn runs is not driven", prompts.length === beforeBusy, prompts.slice(beforeBusy));
  // A prompt the human queues while that turn runs reaches the hook before the turn ends.
  const carried = await chatMessage("human prompt");
  check("1.x: a native prompt queued meanwhile carries it", carried.includes(TASK) && carried.includes("taken by a native prompt"), carried);
  check("1.x: ...and confirms the handoff", stateOf(uid, "g3") === "confirmed", stateOf(uid, "g3"));
  await fire({ type: "session.idle", properties: { sessionID: SID } });
  await sleep(500);
  check("1.x: the turn end after it does not drive the task again", prompts.slice(beforeBusy).every((p) => !p.includes("taken by a native prompt")), prompts.slice(beforeBusy));

  // The registered once exit is the plugin's own teardown, which ends the process with code 1.
  const exitCodes: Array<number | undefined> = [];
  const realExit = process.exit;
  process.exit = ((code?: number) => { exitCodes.push(code); }) as typeof process.exit;
  try {
    registry()?.exit?.();
    await until(() => exitCodes.length > 0, 15_000);
  } finally {
    process.exit = realExit;
  }
  await until(() => !pub.getRoster().some((p) => p.card.name === "Una" && p.status !== "offline"));
  check("1.x: the registered once exit runs the plugin's teardown and exits 1", exitCodes[0] === 1 && !pub.getRoster().some((p) => p.card.name === "Una" && p.status !== "offline"), { exitCodes });
  hooks = undefined;

  // ── 2.x
  const uid2 = mintLifecycleUid();
  seatEnv("Duo", uid2);
  delete (globalThis as { __cotalOpencodeSetup?: boolean }).__cotalOpencodeSetup;
  next = { status: 500 };
  pending.set("Duo", [onceRow("h1", "fails on 2.x")]);
  const ctx = fakeOpenCode2Context();
  dispose2 = await bootPlugin2(ctx);
  await until(() => reports.some((r) => r.goalId === "h1"));
  check("2.x: a failed submission seals the task it carried", stateOf(uid2, "h1") === "sealed", stateOf(uid2, "h1"));
  check("2.x: ...and reports it to the manager once", reports.filter((r) => r.goalId === "h1").length === 1, reports);

  let open!: () => void;
  next = { status: 204, hold: new Promise<void>((r) => (open = r)) };
  const beforeHold = prompts.length;
  offer("Duo", onceRow("h2", "held on 2.x"));
  await until(() => prompts.length > beforeHold);
  check("2.x: a once task drives one submission that carries it", prompts.length === beforeHold + 1 && prompts.at(-1)!.includes("held on 2.x"), prompts.slice(beforeHold));
  check("2.x: the task is claimed while its submission is in flight", stateOf(uid2, "h2") === "claimed", stateOf(uid2, "h2"));
  const promptHook = ctx.sessionHooks.get("prompt") as unknown as (e: { sessionID: string; prompt: { text: string } }) => void;
  const native = { sessionID: SID2, prompt: { text: "native prompt" } };
  promptHook(native);
  check("2.x: a native prompt meanwhile does not carry the claimed task", !native.prompt.text.includes(TASK), native.prompt.text);
  open();
  await until(() => stateOf(uid2, "h2") === "confirmed");
  check("2.x: the landed submission confirms the handoff", stateOf(uid2, "h2") === "confirmed", stateOf(uid2, "h2"));

  offer("Duo", onceRow("h3", "taken by a 2.x native prompt"));
  await sleep(500);
  const native2 = { sessionID: SID2, prompt: { text: "native prompt" } };
  promptHook(native2);
  check("2.x: a native prompt while a turn runs carries a pending task", native2.prompt.text.includes("taken by a 2.x native prompt"), native2.prompt.text);
  check("2.x: ...and confirms the handoff", stateOf(uid2, "h3") === "confirmed", stateOf(uid2, "h3"));
} finally {
  await disposeInProcess(hooks).catch(() => undefined);
  await dispose2?.().catch(() => undefined);
  await pub.stop().catch(() => undefined);
  srv.kill("SIGKILL");
  oc.close();
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(fail === 0 ? `\nOPENCODE ONCE SMOKE PASSED ✅ (${pass} checks)` : `\nOPENCODE ONCE SMOKE FAILED ❌ (${pass} passed, ${fail} failed)`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
