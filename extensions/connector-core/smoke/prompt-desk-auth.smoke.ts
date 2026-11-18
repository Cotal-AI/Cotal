/**
 * The prompt desk on a real nats-server, through the shipped auth callout (SPEC 13.21, 13.22).
 *
 * A fake adapter opens prompts on the desk of a managed agent, `alice.coder`, and records every
 * `deliver` call, every `end` and every write it would make to its harness: the answer it hands over,
 * and the release that gives a dialog back. Alice's interactive sessions (`web`, `term`) and bob's
 * agent `builder`, which holds `grant` rows for `alice.coder`, answer through
 * `CotalEndpoint.callPrincipal`. Raw connections of the same principals send the requests whose
 * timing the suite controls and read the reply bytes off the wire.
 *
 * Covered: the refusals of `openPromptDesk`; the presence count and counter after each change; the
 * `prompt-answer` checks in their order, each request refused by the earliest check it fails; every
 * named case of the desk's work list; the interleavings, in both orders where two exist; the measured
 * replies on the wire; a serve that fails on a reconnect, and a reconnect that lands on a smaller
 * `max_payload`. Every prompt the fake opened must see `end` exactly once.
 *
 * Every row of the state table that the desk can be fed is driven here. The desk never feeds the
 * others, so no broker run reaches them: a delivery result for an open prompt or a second one for a
 * delivered prompt (a `deliver` call has one result), the settle time of an open prompt (it starts at
 * an accepted answer), and expiry, the settle time or the close for a closed prompt (closing stops
 * its timers, and the close skips it). `pnpm smoke:prompt-desk` checks those rows with all the others.
 *
 * Two events "in the same tick" are made by holding the event loop while the second arrives. A
 * request reaches the agent's socket during the hold, and libuv then runs the due timer or the socket
 * first by phase: a hold inside a timer callback lets the socket go first, and a hold in the check
 * phase lets the timer go first.
 *
 * Run: pnpm smoke:prompt-desk:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  AGENT_CONTRACTS, AGENT_ENDPOINT, AGENT_PROMPT_CONTENT_MAX_BYTES, AGENT_PROMPT_DIGEST_DETAIL, AGENT_PROMPT_STATE_DETAIL,
  CotalEndpoint, EpEnvelopeError, agentPromptDigest, createSpaceAuth, epPrincipalCallerReplyFilter, epPrincipalGrantRows,
  epPrincipalNoRespondersSubject, epPrincipalReplySubject, epPrincipalRequestSubject, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, processRuntime, provisionAgentDurables, reconcileSpaceMemoryBuckets, serverConfig, setupSpaceStreams,
  type AgentPrompt, type EndpointReply, type EpCaller, type EpPrincipal, type Presence, type PromptContent, type PromptState,
  type PromptsOutput,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver, type ValidatedUserToken } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  PROMPT_DESK_MIN_MAX_PAYLOAD, PROMPT_SUMMARY_MAX_BYTES, PromptRefused, openPromptDesk,
  stepPrompt, type Delivery, type PromptDesk, type PromptEvent, type PromptHold, type PromptHooks, type PromptSpec, type PromptVerdict,
} from "../src/prompt-desk.js";
import { contentOfBytes, contentWithLargestSummary, permission, question } from "./_prompt-fixtures.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n = 8) => randomBytes(n).toString("hex");
const nonce = () => randomBytes(24).toString("base64url");
async function until(done: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; !(await done()); await wait(20)) if (Date.now() > end) return false;
  return true;
}
async function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await p }; } catch (error) { return { ok: false, error }; }
}
/** Hold the event loop: nothing else in this process runs until `ms` have passed. */
const hold = (ms: number) => { for (const end = Date.now() + ms; Date.now() < end;) { /* held */ } };
/** A caller waits at least 15 s for a `prompt-answer` reply, longer than the desk's 10 s bound. */
const WAIT = 15_000;

