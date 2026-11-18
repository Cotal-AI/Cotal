/**
 * The principal route and the `agent` endpoint on a real nats-server, through the shipped auth
 * callout (SPEC 13.21, 13.22). Every credential is minted by `calloutPermissions` from a ledger
 * row's kind, as the auth service mints it: alice's `coder`, `helper`, `tester` and `legacy` and
 * bob's `builder` are managed-agent rows, alice's `web`, `term` and `oldweb` and bob's `web` are
 * interactive rows, and bob and alice also connect through an admin and a manager-caller view.
 *
 * Two things are added in this suite and nowhere else. `builder` holds `grant` rows for one of
 * alice's agent lifecycles, built by the shipped `epPrincipalGrantRows`, because issuing a grant is
 * later work. And `legacy` and `oldweb` connect with those rows stripped, the credential an auth
 * service from before this release mints.
 *
 * The serving agents are core-only test agents: a `CotalEndpoint` that serves the `agent` cluster
 * with handlers over one hand-made prompt. The callers use `Endpoint.callPrincipal`. The forged
 * publishes and subscriptions ride raw connections of the same principals, so each refusal is
 * matched to the broker's permission violation for that exact subject.
 *
 * The route's 26 security cells, numbered the same in `pnpm smoke:principal-route` (cell 24 needs a
 * registry-authorized serve grant and runs in `pnpm smoke:ep-serve`), a serve and call round trip,
 * cell 27, a malformed nonce; cell 37, a cast; cells 40 and 41, a deadline over 30 s; cell 28, a stored frame a Direct Get delivers on the caller's sentinel;
 * cell 29, a reply under another head that arrives first; cell 30, stopping the endpoint while a
 * handler runs and while `ready` waits; cells 31 and 32, `seq` across serves and endpoint objects of
 * one runtime, and a second server for one lifecycle in a process; cell 33, stop waits for a handler
 * in flight only until its request's deadline; cell 34, a JetStream API answer on the caller's
 * sentinel; cell 35, a refused reply publish is reported; cell 39, servePrincipal serves only
 * `agent`; cell 36, a refused reply read whose flush
 * never settles; a reconnect that rebinds, with cell 38, the handles a replaced connection leaves; a
 * reconnect whose new credential lacks the rows, and the mixed-version cases that need no 0.165
 * release: an agent that serves nothing, a caller or an agent whose credential predates the rows,
 * and a caller pinned to a later revision.
 *
 * Run: pnpm smoke:principal-route:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, headers, PermissionViolationError, tokenAuthenticator, type Msg, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_CLUSTER, AGENT_CONTRACTS, AGENT_ENDPOINT, AGENT_PROMPT_DIGEST_DETAIL, AGENT_PROMPT_STATE_DETAIL, CotalEndpoint, EpEnvelopeError, ContractInvalidError,
  agentClusterArtifacts, agentPromptDigest, buildClusterDocument, canonicalJson, compileContract, createSpaceAuth, epPrincipalGrantRows,
  epPrincipalNoRespondersSubject, epPrincipalReplySubject, epPrincipalRequestSubject, epServeGrantRows, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, parseClusterDocument, permissionsFor, presenceBucket, presenceKeySubject, processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams, spacePrefix,
  type AgentPrompt, type DescribeAnswer, type EndpointReply, type EpPrincipal, type EpPrincipalCommandDef, type PrincipalServe,
  type PromptAnswerInput, type PromptContent, type PromptState, type Presence,
} from "@cotal-ai/core";
// The general principal serve is internal to core; this is the built file the package root loads.
import { servePrincipalRoute } from "../../../packages/core/dist/endpoint-serve.js";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver, type ValidatedUserToken } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n = 12) => randomBytes(n).toString("hex");
const nonce = () => randomBytes(24).toString("base64url");
async function until(done: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(20)) if (Date.now() > end) return false;
  return true;
}
const codeOf = (e: unknown) => (e instanceof EpEnvelopeError ? `${e.code}/${e.outcome ?? "-"}` : `thrown: ${e instanceof Error ? e.message : String(e)}`);
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}

// ---- broker and callout ---------------------------------------------------------------------
const PORT = await pickFreePort(), OPEN_PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`, OPEN_SERVERS = `nats://127.0.0.1:${OPEN_PORT}`;
const space = `prin-${randomUUID().slice(0, 8)}`;
const P = spacePrefix(space);
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
writeFileSync(join(dir, "open.conf"), `port: ${OPEN_PORT}\nhost: 127.0.0.1\n`);
const brokers: ChildProcess[] = [];
const releases: (() => void)[] = [];
for (const conf of ["server.conf", "open.conf"]) {
  const child = spawn("nats-server", ["-c", join(dir, conf)], { stdio: "ignore" });
  releases.push(teardownOnSignal(child, dir));
  brokers.push(child);
}

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const B = deriveOwnerToken("s".repeat(32), "better-auth|bob");

interface Who { name: string; owner: string; actor: string; kind?: "interactive" | "managed-agent"; scope: string[]; uid: string; view?: "admin" | "manager-caller" }
const who = (owner: string, actor: string, kind: Who["kind"], extra: Partial<Who> = {}): Who =>
  ({ name: `${owner === A ? "alice" : "bob"}.${actor}`, owner, actor, kind, scope: [], uid: mintLifecycleUid(), ...extra });
const W = {
  coder: who(A, "coder", "managed-agent"),
  helper: who(A, "helper", "managed-agent"),
  tester: who(A, "tester", "managed-agent"),
  legacy: who(A, "legacy", "managed-agent"),
  stopper: who(A, "stopper", "managed-agent"),
  stopper2: who(A, "stopper2", "managed-agent"),
  stopper3: who(A, "stopper3", "managed-agent"),
  mute: who(A, "mute", "managed-agent"),
  deaf: who(A, "deaf", "interactive"),
  cycler: who(A, "cycler", "managed-agent"),
  web: who(A, "web", "interactive"),
  term: who(A, "term", "interactive"),
  oldWeb: who(A, "oldweb", "interactive"),
  bobWeb: who(B, "web", "interactive"),
  builder: who(B, "builder", "managed-agent"),
  admin: who(B, "console", "interactive", { scope: ["admin"], view: "admin" }),
  mgrCaller: who(A, "ops", "interactive", { view: "manager-caller" }),
};
const coderNext: Who = { ...W.coder, name: "alice.coder (next lifecycle)", uid: mintLifecycleUid() };
const rows = new Map([...Object.values(W), coderNext].map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = rows.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: w.scope, ...(w.kind ? { kind: w.kind } : {}) };
};

// The shipped mint, plus the two test-only edits: grant rows for named grantee lifecycles, and the
// rows stripped for lifecycles whose credential predates them.
type Perm = { pub?: { allow?: string[]; deny?: string[] }; sub?: { allow?: string[]; deny?: string[] }; [k: string]: unknown };
const shipped = calloutPermissions(resolveAcl, async () => {});
const grants = new Map<string, { target: Who; commands: string[] }[]>();
const stripped = new Set<string>();
/** Lifecycles whose serve credential keeps the subscription row and loses the reply publish row. */
const muted = new Set<string>();
/** Lifecycles whose caller credential keeps its request rows and loses the reply read. */
const deaf = new Set<string>();
const strip = (p: Perm): Perm => ({ ...p,
  pub: { ...p.pub, allow: (p.pub?.allow ?? []).filter((r) => !r.includes(".ep.prin")) },
  sub: { ...p.sub, allow: (p.sub?.allow ?? []).filter((r) => !r.includes(".ep.prin")) } });
const mintFor = async (t: ValidatedUserToken, connId: string, readerId: string): Promise<Record<string, unknown>> => {
  let p = (await shipped(t, connId, readerId)) as Perm;
  const uid = t.act.lifecycleUid!;
  if (stripped.has(uid)) p = strip(p);
  if (deaf.has(uid)) p = { ...p, sub: { ...p.sub, allow: (p.sub?.allow ?? []).filter((r) => !r.includes(".ep.prin-reply.")) } };
  if (muted.has(uid)) p = { ...p, pub: { ...p.pub, allow: (p.pub?.allow ?? []).filter((r) => !r.includes(".ep.prin-reply.")) } };
  for (const g of grants.get(uid) ?? []) {
    const r = epPrincipalGrantRows(space, { owner: t.owner, actor: t.act.actor, uid }, { owner: g.target.owner, actor: g.target.actor, uid: g.target.uid }, g.commands);
    p = { ...p, pub: { ...p.pub, allow: [...(p.pub?.allow ?? []), ...r.pub] }, sub: { ...p.sub, allow: [...new Set([...(p.sub?.allow ?? []), ...r.sub])] } };
  }
  return p;
};

async function bearer(w: Who): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: w.scope, lifecycleUid: w.uid,
    ...(w.view ? { view: w.view } : {}), ...(w.view === "manager-caller" ? { managerInstanceId: mintLifecycleUid() } : {}) } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(privateKey as CryptoKey);
}

