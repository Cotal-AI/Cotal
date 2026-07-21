/**
 * MANAGER SERVICE OPS smoke (control-surface P2 item 1, slice 1b) — the FULL typed-command
 * fan-out over a REAL Manager + JWT broker + REAL agent processes (e2e-stub.mjs), proving:
 *
 *  1. The rev-2 cluster document serves ALL 17 commands (describe lists them; targeted commands
 *     declare their modes).
 *  2. SPAWN PARITY (the 1b fidelity oracle): the ctl `start` door and the ep `spawn` door coerce
 *     an identical 16-field request into the IDENTICAL StartAgentOpts (field-for-field, captured
 *     at the single `startAgent` chokepoint), with the same spawner attribution. Deep semantics
 *     (empty `resume`) refuse through the SHARED handler on both doors.
 *  3. REAL lifecycle over ep.one: spawn a real stub agent (joins presence), `ps`/`inspect` list
 *     it (rows now carry `lifecycleUid` — the targeting coordinate), targeted owner-mode
 *     `despawn` tears it down; a STALE-uid target is `expired` (fresh resolver); a NON-spawner
 *     caller is `permission-denied` (the ctl privileged own-child policy, same source both
 *     doors); an UNTARGETED despawn form has no granted row (broker default-deny).
 *  4. BASELINE self-stop: the spawned agent's OWN minted cred (Appendix-B baseline rows) invokes
 *     `stop` with authz-mode `self` and halts itself.
 *  5. definePersona (content-only write, ownership-checked), models (normalized catalogs), purge,
 *     attach (ws url), launch/resume-family negatives (the shared cores answer with the exact
 *     ctl refusals), and the preservation fence: after `preparePreservation` the ep door refuses
 *     ordinary ops (`unavailable`, the SHARED maintenance fence) until `abortPreservation`.
 *  6. Dual-serve intact: the legacy ctl rail still answers.
 *
 * Run: pnpm smoke:manager-service-ops   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, principalKey, DEV_OWNER, CONTROL_PRIVILEGED,
  controlServiceSubject, epCall, epRequestSubject, epCallerReplyFilter, EpEnvelopeError,
  registry,
  type Connector, type ControlReply, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const enc = new TextEncoder(), dec = new TextDecoder();

const space = `mgrops-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-mgrops-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["w1", "w2", "w3", "wp1", "wp2"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const stubCon: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
registry.register(stubCon);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
const M = mgr as unknown as {
  managerLifecycleUid: string;
  agents: Map<string, { id: string; lifecycleUid: string; secretPaths?: { creds?: string } }>;
  startAgent: (opts: Record<string, unknown>, spawner?: string) => Promise<ControlReply>;
};

/** A caller instrument: mint an agent cred with the given ep capabilities (+ ctl privileged via
 *  the spawn capability), connect, and return the epCall/ctl helpers bound to its triple. */
