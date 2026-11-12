/**
 * The permission answer rail and record store, through the shipped endpoint methods on a real broker.
 *
 * alice's agent `coder` holds its prompts with openPermissionHolder. alice's browser actor `web` is an
 * interactive row: it watches alice's records and answers. Her other agent `helper` and bob's browser
 * actor `web` are not allowed to answer, and the broker refuses them.
 *
 *  - A holder writes its records create-only and then by compare-and-set; a retried step lands once.
 *  - The watch delivers each record of the owner, then each change, and drops a value that is not a
 *    record of its key.
 *  - An answer reaches the holder with the sender the broker vouches for, and every holder reply maps
 *    to its outcome. A closed holder reads `gone`.
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
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, permissionAnswerSubject, permissionBucket,
  principalId, serverConfig, setupSpaceStreams, type IncomingPermissionAnswer, type PermissionAnswerReply, type PermissionChange,
  type PermissionRecord,
} from "../src/index.js";
import { mintPermissionRequestId } from "../src/permissions.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
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
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const warnings = new Map<CotalEndpoint, string[]>();
  async function principal(owner: string, actor: string, interactive = false) {
    const id = newIdentity(), lifecycleUid = mintLifecycleUid();
    const creds = await mintCreds(auth, id, "agent", { principal: { owner, actor }, lifecycleUid, ...(interactive ? { interactive: true as const } : {}) });
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds, lifecycleUid, channels: [], consume: false, watchPresence: false, registerPresence: false,
      watchChannels: false, card: { id: id.id, name: actor, kind: "agent", owner, actor },
    });
    ep.on("error", () => {});
    warnings.set(ep, []);
    ep.on("warning", (e: Error) => warnings.get(ep)!.push(e.message));
    await ep.start();
    endpoints.push(ep);
    const raw = () => connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${id.id}` });
    return { ep, raw };
  }
  const coder = await principal("alice", "coder");
  const helper = await principal("alice", "helper");
  const web = await principal("alice", "web", true);
  const teammate = await principal("bob", "web", true);

  const open = new CotalEndpoint({ space, servers: SERVERS, card: { name: "open", kind: "agent" } });
  const openRefusal = (() => { try { open.openPermissionHolder(async () => ({ v: 1, ok: false, code: "unknown" })); return "held"; } catch (e) { return (e as Error).message; } })();
  check("an open mesh holds no permission prompts", /authenticated mesh/.test(openRefusal), openRefusal);

  // ── The holder serves answers with the sender the broker vouches for ───────────────────────────
  const answers: IncomingPermissionAnswer[] = [];
  let reply: PermissionAnswerReply = { v: 1, ok: false, code: "unknown" };
  const port = coder.ep.openPermissionHolder(async (a) => { answers.push(a); return reply; });
  await wait(200);
  const agent = principalId("alice", "coder");
  const id = mintPermissionRequestId();
  const pending: PermissionRecord = {
    v: 1, id, agent, holder: port.holder, tool: "Bash", input: { kind: "shown", value: { command: "npm test" } }, cwd: "/work", askedAt: Date.now(), state: { kind: "pending" },
  };
  check("a minted prompt id is 26 lowercase base32 characters", /^[a-z2-7]{26}$/.test(id) && mintPermissionRequestId() !== id, id);
  check("the holder names this process's lifecycle and runtime", typeof port.holder.lifecycleUid === "string" && port.holder.runtimeId.length > 0, port.holder);

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
  const seen: PermissionChange[] = [];
  const watch = await web.ep.watchPermissions((c) => seen.push(c));
  closers.push(() => watch.stop());
  await watch.ready;
  check("the owner's watch is ready with the one record, in its last state",
    seen.length === 1 && seen[0]?.kind === "put" && seen[0].record.id === id && seen[0].record.state.kind === "approved", seen);
  const second = mintPermissionRequestId();
  const second0 = await port.write({ ...pending, id: second }, 0, "absent");
  await until(() => seen.length === 2);
  check("a new record reaches the watch", seen[1]?.kind === "put" && seen[1].record.id === second, seen.slice(1));
  const raw = await coder.raw();
  closers.push(() => raw.close());
  const junkKey = `alice.coder.${mintPermissionRequestId()}`;
  await jetstream(raw).publish(`$KV.${permissionBucket(space)}.${junkKey}`, JSON.stringify({ from: { id: "x" }, parts: [] }));
  await until(() => warnings.get(web.ep)!.some((w) => w.includes(junkKey)));
  check("a value that is not a record of its key is dropped and reported", seen.length === 2 && warnings.get(web.ep)!.some((w) => w.includes(junkKey)), { seen: seen.length, warnings: warnings.get(web.ep) });
  const bobSeen: PermissionChange[] = [];
  const bobWatch = await teammate.ep.watchPermissions((c) => bobSeen.push(c));
  closers.push(() => bobWatch.stop());
  await bobWatch.ready;
  await wait(200);
  check("a teammate's watch sees none of alice's records", bobSeen.length === 0, bobSeen);
  const agentWatch = await coder.ep.watchPermissions(() => {}).then(() => "watching", (e: Error) => e.message);
  check("an agent cannot watch its owner's records", /permission/i.test(agentWatch), agentWatch);

  // ── Answers: the sender, and every reply's outcome ────────────────────────────────────────────
  const state = approved.state;
  const cases: [string, PermissionAnswerReply, string][] = [
    ["accepted", { v: 1, ok: true, state }, "accepted"],
    ["answered first", { v: 1, ok: false, code: "answered", state }, "answered"],
    ["expired", { v: 1, ok: false, code: "expired", state: { kind: "expired", at: 1 } }, "answered"],
    ["unknown to the holder", { v: 1, ok: false, code: "unknown" }, "gone"],
    ["a conflicting writer", { v: 1, ok: false, code: "conflict" }, "gone"],
    ["a withheld input", { v: 1, ok: false, code: "withheld" }, "refused"],
    ["a busy holder", { v: 1, ok: false, code: "busy" }, "unknown"],
  ];
  const mismatched = [];
  for (const [name, r, kind] of cases) {
    reply = r;
    const outcome = await web.ep.answerPermission(agent, id, { decision: "deny", note: "use staging" });
    if (outcome.kind !== kind) mismatched.push({ name, outcome });
  }
  check(`every holder reply maps to its outcome (${cases.length - mismatched.length} of ${cases.length})`, mismatched.length === 0, mismatched);
  check("each answer reached the holder as alice's browser with its note",
    answers.length === cases.length && answers.every((a) => a.by === "alice.web" && a.id === id && a.answer.decision === "deny" && a.answer.note === "use staging"), answers.slice(0, 1));

  const raws = [];
  for (const body of [{ v: 1, id, decision: "approve", note: "x" }, { v: 2, id, decision: "approve" }, { v: 1, id: "nope", decision: "deny" }, { v: 1, id, decision: "deny", note: "n".repeat(2001) }]) {
    const webRaw = await web.raw();
    closers.push(() => webRaw.close());
    const subject = permissionAnswerSubject(space, "alice", "coder", "alice", "web");
    const m = await webRaw.request(subject, JSON.stringify(body), { noMux: true, reply: `${subject}.reply.${randomUUID()}`, timeout: 3000 }).then((x) => x.json<PermissionAnswerReply>(), (e: Error) => e.message);
    raws.push(m);
  }
  check("a body outside the schema is answered bad-request and never reaches the holder",
    raws.every((r) => typeof r === "object" && r.ok === false && r.code === "bad-request") && answers.length === cases.length, raws);

  const before = answers.length;
  const refused = [
    await helper.ep.answerPermission(agent, id, { decision: "approve" }),
    await teammate.ep.answerPermission(agent, id, { decision: "approve" }),
    await coder.ep.answerPermission(agent, id, { decision: "approve" }),
  ];
  check(`a sibling agent, a teammate and the agent itself are refused by the broker (${refused.filter((o) => o.kind === "refused").length} of 3)`,
    refused.every((o) => o.kind === "refused" && o.reason === "not-permitted") && answers.length === before, refused);

  port.close();
  await wait(100);
  const gone = await web.ep.answerPermission(agent, second, { decision: "approve" });
  check("a closed holder reads gone", gone.kind === "gone" && answers.length === before, gone);
  check("...and the store holds the two records, each in the last state written",
    second0.kind === "written" && seen.filter((c) => c.kind === "put").length === 2, seen.map((c) => c.kind === "put" ? `${c.record.id === id ? "first" : "second"}:${c.record.state.kind}` : c.kind));
} finally {
  for (const close of closers) await close().catch(() => {});
  await Promise.all(endpoints.map((ep) => ep.stop().catch(() => {})));
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
finish();