// ---- raw connections, for the forged publishes and subscriptions ----------------------------
interface Seat { label: string; nc: NatsConnection; refused: { operation: string; subject: string }[] }
const raws: NatsConnection[] = [];
function watchRefusals(label: string, nc: NatsConnection): Seat {
  raws.push(nc);
  const s: Seat = { label, nc, refused: [] };
  void (async () => {
    for await (const st of nc.status())
      if (st.type === "error" && st.error instanceof PermissionViolationError) s.refused.push({ operation: st.error.operation, subject: st.error.subject });
  })().catch(() => {});
  return s;
}
async function seat(w: Who): Promise<Seat> {
  const n = `ibx${randomUUID().replace(/-/g, "")}`;
  const nc = await connect({ servers: SERVERS, name: n, inboxPrefix: `_INBOX_${n}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer(w))] });
  return watchRefusals(w.name, nc);
}
/** A credential signed by the space's account from rows a shipped builder made, for the profiles
 *  the callout does not mint (an observer, a service's serve credential, a test inspector). */
async function staticSeat(label: string, perms: Perm): Promise<Seat> {
  const n = `ibx${randomUUID().replace(/-/g, "")}`;
  const u = createUser();
  const jwt = await encodeUser(label, u, fromPublic(auth.account.pub), { ...perms, sub: { ...perms.sub, allow: [...(perms.sub?.allow ?? []), `_INBOX_${n}.>`] } } as never,
    { signer: fromSeed(enc(auth.account.signingSeed)) });
  const nc = await connect({ servers: SERVERS, name: n, inboxPrefix: `_INBOX_${n}`, maxReconnectAttempts: 0, authenticator: credsAuthenticator(fmtCreds(jwt, u)) });
  return watchRefusals(label, nc);
}
const refusedNow = (s: Seat, operation: string, subject: string) => s.refused.some((r) => r.operation === operation && r.subject === subject);
async function publishRefused(s: Seat, subject: string, opts?: { reply?: string; headers?: ReturnType<typeof headers> }): Promise<boolean> {
  s.nc.publish(subject, enc("{}"), opts);
  await s.nc.flush();
  return until(() => refusedNow(s, "publish", subject));
}
async function subscribeRefused(s: Seat, subject: string): Promise<boolean> {
  s.nc.subscribe(subject, { callback: () => {} });
  await s.nc.flush().catch(() => {});
  return until(() => refusedNow(s, "subscription", subject));
}
async function subscribeAccepted(s: Seat, subject: string): Promise<boolean> {
  s.nc.subscribe(subject, { callback: () => {} });
  await s.nc.flush();
  return !(await until(() => refusedNow(s, "subscription", subject), 800));
}

// ---- the core-only test agent: one hand-made prompt, served on the `agent` endpoint ----------
const iso = (ms: number) => new Date(ms).toISOString();
const promptId = () => Array.from(randomBytes(26), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");
interface TestAgent { serve: PrincipalServe; prompt: AgentPrompt; seq: number; calls: { command: string; authority: string; caller: string }[]; reopen(): AgentPrompt }
function testAgent(ep: CotalEndpoint, w: Who): TestAgent {
  const content: PromptContent = {
    kind: "permission", title: "Allow Bash: npm test?",
    subject: { type: "tool", name: "Bash", input: { kind: "shown", value: { command: "npm test" } }, cwd: "/work" },
    options: [{ id: "allow", label: "Allow", effect: "proceed" }, { id: "deny", label: "Deny", effect: "refuse", note: "optional" }],
    source: { harness: "smoke", scope: "main" },
  };
  const open = (): AgentPrompt => ({ id: promptId(), digest: agentPromptDigest(content), openedAt: iso(Date.now()), expiresAt: iso(Date.now() + 300_000), state: { kind: "open" }, content });
  const agent: TestAgent = {
    serve: undefined as unknown as PrincipalServe, prompt: open(), seq: 1, calls: [],
    reopen() { agent.prompt = open(); agent.seq++; void ep.setPromptsPresence({ open: 1, seq: agent.seq }); return agent.prompt; },
  };
  const note = (command: string) => (ctx: { authority: string; caller: { owner: string; actor: string; uid: string } }) =>
    agent.calls.push({ command, authority: ctx.authority, caller: `${ctx.caller.owner}.${ctx.caller.actor}.${ctx.caller.uid}` });
  const handlers: EpPrincipalCommandDef[] = [
    { command: "prompts", contract: AGENT_CONTRACTS.prompts, handler: (ctx) => {
      note("prompts")(ctx);
      const p = agent.prompt;
      const summary = { id: p.id, digest: p.digest, openedAt: p.openedAt, expiresAt: p.expiresAt, state: p.state, kind: p.content.kind, title: p.content.title,
        contentBytes: Buffer.byteLength(canonicalJson(p.content)), source: p.content.source };
      const rt = { id: ctx.principal.runtimeId, startedAt: Math.floor(performance.timeOrigin) };
      return { runtime: rt, seq: agent.seq, open: p.state.kind === "closed" ? [] : [summary], closed: p.state.kind === "closed" ? [summary] : [] };
    } },
    { command: "prompt", contract: AGENT_CONTRACTS.prompt, handler: (ctx) => {
      note("prompt")(ctx);
      const { id } = ctx.request.args as { id: string };
      if (id !== agent.prompt.id) throw new EpEnvelopeError("not-found", `prompt ${id} is not known to this runtime`, undefined, "not-executed");
      return { prompt: agent.prompt };
    } },
    { command: "prompt-answer", contract: AGENT_CONTRACTS["prompt-answer"], handler: async (ctx) => {
      note("prompt-answer")(ctx);
      const a = ctx.request.args as unknown as PromptAnswerInput;
      if (ctx.caller.owner === w.owner && ctx.caller.actor === w.actor)
        throw new EpEnvelopeError("permission-denied", "an agent never answers its own prompt", undefined, "not-executed");
      const p = agent.prompt;
      if (a.id !== p.id) throw new EpEnvelopeError("not-found", `prompt ${a.id} is not known to this runtime`, undefined, "not-executed");
      if (p.state.kind !== "open") throw new EpEnvelopeError("conflict", "the prompt is not open", [{ kind: AGENT_PROMPT_STATE_DETAIL, state: p.state }], "not-executed");
      if (a.digest !== p.digest) throw new EpEnvelopeError("failed-precondition", "the digest is not the prompt's", [{ kind: AGENT_PROMPT_DIGEST_DETAIL, digest: p.digest }], "not-executed");
      const option = p.content.options.find((o) => o.id === a.option);
      if (!option) throw new EpEnvelopeError("bad-request", `option ${a.option} is not one of the prompt's`, undefined, "not-executed");
      p.state = { kind: "sent", delivery: "unconfirmed",
        answer: { by: { id: `${ctx.caller.owner}.${ctx.caller.actor}`, uid: ctx.caller.uid, authority: ctx.authority }, option: option.id, effect: option.effect, at: iso(Date.now()) } };
      agent.seq++;
      await ep.setPromptsPresence({ open: 1, seq: agent.seq });
      return { state: p.state };
    } },
    { command: "commands", contract: AGENT_CONTRACTS.commands, handler: () => ({ supported: false }) },
    { command: "command", contract: AGENT_CONTRACTS.command, handler: () => { throw new EpEnvelopeError("unimplemented", "this test agent runs no commands", undefined, "not-executed"); } },
  ];
  agent.serve = ep.servePrincipal({ handlers });
  return agent;
}

// ---- endpoints ----------------------------------------------------------------------------
const endpoints: CotalEndpoint[] = [];
const warnings: string[] = [];
function own(ep: CotalEndpoint, label: string): CotalEndpoint {
  ep.on("error", (e: Error) => warnings.push(`${label} error: ${e.message}`));
  ep.on("warning", (e: Error) => warnings.push(`${label} warning: ${e.message}`));
  endpoints.push(ep);
  return ep;
}
async function userEndpoint(w: Who, opts: { registerPresence?: boolean; watchPresence?: boolean } = {}): Promise<CotalEndpoint> {
  const ep = own(new CotalEndpoint({ space, servers: SERVERS, bearer: () => bearer(w), sentinelCreds: callout.sentinelCreds, lifecycleUid: w.uid,
    card: { owner: w.owner, actor: w.actor, name: w.actor, kind: "agent" }, channels: [], consume: false, watchChannels: false,
    registerPresence: opts.registerPresence ?? false, watchPresence: opts.watchPresence ?? false }), w.name);
  await ep.start();
  return ep;
}
const addressOf = (w: Who, rt: string = randomUUID()): EpPrincipal => ({ owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: rt });