async function instrument(caps: Array<{ command: string; owner?: true }>) {
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", {
    lifecycleUid: uid,
    capabilities: ["spawn"],
    endpointCapabilities: caps.map((c) => ({
      endpoint: MANAGER_ENDPOINT, command: c.command,
      ...(c.owner ? { target: { mode: "owner" as const, tOwner: DEV_OWNER } } : {}),
    })),
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });
  const principal = principalKey(DEV_OWNER, id.id).key;
  const call = (command: string, callArgs?: Record<string, unknown>, target?: { actor: string; lifecycleUid: string }) =>
    epCall(nc, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller,
      ...(callArgs !== undefined ? { args: callArgs } : {}),
      ...(target ? { target: { mode: "owner" as const, owner: DEV_OWNER, actor: target.actor, lifecycleUid: target.lifecycleUid } } : {}),
    }, { deadlineMs: 30_000, currentEpoch: async () => 0 });
  const ctl = async (op: string, ctlArgs: Record<string, unknown>): Promise<ControlReply> => {
    const reqSubject = controlServiceSubject(space, CONTROL_PRIVILEGED, DEV_OWNER, id.id);
    const m = await nc.request(reqSubject, JSON.stringify({ op, args: ctlArgs, from: { id: principal, name: "smoke", role: "agent", kind: "agent" } }),
      { timeout: 30_000, noMux: true, reply: `${reqSubject}.reply.${randomUUID()}` });
    return JSON.parse(dec.decode(m.data)) as ControlReply;
  };
  return { id, uid, caller, principal, nc, call, ctl };
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();

  const A = await instrument([
    { command: "status" }, { command: "ps" }, { command: "inspect" }, { command: "models" },
    { command: "spawn" }, { command: "despawn", owner: true }, { command: "attach", owner: true },
    { command: "define-persona" }, { command: "purge" }, { command: "launch" },
    { command: "resume-preserved" }, { command: "commit-resume" }, { command: "finalize-resume" },
    { command: "prepare-preservation" }, { command: "commit-preservation" }, { command: "abort-preservation" },
  ]);
  const B = await instrument([{ command: "despawn", owner: true }, { command: "define-persona" }]);

  console.log("1. describe: the rev-2 document serves the full fan-out");
  {
    const replies: unknown[] = [];
    const sub = A.nc.subscribe(epCallerReplyFilter(space, A.caller), { callback: (_e, m) => replies.push(JSON.parse(dec.decode(m.data))) });
    const subj = epRequestSubject(space, { route: { mode: "one" }, endpoint: MANAGER_ENDPOINT, command: "describe", caller: A.caller, nonce: `n${String(Date.now()).padStart(23, "0")}` });
    A.nc.publish(subj, enc.encode(JSON.stringify({ v: 1, id: "d1", op: { endpoint: MANAGER_ENDPOINT, command: "describe" }, class: "ephemeral", replyExpected: true, deadlineMs: 5000, from: { id: A.principal, name: "smoke" } })));
    await A.nc.flush();
    for (let i = 0; i < 60 && replies.length === 0; i++) await wait(100);
    const d = replies[0] as { ok?: boolean; data?: { descriptor?: { clusters?: Array<{ commands?: string[]; document?: { revision?: number; commands?: Array<{ name: string; targeted: boolean; modes?: string[] }> } }> } } } | undefined;
    const cmds = d?.data?.descriptor?.clusters?.[0]?.commands ?? [];
    check("describe lists all 17 commands", cmds.length === 17 && ["status", "ps", "inspect", "models", "spawn", "despawn", "attach", "stop", "define-persona", "purge", "launch", "resume-preserved", "commit-resume", "finalize-resume", "prepare-preservation", "commit-preservation", "abort-preservation"].every((c) => cmds.includes(c)), cmds);
    const doc = d?.data?.descriptor?.clusters?.[0]?.document;
    const despawnDecl = doc?.commands?.find((c) => c.name === "despawn");
    const stopDecl = doc?.commands?.find((c) => c.name === "stop");
    check("the document is revision 2; despawn declares owner mode, stop declares self mode (child/ledger ABSENT everywhere)",
      doc?.revision === 2 && despawnDecl?.targeted === true && JSON.stringify(despawnDecl?.modes) === '["owner"]'
      && stopDecl?.targeted === true && JSON.stringify(stopDecl?.modes) === '["self"]'
      && doc?.commands?.every((c) => !(c.modes ?? []).includes("child") && !(c.modes ?? []).includes("ledger")) === true, doc?.commands);
    sub.unsubscribe();
  }

  console.log("2. spawn parity: ctl start and ep spawn coerce IDENTICAL StartAgentOpts");
  {
    const captured: Array<{ opts: Record<string, unknown>; spawner?: string }> = [];
    const orig = M.startAgent.bind(mgr);
    M.startAgent = async (opts, spawner) => {
      captured.push({ opts, spawner });
      return { ok: true, data: { name: String(opts.name), id: "x", role: "worker", agent: "e2e-stub", mode: "fake", lifecycleUid: "l".repeat(26) } };
    };
    const fields = {
      agent: "e2e-stub", role: "worker", config: "cfg.md", identity: "idfile", model: "m1", variant: "high",
      launchOptions: { flag: "v", n: 2 }, resume: "sess-1", transcript: true, cwd: "/tmp/x", prompt: "hello",
      subscribe: ["general"], allowSubscribe: ["general", "task"], allowPublish: ["general"], shareTools: "all",
    };
    const rEp = await A.call("spawn", { name: "wp1", ...fields });
    const rCtl = await A.ctl("start", { name: "wp2", ...fields });
    M.startAgent = orig;
    check("both doors accepted the 16-field request", rEp.reply.ok === true && rCtl.ok === true, { ep: rEp.reply, ctl: rCtl });
    const [ep, ctl] = captured;
    const strip = (o: Record<string, unknown>) => { const { name: _n, ...rest } = o; return rest; };
    check("the coerced StartAgentOpts are IDENTICAL field-for-field (the fidelity oracle)",
      captured.length === 2 && JSON.stringify(strip(ep.opts)) === JSON.stringify(strip(ctl.opts)),
      { ep: strip(ep?.opts ?? {}), ctl: strip(ctl?.opts ?? {}) });
    check("both doors attribute the SAME spawner principal", ep?.spawner === A.principal && ctl?.spawner === A.principal, { ep: ep?.spawner, ctl: ctl?.spawner });
    let badCode: string | undefined;
    try { await A.call("spawn", { name: "wp1", bogus: 1 }); } catch (e) { badCode = e instanceof EpEnvelopeError ? e.code : (e as Error).message; }
    check("an unknown spawn field is bad-request at the CALLER's own closed contract (pre-publish; the responder enforces the same digest-bound schema)", badCode === "bad-request", badCode);
    const rEmpty = await A.call("spawn", { name: "wp1", resume: "" });
    check("an empty resume refuses through the SHARED deep validation (both doors, one rule)",
      rEmpty.reply.ok === false && String(rEmpty.reply.error?.message ?? "").includes("session id must not be empty"), rEmpty.reply);
  }

  console.log("3. real lifecycle over ep.one: spawn -> ps/inspect -> targeted despawn");
  const r1 = await A.call("spawn", { name: "w1", agent: "e2e-stub", cwd: repoRoot });
  const w1 = r1.reply.data as { name: string; id: string; lifecycleUid: string };
  check("ep spawn boots a REAL agent (presence-joined reply)", r1.reply.ok === true && w1.name === "w1" && w1.lifecycleUid.length >= 26, r1.reply);
  {
    const ps = await A.call("ps");
    const rows = ps.reply.data as Array<{ name: string; id: string; lifecycleUid: string; mesh: string }>;
    const row = rows.find((x) => x.name === "w1");
    check("ps lists w1 with id + lifecycleUid (the targeting coordinates)", ps.reply.ok === true && row !== undefined && row.id === w1.id && row.lifecycleUid === w1.lifecycleUid, rows);
    const ins = await A.call("inspect", { name: "w1" });
    check("inspect returns the same row", ins.reply.ok === true && (ins.reply.data as { id: string }).id === w1.id);
    const insMiss = await A.call("inspect", { name: "ghost" });
    check("inspect of an unknown name is not-found", insMiss.reply.ok === false && insMiss.reply.error?.code === "not-found", insMiss.reply);
  }
  {
    const rB = await B.call("despawn", { graceful: true }, { actor: w1.id, lifecycleUid: w1.lifecycleUid });
    check("a NON-spawner's targeted despawn is permission-denied (ctl privileged own-child policy, same source both doors)",
      rB.reply.ok === false && rB.reply.error?.code === "permission-denied", rB.reply);
    const rA = await A.call("despawn", { graceful: true }, { actor: w1.id, lifecycleUid: w1.lifecycleUid });
    check("the SPAWNER's targeted owner-mode despawn succeeds", rA.reply.ok === true && (rA.reply.data as { stopped: boolean }).stopped === true, rA.reply);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = !(mgr as unknown as { agents: Map<string, unknown> }).agents.has("w1"); if (!gone) await wait(250); }
    check("w1 is no longer managed after the ep despawn", gone);
    const rStale = await A.call("despawn", { graceful: true }, { actor: w1.id, lifecycleUid: w1.lifecycleUid });
    check("a STALE target (departed incarnation) is expired at the fresh resolver", rStale.reply.ok === false && rStale.reply.error?.code === "expired", rStale.reply);
  }

  console.log("4. baseline self-stop: the agent's OWN cred halts itself over ep.one");
  const r2 = await A.call("spawn", { name: "w2", agent: "e2e-stub", cwd: repoRoot });
  check("w2 spawned", r2.reply.ok === true, r2.reply);
  {
    const w2 = M.agents.get("w2")!;
    const credsPath = w2.secretPaths?.creds ?? join(authDir(workspaceRoot), "creds", `w2.${w2.lifecycleUid}.creds`);
    check("w2's lifecycle-keyed creds file exists", existsSync(credsPath), credsPath);
    const w2Creds = readFileSync(credsPath, "utf8");
    const w2Nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: w2Creds }), maxReconnectAttempts: 0 });
    const selfCaller: EpCaller = { owner: DEV_OWNER, actor: w2.id, uid: w2.lifecycleUid };
    const rSelf = await epCall(w2Nc, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command: "stop", contract: MANAGER_CONTRACTS.stop, caller: selfCaller,
      args: { graceful: true }, target: { mode: "self" },
    }, { deadlineMs: 15_000, currentEpoch: async () => 0 });
    check("the agent's OWN baseline cred invokes self-mode `stop` and halts itself",
      rSelf.reply.ok === true && (rSelf.reply.data as { name: string; stopped: boolean }).name === "w2" && (rSelf.reply.data as { stopped: boolean }).stopped === true, rSelf.reply);
    await w2Nc.drain().catch(() => w2Nc.close());
  }

  console.log("5. definePersona / models / purge / attach / launch + resume negatives");
  {
    const rDef = await A.call("define-persona", { name: "eppersona", persona: "You are the ep persona.", model: "m9" });
    check("definePersona creates the persona (content-only write)", rDef.reply.ok === true && existsSync(join(workspaceRoot, ".cotal", "agents", "eppersona.md")), rDef.reply);
    const rDefB = await B.call("define-persona", { name: "eppersona", persona: "takeover" });
    check("a FOREIGN redefine refuses (ownership preserved through the ep door)",
      rDefB.reply.ok === false && String(rDefB.reply.error?.message ?? "").includes("not authorized to redefine"), rDefB.reply);
    const rModels = await A.call("models", {});
    const catalogs = (rModels.reply.data as { catalogs: Array<{ agent: string; supported: boolean }> })?.catalogs;
    check("models answers the NORMALIZED catalog list (stub connector: supported=false)",
      rModels.reply.ok === true && Array.isArray(catalogs) && catalogs.some((c) => c.agent === "e2e-stub" && c.supported === false), rModels.reply);
    const rPurge = await A.call("purge", {});
    check("purge clears the space history (typed {chat} result)", rPurge.reply.ok === true && typeof (rPurge.reply.data as { chat: number }).chat === "number", rPurge.reply);
    const r3 = await A.call("spawn", { name: "w3", agent: "e2e-stub", cwd: repoRoot });
    check("w3 spawned for attach", r3.reply.ok === true, r3.reply);
    const w3 = r3.reply.data as { id: string; lifecycleUid: string };
    const rAttach = await A.call("attach", undefined, { actor: w3.id, lifecycleUid: w3.lifecycleUid });
    check("targeted attach returns the WS url", rAttach.reply.ok === true && String((rAttach.reply.data as { ws: string }).ws).startsWith("ws"), rAttach.reply);
    const rLaunch = await A.call("launch", { runId: "zzzz", name: "x" });
    check("launch with an unknown runId refuses through the shared core", rLaunch.reply.ok === false && rLaunch.reply.error?.code === "failed-precondition", rLaunch.reply);
    const rRes = await A.call("resume-preserved", { attemptId: "nope", inventory: { version: "cotal-manager-resume/v1", space, createdAt: "x", agents: [] } });
    check("resumePreserved refuses with the EXACT ctl core message (no --resume-attempt manager)",
      rRes.reply.ok === false && String(rRes.reply.error?.message ?? "").includes("requires a manager started with --resume-attempt"), rRes.reply);
    const rCommit = await A.call("commit-resume", { attemptId: "nope" });
    check("commitResume refuses (no such attempt) through the shared core", rCommit.reply.ok === false && String(rCommit.reply.error?.message ?? "").includes("resume attempt"), rCommit.reply);
    const rFin = await A.call("finalize-resume", { attemptId: "nope", durableCommitToken: "a".repeat(64) });
    check("finalizeResume refuses (no such attempt) through the shared core", rFin.reply.ok === false && String(rFin.reply.error?.message ?? "").includes("resume attempt"), rFin.reply);
  }

  console.log("6. preservation fence: prepare fences the ep door, abort restores");
  {
    const rPrep = await A.call("prepare-preservation", { attemptId: "ep-attempt-1" });
    const plan = rPrep.reply.data as { state?: string; inventory?: { agents?: unknown[] } };
    check("preparePreservation returns the plan (inventory built, no child stopped)",
      rPrep.reply.ok === true && typeof plan?.state === "string" && Array.isArray(plan?.inventory?.agents), rPrep.reply);
    const rFenced = await A.call("ps");
    check("while preserving, ordinary ep ops refuse (unavailable — the SHARED maintenance fence)",
      rFenced.reply.ok === false && rFenced.reply.error?.code === "unavailable", rFenced.reply);
    const rAbort = await A.call("abort-preservation", { attemptId: "ep-attempt-1" });
    check("abortPreservation restores active", rAbort.reply.ok === true && (rAbort.reply.data as { state: string }).state === "active", rAbort.reply);
    const rAfter = await A.call("ps");
    check("ordinary ep ops work again after the abort", rAfter.reply.ok === true);
  }

  console.log("7. sanitization: traversal tokens refuse at the SHARED name/id grammar on the ep door");
  {
    const rTravRef = await A.call("spawn", { name: "../evil" });
    check("a traversal spawn ref refuses (bare ref = safe token, no path escape)",
      rTravRef.reply.ok === false && String(rTravRef.reply.error?.message ?? "").includes("unsafe name"), rTravRef.reply);
    const rTravId = await A.call("spawn", { name: "w1", agent: "e2e-stub", identity: "../evil" });
    check("a traversal identity override refuses at the FINAL allocation-site grammar",
      rTravId.reply.ok === false && String(rTravId.reply.error?.message ?? "").includes("unsafe name"), rTravId.reply);
    const rTravDef = await A.call("define-persona", { name: "../evil", persona: "x" });
    check("a traversal define-persona name refuses before any file write",
      rTravDef.reply.ok === false && String(rTravDef.reply.error?.message ?? "").includes("unsafe name"), rTravDef.reply);
    check("no stray file escaped the agents dir", !existsSync(join(workspaceRoot, ".cotal", "evil.md")) && !existsSync(join(dir, "evil.md")));
    const rTravRun = await A.call("launch", { runId: "../x", name: "w1" });
    check("a traversal launch runId refuses at the token-safe spec loader", rTravRun.reply.ok === false, rTravRun.reply);
    // Frontmatter injection: the YAML library owns quoting, so a newline-bearing model can never
    // smuggle a POLICY field (capabilities) into the persona file (P6 content-vs-policy).
    const rInj = await A.call("define-persona", { name: "injprobe", persona: "body", model: "x\ncapabilities: [spawn]" });
    const injPath = join(workspaceRoot, ".cotal", "agents", "injprobe.md");
    const injRaw = rInj.reply.ok === true && existsSync(injPath) ? readFileSync(injPath, "utf8") : "";
    check("a newline-bearing model field cannot inject frontmatter policy (YAML-escaped; no capabilities key lands)",
      rInj.reply.ok === true && injRaw.length > 0 && !/^capabilities:/m.test(injRaw), injRaw);
  }

  console.log("8. dual-serve intact");
  {
    const psCtl = await A.ctl("ps", {});
    check("the legacy ctl rail still answers ps", psCtl.ok === true, psCtl);
  }

  await A.nc.drain().catch(() => A.nc.close());
  await B.nc.drain().catch(() => B.nc.close());
  await mgr.stop();
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "MANAGER SERVICE OPS SMOKE OK ✅" : "MANAGER SERVICE OPS SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