// ---- broker and callout ---------------------------------------------------------------------
const PORT = await pickFreePort(), OPEN_PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`, OPEN_SERVERS = `nats://127.0.0.1:${OPEN_PORT}`;
const space = `desk-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const serverConf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] });
writeFileSync(join(dir, "server.conf"), serverConf);
writeFileSync(join(dir, "open.conf"), `port: ${OPEN_PORT}\nhost: 127.0.0.1\n`);
const brokers = new Map<string, ChildProcess>();
const releases: (() => void)[] = [];
function startBroker(conf: string): void {
  const child = spawn("nats-server", ["-c", join(dir, conf)], { stdio: "ignore" });
  releases.push(teardownOnSignal(child, dir));
  brokers.set(conf, child);
}
startBroker("server.conf");
startBroker("open.conf");

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const B = deriveOwnerToken("s".repeat(32), "better-auth|bob");

interface Who { name: string; owner: string; actor: string; kind: "interactive" | "managed-agent"; uid: string }
const who = (owner: string, actor: string, kind: Who["kind"]): Who =>
  ({ name: `${owner === A ? "alice" : "bob"}.${actor}`, owner, actor, kind, uid: mintLifecycleUid() });
const W = {
  coder: who(A, "coder", "managed-agent"),
  coder2: who(A, "coder2", "managed-agent"),
  legacy: who(A, "legacy", "managed-agent"),
  web: who(A, "web", "interactive"),
  term: who(A, "term", "interactive"),
  builder: who(B, "builder", "managed-agent"),
};
const ledger = new Map(Object.values(W).map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: [], kind: w.kind };
};
// The shipped mint, plus two test-only edits: `builder` holds grant rows for alice.coder, built by the
// shipped builder, and a stripped lifecycle gets the credential an auth service from before the rows mints.
type Perm = { pub?: { allow?: string[] }; sub?: { allow?: string[] }; [k: string]: unknown };
const shipped = calloutPermissions(resolveAcl, async () => {});
const stripped = new Set<string>([W.legacy.uid]);
const mintFor = async (t: ValidatedUserToken, connId: string, readerId: string): Promise<Record<string, unknown>> => {
  let p = (await shipped(t, connId, readerId)) as Perm;
  const uid = t.act.lifecycleUid!;
  if (stripped.has(uid))
    p = { ...p, pub: { ...p.pub, allow: (p.pub?.allow ?? []).filter((r) => !r.includes(".ep.prin")) }, sub: { ...p.sub, allow: (p.sub?.allow ?? []).filter((r) => !r.includes(".ep.prin")) } };
  if (uid === W.builder.uid) {
    const r = epPrincipalGrantRows(space, { owner: B, actor: "builder", uid }, { owner: A, actor: "coder", uid: W.coder.uid }, ["prompts", "prompt", "prompt-answer"]);
    p = { ...p, pub: { ...p.pub, allow: [...(p.pub?.allow ?? []), ...r.pub] }, sub: { ...p.sub, allow: [...new Set([...(p.sub?.allow ?? []), ...r.sub])] } };
  }
  return p;
};
async function bearer(w: Who): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: [], lifecycleUid: w.uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(privateKey as CryptoKey);
}

// ---- endpoints, raw seats, desks --------------------------------------------------------------
const endpoints: CotalEndpoint[] = [];
const events: string[] = [];
function own(ep: CotalEndpoint, label: string): CotalEndpoint {
  ep.on("error", (e: Error) => events.push(`${label} error: ${e.message}`));
  ep.on("warning", (e: Error) => events.push(`${label} warning: ${e.message}`));
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
const raws: NatsConnection[] = [];
interface Seat { w: Who; nc: NatsConnection }
async function seat(w: Who): Promise<Seat> {
  const n = `ibx${randomUUID().replace(/-/g, "")}`;
  const nc = await connect({ servers: SERVERS, name: n, inboxPrefix: `_INBOX_${n}`, maxReconnectAttempts: 0,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer(w))] });
  raws.push(nc);
  return { w, nc };
}
const warns: string[] = [];
const desks: PromptDesk[] = [];
async function deskOn(ep: CotalEndpoint, label: string): Promise<PromptDesk> {
  const desk = await openPromptDesk(ep, { warn: (m) => warns.push(`${label}: ${m}`) });
  desks.push(desk);
  return desk;
}
const addressOf = (w: Who): EpPrincipal => ({ owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id });
const callerOf = (w: Who): EpCaller => ({ owner: w.owner, actor: w.actor, uid: w.uid });
const coderAt = addressOf(W.coder);

// ---- the fake adapter -----------------------------------------------------------------------
/** One prompt of the fake adapter: what it handed over, what it wrote, and every `end`. `deliver`
 *  stays pending until the suite settles it with `delivered`. */
interface Fake {
  label: string; id: string; digest: string; hold: PromptHold;
  verdicts: PromptVerdict[]; writes: string[]; ends: boolean[]; checks: number;
  delivered(d: Delivery): void; failed(e: Error): void;
}
const fakes: Fake[] = [];
function openFake(desk: PromptDesk, label: string, o: {
  content?: PromptContent; openMs?: number; settleMs?: number;
  /** The spec as the adapter gives it, in place of one built from the three fields above. */
  spec?: unknown;
  check?: (v: PromptVerdict, f: Fake) => unknown;
  deliver?: (v: PromptVerdict) => Promise<Delivery>;
  /** Runs after the fake records the `end`; what it returns, `end` returns. */
  end?: () => unknown;
  /** Sees the hooks object the fake hands to the desk. */
  hooks?: (h: PromptHooks) => void;
} = {}): Fake {
  const content = (o.spec as { content?: PromptContent } | undefined)?.content ?? o.content ?? permission(`Allow Bash: ${label}?`);
  let settle: { resolve(d: Delivery): void; reject(e: Error): void } | undefined;
  const f = {
    label, verdicts: [], writes: [], ends: [], checks: 0,
    delivered: (d: Delivery) => settle?.resolve(d), failed: (e: Error) => settle?.reject(e),
  } as unknown as Fake;
  const hooks: PromptHooks = {
    check: (v) => { f.checks++; return o.check?.(v, f) as string | undefined; },
    deliver: (v) => {
      f.verdicts.push(v);
      f.writes.push(`answer:${v.option}`);
      if (o.deliver) return o.deliver(v);
      return new Promise<Delivery>((resolve, reject) => { settle = { resolve, reject }; });
    },
    end: ({ attempted }) => {
      f.ends.push(attempted);
      if (!attempted) f.writes.push("release");
      return o.end?.() as undefined;
    },
  };
  o.hooks?.(hooks);
  f.hold = desk.open((o.spec ?? { content, openMs: o.openMs ?? 600_000, settleMs: o.settleMs ?? 600_000 }) as PromptSpec, hooks);
  f.id = f.hold.id;
  f.digest = agentPromptDigest(content);
  fakes.push(f);
  return f;
}

// ---- callers --------------------------------------------------------------------------------
let webEp!: CotalEndpoint, builderEp!: CotalEndpoint, coderEp!: CotalEndpoint;
let webRaw!: Seat, builderRaw!: Seat;
const call = (ep: CotalEndpoint, command: string, args: Record<string, unknown>, o: { to?: EpPrincipal; authority?: "owner" | "grant"; deadlineMs?: number } = {}) =>
  ep.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: o.to ?? coderAt, command, authority: o.authority ?? "owner", args, deadlineMs: o.deadlineMs ?? WAIT });
const answer = (f: Fake, option: string, extra: Record<string, unknown> = {}, o: { ep?: CotalEndpoint; to?: EpPrincipal; authority?: "owner" | "grant" } = {}) =>
  call(o.ep ?? webEp, "prompt-answer", { id: f.id, digest: f.digest, option, ...extra }, o);
/** Send an answer and wait until the fake's `deliver` holds it. `reply` still waits. */
async function accept(f: Fake, option = "allow", extra: Record<string, unknown> = {}): Promise<{ reply: Promise<EndpointReply> }> {
  const n = f.verdicts.length;
  const reply = answer(f, option, extra);
  if (!(await until(() => f.verdicts.length > n || f.ends.length > 0))) throw new Error(`${f.label}: deliver was not called`);
  return { reply };
}
const stateIn = (r: EndpointReply): PromptState | undefined => (r.ok ? (r.data as { state: PromptState }).state : undefined);
const verdictOf = (r: EndpointReply): string => (r.ok ? `ok ${show(stateIn(r))}` : `${r.error.code}/${r.error.outcome ?? "-"}`);
const refusedAs = (r: EndpointReply, code: string) => !r.ok && r.error.code === code && r.error.outcome === "not-executed";
const detailState = (r: EndpointReply): PromptState | undefined =>
  r.ok ? undefined : (r.error.details?.find((d) => d.kind === AGENT_PROMPT_STATE_DETAIL) as { state?: PromptState } | undefined)?.state;
async function list(to = coderAt, ep = webEp): Promise<PromptsOutput> {
  const r = await call(ep, "prompts", {}, { to });
  if (!r.ok) throw new Error(`prompts was refused: ${r.error.code} ${r.error.message}`);
  return r.data as PromptsOutput;
}
async function stateOf(f: Fake, to = coderAt): Promise<PromptState | undefined> {
  const l = await list(to);
  return [...l.open, ...l.closed].find((s) => s.id === f.id)?.state;
}
function show(s: PromptState | undefined): string {
  if (s === undefined) return "none";
  if (s.kind === "open") return "open";
  if (s.kind === "sent") return `sent/${s.delivery}`;
  const o = s.outcome as { kind: string; seen?: { tie: string; effect?: string }; late?: unknown };
  return `closed/${o.kind}${o.seen ? `/${o.seen.tie}${o.seen.effect ? `:${o.seen.effect}` : ""}` : ""}${o.late ? "+late" : ""}`;
}
/** The state the desk's own table moves `from` to on `event`, or `from` when it does not move it. */
const tableStep = (from: PromptState, event: PromptEvent): PromptState => {
  const step = stepPrompt(from, event, new Date().toISOString());
  return step.kind === "move" ? step.next : from;
};
/** Every event the desk can feed its table. */
const EVERY_EVENT: PromptEvent[] = [
  { kind: "delivery", result: "confirmed" }, { kind: "delivery", result: "delivered" }, { kind: "delivery", result: "gone" }, { kind: "delivery", result: "failed" },
  { kind: "settle", evidence: { kind: "confirmed" } }, { kind: "settle", evidence: { kind: "withdrawn" } },
  { kind: "settle", evidence: { kind: "local", seen: { tie: "none" } } }, { kind: "settle", evidence: { kind: "observed", seen: { tie: "prompt", effect: "proceed" } } },
  { kind: "expiry" }, { kind: "settle-time" }, { kind: "close" },
];
/** Two replies about one prompt that cross: the later one is the state the desk's table moves the
 *  earlier one to on `event`, and no event moves the later one, so a reader that holds both, in either
 *  order, holds the state the prompt ended in. */
const crossing = (earlier: PromptState, later: PromptState, event: PromptEvent): boolean =>
  show(tableStep(earlier, event)) === show(later) && EVERY_EVENT.every((e) => tableStep(later, e) === later);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A request from a raw connection, with the nonce and envelope `callPrincipal` would use. With
 *  `listen`, resolves the reply and its size in bytes on the wire; without, nobody reads the reply. */
function rawSend(s: Seat, command: string, args: Record<string, unknown>, listen = true, to = coderAt): Promise<{ bytes: number; reply: EndpointReply } | undefined> {
  const n = nonce();
  const caller = callerOf(s.w);
  const authority = s.w === W.builder ? "grant" : "owner";
  const replyTo = epPrincipalReplySubject(space, { endpoint: AGENT_ENDPOINT, principal: to, caller, nonce: n });
  const got = new Promise<{ bytes: number; reply: EndpointReply } | undefined>((resolve) => {
    if (!listen) return resolve(undefined);
    const timer = setTimeout(() => { sub.unsubscribe(); resolve(undefined); }, WAIT);
    const sub = s.nc.subscribe(epPrincipalCallerReplyFilter(space, caller, n), { callback: (_e, m) => {
      if (m.subject !== replyTo) return;
      clearTimeout(timer);
      sub.unsubscribe();
      resolve({ bytes: m.data.length, reply: JSON.parse(dec(m.data)) as EndpointReply });
    } });
  });
  const contract = AGENT_CONTRACTS[command];
  const env = { v: 1, id: hex(), op: { endpoint: AGENT_ENDPOINT, command, inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest },
    class: "ephemeral", replyExpected: true, deadlineMs: WAIT, args, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor } };
  s.nc.publish(epPrincipalRequestSubject(space, { endpoint: AGENT_ENDPOINT, principal: to, command, authority, caller, nonce: n }), enc(JSON.stringify(env)),
    { reply: epPrincipalNoRespondersSubject(space, caller, n) });
  return got;
}
/** Run `send` and then hold the loop for `ms`, so what it sent reaches the agent's socket during the
 *  hold. In a timer callback (`timer`) the agent's socket is read before the next due timer runs; in
 *  the check phase (`check`) the due timer runs first. `after` runs at the end of the hold. */
function inOneTick(at: number, phase: "timer" | "check", send: () => void, ms: number, after?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const go = () => { send(); queueMicrotask(() => { hold(ms); after?.(); resolve(); }); };
    setTimeout(() => (phase === "timer" ? go() : setImmediate(go)), Math.max(0, at - Date.now()));
  });
}
async function expiresAtOf(f: Fake): Promise<number> {
  const s = (await list()).open.find((x) => x.id === f.id);
  if (!s) throw new Error(`${f.label} is not open`);
  return Date.parse(s.expiresAt);
}
/** Each scenario that runs beside others collects its results and reports them in order. */
type Results = [string, boolean, unknown?][];
async function scenario(fn: (ok: (name: string, cond: boolean, extra?: unknown) => void) => Promise<void>): Promise<Results> {
  const out: Results = [];
  try {
    await fn((name, cond, extra) => out.push([name, cond, extra]));
  } catch (e) {
    out.push([`the scenario threw: ${(e as Error).message}`, false, e]);
  }
  return out;
}
const report = (all: Results[]) => { for (const out of all) for (const [name, cond, extra] of out) check(name, cond, extra); };
const roster = (w: Who): Presence | undefined => webEp.getRoster().find((p) => p.card.id === `${w.owner}.${w.actor}`);
const presenceIs = (open: number, seq: number, w = W.coder) =>
  until(() => { const p = roster(w); return p?.prompts?.open === open && p.prompts.seq === seq; }, 8000);

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
  for (const w of [W.coder, W.coder2, W.legacy])
    await provisionAgentDurables(provisioner, { owner: w.owner, actor: w.actor, lifecycleUid: w.uid }, { durableMembership: false });
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
  coderEp = await userEndpoint(W.coder, { registerPresence: true });
  webEp = await userEndpoint(W.web, { watchPresence: true });
  builderEp = await userEndpoint(W.builder);
  const termEp = await userEndpoint(W.term);
  webRaw = await seat(W.web);
  builderRaw = await seat(W.builder);

  // ── openPromptDesk refuses where it cannot serve ──
  console.log("\nopenPromptDesk refuses where no answer can arrive");
  {
    const legacyEp = await userEndpoint(W.legacy, { registerPresence: true });
    const r = await settled(openPromptDesk(legacyEp, { warn: () => {} }));
    check("a credential minted before the rows: rejects with the broker's refusal of the subscription",
      !r.ok && r.error instanceof EpEnvelopeError && r.error.code === "permission-denied", r);
    await until(() => roster(W.legacy) !== undefined, 8000);
    check("...and its presence carries no prompts field", roster(W.legacy) !== undefined && roster(W.legacy)!.prompts === undefined, roster(W.legacy));
    const staticUid = mintLifecycleUid(), openUid = mintLifecycleUid();
    const staticEp = own(new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "agent", { principal: { owner: "local", actor: "stat" }, lifecycleUid: staticUid }),
      lifecycleUid: staticUid, card: { owner: "local", actor: "stat", name: "stat", kind: "agent" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false }), "static");
    await staticEp.start();
    const openEp = own(new CotalEndpoint({ space, servers: OPEN_SERVERS, lifecycleUid: openUid, card: { actor: "open", name: "open", kind: "agent" }, consume: false, registerPresence: false, watchPresence: false, watchChannels: false }), "open");
    await openEp.start();
    const s = await settled(openPromptDesk(staticEp, { warn: () => {} }));
    const o = await settled(openPromptDesk(openEp, { warn: () => {} }));
    check("a static credential: rejects", !s.ok && String((s.error as Error).message).includes("static credential"), s);
    check("an open mesh: rejects", !o.ok && String((o.error as Error).message).includes("open mesh"), o);
  }

  // ── desk 1: presence, the answer checks, check, retries ──
  console.log("\ndesk 1: the presence count and counter after each change");
  const desk1 = await deskOn(coderEp, "desk1");
  {
    check("openPromptDesk resolves once the broker accepted the subscription, and presence shows { open: 0, seq: 1 }: the serve took seq 0 and the desk the next", await presenceIs(0, 1));
    const l0 = await list();
    check("prompts: no prompt, seq 1, and the runtime is the agent's presence runtime",
      l0.open.length === 0 && l0.closed.length === 0 && l0.seq === 1 && l0.runtime.id === coderAt.runtimeId
      && l0.runtime.startedAt === processRuntime(W.coder.uid).startedAt && roster(W.coder)?.runtime?.id === coderAt.runtimeId, l0);
    const P1 = openFake(desk1, "presence one");
    check("a prompt opens: { open: 1, seq: 2 }", await presenceIs(1, 2) && (await list()).seq === 2);
    const P2 = openFake(desk1, "presence two");
    check("a second opens: { open: 2, seq: 3 }", await presenceIs(2, 3));
    const full = await call(webEp, "prompt", { id: P2.id });
    const got = full.ok ? (full.data as { prompt: AgentPrompt }).prompt : undefined;
    check("prompt returns the full prompt, and the reader's recomputed digest equals the one it carries",
      got !== undefined && agentPromptDigest(got.content) === got.digest && got.digest === P2.digest && got.state.kind === "open", full);
    const r1 = (await accept(P1)).reply;
    check("an answer is accepted: { open: 2, seq: 4 }", await presenceIs(2, 4));
    P1.delivered({ kind: "delivered" });
    const a1 = await r1;
    check("its receipt: the reply says sent, delivered, and presence { open: 2, seq: 5 }", show(stateIn(a1)) === "sent/delivered" && await presenceIs(2, 5), verdictOf(a1));
    P1.hold.settle({ kind: "confirmed" });
    check("the harness confirms it: closed, answered, and { open: 1, seq: 6 }", await presenceIs(1, 6) && show(await stateOf(P1)) === "closed/answered");
    P2.hold.settle({ kind: "withdrawn" });
    check("the other is withdrawn: { open: 0, seq: 7 }", await presenceIs(0, 7) && show(await stateOf(P2)) === "closed/withdrawn/none");
    check("each ended once: the answered one attempted, the withdrawn one released to the harness",
      same(P1.ends, [true]) && same(P1.writes, ["answer:allow"]) && same(P2.ends, [false]) && same(P2.writes, ["release"]), { P1: P1.writes, P2: P2.writes });
  }

  console.log("\ndesk 1: the prompt-answer checks, in order; each refusal is not-executed and leaves the prompt as it was");
  {
    // 1. On an interactive actor's own desk: the self-answer is refused first, also for an id it does not know.
    const termDesk = await deskOn(termEp, "term");
    const termAt = addressOf(W.term);
    const T1 = openFake(termDesk, "term's own");
    const self1 = await answer(T1, "allow", {}, { ep: termEp, to: termAt });
    const self2 = await call(termEp, "prompt-answer", { id: "z".repeat(26), digest: `sha256:${"0".repeat(64)}`, option: "nope" }, { to: termAt });
    check("check 1: an agent answering its own prompt is permission-denied, also with an unknown id, a wrong digest and an unknown option",
      refusedAs(self1, "permission-denied") && refusedAs(self2, "permission-denied"), [verdictOf(self1), verdictOf(self2)]);
    const readOwn = await call(termEp, "prompts", {}, { to: termAt });
    check("check 1: the same actor may read its own prompts, and the prompt is still open with nothing handed over",
      readOwn.ok && (readOwn.data as PromptsOutput).open[0]?.state.kind === "open" && T1.verdicts.length === 0 && T1.checks === 0, readOwn);
    const termSeq = (readOwn.data as PromptsOutput).seq;
    await termDesk.close();
    check("closing the interactive actor's desk withdraws its prompt and releases it", same(T1.ends, [false]));
    // seq goes on across endpoint objects of one lifecycle in this process.
    const termNext = await userEndpoint(W.term);
    const next = await settled(deskOn(termNext, "term, a new endpoint"));
    const firstSeq = next.ok ? (await list(termAt)).seq : -1;
    check("a desk on a new endpoint object for the same lifecycle goes on counting: its first seq is above every seq the last desk used",
      next.ok && firstSeq > termSeq + 1, { termSeq, firstSeq, opened: next.ok ? "yes" : (next.error as Error).message });
    if (next.ok) await next.value.close();

    // 2.
    const r2 = await call(webEp, "prompt-answer", { id: "z".repeat(26), digest: `sha256:${"0".repeat(64)}`, option: "nope" });
    check("check 2: an id this runtime does not know is not-found, before the digest or the option", refusedAs(r2, "not-found"), verdictOf(r2));

    // 3 and 4: on a sent prompt whose expiresAt has passed.
    const C3 = openFake(desk1, "checks 3 and 4", { openMs: 1000 });
    const orig = (await accept(C3)).reply;
    await wait(1200);
    const t0 = Date.now();
    const retry = await answer(C3, "allow");
    check("check 3: the same answer again, after expiresAt, is ok with the current state at once: sent, unconfirmed",
      show(stateIn(retry)) === "sent/unconfirmed" && Date.now() - t0 < 2000 && C3.verdicts.length === 1, verdictOf(retry));
    const r4 = await answer(C3, "nope", { digest: `sha256:${"1".repeat(64)}` });
    check("check 4: a different answer to a prompt that is not open is conflict with its state, before the digest and the option",
      refusedAs(r4, "conflict") && show(detailState(r4)) === "sent/unconfirmed", verdictOf(r4));
    C3.delivered({ kind: "confirmed" });
    check("the first answer's reply reads the state its result left: closed, answered", show(stateIn(await orig)) === "closed/answered");
    const again = await answer(C3, "allow");
    check("check 3 again on the closed prompt: ok with the same closed state, and nothing was handed over twice",
      show(stateIn(again)) === "closed/answered" && C3.verdicts.length === 1 && same(C3.ends, [true]), verdictOf(again));

    // 5.
    const C5 = openFake(desk1, "check 5");
    const r5 = await answer(C5, "nope", { digest: `sha256:${"2".repeat(64)}` });
    const shown = r5.ok ? undefined : (r5.error.details?.find((d) => d.kind === AGENT_PROMPT_DIGEST_DETAIL) as { digest?: string } | undefined)?.digest;
    check("check 5: a digest that differs is failed-precondition with the prompt's digest, before the option",
      refusedAs(r5, "failed-precondition") && shown === C5.digest, verdictOf(r5));

    // 6 to 9, on a question whose check refuses every answer it sees.
    const Q = openFake(desk1, "checks 6 to 9", { content: question(), check: () => "the adapter refuses this answer" });
    const r6 = await answer(Q, "nope", { note: "x", values: { suite: "nightly" } });
    check("check 6: an option that is not the prompt's is bad-request, before the note, the values and the adapter",
      refusedAs(r6, "bad-request") && !r6.ok && r6.error.message.includes("not one of the prompt's") && Q.checks === 0, verdictOf(r6));
    const r7 = await Promise.all([
      answer(Q, "why", { values: { suite: "nightly" } }),
      answer(Q, "why", { note: "" }),
      answer(Q, "dismiss", { note: "no" }),
      answer(Q, "submit"),
      answer(Q, "dismiss", { values: { suite: "unit" } }),
    ]);
    const why = r7.map((r) => (r.ok ? "ok" : r.error.message));
    check("check 7: a missing or empty required note, a note the option takes not, missing values and values it takes not: bad-request, before the values and the adapter",
      r7.every((r) => refusedAs(r, "bad-request")) && why[0].includes("needs a note") && why[1].includes("needs a note") && why[2].includes("takes no note")
      && why[3].includes("needs values") && why[4].includes("takes no values") && Q.checks === 0, why);
    const r8 = await Promise.all([answer(Q, "submit", { values: { suite: "nightly" } }), answer(Q, "submit", { values: { suite: "unit", extra: 1 } }), answer(Q, "submit", { values: { retries: 1 } })]);
    check("check 8: values that fail the form (a value outside the choice, a property it does not declare, a required one missing) are bad-request, before the adapter",
      r8.every((r) => refusedAs(r, "bad-request") && !r.ok && r.error.message.includes("do not match the form")) && Q.checks === 0, r8.map(verdictOf));
    const r9 = await answer(Q, "submit", { values: { suite: "unit", retries: 2 } });
    check("check 9: the adapter's check refuses: bad-request with its message",
      refusedAs(r9, "bad-request") && !r9.ok && r9.error.message === "the adapter refuses this answer" && Q.checks === 1, verdictOf(r9));
    check("after checks 5 to 9 both prompts are still open, and nothing was handed over",
      show(await stateOf(C5)) === "open" && show(await stateOf(Q)) === "open" && C5.verdicts.length === 0 && Q.verdicts.length === 0);
    console.log("    check 10 (expiresAt has passed) and its place after check 9 run with the same-tick interleavings below");
    // 11.
    const Q2 = openFake(desk1, "check 11", { content: question() });
    const r11p = (await accept(Q2, "submit", { values: { suite: "e2e" } })).reply;
    check("check 11: a valid answer is accepted, and deliver gets the verdict with its values and the answerer from the subject",
      Q2.verdicts[0]?.option === "submit" && same(Q2.verdicts[0]?.values, { suite: "e2e" })
      && same(Q2.verdicts[0]?.by, { id: `${A}.web`, uid: W.web.uid, authority: "owner" }), Q2.verdicts);
    Q2.delivered({ kind: "confirmed" });
    check("...its reply is ok, executed: closed, answered", show(stateIn(await r11p)) === "closed/answered");
    for (const f of [C5, Q]) f.hold.settle({ kind: "withdrawn" });

    // A grantee answers with the grant word.
    const G = openFake(desk1, "a grantee answers");
    const g = answer(G, "deny", { note: "use the staging suite" }, { ep: builderEp, authority: "grant" });
    await until(() => G.verdicts.length === 1);
    G.delivered({ kind: "confirmed" });
    const gs = stateIn(await g);
    check("a grantee's answer is accepted, and the answerer is bob.builder under the grant word",
      gs?.kind === "closed" && gs.outcome.kind === "answered" && same(gs.outcome.answer.by, { id: `${B}.builder`, uid: W.builder.uid, authority: "grant" })
      && G.verdicts[0]?.note === "use the staging suite", gs);
  }

  console.log("\ndesk 1: check, retries");
  {
    const CR = openFake(desk1, "check refuses", { check: (v) => (v.option === "allow" ? "allow is not offered for this command" : undefined) });
    const refusedAllow = await answer(CR, "allow");
    check("check refuses an answer: bad-request with the adapter's message, and the prompt stays open",
      refusedAs(refusedAllow, "bad-request") && !refusedAllow.ok && refusedAllow.error.message === "allow is not offered for this command" && show(await stateOf(CR)) === "open", verdictOf(refusedAllow));
    const corrected = (await accept(CR, "deny", { note: "not this one" })).reply;
    CR.delivered({ kind: "confirmed" });
    check("...and a corrected answer is accepted", show(stateIn(await corrected)) === "closed/answered" && CR.verdicts.length === 1);

    const CT = openFake(desk1, "check throws", { check: () => { throw new Error("check exploded"); } });
    const thrown = await answer(CT, "allow");
    check("check throws: internal, not-executed, the prompt stays open, and the desk warns",
      refusedAs(thrown, "internal") && show(await stateOf(CT)) === "open" && CT.verdicts.length === 0 && warns.some((w) => w.includes("check threw: check exploded")), verdictOf(thrown));
    CT.hold.settle({ kind: "withdrawn" });
    const CN = openFake(desk1, "check returns a number", { check: () => 7 as unknown as string });
    const odd = await answer(CN, "allow");
    check("check that returns something other than a message or undefined is a bug too: internal, and the prompt stays open",
      refusedAs(odd, "internal") && show(await stateOf(CN)) === "open" && warns.some((w) => w.includes(CN.id) && w.includes("returned number")), verdictOf(odd));
    let typeError = "";
    try { CN.hold.settle({ kind: "local" } as never); } catch (e) { typeError = e instanceof TypeError ? e.message : `not a TypeError: ${String(e)}`; }
    check("settle refuses a report that is not an Evidence with a TypeError, and the prompt stays open",
      typeError.includes("is not an Evidence") && show(await stateOf(CN)) === "open", typeError);
    CN.hold.settle({ kind: "withdrawn" });

    // A lost reply: the answer goes out on a raw connection that reads no reply.
    const RL = openFake(desk1, "lost reply");
    await rawSend(webRaw, "prompt-answer", { id: RL.id, digest: RL.digest, option: "allow" }, false);
    await until(() => RL.verdicts.length === 1);
    const t0 = Date.now();
    const afterLoss = await answer(RL, "allow");
    check("a retry after a lost reply returns the state at once and hands nothing over twice",
      show(stateIn(afterLoss)) === "sent/unconfirmed" && Date.now() - t0 < 2000 && RL.verdicts.length === 1, verdictOf(afterLoss));
    RL.delivered({ kind: "confirmed" });
    await until(async () => show(await stateOf(RL)) === "closed/answered");
    const afterClose = await answer(RL, "allow");
    check("...and once it closed, the same answer gets the closed state, still with one hand-over",
      show(stateIn(afterClose)) === "closed/answered" && RL.verdicts.length === 1, verdictOf(afterClose));

    const RP = openFake(desk1, "pending retry");
    let origDone = false;
    const orig = (await accept(RP)).reply;
    void orig.then(() => { origDone = true; });
    const t1 = Date.now();
    const quick = await answer(RP, "allow");
    check("a retry while the first delivery is still pending returns sent at once, while the first reply still waits",
      show(stateIn(quick)) === "sent/unconfirmed" && Date.now() - t1 < 2000 && !origDone, { took: Date.now() - t1, origDone });
    const otherDigest = await answer(RP, "allow", { digest: `sha256:${"3".repeat(64)}` });
    check("a retry with a different digest is refused: conflict, because it is not the same answer and the prompt is not open",
      refusedAs(otherDigest, "conflict") && show(detailState(otherDigest)) === "sent/unconfirmed", verdictOf(otherDigest));
    RP.delivered({ kind: "delivered" });
    check("...and the first reply reads the receipt: sent, delivered", show(stateIn(await orig)) === "sent/delivered");
    RP.hold.settle({ kind: "confirmed" });
  }

  // ── timing: these run side by side, each on its own prompt ──
  console.log("\ndesk 1: deliver, the settle time, the 10 s bound and expiry (side by side, about 11 s)");
  report(await Promise.all([
    scenario(async (ok) => {
      const f = openFake(desk1, "deliver never resolves");
      const t0 = Date.now();
      const orig = (await accept(f)).reply;
      const r = await orig;
      ok("deliver that never resolves: the reply comes at the 10 s bound with sent, unconfirmed",
        show(stateIn(r)) === "sent/unconfirmed" && Date.now() - t0 >= 9500 && Date.now() - t0 < 13000, { took: Date.now() - t0, got: verdictOf(r) });
      f.delivered({ kind: "confirmed" });
      ok("...and its late result is applied: closed, answered, end attempted once",
        await until(async () => show(await stateOf(f)) === "closed/answered") && same(f.ends, [true]), f.ends);
    }),
    scenario(async (ok) => {
      const together = openFake(desk1, "10 s bound and T due together", { settleMs: 10_000 });
      const boundFirst = openFake(desk1, "10 s bound due 1 ms before T", { settleMs: 10_001 });
      const [a, b] = await Promise.all([accept(together), accept(boundFirst)]);
      // Hold the loop across both due times: the timers phase then runs every due timer of the two
      // prompts in one tick, in the order they are due, and armed order among those due together.
      await inOneTick(Date.now() + 9_800, "check", () => {}, 600);
      const [ra, rb] = [await a.reply, await b.reply];
      const after = await answer(boundFirst, "allow");
      ok("the 10 s bound and T in one tick: due together, T was armed first and the reply reads closed, unconfirmed, nothing seen; due 1 ms before T, the bound answers sent, unconfirmed, and T then closes it",
        show(stateIn(ra)) === "closed/unconfirmed/none" && show(stateIn(rb)) === "sent/unconfirmed" && show(stateIn(after)) === "closed/unconfirmed/none"
        && same(together.ends, [true]) && same(boundFirst.ends, [true]), [verdictOf(ra), verdictOf(rb), verdictOf(after)]);
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "10 s bound racing T, bound first", { settleMs: 10_500 });
      const orig = await ((await accept(f)).reply);
      const retry = await answer(f, "allow");
      ok("the 10 s bound 500 ms before T: the reply reads sent, unconfirmed, and an identical retry right after reads the same",
        show(stateIn(orig)) === "sent/unconfirmed" && show(stateIn(retry)) === "sent/unconfirmed", [verdictOf(orig), verdictOf(retry)]);
      await until(async () => (await stateOf(f))?.kind === "closed", 3000);
      const late = await answer(f, "allow");
      ok("...then T closes it, and a retry reads closed, unconfirmed, nothing seen", show(stateIn(late)) === "closed/unconfirmed/none", verdictOf(late));
      ok("crossing replies, the 10 s bound then T: the desk's table moves the first reply's state to the later one on T and moves the later one on no event, so either order ends closed",
        crossing(stateIn(orig)!, stateIn(late)!, { kind: "settle-time" }), [verdictOf(orig), verdictOf(late)]);
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "gone after the 10 s reply");
      const r = await ((await accept(f)).reply);
      f.delivered({ kind: "gone" });
      await until(async () => show(await stateOf(f)) === "closed/undelivered");
      const retry = await answer(f, "allow");
      ok("gone after the 10 s reply: the reply was sent, unconfirmed, and a retry after gone is ok, executed: closed, undelivered",
        show(stateIn(r)) === "sent/unconfirmed" && show(stateIn(retry)) === "closed/undelivered" && same(f.ends, [true]), [verdictOf(r), verdictOf(retry)]);
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "gone before the 10 s reply", { deliver: async () => { await wait(100); return { kind: "gone" }; } });
      const t0 = Date.now();
      const r = await answer(f, "allow");
      const again = await answer(f, "allow");
      const other = await answer(f, "deny");
      ok("gone before the 10 s reply: ok, executed, closed, undelivered, at once", show(stateIn(r)) === "closed/undelivered" && Date.now() - t0 < 3000, verdictOf(r));
      ok("...the same answer again gets the same reply, and a different answer gets conflict",
        r.ok && again.ok && same(r.data, again.data) && refusedAs(other, "conflict") && show(detailState(other)) === "closed/undelivered", [verdictOf(again), verdictOf(other)]);
      ok("...and the adapter wrote its answer once and released nothing", same(f.writes, ["answer:allow"]) && same(f.ends, [true]));
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "settle time, nothing seen", { settleMs: 1000 });
      const t0 = Date.now();
      const r = await ((await accept(f)).reply);
      ok("the settle time: a sent prompt with no evidence closes unconfirmed, nothing seen, at settleMs, and the waiting reply reads it",
        show(stateIn(r)) === "closed/unconfirmed/none" && Date.now() - t0 >= 900 && Date.now() - t0 < 4000 && same(f.ends, [true]), { took: Date.now() - t0, got: verdictOf(r) });
      const before = warns.length;
      f.hold.settle({ kind: "observed", seen: { tie: "subject", effect: "proceed" } });
      ok("evidence that arrives after changes nothing: the report for the closed prompt is warned and ignored",
        show(await stateOf(f)) === "closed/unconfirmed/none" && warns.slice(before).some((w) => w.includes(f.id) && w.includes("is ignored (1 so far)")), warns.slice(before));
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "settle time, evidence first", { settleMs: 1000 });
      const beside = openFake(desk1, "settle time, no evidence, beside it", { settleMs: 1000 });
      const [orig, besideOrig] = await Promise.all([accept(f), accept(beside)]);
      f.hold.settle({ kind: "observed", seen: { tie: "subject", effect: "proceed" } });
      const r = await orig.reply;
      const rb = await besideOrig.reply;
      await wait(1300);
      ok("evidence that arrives first wins: closed, unconfirmed with the sighting; the settle time, which closed the prompt answered beside it with nothing seen, changes nothing after",
        show(stateIn(r)) === "closed/unconfirmed/subject:proceed" && show(await stateOf(f)) === "closed/unconfirmed/subject:proceed" && same(f.ends, [true])
        && show(stateIn(rb)) === "closed/unconfirmed/none" && same(beside.ends, [true]), [verdictOf(r), verdictOf(rb)]);
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "A, T, D", { settleMs: 1000 });
      const orig = (await accept(f)).reply;
      const r1 = await answer(f, "allow");
      const o = await orig;
      const r2 = await answer(f, "allow");
      f.delivered({ kind: "delivered" });
      await wait(100);
      const r3 = await answer(f, "allow");
      ok("A then T then D, with a retry between each: sent, unconfirmed; the reply reads closed, unconfirmed after T; the late receipt changes nothing",
        show(stateIn(r1)) === "sent/unconfirmed" && show(stateIn(o)) === "closed/unconfirmed/none" && show(stateIn(r2)) === "closed/unconfirmed/none"
        && same(stateIn(r3), stateIn(r2)) && same(f.ends, [true]), [r1, o, r2, r3].map(verdictOf));
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "A, D, T", { settleMs: 1500 });
      const orig = (await accept(f)).reply;
      const r1 = await answer(f, "allow");
      f.delivered({ kind: "delivered" });
      const o = await orig;
      const r2 = await answer(f, "allow");
      await until(async () => (await stateOf(f))?.kind === "closed", 3000);
      const r3 = await answer(f, "allow");
      ok("A then D then T, with a retry between each: sent, unconfirmed; the reply reads sent, delivered; then closed, unconfirmed after T",
        show(stateIn(r1)) === "sent/unconfirmed" && show(stateIn(o)) === "sent/delivered" && show(stateIn(r2)) === "sent/delivered"
        && show(stateIn(r3)) === "closed/unconfirmed/none" && same(f.ends, [true]), [r1, o, r2, r3].map(verdictOf));
      ok("crossing replies, D then T: the desk's table moves the receipt's state to the later one on T and moves the later one on no event, so either order ends closed",
        crossing(stateIn(o)!, stateIn(r3)!, { kind: "settle-time" }), [verdictOf(o), verdictOf(r3)]);
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "deliver resolves something else", { settleMs: 1000, deliver: async () => ({ kind: "applied" }) as unknown as Delivery });
      const r = await answer(f, "allow");
      ok("deliver that resolves with something that is not a Delivery is a failed call: sent, unconfirmed, and the desk warns",
        show(stateIn(r)) === "sent/unconfirmed" && warns.some((w) => w.includes(f.id) && w.includes("which is not a Delivery")), verdictOf(r));
      await until(async () => (await stateOf(f))?.kind === "closed", 3000);
      ok("...and the settle time closes it, end attempted", same(f.ends, [true]));
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "expiry", { openMs: 1000 });
      const t0 = Date.now();
      await until(async () => (await stateOf(f))?.kind === "closed", 4000);
      ok("an open prompt closes expired at expiresAt, with end not attempted, and the adapter gives the dialog back",
        show(await stateOf(f)) === "closed/expired" && Date.now() - t0 >= 900 && same(f.ends, [false]) && same(f.writes, ["release"]), f.writes);
    }),
    scenario(async (ok) => {
      const f = openFake(desk1, "deliver rejects after it wrote", { settleMs: 1500, deliver: () => Promise.reject(new Error("the hook pipe closed after the write")) });
      const t0 = Date.now();
      const r = await answer(f, "allow");
      ok("deliver rejects after it wrote: the reply comes at once with sent, unconfirmed, and the desk warns",
        show(stateIn(r)) === "sent/unconfirmed" && Date.now() - t0 < 3000 && warns.some((w) => w.includes(f.id) && w.includes("the hook pipe closed after the write")), verdictOf(r));
      ok("...the prompt stays sent, unconfirmed", show(await stateOf(f)) === "sent/unconfirmed");
      await until(async () => (await stateOf(f))?.kind === "closed", 3000);
      ok("...and when it closes, end is attempted and the adapter writes nothing more",
        show(await stateOf(f)) === "closed/unconfirmed/none" && same(f.ends, [true]) && same(f.writes, ["answer:allow"]), f.writes);
    }),
  ]));

  console.log("\ndesk 1: open's refusals");
  {
    const content = permission();
    const refusal = (spec: Record<string, unknown>) => { try { openFake(desk1, "open's refusals", { spec }); return "opened"; } catch (e) { return e instanceof PromptRefused ? e.reason : `threw ${(e as Error).message}`; } };
    const bad = [
      { content, settleMs: 1000 }, { content, openMs: 1000 }, { content, openMs: 999, settleMs: 1000 }, { content, openMs: 7 * 86_400_000 + 1, settleMs: 1000 },
      { content, openMs: 1000, settleMs: 0 }, { content, openMs: 1000, settleMs: 86_400_000 + 1 }, { content, openMs: 1500.5, settleMs: 1000 },
    ].map(refusal);
    check(`a spec without openMs or settleMs, or with one outside its range: ${bad.filter((r) => r === "invalid").length}/7 refused invalid`, bad.every((r) => r === "invalid"), bad);
    const spec = (c: PromptContent) => ({ content: c, openMs: 60_000, settleMs: 60_000 });
    const q = question();
    const invalid = [
      permission("two\nlines"),
      permission("x", { options: [{ id: "allow", label: "Allow", effect: "proceed" }, { id: "allow", label: "Again", effect: "refuse" }] }),
      permission("x", { options: [{ id: "allow", label: "Allow", effect: "proceed", form: "required" }] }),
      { ...q, options: q.options.filter((o) => o.form === undefined) },
      { ...q, form: { schema: { ...q.form!.schema, required: ["suite", "missing"] } } },
      permission("x", { subject: { type: "tool", name: "Write", input: { kind: "omitted", bytes: 9_000_000 } } }),
    ].map((c) => refusal(spec(c)));
    check(`content that breaks the rules is invalid: ${invalid.filter((r) => r === "invalid").length}/6 (a two-line title, a repeated option id, a form option without a form, a form no option submits, a required name with no property, an omitted input with a proceed option)`,
      invalid.every((r) => r === "invalid"), invalid);
    const omittedDeny = refusal(spec(permission("x", { subject: { type: "tool", name: "Write", input: { kind: "omitted", bytes: 9_000_000 } },
      options: [{ id: "deny", label: "Deny", effect: "refuse" }] })));
    check("an omitted input with only a refusing option opens: it can be refused remotely", omittedDeny === "opened", omittedDeny);
  }

  console.log("\ndesk 1: hooks and a logger that break their contract");
  {
    // Node exits on an unhandled rejection by default; here each one is counted instead.
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on("unhandledRejection", onUnhandled);
    const unhandledSince = async (before: number) => { await wait(100); return unhandled - before; };
    try {
      let before = unhandled;
      const bigint = openFake(desk1, "deliver resolves 1n", { deliver: async () => 1n as unknown as Delivery });
      const t0 = Date.now();
      const r = await answer(bigint, "allow");
      const took = Date.now() - t0;
      const lost = await unhandledSince(before);
      check("deliver that resolves 1n is one failed call: the reply comes at once with sent, unconfirmed, the desk warns, and nothing is unhandled",
        show(stateIn(r)) === "sent/unconfirmed" && took < 2000 && lost === 0
        && warns.some((w) => w.includes(bigint.id) && w.includes("1n") && w.includes("not a Delivery")), { took, got: verdictOf(r), unhandled: lost });
      bigint.hold.settle({ kind: "withdrawn" });
      check("...and a report then closes it, end attempted once", show(await stateOf(bigint)) === "closed/unconfirmed/none" && same(bigint.ends, [true]), bigint.ends);

      before = unhandled;
      const asyncCheck = openFake(desk1, "check is async and rejects", { check: async () => { throw new Error("the async check failed"); } });
      const rc = await answer(asyncCheck, "allow");
      const lostCheck = await unhandledSince(before);
      check("check written as an async function that rejects: internal, not-executed, the prompt stays open, the desk warns, and the rejection is not unhandled",
        refusedAs(rc, "internal") && show(await stateOf(asyncCheck)) === "open" && asyncCheck.verdicts.length === 0 && lostCheck === 0
        && warns.some((w) => w.includes(asyncCheck.id) && w.includes("promise")), { got: verdictOf(rc), unhandled: lostCheck });
      asyncCheck.hold.settle({ kind: "withdrawn" });

      before = unhandled;
      const asyncEnd = openFake(desk1, "end is async and rejects", { end: async () => { throw new Error("the async end failed"); } });
      asyncEnd.hold.settle({ kind: "withdrawn" });
      const lostEnd = await unhandledSince(before);
      check("end written as an async function that rejects: the prompt closes, end came once, and the rejection is not unhandled",
        show(await stateOf(asyncEnd)) === "closed/withdrawn/none" && same(asyncEnd.ends, [false]) && lostEnd === 0, { unhandled: lostEnd });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // A logger that throws, on the interactive actor's own desk.
    const termAt = addressOf(W.term);
    const loud = await openPromptDesk(termEp, { warn: (m) => { warns.push(`loud: ${m}`); throw new Error("the logger is down"); } });
    desks.push(loud);
    const endThrows = openFake(loud, "end throws, and so does the logger", { end: () => { throw new Error("end exploded"); } });
    const after = openFake(loud, "closed after it");
    let closeThrew = "";
    try { await loud.close(); } catch (e) { closeThrew = (e as Error).message; }
    const served = await settled(call(webEp, "prompts", {}, { to: termAt, deadlineMs: 3000 }));
    check("a logger that throws stops no close: end threw and so did its warning, and close() still ended every prompt and stopped serving",
      closeThrew === "" && same(endThrows.ends, [false]) && same(after.ends, [false]) && warns.some((w) => w.startsWith("loud: ") && w.includes("end exploded"))
      && !served.ok && served.error instanceof EpEnvelopeError && served.error.code === "unavailable",
      { closeThrew, ends: [endThrows.ends, after.ends], served: served.ok ? verdictOf(served.value) : (served.error as Error).message });

  }

  console.log("\ndesk 1: the timers measure from the desk's own clock");
  {
    // Whatever runs in `open` after it fixed expiresAt, X still fires at expiresAt. A spec getter the
    // desk reads after that holds the loop for 600 ms.
    let reads = 0, endedAt = 0;
    const spec = { content: permission("Allow Bash: expiry from expiresAt?"), openMs: 1000, get settleMs() { if (++reads === 2) hold(600); return 60_000; } };
    const x = openFake(desk1, "expiry from expiresAt", { spec, end: () => { endedAt = Date.now(); } });
    const expiresAt = await expiresAtOf(x);
    await until(() => x.ends.length === 1, 4000);
    check("expiry is armed for what is left until expiresAt: the prompt closes expired at expiresAt, not 600 ms after it",
      same(x.ends, [false]) && reads >= 2 && endedAt - expiresAt >= 0 && endedAt - expiresAt < 250, { late: endedAt - expiresAt, reads });

    // The wall clock steps back 500 ms after the answer is accepted, so the settle timer runs before
    // the settle time by the desk's clock.
    const realNow = Date.now;
    const early = openFake(desk1, "the settle timer runs early", { settleMs: 1000 });
    const reply = (await accept(early)).reply;
    Date.now = () => realNow() - 500;
    try {
      await reply;
      await until(() => early.ends.length === 1, 4000);
    } finally {
      Date.now = realNow;
    }
    const s = await stateOf(early);
    const waited = s?.kind === "closed" && s.outcome.kind === "unconfirmed" ? Date.parse(s.at) - Date.parse(s.outcome.answer.at) : -1;
    check("a settle timer that runs before the settle time by the desk's clock arms itself again: the prompt closes unconfirmed no earlier than settleMs after the answer",
      show(s) === "closed/unconfirmed/none" && waited >= 1000, { state: show(s), waited });
  }

  console.log("\ndesk 1: a closed prompt lets its hooks go");
  {
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    // The harness side keeps the deliver call it never settles.
    const harness: Promise<Delivery>[] = [];
    let ref: WeakRef<PromptHooks> | undefined;
    const f = openFake(desk1, "hooks after end", {
      deliver: () => { const p = new Promise<Delivery>(() => {}); harness.push(p); return p; },
      hooks: (h) => { ref = new WeakRef(h); },
    });
    const reply = (await accept(f)).reply;
    f.hold.settle({ kind: "withdrawn" });
    await reply;
    for (let i = 0; i < 3; i++) { await wait(20); gc(); }
    check("once end has run the desk drops the prompt's hooks: they are collected while the harness still holds the deliver call that never settles and the prompt is in the closed memory",
      same(f.ends, [true]) && harness.length === 1 && ref !== undefined && ref.deref() === undefined && show(await stateOf(f)) === "closed/unconfirmed/none", { ends: f.ends, collected: ref?.deref() === undefined });
  }

  // ── desk 1 closes, desk 2 opens: the closed memory, the caps, the bounds on the wire ──
  console.log("\ndesk 2: the closed memory, the caps, the summary bound, and the replies on the wire");
  const lastSeq1 = (await list()).seq;
  await desk1.close();
  check("desk 1 closes: presence carries no prompts field", await until(() => roster(W.coder) !== undefined && roster(W.coder)!.prompts === undefined, 8000), roster(W.coder)?.prompts);
  const desk2 = await deskOn(coderEp, "desk2");
  {
    await until(() => roster(W.coder)?.prompts !== undefined, 8000);
    const seq2 = roster(W.coder)?.prompts?.seq ?? -1;
    check("a desk opened again in the same process goes on counting: its first seq is above every seq desk 1 used", seq2 > lastSeq1, { lastSeq1, seq2 });

    const M = openFake(desk2, "left the closed memory");
    const m = (await accept(M)).reply;
    M.delivered({ kind: "confirmed" });
    await m;
    const kept = await answer(M, "allow");
    for (let i = 0; i < 32; i++) openFake(desk2, `filler ${i}`).hold.settle({ kind: "withdrawn" });
    const gone = await answer(M, "allow");
    const read = await call(webEp, "prompt", { id: M.id });
    check("a retry while the prompt is in the closed memory is ok; after 32 more closed it left the memory and the retry is not-found",
      show(stateIn(kept)) === "closed/answered" && refusedAs(gone, "not-found") && refusedAs(read, "not-found"), [verdictOf(kept), verdictOf(gone), verdictOf(read)]);
    const l = await list();
    check("the list keeps the last 32 closed prompts", l.closed.length === 32 && !l.closed.some((s) => s.id === M.id));

    let refusedReason = "";
    const big = openFake(desk2, "the largest content", { content: contentOfBytes(AGENT_PROMPT_CONTENT_MAX_BYTES, "p".repeat(32)) });
    try { openFake(desk2, "one byte over", { content: contentOfBytes(AGENT_PROMPT_CONTENT_MAX_BYTES + 1) }); } catch (e) { refusedReason = (e as PromptRefused).reason; }
    check(`content of ${AGENT_PROMPT_CONTENT_MAX_BYTES} canonical bytes opens, and one byte more is refused too-large`, refusedReason === "too-large", refusedReason);
    const bigReply = (await accept(big, "p".repeat(32))).reply;
    const wire = await rawSend(webRaw, "prompt", { id: big.id });
    const fullPrompt = wire?.reply.ok ? (wire.reply.data as { prompt: AgentPrompt }).prompt : undefined;
    console.log(`    the largest full prompt reply on the wire, sent and unconfirmed: ${wire?.bytes} bytes`);
    check(`the largest full prompt reply on the wire is ${wire?.bytes} bytes, under ${PROMPT_DESK_MIN_MAX_PAYLOAD}, and its digest checks`,
      wire !== undefined && wire.bytes <= PROMPT_DESK_MIN_MAX_PAYLOAD && fullPrompt !== undefined && agentPromptDigest(fullPrompt.content) === big.digest, wire?.bytes);
    big.hold.settle({ kind: "withdrawn" });
    check("...and the waiting reply reads the state the report left", show(stateIn(await bigReply)) === "closed/unconfirmed/none");

    // The summary bound.
    let over = "";
    const at = openFake(desk2, "the largest summary", { content: contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES, "s") });
    try { openFake(desk2, "one byte over", { content: contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES + 1, "s") }); } catch (e) { over = (e as PromptRefused).reason; }
    check(`a prompt whose largest state encodes its summary to ${PROMPT_SUMMARY_MAX_BYTES} bytes opens, and one byte more is refused too-large`, over === "too-large", over);
    const sizes: [string, number][] = [];
    const measure = async () => {
      const l = await list();
      const s = [...l.open, ...l.closed].find((x) => x.id === at.id)!;
      sizes.push([show(s.state), Buffer.byteLength(JSON.stringify(s))]);
    };
    await measure();
    const ar = (await accept(at, "deny", { note: "n".repeat(2000) })).reply;
    await measure();
    at.delivered({ kind: "delivered" });
    await ar;
    await measure();
    at.hold.settle({ kind: "local", seen: { tie: "subject", effect: "proceed" } });
    await until(async () => (await stateOf(at))?.kind === "closed");
    await measure();
    console.log(`    the admitted summary in each state it reached: ${sizes.map(([s, b]) => `${s} ${b}`).join(", ")}`);
    check(`every state the admitted prompt then reaches still fits in ${PROMPT_SUMMARY_MAX_BYTES} bytes`, sizes.length === 4 && sizes.every(([, b]) => b <= PROMPT_SUMMARY_MAX_BYTES), sizes);

    // 32 closed and 32 open, each with a summary at the bound in its largest state, then the 33rd.
    for (let i = 0; i < 32; i++) {
      const f = openFake(desk2, `closed at the bound ${i}`, { content: contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES, "c") });
      const r = (await accept(f)).reply;
      f.hold.settle({ kind: "observed", seen: { tie: "subject", effect: "proceed" } });
      await r;
    }
    const waiting: Promise<EndpointReply>[] = [];
    for (let i = 0; i < 32; i++) waiting.push((await accept(openFake(desk2, `open at the bound ${i}`, { content: contentWithLargestSummary(PROMPT_SUMMARY_MAX_BYTES, "o") }))).reply);
    let fullReason = "";
    try { openFake(desk2, "the 33rd"); } catch (e) { fullReason = (e as PromptRefused).reason; }
    check("a 33rd prompt is refused full while 32 are open or sent", fullReason === "full" && desk2.waiting === 32, { fullReason, waiting: desk2.waiting });
    const listWire = await rawSend(webRaw, "prompts", {});
    const listed = listWire?.reply.ok ? (listWire.reply.data as PromptsOutput) : undefined;
    const each = listed ? [...listed.open, ...listed.closed].map((s) => Buffer.byteLength(JSON.stringify(s))) : [];
    console.log(`    the prompts reply on the wire, 32 sent and 32 closed at the bound: ${listWire?.bytes} bytes; summaries ${Math.min(...each)} to ${Math.max(...each)} bytes`);
    check(`the complete list reply on the wire is ${listWire?.bytes} bytes, under ${PROMPT_DESK_MIN_MAX_PAYLOAD}, with 32 and 32 summaries each within ${PROMPT_SUMMARY_MAX_BYTES}`,
      listWire !== undefined && listWire.bytes <= PROMPT_DESK_MIN_MAX_PAYLOAD && listed?.open.length === 32 && listed.closed.length === 32 && each.every((b) => b <= PROMPT_SUMMARY_MAX_BYTES), { bytes: listWire?.bytes });
    await desk2.close();
    // Each reply was sent at the first of the 10 s bound and the close.
    const closedReplies = await Promise.all(waiting);
    check("every one of the 32 waiting replies is ok, executed, read at the 10 s bound or at the close",
      closedReplies.every((r) => ["sent/unconfirmed", "closed/unconfirmed/none"].includes(show(stateIn(r)))), [...new Set(closedReplies.map(verdictOf))]);
  }

  // ── desk 3: the interleavings in one tick ──
  console.log("\ndesk 3: interleavings in one tick, in both orders");
  const desk3 = await deskOn(coderEp, "desk3");
  {
    const ans = (s: Seat, f: Fake, option: string, extra: Record<string, unknown> = {}) => rawSend(s, "prompt-answer", { id: f.id, digest: f.digest, option, ...extra });

    // An answer and an expiry in the same tick.
    const E1 = openFake(desk3, "expiry, then the answer", { openMs: 2000 });
    let e1!: ReturnType<typeof rawSend>;
    await inOneTick((await expiresAtOf(E1)) - 500, "check", () => { e1 = ans(webRaw, E1, "allow"); }, 800);
    const r1 = (await e1)?.reply;
    check("an answer and an expiry in one tick, expiry first: the prompt closes expired and the answer meets conflict, with end not attempted",
      r1 !== undefined && refusedAs(r1, "conflict") && show(detailState(r1)) === "closed/expired" && same(E1.ends, [false]) && E1.verdicts.length === 0, r1 && verdictOf(r1));
    const E2 = openFake(desk3, "the answer, then expiry", { openMs: 2000, check: (v) => (v.option === "deny" ? "the adapter refuses deny" : undefined) });
    let e2deny!: ReturnType<typeof rawSend>, e2allow!: ReturnType<typeof rawSend>;
    await inOneTick((await expiresAtOf(E2)) - 500, "timer", () => { e2deny = ans(webRaw, E2, "deny"); e2allow = ans(webRaw, E2, "allow"); }, 800);
    const [d2, a2] = [(await e2deny)?.reply, (await e2allow)?.reply];
    check("an answer and an expiry in one tick, the answer first, after expiresAt: check 9 refuses first (bad-request), then check 10 (expired)",
      d2 !== undefined && a2 !== undefined && refusedAs(d2, "bad-request") && !d2.ok && d2.error.message === "the adapter refuses deny" && refusedAs(a2, "expired"), [d2 && verdictOf(d2), a2 && verdictOf(a2)]);
    await until(async () => (await stateOf(E2))?.kind === "closed", 3000);
    check("...then the expiry closes it expired, end not attempted, and nothing was handed over",
      show(await stateOf(E2)) === "closed/expired" && same(E2.ends, [false]) && E2.verdicts.length === 0);

    // Two different answers in the same tick.
    for (const [first, second] of [["allow", "deny"], ["deny", "allow"]] as const) {
      const f = openFake(desk3, `two answers, ${first} first`);
      let p1!: ReturnType<typeof rawSend>, p2!: ReturnType<typeof rawSend>;
      await inOneTick(Date.now() + 20, "timer", () => { p1 = ans(webRaw, f, first); p2 = ans(webRaw, f, second); }, 300);
      await until(() => f.verdicts.length === 1);
      f.delivered({ kind: "confirmed" });
      const [x, y] = [(await p1)?.reply, (await p2)?.reply];
      const conflicting = detailState(y!);
      check(`two different answers in one tick, ${first} first: ${first} is accepted, and ${second} gets conflict with the state ${first} left`,
        x?.ok === true && show(stateIn(x)) === "closed/answered" && refusedAs(y!, "conflict") && conflicting?.kind === "sent" && conflicting.answer.option === first
        && f.verdicts.length === 1 && f.verdicts[0].option === first, [x && verdictOf(x), y && verdictOf(y)]);
    }
    {
      const f = openFake(desk3, "two answerers in one tick");
      let p1!: ReturnType<typeof rawSend>, p2!: ReturnType<typeof rawSend>;
      await inOneTick(Date.now() + 20, "timer", () => { p1 = ans(webRaw, f, "allow"); p2 = ans(builderRaw, f, "deny"); }, 300);
      await until(() => f.verdicts.length === 1);
      f.delivered({ kind: "confirmed" });
      const replies = [(await p1)?.reply, (await p2)?.reply];
      const okCount = replies.filter((r) => r?.ok).length, conflicts = replies.filter((r) => r && refusedAs(r, "conflict")).length;
      check("two answerers in one tick (alice.web and bob.builder): exactly one is accepted, the other gets conflict",
        okCount === 1 && conflicts === 1 && f.verdicts.length === 1, replies.map((r) => r && verdictOf(r)));
    }

    // settle for an open prompt while an answer for it is being checked.
    {
      const f = openFake(desk3, "a report from inside check", {
        check: (_v, me) => { me.hold.settle({ kind: "local", seen: { tie: "prompt", effect: "refuse" } }); return undefined; },
      });
      const r = await answer(f, "allow");
      const s = stateIn(r);
      check("a report made while the answer is being checked is applied after it: the answer is accepted, then the report closes it local with the answer as late",
        s?.kind === "closed" && s.outcome.kind === "local" && s.outcome.late?.option === "allow" && same(f.ends, [true]) && same(f.writes, ["answer:allow"]), verdictOf(r));
    }
    {
      const f = openFake(desk3, "a report before the answer");
      let p!: ReturnType<typeof rawSend>;
      await inOneTick(Date.now() + 20, "timer", () => { p = ans(webRaw, f, "allow"); }, 300,
        () => f.hold.settle({ kind: "local", seen: { tie: "prompt", effect: "refuse" } }));
      const r = (await p)?.reply;
      check("a report that reaches the desk before the answer in the same tick: it closes local, and the answer meets conflict",
        r !== undefined && refusedAs(r, "conflict") && show(detailState(r)) === "closed/local/prompt:refuse" && same(f.ends, [false]) && same(f.writes, ["release"]), r && verdictOf(r));
    }

    // observed for an open prompt.
    {
      const tied = openFake(desk3, "observed, tied to the prompt");
      const subj = openFake(desk3, "observed, tied to the subject");
      const none = openFake(desk3, "observed, nothing tied");
      tied.hold.settle({ kind: "observed", seen: { tie: "prompt", effect: "proceed" } });
      subj.hold.settle({ kind: "observed", seen: { tie: "subject", effect: "proceed" } });
      none.hold.settle({ kind: "observed", seen: { tie: "none" } });
      const got = [await stateOf(tied), await stateOf(subj), await stateOf(none)].map(show);
      check("observed for an open prompt: tied to the prompt it closes local; tied to the subject or to nothing it closes withdrawn with that sighting; end not attempted",
        same(got, ["closed/local/prompt:proceed", "closed/withdrawn/subject:proceed", "closed/withdrawn/none"]) && [tied, subj, none].every((f) => same(f.ends, [false])), got);
      const confirmed = openFake(desk3, "confirmed while open");
      const before = warns.length;
      confirmed.hold.settle({ kind: "confirmed" });
      check("a confirmation for an open prompt changes nothing and warns: there is no accepted answer to confirm",
        show(await stateOf(confirmed)) === "open" && confirmed.ends.length === 0
        && warns.slice(before).some((w) => w.includes(confirmed.id) && w.includes("no accepted answer")), warns.slice(before));
      confirmed.hold.settle({ kind: "withdrawn" });
    }

    // gone after a retry in the same tick already got ok.
    {
      const f = openFake(desk3, "gone after a same-tick retry");
      const orig = (await accept(f)).reply;
      let retry!: ReturnType<typeof rawSend>;
      await new Promise<void>((resolve) => setTimeout(() => {
        retry = rawSend(webRaw, "prompt-answer", { id: f.id, digest: f.digest, option: "allow" });
        setImmediate(() => { f.delivered({ kind: "gone" }); resolve(); });
        queueMicrotask(() => hold(300));
      }, 20));
      const rr = (await retry)?.reply, ro = await orig;
      const after = await answer(f, "allow");
      check("gone in the same tick, after a retry already got ok: the retry read sent, unconfirmed, the first reply closed, undelivered, and every reply is ok, executed",
        rr !== undefined && show(stateIn(rr)) === "sent/unconfirmed" && show(stateIn(ro)) === "closed/undelivered" && show(stateIn(after)) === "closed/undelivered", [rr && verdictOf(rr), verdictOf(ro), verdictOf(after)]);
    }
    await desk3.close();
  }

  // ── desks 4 to 6: a pending receipt meets expiry, a disconnect and close() ──
  console.log("\ndesks 4 to 6: a pending receipt meets expiry, a disconnect and close()");
  const reconnectCoder = async () => {
    await (coderEp as unknown as { nc: NatsConnection }).nc.reconnect();
    return until(async () => (await settled(call(webEp, "prompts", {}, { deadlineMs: 1500 }))).ok, 15_000);
  };
  for (const order of ["expiry, then a disconnect", "a disconnect, then expiry"] as const) {
    const desk = await deskOn(coderEp, `desk ${order}`);
    const f = openFake(desk, order, { openMs: order === "expiry, then a disconnect" ? 1000 : 4000 });
    const orig = (await accept(f)).reply;
    const expiresAt = Date.parse((await list()).open.find((s) => s.id === f.id)!.expiresAt);
    const steps: string[] = [];
    for (const step of order === "expiry, then a disconnect" ? ["expiry", "disconnect"] : ["disconnect", "expiry"]) {
      if (step === "expiry") { await wait(Math.max(0, expiresAt - Date.now()) + 200); steps.push(`after expiry ${show(await stateOf(f))}`); }
      else { const back = await reconnectCoder(); steps.push(`after the disconnect ${back ? "serving" : "not serving"} ${show(await stateOf(f))}`); }
    }
    const noEndYet = f.ends.length === 0;
    await desk.close();
    const r = await orig;
    check(`an accepted answer whose receipt is pending, then ${order}, then close(): it stays sent until close, end comes once with attempted, and nothing is written after the answer`,
      steps.every((s) => s.endsWith("sent/unconfirmed") && !s.includes("not serving")) && noEndYet && show(stateIn(r)) === "closed/unconfirmed/none"
      && same(f.ends, [true]) && same(f.writes, ["answer:allow"]), { steps, ends: f.ends, writes: f.writes, reply: verdictOf(r) });
  }
  {
    const desk6 = await deskOn(coderEp, "desk6");
    const pending = openFake(desk6, "close with an unresolved deliver");
    const goneLater = openFake(desk6, "gone after close");
    const stillOpen = openFake(desk6, "open at close");
    const [p1, p2] = [(await accept(pending)).reply, (await accept(goneLater)).reply];
    const before = warns.length;
    const t0 = Date.now();
    await desk6.close();
    const took = Date.now() - t0;
    const [r1, r2] = [await p1, await p2];
    check("close() with an unresolved deliver returns without waiting for it, and each waiting caller gets its reply: ok, executed, closed, unconfirmed",
      took < 3000 && show(stateIn(r1)) === "closed/unconfirmed/none" && show(stateIn(r2)) === "closed/unconfirmed/none", { took, r1: verdictOf(r1), r2: verdictOf(r2) });
    pending.delivered({ kind: "confirmed" });
    goneLater.delivered({ kind: "gone" });
    await wait(200);
    check("the late results change nothing: end came once each, nothing more is written, and the desk says nothing about them",
      same(pending.ends, [true]) && same(goneLater.ends, [true]) && same(stillOpen.ends, [false]) && same(stillOpen.writes, ["release"])
      && same(pending.writes, ["answer:allow"]) && warns.length === before, { warns: warns.slice(before) });
    await until(() => roster(W.coder) !== undefined && roster(W.coder)!.prompts === undefined, 8000);
    const after = await settled(call(webEp, "prompts", {}, { deadlineMs: 3000 }));
    check("a closed desk clears the presence field and serves nothing: unavailable, not-executed",
      roster(W.coder)?.prompts === undefined && !after.ok && after.error instanceof EpEnvelopeError && after.error.code === "unavailable" && after.error.outcome === "not-executed",
      after.ok ? after.value : (after.error as Error).message);
    let closedReason = "";
    try { openFake(desk6, "after close"); } catch (e) { closedReason = (e as PromptRefused).reason; }
    check("open on a closed desk is refused closed, so the harness answers that dialog", closedReason === "closed", closedReason);
  }

  // ── a serve that fails on a reconnect ──
  console.log("\ndesk lifecycle: a serve that fails on a reconnect, and a smaller max_payload");
  {
    const coder2Ep = await userEndpoint(W.coder2, { registerPresence: true });
    const before = warns.length;
    const desk = await deskOn(coder2Ep, "coder2");
    const at2 = addressOf(W.coder2);
    const open = openFake(desk, "open when the serve fails");
    const sent = openFake(desk, "sent when the serve fails");
    const reply = call(webEp, "prompt-answer", { id: sent.id, digest: sent.digest, option: "allow" }, { to: at2, deadlineMs: 6000 });
    await until(() => sent.verdicts.length === 1);
    await until(() => roster(W.coder2)?.prompts !== undefined, 8000);
    stripped.add(W.coder2.uid);
    await (coder2Ep as unknown as { nc: NatsConnection }).nc.reconnect();
    const closedOnIt = await until(() => open.ends.length === 1 && sent.ends.length === 1, 10_000);
    check("the next credential lacks the rows: the serve fails, the desk closes, the open prompt is released and the sent one ends attempted",
      closedOnIt && same(open.ends, [false]) && same(sent.ends, [true]) && warns.slice(before).some((w) => w.startsWith("coder2: the prompt desk closed")), warns.slice(before));
    check("...and presence clears the prompts field", await until(() => roster(W.coder2) !== undefined && roster(W.coder2)!.prompts === undefined, 8000));
    const r = await settled(reply);
    check("...the waiting caller, whose reply can no longer be published, sees an unknown outcome at its deadline, never a refusal that claims nothing ran",
      !r.ok && r.error instanceof EpEnvelopeError && r.error.code === "deadline-exceeded" && r.error.outcome === "unknown", r.ok ? verdictOf(r.value) : (r.error as Error).message);
  }

  const errors = () => events.filter((e) => e.includes(" error: "));
  check("no endpoint emitted an error before the broker restart", errors().length === 0, errors());
  const restartAt = events.length;

  // ── a reconnect that lands on a smaller max_payload ──
  {
    const desk7 = await deskOn(coderEp, "desk7");
    const before = warns.length;
    const f = openFake(desk7, "open when the limit shrinks");
    await until(() => roster(W.coder)?.prompts !== undefined, 8000);
    // The broker comes back with a 262144-byte max_payload, and every client reconnects to it.
    await killAndAwaitExit(brokers.get("server.conf")!);
    writeFileSync(join(dir, "server.conf"), `${serverConf}\nmax_payload: 262144\n`);
    startBroker("server.conf");
    const closedOnIt = await until(() => f.ends.length === 1, 60_000);
    check("a reconnect to a max_payload under 524288 closes the desk: the prompt is released and the desk warns",
      closedOnIt && same(f.ends, [false]) && warns.slice(before).some((w) => w.includes("max_payload is 262144 bytes")), warns.slice(before));
    let reconnected = false;
    for (let i = 0; i < 300 && !reconnected; i++) { try { reconnected = coderEp.maxPayload === 262144; } catch { /* not live yet */ } if (!reconnected) await wait(100); }
    const again = await settled(openPromptDesk(coderEp, { warn: () => {} }));
    check("openPromptDesk on that connection rejects, naming the limit", reconnected && !again.ok && String((again.error as Error).message).includes("262144"), again.ok ? "opened" : (again.error as Error).message);
  }

  console.log("\nevery path");
  check(`end came exactly once for every prompt the fake opened: ${fakes.length} prompts`, fakes.every((f) => f.ends.length === 1),
    fakes.filter((f) => f.ends.length !== 1).map((f) => `${f.label}: ${JSON.stringify(f.ends)}`));
  check("the desk never reported a row that cannot happen, an end twice, or another bug", !warns.some((w) => w.includes("bug")), warns.filter((w) => w.includes("bug")));
  // While the restarted broker waits for the auth callout's own connection to come back, a client's
  // first reconnect is refused. The restart also drops the space's Memory buckets, presence among
  // them, until the host reconciles them, so alice.web's presence watch rebind reports `timeout`
  // while it is disconnected and `stream not found` once it is back. That window closes when the
  // host has reconciled and alice.web's watch reports a presence change written after it.
  await reconcileSpaceMemoryBuckets({ servers: SERVERS, space, creds: provisionerCreds });
  const activity = `back after the restart ${randomUUID()}`;
  let windowEnd = -1;
  webEp.on("presence", (e: { presence: Presence }) => {
    if (windowEnd < 0 && e.presence.card.id === `${W.coder.owner}.${W.coder.actor}` && e.presence.activity === activity) windowEnd = events.length;
  });
  await coderEp.setActivity(activity);
  const watchBack = await until(() => windowEnd >= 0, 30_000);
  const inWindow = events.slice(restartAt, watchBack ? windowEnd : events.length).filter((e) => e.includes(" error: "));
  const afterWindow = watchBack ? events.slice(windowEnd).filter((e) => e.includes(" error: ")) : [];
  check("across the restart the endpoints reported only the broker's refusal while the auth callout reconnected, and JetStream's timeout or stream not found until the host restored the presence bucket",
    watchBack && inWindow.every((e) => /^\S+ error: (Authorization Violation|stream not found|timeout)$/.test(e))
      && afterWindow.every((e) => e.endsWith(" error: Authorization Violation")),
    { watchBack, inWindow, afterWindow });
} finally {
  for (const d of desks) await d.close().catch(() => {});
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of raws) await nc.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  for (const b of brokers.values()) await killAndAwaitExit(b);
  for (const r of releases) r();
  rmSync(dir, { recursive: true, force: true });
}
finish();