let calloutNc: NatsConnection | undefined;
try {
  for (const port of [PORT, OPEN_PORT]) {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${port}`); if (!up) await wait(200); }
    if (!up) throw new Error(`nats-server did not come up on ${port}`);
  }
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  const provisioner = own(new CotalEndpoint({ space, servers: SERVERS, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false }), "provisioner");
  await provisioner.start();
  // The agents that register presence prove their lifecycle with their own DM durable.
  for (const w of [W.coder, W.legacy, W.cycler]) await provisionAgentDurables(provisioner, { owner: w.owner, actor: w.actor, lifecycleUid: w.uid }, { durableMembership: false });

  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: mintFor,
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });
  grants.set(W.builder.uid, [
    { target: W.coder, commands: ["describe", "prompts", "prompt", "prompt-answer"] },
    { target: W.tester, commands: ["prompts"] },
  ]);
  stripped.add(W.legacy.uid);
  stripped.add(W.oldWeb.uid);

  const coderEp = await userEndpoint(W.coder, { registerPresence: true });
  const webEp = await userEndpoint(W.web, { watchPresence: true });
  const builderEp = await userEndpoint(W.builder);
  const bobWebEp = await userEndpoint(W.bobWeb);
  const helperEp = await userEndpoint(W.helper);
  const termEp = await userEndpoint(W.term);
  const oldWebEp = await userEndpoint(W.oldWeb);
  check("every principal connects through the shipped callout", endpoints.every((ep) => ep !== undefined));

  // ── the serve and call round trip, and cell 1 ──
  console.log("\nround trip: a core-only test agent serves a hand-made prompt");
  const coder = testAgent(coderEp, W.coder);
  await coder.serve.ready;
  check("servePrincipal: ready resolves once the broker accepted the subscription", true);
  await coderEp.setPromptsPresence({ open: 1, seq: coder.seq });
  let seen: Presence | undefined;
  await until(() => { seen = webEp.getRoster().find((p) => p.card.id === `${A}.coder`); return seen?.prompts?.seq === coder.seq; }, 8000);
  check("the caller learns the agent's address and its prompts count from presence",
    seen?.lifecycleUid === W.coder.uid && typeof seen.runtime?.id === "string" && seen.prompts?.open === 1 && seen.prompts.seq === coder.seq, seen);
  const coderAt: EpPrincipal = { owner: A, actor: "coder", uid: seen!.lifecycleUid!, runtimeId: seen!.runtime!.id };
  const call = (ep: CotalEndpoint, to: EpPrincipal, command: string, authority: "owner" | "grant", args?: Record<string, unknown>, deadlineMs = 4000) =>
    ep.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: to, command, authority, ...(args ? { args } : {}), deadlineMs });

  const list = await call(webEp, coderAt, "prompts", "owner", {});
  const listed = list.ok ? (list.data as { open: { id: string; digest: string; title: string }[]; seq: number; runtime: { id: string } }) : undefined;
  console.log(`    prompts -> ${JSON.stringify(listed?.open.map((s) => ({ id: s.id, title: s.title })))} seq ${listed?.seq}`);
  check("cell 1: prompts answers the owner's interactive session with the open prompt and the runtime it asked",
    listed?.open.length === 1 && listed.open[0].id === coder.prompt.id && listed.runtime.id === coderAt.runtimeId && listed.seq === coder.seq, list);
  const full = await call(webEp, coderAt, "prompt", "owner", { id: coder.prompt.id });
  const got = full.ok ? (full.data as { prompt: AgentPrompt }).prompt : undefined;
  check("cell 1: prompt answers the full prompt, and the reader's recomputed digest equals the one it carries",
    got !== undefined && agentPromptDigest(got.content) === got.digest && got.digest === listed?.open[0].digest, full);
  const answered = await call(webEp, coderAt, "prompt-answer", "owner", { id: got!.id, digest: got!.digest, option: "deny", note: "not now" });
  const state = answered.ok ? (answered.data as { state: PromptState }).state : undefined;
  console.log(`    prompt-answer -> ${JSON.stringify(state)}`);
  check("cell 1: prompt-answer is accepted, and the answerer comes from the subject: the owner word and the caller triple",
    state?.kind === "sent" && state.answer.by.id === `${A}.web` && state.answer.by.uid === W.web.uid && state.answer.by.authority === "owner" && state.answer.option === "deny", answered);
  const describe = await call(webEp, coderAt, "describe", "owner");
  const answer = describe.ok ? (describe.data as DescribeAnswer) : undefined;
  check("cell 1: describe answers the fixed cluster inline, public, under the agent's owner",
    answer?.public === true && answer.descriptor.endpoint === "agent" && answer.descriptor.owner === A
    && answer.descriptor.clusters[0].digest === agentClusterArtifacts().closureDigest
    && JSON.stringify(answer.descriptor.clusters[0].commands) === JSON.stringify(["prompts", "prompt", "prompt-answer", "commands", "command"]), describe);
  check("cell 1: the agent's handlers saw three requests, each under the owner word from alice.web's triple",
    coder.calls.length === 3 && coder.calls.every((c) => c.authority === "owner" && c.caller === `${A}.web.${W.web.uid}`), coder.calls);
  await until(() => webEp.getRoster().find((p) => p.card.id === `${A}.coder`)?.prompts?.seq === coder.seq, 8000);
  check("presence: the counter moved with the answer, and a presence event carried it to the reader",
    webEp.getRoster().find((p) => p.card.id === `${A}.coder`)?.prompts?.seq === coder.seq);
  const again = await call(webEp, coderAt, "prompt-answer", "owner", { id: got!.id, digest: got!.digest, option: "allow" });
  check("a second answer meets the state the first one left: conflict, not-executed, with the state in details",
    !again.ok && again.error.code === "conflict" && again.error.outcome === "not-executed" && again.error.details?.[0]?.kind === AGENT_PROMPT_STATE_DETAIL, again);

  // ── cell 2: a managed agent publishes a request addressed to itself ──
  const coderRaw = await seat(W.coder);
  const reqTo = (to: EpPrincipal, cmd: string, word: string, c: Who) => epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: to, command: cmd, authority: word as "owner", caller: { owner: c.owner, actor: c.actor, uid: c.uid }, nonce: nonce() });
  {
    const before = coder.calls.length;
    const r = await Promise.all(["owner", "grant"].map((word) => publishRefused(coderRaw, reqTo(coderAt, "prompt-answer", word, W.coder))));
    check(`cell 2: ${r.filter(Boolean).length}/2 self-addressed publishes by the managed agent refused by the broker`, r.every(Boolean));
    check("cell 2: the agent received none", coder.calls.length === before);
  }

  // ── cell 3: an interactive actor that runs a harness answers itself ──
  {
    const term = testAgent(termEp, W.term);
    await term.serve.ready;
    const termAt = addressOf(W.term, processRuntime(W.term.uid).id);
    const self = await call(termEp, termAt, "prompt-answer", "owner", { id: term.prompt.id, digest: term.prompt.digest, option: "allow" });
    check("cell 3: the broker lets an interactive actor call its own agent endpoint, and the command refuses permission-denied",
      !self.ok && self.error.code === "permission-denied" && self.error.outcome === "not-executed" && term.calls.at(-1)?.caller === `${A}.term.${W.term.uid}`, self);
    const read = await call(termEp, termAt, "prompts", "owner", {});
    check("cell 3: the same actor may read its own prompts", read.ok);
    await term.serve.stop();
  }

  // ── cells 4 and 5: a sibling agent of the same owner ──
  const helperRaw = await seat(W.helper);
  {
    const before = coder.calls.length;
    const r = await Promise.all(["owner", "grant"].map((word) => publishRefused(helperRaw, reqTo(coderAt, "prompt-answer", word, W.helper))));
    check(`cell 4: ${r.filter(Boolean).length}/2 sibling publishes refused`, r.every(Boolean));
    check("cell 4: the agent received none", coder.calls.length === before);
    const subs = [
      `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${coderAt.runtimeId}.*.*.*.*.*.*`,
      `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.>`,
      `${P}.ep.prin.agent.${A}.>`,
      `${P}.ep.prin.>`,
    ];
    const s = await Promise.all(subs.map((sub) => subscribeRefused(helperRaw, sub)));
    check(`cell 5: ${s.filter(Boolean).length}/${subs.length} sibling subscriptions to the agent's request subject refused`, s.every(Boolean));
  }

  // ── cell 6: another owner's interactive session calls ──
  const bobWebRaw = await seat(W.bobWeb);
  {
    const before = coder.calls.length;
    const r = await Promise.all(["describe", "prompts", "prompt", "prompt-answer"].map((cmd) => publishRefused(bobWebRaw, reqTo(coderAt, cmd, "owner", W.bobWeb))));
    check(`cell 6: ${r.filter(Boolean).length}/4 publishes by bob.web refused`, r.every(Boolean));
    const viaCaller = await settle(call(bobWebEp, coderAt, "prompts", "owner", {}));
    check("cell 6: the shipped caller reports the refusal as permission-denied, not-executed",
      !viaCaller.ok && codeOf(viaCaller.error) === "permission-denied/not-executed", viaCaller);
    check("cell 6: the agent received none", coder.calls.length === before);
  }

  // ── cell 7: admin, observer, a manager-caller view, a service credential ──
  {
    const before = coder.calls.length;
    const observer = await staticSeat("observer", permissionsFor("observer", space, { owner: A, actor: "obs", connId: "ibxobserverobserverobserver0000", readerId: "rdr0" }, {}) as Perm);
    const svcRows = epServeGrantRows(space, { endpoint: "org.example.svc", instanceId: mintLifecycleUid(), epoch: 1, ephemeralCommands: ["run"] });
    const service = await staticSeat("service serve credential", { pub: { allow: svcRows.pub }, sub: { allow: svcRows.sub } });
    const holders: [Seat, Who][] = [[await seat(W.admin), W.admin], [observer, who(A, "obs", undefined)], [await seat(W.mgrCaller), W.mgrCaller], [service, who(A, "svc", undefined)]];
    let pubs = 0, subs = 0;
    for (const [s, w] of holders) {
      const p = await Promise.all([
        publishRefused(s, reqTo(coderAt, "prompt-answer", "owner", w)),
        publishRefused(s, reqTo(coderAt, "prompt-answer", "grant", w)),
        publishRefused(s, epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: coderAt, caller: { owner: A, actor: "web", uid: W.web.uid }, nonce: nonce() })),
      ]);
      const q = await Promise.all([`${P}.ep.prin.>`, `${P}.ep.prin-reply.>`, `${P}.ep.*.agent.>`].map((sub) => subscribeRefused(s, sub)));
      pubs += p.filter(Boolean).length; subs += q.filter(Boolean).length;
      console.log(`    ${s.label}: ${p.filter(Boolean).length}/3 publishes refused, ${q.filter(Boolean).length}/3 subscriptions refused`);
    }
    check(`cell 7: ${pubs}/12 publishes and ${subs}/12 subscriptions refused across admin, observer, manager-caller and a service credential`, pubs === 12 && subs === 12);
    check("cell 7: the agent received none", coder.calls.length === before);
  }

  // ── cell 8: a caller publishes with another caller's tokens in the tail ──
  const webRaw = await seat(W.web);
  {
    const before = coder.calls.length;
    const forged = [
      reqTo(coderAt, "prompt-answer", "owner", W.bobWeb),
      reqTo(coderAt, "prompt-answer", "owner", { ...W.web, actor: "other" }),
      reqTo(coderAt, "prompt-answer", "owner", { ...W.web, uid: mintLifecycleUid() }),
    ];
    const r = await Promise.all(forged.map((s) => publishRefused(webRaw, s)));
    check(`cell 8: ${r.filter(Boolean).length}/3 forged-tail publishes refused (other owner, other actor, other uid)`, r.every(Boolean));
    check("cell 8: the agent received none", coder.calls.length === before);
  }

  // ── cells 9, 20 and 21: crafted envelopes from the owner's own row ──
  const D = (cmd: string) => ({ inputDigest: AGENT_CONTRACTS[cmd].input.closureDigest, outputDigest: AGENT_CONTRACTS[cmd].output.closureDigest });
  async function rawCall(s: Seat, cmd: string, over: Record<string, unknown>, opts: { headers?: ReturnType<typeof headers>; waitMs?: number } = {}): Promise<EndpointReply | "none"> {
    const n = nonce();
    const subject = epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: coderAt, command: cmd, authority: "owner", caller: { owner: A, actor: "web", uid: W.web.uid }, nonce: n });
    const replyTo = epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: coderAt, caller: { owner: A, actor: "web", uid: W.web.uid }, nonce: n });
    const got: Msg[] = [];
    const sub = s.nc.subscribe(`${P}.ep.prin-reply.*.*.*.*.*.${A}.web.${W.web.uid}.${n}`, { callback: (_e, m) => { got.push(m); } });
    await s.nc.flush();
    const env = { v: 1, id: hex(8), op: { endpoint: AGENT_ENDPOINT, command: cmd, ...D(cmd) }, class: "ephemeral", replyExpected: true, deadlineMs: 4000,
      args: { id: coder.prompt.id }, from: { id: `${A}.web`, name: "web" }, ...over };
    s.nc.publish(subject, enc(JSON.stringify(env)), { reply: epPrincipalNoRespondersSubject(space, { owner: A, actor: "web", uid: W.web.uid }, n), ...(opts.headers ? { headers: opts.headers } : {}) });
    await s.nc.flush();
    await until(() => got.length > 0, opts.waitMs ?? 3000);
    sub.unsubscribe();
    if (got.length === 0) return "none";
    return got[0].subject === replyTo ? JSON.parse(dec(got[0].data)) as EndpointReply : "none";
  }
  {
    const r9 = await rawCall(webRaw, "prompt", { from: { id: `${A}.boss`, name: "boss" } });
    check("cell 9: from.id naming someone else is answered sender-mismatch, not-executed", r9 !== "none" && !r9.ok && r9.error.code === "sender-mismatch" && r9.error.outcome === "not-executed", r9);
    const before = coder.calls.length;
    const h = headers();
    h.set("Nats-Stream", "SOMESTREAM");
    const r20a = await rawCall(webRaw, "prompt", {}, { headers: h, waitMs: 1500 });
    const h2 = headers();
    h2.set("nats-subject", "");
    const r20b = await rawCall(webRaw, "prompt", {}, { headers: h2, waitMs: 1500 });
    check("cell 20: frames carrying Nats-Stream or an empty nats-subject header are dropped: no reply, no handler", r20a === "none" && r20b === "none" && coder.calls.length === before, { r20a, r20b });
    const r21a = await rawCall(webRaw, "prompt", { target: { owner: A, actor: "coder", lifecycleUid: W.coder.uid } });
    const r21b = await rawCall(webRaw, "prompt", { bind: { instanceId: W.coder.uid, epoch: 0 } });
    check("cell 21: a body target is target-mismatch and a bind is bad-request, both not-executed",
      r21a !== "none" && !r21a.ok && r21a.error.code === "target-mismatch" && r21a.error.outcome === "not-executed"
      && r21b !== "none" && !r21b.ok && r21b.error.code === "bad-request" && r21b.error.outcome === "not-executed", { r21a, r21b });
    const ok = await rawCall(webRaw, "prompt", {});
    check("control: the same raw envelope with nothing forged is answered ok", ok !== "none" && ok.ok, ok);

    // cell 27: the caller's row spans the nonce, so the broker passes a malformed one. The subject
    // then matches no shape and the handler MUST NOT run (SPEC 13.21).
    const beforeBadNonce = coder.calls.length;
    const good = epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: coderAt, command: "prompt", authority: "owner", caller: { owner: A, actor: "web", uid: W.web.uid }, nonce: nonce() });
    const badNonce = `${good.slice(0, good.lastIndexOf(".") + 1)}x`;
    const env = { v: 1, id: hex(8), op: { endpoint: AGENT_ENDPOINT, command: "prompt", ...D("prompt") }, class: "ephemeral", replyExpected: true, deadlineMs: 4000,
      args: { id: coder.prompt.id }, from: { id: `${A}.web`, name: "web" } };
    webRaw.nc.publish(badNonce, enc(JSON.stringify(env)), { reply: `${P}.ep.prin-reply._nr._nr._nr._nr._nr.${A}.web.${W.web.uid}.x` });
    await webRaw.nc.flush();
    await until(() => coder.calls.length > beforeBadNonce, 1500);
    check("cell 27: the broker passes the owner's request with the nonce x, and the agent's handler runs zero times",
      !refusedNow(webRaw, "publish", badNonce) && coder.calls.length === beforeBadNonce, { ran: coder.calls.length - beforeBadNonce });

    // cell 37: every command on this route is request/reply, so a cast is refused before the
    // handler runs, and like every cast it gets no reply.
    const beforeCast = coder.calls.length;
    const cast = await rawCall(webRaw, "prompt", { replyExpected: false }, { waitMs: 1500 });
    check("cell 37: a request with replyExpected false is refused: the agent's handler runs zero times, and no reply comes",
      cast === "none" && coder.calls.length === beforeCast, { ran: coder.calls.length - beforeCast, cast });

    // cell 40: a principal-route deadline is at most 30 s, so a handler that ignores its signal
    // cannot hold a serve's stop open longer. A larger one is refused before the handler runs.
    const beforeLong = coder.calls.length;
    const long = await rawCall(webRaw, "prompt", { deadlineMs: 30_001 });
    check("cell 40: a request with deadlineMs 30001 on the owner's row is answered bad-request, not-executed, and the agent's handler runs zero times",
      long !== "none" && !long.ok && long.error.code === "bad-request" && long.error.outcome === "not-executed" && coder.calls.length === beforeLong,
      { ran: coder.calls.length - beforeLong, long });
    const atCap = await rawCall(webRaw, "prompt", { deadlineMs: 30_000 });
    check("control: the same request with deadlineMs 30000 is answered ok", atCap !== "none" && atCap.ok, atCap);

    // cell 41: the caller refuses the same deadline before it publishes anything.
    const webNc = (webEp as unknown as { nc: NatsConnection }).nc;
    const publish = webNc.publish.bind(webNc);
    let published = 0;
    webNc.publish = (subject, ...rest) => { if (subject.startsWith(`${P}.ep.prin.`)) published++; return publish(subject, ...rest); };
    const refusedLong = await settle(webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: coderAt, command: "prompts", authority: "owner", args: {}, deadlineMs: 30_001 }));
    webNc.publish = publish;
    check("cell 41: callPrincipal with deadlineMs 30001 throws bad-request, not-executed, and publishes no request",
      !refusedLong.ok && codeOf(refusedLong.error) === "bad-request/not-executed" && published === 0,
      { published, got: refusedLong.ok ? refusedLong.value : codeOf(refusedLong.error) });
  }

  // ── cell 10: the agent publishes a reply under another principal's head ──
  {
    const tail = { owner: A, actor: "web", uid: W.web.uid };
    const heads = [
      epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(W.helper), caller: tail, nonce: nonce() }),
      epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(coderNext), caller: tail, nonce: nonce() }),
      epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: addressOf(W.builder), caller: tail, nonce: nonce() }),
      epPrincipalReplySubject(space, { endpoint: "other", principal: coderAt, caller: tail, nonce: nonce() }),
    ];
    const r = await Promise.all(heads.map((s) => publishRefused(coderRaw, s)));
    check(`cell 10: ${r.filter(Boolean).length}/4 replies under a foreign head refused (sibling, own later lifecycle, other owner, other endpoint)`, r.every(Boolean));
  }

  // ── cell 11: a caller subscribes another caller's reply subject ──
  const builderRaw = await seat(W.builder);
  {
    const r = await Promise.all([
      subscribeRefused(bobWebRaw, `${P}.ep.prin-reply.*.*.*.*.*.${A}.web.${W.web.uid}.*`),
      subscribeRefused(bobWebRaw, `${P}.ep.prin-reply.>`),
      subscribeRefused(webRaw, `${P}.ep.prin-reply.*.*.*.*.*.${B}.web.${W.bobWeb.uid}.*`),
      subscribeRefused(builderRaw, `${P}.ep.prin-reply.*.*.*.*.*.${A}.web.${W.web.uid}.*`),
    ]);
    check(`cell 11: ${r.filter(Boolean).length}/4 foreign reply subscriptions refused`, r.every(Boolean));
  }

  // ── cell 12: a request names a runtime id nobody serves ──
  {
    const before = coder.calls.length;
    const gone = await settle(call(webEp, { ...coderAt, runtimeId: "rt_gone" }, "prompt-answer", "owner", { id: coder.prompt.id, digest: coder.prompt.digest, option: "allow" }));
    check("cell 12: unavailable, not-executed, answered by the broker on the sentinel, never a reply",
      !gone.ok && codeOf(gone.error) === "unavailable/not-executed", gone);
    check("cell 12: the agent received none", coder.calls.length === before);
  }

  // ── cells 13 and 14: a serving credential and the sentinel ──
  {
    const r = await Promise.all([
      publishRefused(coderRaw, epPrincipalNoRespondersSubject(space, { owner: A, actor: "web", uid: W.web.uid }, nonce()), { headers: headers(503, "No Responders") }),
      publishRefused(builderRaw, epPrincipalNoRespondersSubject(space, { owner: B, actor: "builder", uid: W.builder.uid }, nonce())),
      publishRefused(webRaw, epPrincipalNoRespondersSubject(space, { owner: A, actor: "web", uid: W.web.uid }, nonce())),
    ]);
    check(`cell 13: ${r.filter(Boolean).length}/3 publishes on a sentinel refused (the agent forging a 503, a grantee, an interactive session)`, r.every(Boolean));
    // The agent's own raw connection serves a second runtime and answers every request with a 503 on the caller's sentinel.
    const liarRt = `${coderAt.runtimeId.slice(0, 30)}x`;
    let received = 0;
    const forgedBefore = coderRaw.refused.length;
    coderRaw.nc.subscribe(`${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${liarRt}.*.*.*.*.*.*`, { callback: (_e, m) => {
      received++;
      const t = m.subject.split(".");
      coderRaw.nc.publish(`${P}.ep.prin-reply._nr._nr._nr._nr._nr.${t[11]}.${t[12]}.${t[13]}.${t[14]}`, new Uint8Array(), { headers: headers(503, "No Responders") });
    } });
    await coderRaw.nc.flush();
    const lie = await settle(call(webEp, { ...coderAt, runtimeId: liarRt }, "prompts", "owner", {}, 2000));
    const forgedRefused = await until(() => coderRaw.refused.slice(forgedBefore).some((x) => x.operation === "publish" && x.subject.includes(".ep.prin-reply._nr._nr._nr._nr._nr.")), 1000);
    check("cell 14: the serving agent received the request and its forged no-responders was refused", received === 1 && forgedRefused, { received, forgedRefused });
    check("cell 14: the caller saw deadline-exceeded, unknown, never unavailable", !lie.ok && codeOf(lie.error) === "deadline-exceeded/unknown", lie);
  }

  // ── cell 15: a credential from another lifecycle of the agent subscribes this uid ──
  {
    const next = await seat(coderNext);
    const r = await Promise.all([
      `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${coderAt.runtimeId}.*.*.*.*.*.*`,
      `${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.>`,
      `${P}.ep.prin.agent.${A}.coder.*.*.*.*.*.*.*.*.*`,
    ].map((s) => subscribeRefused(next, s)));
    check(`cell 15: ${r.filter(Boolean).length}/3 subscriptions by the later lifecycle to this uid refused`, r.every(Boolean));
    check("cell 15 control: the later lifecycle subscribes its own uid", await subscribeAccepted(next, `${P}.ep.prin.agent.${A}.coder.${coderNext.uid}.rt_other.*.*.*.*.*.*`));
  }

  // ── cells 16 and 17: a hand-built grant row ──
  {
    const fresh = coder.reopen();
    const before = coder.calls.length;
    const reads = await Promise.all([call(builderEp, coderAt, "describe", "grant"), call(builderEp, coderAt, "prompts", "grant", {}), call(builderEp, coderAt, "prompt", "grant", { id: fresh.id })]);
    const ans = await call(builderEp, coderAt, "prompt-answer", "grant", { id: fresh.id, digest: fresh.digest, option: "allow" });
    const st = ans.ok ? (ans.data as { state: PromptState }).state : undefined;
    check("cell 16: the grant row reads and answers, and the answer's by.authority is grant",
      reads.every((r) => r.ok) && st?.kind === "sent" && st.answer.by.authority === "grant" && st.answer.by.id === `${B}.builder` && st.answer.by.uid === W.builder.uid, { reads, ans });
    check("cell 16: the agent's handlers received three requests, each under the grant word", coder.calls.length - before === 3 && coder.calls.slice(before).every((c) => c.authority === "grant"));
    const r = await Promise.all([
      publishRefused(builderRaw, reqTo(addressOf(W.helper), "prompt-answer", "grant", W.builder)),
      publishRefused(builderRaw, reqTo(addressOf(coderNext), "prompt-answer", "grant", W.builder)),
      publishRefused(builderRaw, reqTo({ ...coderAt, owner: B }, "prompt-answer", "grant", W.builder)),
    ]);
    check(`cell 17: ${r.filter(Boolean).length}/3 grant publishes off the named lifecycle refused (sibling, later lifecycle, other owner)`, r.every(Boolean));
  }

  // ── cell 18: a static credential and an open mesh ──
  {
    const staticUid = mintLifecycleUid(), openUid = mintLifecycleUid();
    const staticCreds = await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "local", actor: "stat" }, lifecycleUid: staticUid });
    const staticEp = own(new CotalEndpoint({ space, servers: SERVERS, creds: staticCreds, lifecycleUid: staticUid, card: { owner: "local", actor: "stat", name: "stat", kind: "agent" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false }), "static");
    await staticEp.start();
    const openEp = own(new CotalEndpoint({ space, servers: OPEN_SERVERS, lifecycleUid: openUid, card: { actor: "open", name: "open", kind: "agent" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false }), "open");
    await openEp.start();
    const handlers = (["prompts", "prompt", "prompt-answer"] as const).map((command) => ({ command, contract: AGENT_CONTRACTS[command], handler: () => undefined }));
    let staticRefusal = "", openRefusal = "";
    try { staticEp.servePrincipal({ handlers }); } catch (e) { staticRefusal = (e as Error).message; }
    try { openEp.servePrincipal({ handlers }); } catch (e) { openRefusal = (e as Error).message; }
    check("cell 18: servePrincipal throws on a static credential", staticRefusal.includes("static credential"), staticRefusal);
    check("cell 18: servePrincipal throws on an open mesh", openRefusal.includes("open mesh"), openRefusal);
    // Nothing subscribed the would-be subjects: the broker answers no responders for each.
    const probe = async (nc: NatsConnection, subject: string) => {
      const inbox = `probe.${hex(8)}`;
      let code: number | undefined;
      const sub = nc.subscribe(inbox, { callback: (_e, m) => { code = (m.headers as { code?: number } | undefined)?.code; } });
      nc.publish(subject, enc("{}"), { reply: inbox });
      await nc.flush();
      await until(() => code !== undefined, 2000);
      sub.unsubscribe();
      return code;
    };
    const inspector = (await staticSeat("inspector", { pub: { allow: [">"] }, sub: { allow: [">"] } })).nc;
    const openRaw = await connect({ servers: OPEN_SERVERS, maxReconnectAttempts: 0 });
    raws.push(openRaw);
    // The exact subjects these processes would serve: their own principal, lifecycle and runtime id.
    const wouldServe = (actor: string, uid: string) => epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: { owner: "local", actor, uid, runtimeId: processRuntime(uid).id },
      command: "prompts", authority: "owner", caller: { owner: "local", actor: "x", uid: mintLifecycleUid() }, nonce: nonce() });
    const staticCode = await probe(inspector, wouldServe("stat", staticUid));
    const openCode = await probe(openRaw, wouldServe("open", openUid));
    check("cell 18: no principal-route subject is served on either mesh (the broker answers no responders)", staticCode === 503 && openCode === 503, { staticCode, openCode });
  }

  // ── cell 19, also the mixed-version case of an agent whose credential predates the rows ──
  {
    const legacyEp = await userEndpoint(W.legacy, { registerPresence: true });
    const legacy = testAgent(legacyEp, W.legacy);
    const r = await settle(legacy.serve.ready);
    check("cell 19: a credential without the serve rows: ready rejects with the broker's refusal",
      !r.ok && r.error instanceof EpEnvelopeError && r.error.code === "permission-denied" && (r.error as Error).message.includes("principal-route subject"), r);
    const failed = await Promise.race([legacy.serve.failed, wait(1000).then(() => undefined)]);
    check("cell 19: the refusal ends the serve: failed resolves", failed instanceof Error);
    let presence: Presence | undefined;
    await until(() => { presence = webEp.getRoster().find((p) => p.card.id === `${A}.legacy`); return presence !== undefined; }, 8000);
    check("cell 19: its presence carries no prompts field", presence !== undefined && presence.prompts === undefined, presence);
    let setRefusal = "";
    try { await legacyEp.setPromptsPresence({ open: 0, seq: 0 }); } catch (e) { setRefusal = (e as Error).message; }
    check("cell 19: the presence setter refuses once the serve ended", setRefusal.includes("call servePrincipal first"), setRefusal);
    check("cell 19: the refused subscription reached no error listener", !warnings.some((w) => w.startsWith("alice.legacy error")), warnings.filter((w) => w.startsWith("alice.legacy")));
  }

  // ── cell 22: an owner caller sends the grant word, and the reverse ──
  {
    const before = coder.calls.length;
    const r = await Promise.all([
      publishRefused(webRaw, reqTo(coderAt, "prompt-answer", "grant", W.web)),
      publishRefused(bobWebRaw, reqTo(addressOf(W.builder), "prompt-answer", "grant", W.bobWeb)),
      publishRefused(builderRaw, reqTo(coderAt, "prompt-answer", "owner", W.builder)),
      publishRefused(builderRaw, reqTo({ ...coderAt, owner: B }, "prompt-answer", "owner", W.builder)),
    ]);
    check(`cell 22: ${r.filter(Boolean).length}/4 publishes under the other authority word refused`, r.every(Boolean));
    check("cell 22: the agent received none", coder.calls.length === before);
  }

  // ── cell 23: servePrincipal and a cluster command that declares no authorities ──
  {
    const plain = buildClusterDocument("ai.cotal.test", 1, [{ name: "prompts", targeted: false, capability: "agent.prompts.read", input: { type: "object", additionalProperties: false, properties: {} }, output: { type: "null" } }]);
    let refusal = "";
    try { servePrincipalRoute(helperRaw.nc, space, addressOf(W.helper, processRuntime(W.helper.uid).id), { endpoint: AGENT_ENDPOINT, cluster: plain, handlers: [] }); } catch (e) { refusal = (e as Error).message; }
    check("cell 23: the general principal serve throws for a command without authorities, before anything is subscribed", refusal.includes("declares no authorities"), refusal);
    // The entry point an agent uses serves `agent` with AGENT_CLUSTER and nothing else.
    let bound = "";
    try { helperEp.servePrincipal({ endpoint: "other", cluster: AGENT_CLUSTER, handlers: [] } as unknown as { handlers: EpPrincipalCommandDef[] }); } catch (e) { bound = (e as Error).message; }
    check("cell 39: servePrincipal refuses an endpoint or cluster: it serves only agent with AGENT_CLUSTER", bound.includes("serves only the \"agent\" endpoint"), bound);
    console.log("    cell 24 (serveEndpoint refuses an authorities cluster) needs a registry-authorized serve grant: pnpm smoke:ep-serve");
  }

  // ── cell 25: a command that admits owner only, called with a grant row ──
  {
    const ownerOnly = buildClusterDocument("ai.cotal.test", 1, [{ name: "prompts", targeted: false, authorities: ["owner"], capability: "agent.prompts.read", input: { type: "object", additionalProperties: false, properties: {} }, output: { type: "object" } }]);
    const contract = { input: compileContract({ root: { type: "object", additionalProperties: false, properties: {} } }), output: compileContract({ root: { type: "object" } }) };
    let ran = 0;
    // A cluster other than AGENT_CLUSTER needs the general serve, which the package root does not export.
    const testerAt = addressOf(W.tester, processRuntime(W.tester.uid).id);
    const testerRaw = await seat(W.tester);
    const tester = servePrincipalRoute(testerRaw.nc, space, testerAt, { endpoint: AGENT_ENDPOINT, cluster: ownerOnly, handlers: [{ command: "prompts", contract, handler: () => { ran++; return {}; } }] });
    await tester.ready;
    const asGrant = await builderEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: testerAt, command: "prompts", authority: "grant", args: {}, deadlineMs: 4000, contract });
    check("cell 25: the broker lets the grant row through and the command refuses permission-denied, not-executed",
      !asGrant.ok && asGrant.error.code === "permission-denied" && asGrant.error.outcome === "not-executed" && ran === 0, asGrant);
    const asOwner = await webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: testerAt, command: "prompts", authority: "owner", args: {}, deadlineMs: 4000, contract });
    check("cell 25 control: the owner word the command admits runs it", asOwner.ok && ran === 1, asOwner);
    await tester.stop();
  }

  // ── cell 26: a cluster document's authorities refusals at parse ──
  {
    const D0 = `sha256:${"a".repeat(64)}`;
    const docWith = (cmd: Record<string, unknown>) => ({ urn: "ai.cotal.test", revision: 1, attributes: [], events: [], commands: [{ name: "prompts", class: "ephemeral", targeted: false, capability: "a.b", inputDigest: D0, outputDigest: D0, ...cmd }] });
    const bad = [
      { targeted: true, modes: ["owner"], authorities: ["owner"] }, { modes: ["owner"], authorities: ["owner"] }, { authorities: [] }, { authorities: ["owner", "boss"] },
    ].filter((cmd) => { try { parseClusterDocument(docWith(cmd)); return false; } catch (e) { return e instanceof ContractInvalidError; } });
    check(`cell 26: ${bad.length}/4 documents refused contract-invalid at parse (targeted, with modes, empty, unknown word)`, bad.length === 4);
  }

  // ── cell 28: a stored frame on the caller's sentinel ──
  // The agent's whole real credential holds Direct Get on the presence bucket, and Direct Get replies
  // on whatever subject its requester names. Its raw connection serves another runtime id and, for
  // each request, asks Direct Get to deliver its own stored presence on the caller's sentinel.
  {
    const rt = `${coderAt.runtimeId.slice(0, 30)}s`;
    const onSentinel: Msg[] = [];
    const watch = webRaw.nc.subscribe(`${P}.ep.prin-reply._nr._nr._nr._nr._nr.${A}.web.${W.web.uid}.*`, { callback: (_e, m) => { onSentinel.push(m); } });
    await webRaw.nc.flush();
    let received = 0;
    const refusedBefore = coderRaw.refused.length;
    const dg = coderRaw.nc.subscribe(`${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${rt}.*.*.*.*.*.*`, { callback: (_e, m) => {
      received++;
      const t = m.subject.split(".");
      coderRaw.nc.publish(`$JS.API.DIRECT.GET.KV_${presenceBucket(space)}`, enc(JSON.stringify({ last_by_subj: presenceKeySubject(space, A, "coder") })),
        { reply: epPrincipalNoRespondersSubject(space, { owner: t[11], actor: t[12], uid: t[13] }, t[14]) });
    } });
    await coderRaw.nc.flush();
    const r = await settle(call(webEp, { ...coderAt, runtimeId: rt }, "prompts", "owner", {}, 2500));
    dg.unsubscribe();
    watch.unsubscribe();
    const stored = onSentinel.filter((m) => m.headers?.get("Nats-Stream"));
    check("cell 28: with the agent's own credential a Direct Get delivered its stored presence on the caller's sentinel, with stored provenance",
      received === 1 && stored.length === 1 && coderRaw.refused.length === refusedBefore, { received, onSentinel: onSentinel.length, stored: stored.length, refused: coderRaw.refused.slice(refusedBefore) });
    check("cell 28: the caller drops the stored frame and does not settle on it: deadline-exceeded, unknown, never internal or unavailable",
      !r.ok && codeOf(r.error) === "deadline-exceeded/unknown", r.ok ? r.value : codeOf(r.error));
  }

  // ── cell 29: a message from another head reaches the caller's reply read first ──
  // The agent's reply row spans the runtime id, so its raw connection, serving another runtime id,
  // first replies under the head of the runtime the caller did not address, then the real reply.
  {
    const rt = `${coderAt.runtimeId.slice(0, 30)}d`;
    let received = 0;
    const liar = coderRaw.nc.subscribe(`${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${rt}.*.*.*.*.*.*`, { callback: (_e, m) => {
      received++;
      const t = m.subject.split(".");
      const caller = { owner: t[11], actor: t[12], uid: t[13] };
      const id = (JSON.parse(dec(m.data)) as { id: string }).id;
      const body = (seq: number) => enc(JSON.stringify({ v: 1, id, ok: true, data: { runtime: { id: rt, startedAt: 1 }, seq, open: [], closed: [] } }));
      coderRaw.nc.publish(epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: coderAt, caller, nonce: t[14] }), body(6));
      setTimeout(() => coderRaw.nc.publish(epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: { ...coderAt, runtimeId: rt }, caller, nonce: t[14] }), body(7)), 200);
    } });
    await coderRaw.nc.flush();
    const r = await settle(call(webEp, { ...coderAt, runtimeId: rt }, "prompts", "owner", {}, 3000));
    liar.unsubscribe();
    check("cell 29: a reply under another head is not this call's reply: the caller keeps waiting and takes the one the addressed process derives",
      received === 1 && r.ok && r.value.ok && (r.value.data as { seq: number }).seq === 7, r.ok ? r.value : codeOf(r.error));
  }

  // ── cell 34: a JetStream API reply on the caller's sentinel ──
  // Any client that may make a JetStream API request can name the caller's sentinel as its reply
  // subject, and the broker answers there with plain JSON and no headers. The agent's raw
  // connection, with its whole stock credential, serves another runtime id, sends `$JS.API.INFO`
  // with the caller's sentinel as reply, then sends the real reply.
  {
    const rt = `${coderAt.runtimeId.slice(0, 30)}j`;
    const onSentinel: Msg[] = [];
    const watch = webRaw.nc.subscribe(`${P}.ep.prin-reply._nr._nr._nr._nr._nr.${A}.web.${W.web.uid}.*`, { callback: (_e, m) => { onSentinel.push(m); } });
    await webRaw.nc.flush();
    let received = 0;
    const refusedBefore = coderRaw.refused.length;
    const js = coderRaw.nc.subscribe(`${P}.ep.prin.agent.${A}.coder.${W.coder.uid}.${rt}.*.*.*.*.*.*`, { callback: (_e, m) => {
      received++;
      const t = m.subject.split(".");
      const caller = { owner: t[11], actor: t[12], uid: t[13] };
      coderRaw.nc.publish("$JS.API.INFO", enc(""), { reply: epPrincipalNoRespondersSubject(space, caller, t[14]) });
      const id = (JSON.parse(dec(m.data)) as { id: string }).id;
      const body = enc(JSON.stringify({ v: 1, id, ok: true, data: { runtime: { id: rt, startedAt: 1 }, seq: 8, open: [], closed: [] } }));
      setTimeout(() => coderRaw.nc.publish(epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: { ...coderAt, runtimeId: rt }, caller, nonce: t[14] }), body), 300);
    } });
    await coderRaw.nc.flush();
    const r = await settle(call(webEp, { ...coderAt, runtimeId: rt }, "prompts", "owner", {}, 3000));
    js.unsubscribe();
    watch.unsubscribe();
    const apiFrames = onSentinel.filter((m) => !m.headers && dec(m.data).includes("io.nats.jetstream.api.v1.account_info_response"));
    check("cell 34: with the agent's own credential a JetStream API request put its plain JSON answer on the caller's sentinel",
      received === 1 && apiFrames.length === 1 && coderRaw.refused.length === refusedBefore, { received, onSentinel: onSentinel.map((m) => dec(m.data).slice(0, 80)), refused: coderRaw.refused.slice(refusedBefore) });
    check("cell 34: the caller drops it and keeps waiting: it takes the real reply, never internal",
      r.ok && r.value.ok && (r.value.data as { seq: number }).seq === 8, r.ok ? r.value : codeOf(r.error));
  }

  // ── cell 30: stopping the endpoint ends its principal serve ──
  const stubHandlers = (prompts?: EpPrincipalCommandDef["handler"]): EpPrincipalCommandDef[] => (["prompts", "prompt", "prompt-answer", "commands", "command"] as const).map((command) => ({
    command, contract: AGENT_CONTRACTS[command],
    handler: command === "prompts" && prompts ? prompts : (ctx) => ({ runtime: { id: ctx.principal.runtimeId, startedAt: 1 }, seq: 0, open: [], closed: [] }),
  }));
  {
    const stopperEp = await userEndpoint(W.stopper);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false, finished = false;
    const serve = stopperEp.servePrincipal({ handlers: stubHandlers(async (ctx) => {
      entered = true;
      await gate;
      finished = true;
      return { runtime: { id: ctx.principal.runtimeId, startedAt: 1 }, seq: 0, open: [], closed: [] };
    }) });
    await serve.ready;
    const reply = settle(call(webEp, addressOf(W.stopper, processRuntime(W.stopper.uid).id), "prompts", "owner", {}, 6000));
    await until(() => entered);
    let stopped = false;
    const stopping = settle(stopperEp.stop().then(() => { stopped = true; }));
    await wait(500);
    const stoppedWhileRunning = stopped;
    release();
    await stopping;
    const r = await reply;
    check("cell 30: stop() waits for a principal-route handler in flight: it had not returned while the handler ran",
      entered && !stoppedWhileRunning && finished && stopped, { entered, stoppedWhileRunning, finished, stopped });
    check("cell 30: ...so its reply went out on the open connection, and the caller reads it", r.ok && r.value.ok, r.ok ? r.value : codeOf(r.error));
    const stopper2Ep = await userEndpoint(W.stopper2);
    const pending = stopper2Ep.servePrincipal({ handlers: stubHandlers() });
    const stop2 = stopper2Ep.stop();
    const readyOutcome = await Promise.race([settle(pending.ready), wait(3000).then(() => "still pending" as const)]);
    await stop2.catch(() => {});
    check("cell 30: stop() right after servePrincipal settles ready with a refusal that says the serve stopped, never a ready on a stopped endpoint",
      readyOutcome !== "still pending" && !readyOutcome.ok && String((readyOutcome.error as Error).message).includes("stopped serving"),
      readyOutcome === "still pending" ? readyOutcome : readyOutcome.ok ? "ready resolved" : (readyOutcome.error as Error).message);
  }

  // ── cell 35: a refused reply publish is reported ──
  // The agent's credential keeps its serve row and lacks the reply row. Its handler runs and the
  // broker refuses the reply. No call or serve awaits that refusal, so the endpoint reports it.
  {
    muted.add(W.mute.uid);
    const muteEp = await userEndpoint(W.mute);
    const serve = muteEp.servePrincipal({ handlers: stubHandlers() });
    await serve.ready;
    const r = await settle(call(webEp, addressOf(W.mute, processRuntime(W.mute.uid).id), "prompts", "owner", {}, 1500));
    await until(() => warnings.some((w) => w.startsWith("alice.mute error:")), 2000);
    const reported = warnings.filter((w) => w.startsWith("alice.mute error:"));
    check("cell 35: the broker refused the agent's reply, the caller saw its deadline, and the agent's endpoint reported the refusal as an error naming the reply subject",
      !r.ok && codeOf(r.error) === "deadline-exceeded/unknown" && reported.length === 1 && reported[0].includes(`${P}.ep.prin-reply.agent.${A}.mute.`),
      { call: r.ok ? r.value : codeOf(r.error), reported });
    await muteEp.stop();
  }

  // ── cell 36: a refused reply read whose flush never settles ──
  // The caller's credential keeps its request rows and lacks the reply read. The broker refuses the
  // read; the call waits one flush for a publish refusal that would say nothing ran. That flush
  // never settles here, the case of a connection that stopped answering: the refusal still wins.
  {
    deaf.add(W.deaf.uid);
    const deafEp = await userEndpoint(W.deaf);
    const nc = (deafEp as unknown as { nc: NatsConnection }).nc;
    const flush = nc.flush.bind(nc);
    nc.flush = () => new Promise<void>(() => {});
    const r = await settle(call(deafEp, coderAt, "prompts", "owner", {}, 1500));
    nc.flush = flush;
    check("cell 36: a refused reply read whose flush never settles is permission-denied, unknown at the deadline, never deadline-exceeded",
      !r.ok && codeOf(r.error) === "permission-denied/unknown", r.ok ? r.value : codeOf(r.error));
    await deafEp.stop();
  }

  // ── cells 31 and 32: seq never goes back under one runtime id, and one server per lifecycle ──
  {
    const cyclerSeq = () => webEp.getRoster().find((p) => p.card.id === `${A}.cycler`)?.prompts?.seq;
    const cyclerEp = await userEndpoint(W.cycler, { registerPresence: true });
    const first = cyclerEp.servePrincipal({ handlers: stubHandlers() });
    await first.ready;
    await cyclerEp.setPromptsPresence({ open: 2, seq: 50 });
    await until(() => cyclerSeq() === 50, 8000);
    await first.stop();
    await until(() => cyclerSeq() === undefined, 8000);
    const again = cyclerEp.servePrincipal({ handlers: stubHandlers() });
    await again.ready;
    await until(() => cyclerSeq() !== undefined, 8000);
    check("cell 31: serving agent again on the same endpoint takes a fresh seq, { open: 0, seq: 51 }: never seq 0, and never 50, which named a list with two prompts open",
      cyclerSeq() === 51 && webEp.getRoster().find((p) => p.card.id === `${A}.cycler`)?.prompts?.open === 0, webEp.getRoster().find((p) => p.card.id === `${A}.cycler`)?.prompts);
    let below = "";
    try { await cyclerEp.setPromptsPresence({ open: 0, seq: 50 }); } catch (e) { below = (e as Error).message; }
    check("cell 31: a seq below one this runtime already used is refused, the one the last serve showed too", below.includes("never goes back"), below);
    const twin = await userEndpoint(W.cycler);
    let twinRefusal = "";
    try { twin.servePrincipal({ handlers: stubHandlers() }); } catch (e) { twinRefusal = (e as Error).message; }
    check("cell 32: a second endpoint for the same lifecycle in this process may not serve agent while the first does: it would answer the same subject",
      twinRefusal.includes("already serves") && twinRefusal.includes(W.cycler.uid), twinRefusal);
    await twin.stop();
    await cyclerEp.stop();
    const nextEp = await userEndpoint(W.cycler, { registerPresence: true });
    const third = nextEp.servePrincipal({ handlers: stubHandlers() });
    await third.ready;
    await until(() => cyclerSeq() !== undefined, 8000);
    let next = -1;
    try { next = nextEp.nextPromptsSeq(); } catch { /* not there */ }
    check("cell 31: a new endpoint object for the same lifecycle, after the first stopped, serves again: same runtime id, a fresh seq 52, and the next seq 53",
      cyclerSeq() === 52 && webEp.getRoster().find((p) => p.card.id === `${A}.cycler`)?.runtime?.id === processRuntime(W.cycler.uid).id && next === 53,
      { seq: cyclerSeq(), next });
    await third.stop();
  }

  // ── cell 33: stop waits for a handler in flight only until its request's deadline ──
  {
    const ep3 = await userEndpoint(W.stopper3);
    const at = addressOf(W.stopper3, processRuntime(W.stopper3.uid).id);
    const replies: string[] = [];
    const watch = webRaw.nc.subscribe(`${P}.ep.prin-reply.agent.${A}.stopper3.*.*.${A}.web.${W.web.uid}.*`, { callback: (_e, m) => { replies.push(m.subject); } });
    await webRaw.nc.flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0, aborted = 0;
    const serve = ep3.servePrincipal({ handlers: stubHandlers(async (ctx) => {
      entered++;
      ctx.signal?.addEventListener("abort", () => { aborted++; });
      await gate; // ignores the signal
      return { runtime: { id: ctx.principal.runtimeId, startedAt: 1 }, seq: 0, open: [], closed: [] };
    }) });
    await serve.ready;
    const deadlineMs = 2500;
    const reply = settle(call(webEp, at, "prompts", "owner", {}, deadlineMs));
    const sentAt = performance.now();
    await until(() => entered === 1);
    const stopAt = performance.now();
    const stopped = await Promise.race([serve.stop().then(() => performance.now()), wait(deadlineMs + 3000).then(() => undefined)]);
    const r = await reply;
    check("cell 33: stop() on a handler that never settles returns once the request's deadline passed, not when the handler does",
      stopped !== undefined && stopped - sentAt <= deadlineMs + 1000 && stopped - stopAt >= 500,
      { stopAfterMs: stopped === undefined ? "still waiting" : Math.round(stopped - stopAt), sinceSentMs: stopped === undefined ? undefined : Math.round(stopped - sentAt) });
    check("cell 33: the handler's signal aborted when the serve stopped", aborted === 1, { aborted });
    const seenBefore = replies.length;
    release();
    await wait(500);
    check("cell 33: the handler's late reply is dropped, and the caller saw its deadline",
      replies.length === seenBefore && seenBefore === 0 && !r.ok && codeOf(r.error) === "deadline-exceeded/unknown", { replies: replies.length, call: r.ok ? r.value : codeOf(r.error) });
    // A handler that ends on the signal lets stop return at once, and its reply still goes out.
    const again = ep3.servePrincipal({ handlers: stubHandlers(async (ctx) => {
      entered++;
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
      return { runtime: { id: ctx.principal.runtimeId, startedAt: 1 }, seq: 0, open: [], closed: [] };
    }) });
    await again.ready;
    const second = settle(call(webEp, at, "prompts", "owner", {}, 8000));
    await until(() => entered === 2);
    const t0 = performance.now();
    await Promise.race([again.stop(), wait(10_000)]);
    const tookMs = performance.now() - t0;
    const r2 = await second;
    check("cell 33: a handler that ends on the signal lets stop() return at once, and its reply goes out",
      tookMs < 1000 && r2.ok && r2.value.ok, { tookMs: Math.round(tookMs), call: r2.ok ? r2.value : codeOf(r2.error) });
    watch.unsubscribe();
    await ep3.stop();
  }

  // ── mixed versions that need no 0.165 release ──
  console.log("\nmixed versions");
  {
    const helperAt = addressOf(W.helper, processRuntime(W.helper.uid).id);
    const older = await settle(call(webEp, helperAt, "prompts", "owner", {}));
    check("this caller, an agent that serves nothing on the route: unavailable, not-executed", !older.ok && codeOf(older.error) === "unavailable/not-executed", older);
    const oldCaller = await settle(call(oldWebEp, coderAt, "prompts", "owner", {}));
    check("a caller minted before the rows: permission-denied, not-executed", !oldCaller.ok && codeOf(oldCaller.error) === "permission-denied/not-executed", oldCaller);
    const laterContract = { input: AGENT_CONTRACTS.prompts.input, output: compileContract({ root: { type: "object", properties: { runtime: {}, seq: {}, open: {}, closed: {}, interrupted: {} } } }) };
    const pinned = await webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: coderAt, command: "prompts", authority: "owner", args: {}, deadlineMs: 4000, contract: laterContract });
    check("a revision-3 caller and a revision-2 agent: contract-mismatch, not-executed", !pinned.ok && pinned.error.code === "contract-mismatch" && pinned.error.outcome === "not-executed", pinned);
    const d = await call(webEp, coderAt, "describe", "owner");
    const doc = d.ok ? (d.data as DescribeAnswer).descriptor.clusters[0] : undefined;
    const parsed = doc?.document ? parseClusterDocument(doc.document) : undefined;
    check("then describe: the agent serves revision 2, and the document matches the caller's embedded artifacts",
      parsed?.revision === 2 && doc?.digest === agentClusterArtifacts().closureDigest
      && parsed.commands.every((c) => c.inputDigest === AGENT_CONTRACTS[c.name].input.closureDigest && c.outputDigest === AGENT_CONTRACTS[c.name].output.closureDigest), d);
    const current = await call(webEp, coderAt, "prompts", "owner", {});
    check("then revision 2 answers", current.ok, current);
  }

  // ── a reconnect that rebinds ──
  console.log("\nreconnects");
  {
    const oldRuntime = coderAt.runtimeId;
    const shown: (number | undefined)[] = [];
    const onPresence = (e: { presence: Presence }) => { if (e.presence.card.id === `${A}.coder`) shown.push(e.presence.prompts?.seq); };
    webEp.on("presence", onPresence);
    await coderEp.reconnect();
    let after: EndpointReply | undefined;
    for (let i = 0; i < 50 && after === undefined; i++) {
      const r = await settle(call(webEp, coderAt, "prompts", "owner", {}, 1500));
      if (r.ok && r.value.ok) after = r.value; else await wait(100);
    }
    check("a rebuilt connection subscribes again: the agent answers on the same runtime id", after?.ok === true && (after.data as { runtime: { id: string } }).runtime.id === oldRuntime, after);
    // The serve keeps a handle per connection only until that connection is replaced.
    const handles = () => (coderEp as unknown as { principalServes: Map<string, { handles: unknown[] }> }).principalServes.get(AGENT_ENDPOINT)?.handles.length;
    await coderEp.reconnect();
    for (let i = 0, done = false; i < 50 && !done; i++) {
      const r = await settle(call(webEp, coderAt, "prompts", "owner", {}, 1500));
      done = r.ok && r.value.ok;
      if (!done) await wait(100);
    }
    await until(() => handles() === 1, 3000);
    check("cell 38: after two rebuilt connections the serve holds one handle, the current connection's", handles() === 1, { handles: handles() });
    await until(() => webEp.getRoster().find((p) => p.card.id === `${A}.coder`)?.prompts !== undefined, 8000);
    webEp.off("presence", onPresence);
    check("on the new connection presence carried no prompts field until the broker accepted the new subscription, then the field again",
      shown.includes(undefined) && shown.lastIndexOf(coder.seq) > shown.indexOf(undefined) && webEp.getRoster().find((p) => p.card.id === `${A}.coder`)?.prompts?.seq === coder.seq, shown);
    // The library reconnects in place and re-subscribes on a connection the broker authorized again.
    const raw = (coderEp as unknown as { nc: NatsConnection }).nc;
    await raw.reconnect();
    let inPlace = false;
    for (let i = 0; i < 50 && !inPlace; i++) {
      const r = await settle(call(webEp, coderAt, "prompts", "owner", {}, 1500));
      inPlace = r.ok && r.value.ok;
      if (!inPlace) await wait(100);
    }
    check("an in-place reconnect re-runs the check and keeps serving", inPlace && (coderEp as unknown as { nc: NatsConnection }).nc === raw);
    // The next credential predates the rows: the check fails, the serve ends, the field goes.
    stripped.add(W.coder.uid);
    await raw.reconnect();
    const failedAfter = await Promise.race([coder.serve.failed, wait(8000).then(() => undefined)]);
    check("a reconnect whose credential lacks the rows ends the serve: failed resolves with the broker's refusal",
      failedAfter instanceof EpEnvelopeError && failedAfter.code === "permission-denied", failedAfter);
    await until(() => webEp.getRoster().find((p) => p.card.id === `${A}.coder`)?.prompts === undefined, 8000);
    check("...and its presence clears the prompts field", webEp.getRoster().find((p) => p.card.id === `${A}.coder`)?.prompts === undefined);
    const afterFail = await settle(call(webEp, coderAt, "prompts", "owner", {}, 2000));
    check("...and nothing serves the agent: unavailable, not-executed", !afterFail.ok && codeOf(afterFail.error) === "unavailable/not-executed", afterFail);
    check("a later refusal is reported on the warning channel, never as an error", warnings.some((w) => w.startsWith("alice.coder warning: stopped serving")) && !warnings.some((w) => w.startsWith("alice.coder error")),
      warnings.filter((w) => w.startsWith("alice.coder")));
  }
  const unexpected = warnings.filter((w) => w.includes(" error: ") && !w.startsWith("alice.mute error:"));
  check("no endpoint emitted an error but the reply refusal cell 35 provokes", unexpected.length === 0, unexpected);
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of raws) await nc.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  for (const b of brokers) await killAndAwaitExit(b);
  for (const r of releases) r();
  rmSync(dir, { recursive: true, force: true });
}
finish();
