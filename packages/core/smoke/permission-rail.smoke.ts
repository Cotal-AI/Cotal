/**
 * The permission answer rail and record store, through the shipped endpoint methods on a real broker.
 *
 * alice's agent `coder` holds its prompts with openPermissionHolder. alice's browser actor `web` is an
 * interactive row: it watches alice's records through its own reader, which a provisioner endpoint
 * opens, and answers. Her other agent `helper` and bob's browser actor `web` are not allowed to
 * answer, and the broker refuses them.
 *
 *  - Only the auth callout mints an interactive row: a static mint refuses it.
 *  - A holder writes its records create-only and then by compare-and-set; a retried step lands once.
 *  - The watch replays each record of the owner, then each change, and drops a value that is not a
 *    record of its key. An agent's watch is refused.
 *  - An answer reaches the one process its record names, with the sender the broker vouches for, and
 *    every holder reply maps to its outcome. A holder that does not hold a prompt stays silent. A
 *    closed holder reads `gone`, even while another process of the agent serves, and a wait
 *    shorter than the answer timeout is refused.
 *  - An open mesh holds nothing.
 *
 * Run: pnpm smoke:permission-rail   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  CotalEndpoint, PERMISSION_ANSWER_TIMEOUT_MS, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  permissionAnswerSubject, permissionBucket, permissionsFor, principalId, serverConfig, setupSpaceStreams, type IncomingPermissionAnswer,
  type PermissionAnswerReply, type PermissionReaderOpener, type PermissionRecord,
} from "../src/index.js";
import { mintPermissionRequestId } from "../src/permissions.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = new TextEncoder();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(25)) if (Date.now() > end) return false;
  return true;
}

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `perm-rail-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const endpoints: CotalEndpoint[] = [];
const closers: (() => Promise<unknown>)[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({ space, servers: SERVERS, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  await provisioner.start();
  endpoints.push(provisioner);
  const open: PermissionReaderOpener = (reader) => provisioner.openPermissionReader(reader);

  const staticInteractive = await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "alice", actor: "web" }, lifecycleUid: mintLifecycleUid(), interactive: true })
    .then(() => "minted", (e: Error) => e.message);
  check("a static mint is never interactive", /static mint is never interactive/.test(staticInteractive), staticInteractive);

  const warnings = new Map<CotalEndpoint, string[]>();
  /** An interactive row is minted by the auth callout, which core cannot run, so this signs the rows
   *  the callout mints for one: the shipped agent rows over a principal with the callout's reader id. */
  async function interactiveCreds(id: ReturnType<typeof newIdentity>, owner: string, actor: string, lifecycleUid: string): Promise<string> {
    const perms = permissionsFor("agent", space, { owner, actor, connId: id.id, lifecycleUid, readerId: `callout_${id.id}` }, { interactive: true });
    const jwt = await encodeUser(actor, fromPublic(id.id), fromPublic(auth.account.pub), perms, { signer: fromSeed(enc.encode(auth.account.signingSeed)) });
    return new TextDecoder().decode(fmtCreds(jwt, fromSeed(enc.encode(id.seed))));
  }
  async function principal(owner: string, actor: string, interactive = false, lifecycleUid = mintLifecycleUid()) {
    const id = newIdentity();
    const creds = interactive ? await interactiveCreds(id, owner, actor, lifecycleUid) : await mintCreds(auth, id, "agent", { principal: { owner, actor }, lifecycleUid });
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds, lifecycleUid, channels: [], consume: false, watchPresence: false, registerPresence: false,
      watchChannels: false, card: { id: id.id, name: actor, kind: "agent", owner, actor },
    });
    ep.on("error", () => {});
    warnings.set(ep, []);
    ep.on("warning", (e: Error) => warnings.get(ep)!.push(e.message));
    await ep.start();
    endpoints.push(ep);
    const raw = () => connect({ servers: SERVERS, authenticator: credsAuthenticator(enc.encode(creds)), inboxPrefix: `_INBOX_${id.id}` });
    return { ep, raw };
  }
  const coder = await principal("alice", "coder");
  const helper = await principal("alice", "helper");
  const web = await principal("alice", "web", true);
  const teammate = await principal("bob", "web", true);

  const openMesh = new CotalEndpoint({ space, servers: SERVERS, card: { name: "open", kind: "agent" } });
  const openRefusal = (() => { try { openMesh.openPermissionHolder(async () => ({ v: 1, ok: false, code: "unknown" })); return "held"; } catch (e) { return (e as Error).message; } })();
  check("an open mesh holds no permission prompts", /authenticated mesh/.test(openRefusal), openRefusal);

  // ── The holder serves answers with the sender the broker vouches for ───────────────────────────
  const answers: IncomingPermissionAnswer[] = [];
  let reply: PermissionAnswerReply | undefined = { v: 1, ok: false, code: "unknown" };
  const port = coder.ep.openPermissionHolder(async (a) => { answers.push(a); return reply; });
  await wait(200);
  const agent = principalId("alice", "coder");
  const id = mintPermissionRequestId();
  const pending: PermissionRecord = {
    v: 1, id, agent, holder: port.holder, tool: "Bash", input: { kind: "shown", value: { command: "npm test" } }, cwd: "/work", askedAt: Date.now(), state: { kind: "pending" },
  };
  check("a minted prompt id is 26 lowercase base32 characters", /^[a-z2-7]{26}$/.test(id) && mintPermissionRequestId() !== id, id);
  check("the holder names this process's lifecycle and runtime, as one subject token", typeof port.holder.lifecycleUid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(port.holder.runtimeId), port.holder);

  // ── Records: create-only, then compare-and-set; a retried step lands once ──────────────────────
  const created = await port.write(pending, 0, "absent");
  const retried = await port.write(pending, 0, "retry");
  check("a create lands and a retry of the same step returns the revision it landed at",
    created.kind === "written" && retried.kind === "written" && retried.revision === created.revision, { created, retried });
  const recreated = await port.write(pending, 1, "absent");
  check("a second create of the same key is a conflict", recreated.kind === "conflict", recreated);
  const approved: PermissionRecord = { ...pending, state: { kind: "approved", by: principalId("alice", "web"), at: Date.now() } };
  const moved = created.kind === "written" ? await port.write(approved, 1, created.revision) : created;
  const stale = created.kind === "written" ? await port.write(pending, 2, created.revision) : created;
  check("a write at the last revision lands and one at a stale revision is a conflict", moved.kind === "written" && stale.kind === "conflict", { moved, stale });
  const sibling = mintPermissionRequestId();
  const misfiled = await port.write({ ...pending, id: sibling, agent: principalId("alice", "helper") }, 0, "absent");
  check("the holder cannot write a sibling's record", misfiled.kind === "refused" && /permission/i.test(misfiled.reason), misfiled);

  // ── The watch: each record of the owner, then each change ─────────────────────────────────────
  let hints = 0;
  const watch = await web.ep.watchPermissions(open, () => hints++);
  closers.push(() => watch.stop());
  await watch.ready;
  const shown = () => watch.records().map((r) => `${r.id === id ? "first" : r.id}:${r.state.kind}`);
  check("the owner's watch is ready with the one record, in its last state",
    watch.records().length === 1 && watch.records()[0]?.id === id && watch.records()[0]?.state.kind === "approved", shown());
  const second = mintPermissionRequestId();
  const second0 = await port.write({ ...pending, id: second, askedAt: pending.askedAt + 1 }, 0, "absent");
  await until(() => watch.records().length === 2);
  check("a new record reaches the watch, after the first, with a hint", watch.records()[1]?.id === second && hints >= 1, { records: shown(), hints });
  const raw = await coder.raw();
  closers.push(() => raw.close());
  const junkKey = `alice.coder.${mintPermissionRequestId()}`;
  await jetstream(raw).publish(`$KV.${permissionBucket(space)}.${junkKey}`, JSON.stringify({ from: { id: "x" }, parts: [] }));
  await until(() => warnings.get(web.ep)!.some((w) => w.includes(junkKey)));
  check("a value that is not a record of its key is dropped and reported", watch.records().length === 2 && warnings.get(web.ep)!.some((w) => w.includes(junkKey)), { records: shown(), warnings: warnings.get(web.ep) });
  const again = await web.ep.watchPermissions(open).then(() => "watching", (e: Error) => e.message);
  check("an endpoint runs one watch", /already watches/.test(again), again);
  const bobWatch = await teammate.ep.watchPermissions(open);
  closers.push(() => bobWatch.stop());
  await bobWatch.ready;
  check("a teammate's watch sees none of alice's records", bobWatch.records().length === 0, bobWatch.records());
  const agentWatch = await coder.ep.watchPermissions(open);
  const agentFailure = await Promise.race([agentWatch.failed, wait(5000).then(() => ({ kind: "still running" }))]);
  check("an agent's watch is refused by the broker", agentFailure.kind === "refused", agentFailure);

  // ── Answers: the process, the sender, and every reply's outcome ───────────────────────────────
  const target = { agent, id, holder: port.holder };
  const state = approved.state;
  const cases: [string, PermissionAnswerReply, string][] = [
    ["accepted", { v: 1, ok: true, state }, "accepted"],
    ["answered first", { v: 1, ok: false, code: "answered", state }, "answered"],
    ["expired", { v: 1, ok: false, code: "expired", state: { kind: "expired", at: 1 } }, "answered"],
    ["a closing holder", { v: 1, ok: false, code: "unknown" }, "gone"],
    ["a conflicting writer", { v: 1, ok: false, code: "conflict" }, "gone"],
    ["a withheld input", { v: 1, ok: false, code: "withheld" }, "refused"],
    ["a busy holder", { v: 1, ok: false, code: "busy" }, "unknown"],
  ];
  const mismatched = [];
  for (const [name, r, kind] of cases) {
    reply = r;
    const outcome = await web.ep.answerPermission(target, { decision: "deny", note: "use staging" });
    if (outcome.kind !== kind) mismatched.push({ name, outcome });
  }
  check(`every holder reply maps to its outcome (${cases.length - mismatched.length} of ${cases.length})`, mismatched.length === 0, mismatched);
  check("each answer reached the holder as alice's browser with its note",
    answers.length === cases.length && answers.every((a) => a.by === "alice.web" && a.id === id && a.answer.decision === "deny" && a.answer.note === "use staging"), answers.slice(0, 1));

  const subject = permissionAnswerSubject(space, "alice", "coder", port.holder.runtimeId, "alice", "web");
  const rawAsk = async (body: unknown, timeout = 3000) => {
    const webRaw = await web.raw();
    closers.push(() => webRaw.close());
    return webRaw.request(subject, JSON.stringify(body), { noMux: true, reply: `${subject}.reply.${randomUUID()}`, timeout }).then((x) => x.json<PermissionAnswerReply>(), (e: Error) => e.message);
  };
  const malformed = [];
  for (const body of [{ v: 1, id, decision: "approve", note: "x" }, { v: 2, id, decision: "approve" }, { v: 1, id: "nope", decision: "deny" }, { v: 1, id, decision: "deny", note: "n".repeat(2001) }])
    malformed.push(await rawAsk(body));
  check("a body outside the schema is answered bad-request and never reaches the holder",
    malformed.every((r) => typeof r === "object" && r.ok === false && r.code === "bad-request") && answers.length === cases.length, malformed);

  reply = undefined;
  const silent = await rawAsk({ v: 1, id: mintPermissionRequestId(), decision: "approve" }, 1500);
  check("a holder that does not hold the prompt sends no reply at all", typeof silent === "string" && /timeout/i.test(silent) && answers.length === cases.length + 1, silent);

  // Another process of the same agent, under a later lifecycle, holds its own prompts.
  const successor = await principal("alice", "coder");
  const theirs: IncomingPermissionAnswer[] = [];
  const port2 = successor.ep.openPermissionHolder(async (a) => { theirs.push(a); return { v: 1, ok: true, state }; });
  await wait(200);
  reply = { v: 1, ok: true, state };
  const toFirst = await web.ep.answerPermission(target, { decision: "approve" });
  const toSecond = await web.ep.answerPermission({ agent, id: second, holder: port2.holder }, { decision: "approve" });
  check("an answer reaches only the process its record names, never another process of the same agent",
    port2.holder.runtimeId !== port.holder.runtimeId && toFirst.kind === "accepted" && toSecond.kind === "accepted"
      && theirs.length === 1 && theirs[0]!.id === second && answers.at(-1)?.id === id,
    { toFirst, toSecond, theirs: theirs.length, runtimes: [port.holder.runtimeId, port2.holder.runtimeId] });

  const shortWait = await web.ep.answerPermission(target, { decision: "approve" }, PERMISSION_ANSWER_TIMEOUT_MS - 1).then(() => "sent", (e: Error) => e.message);
  check("a wait shorter than the answer timeout is refused", /shorter than/.test(shortWait), shortWait);

  const before = answers.length;
  const refused = [
    await helper.ep.answerPermission(target, { decision: "approve" }),
    await teammate.ep.answerPermission(target, { decision: "approve" }),
    await coder.ep.answerPermission(target, { decision: "approve" }),
  ];
  check(`a sibling agent, a teammate and the agent itself are refused by the broker (${refused.filter((o) => o.kind === "refused").length} of 3)`,
    refused.every((o) => o.kind === "refused" && o.reason === "not-permitted") && answers.length === before, refused);

  // The successor still serves its own runtime, so an answer to the closed holder reaches no process.
  port.close();
  await wait(100);
  const gone = await web.ep.answerPermission({ agent, id: second, holder: port.holder }, { decision: "approve" });
  check("a closed holder reads gone, while another process of the same agent still serves",
    gone.kind === "gone" && answers.length === before && theirs.length === 1, { gone, theirs: theirs.length });
  port2.close();
  check("...and the store holds the two records, each in the last state written",
    second0.kind === "written" && watch.records().length === 2, shown());
} finally {
  for (const close of closers) await close().catch(() => {});
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
