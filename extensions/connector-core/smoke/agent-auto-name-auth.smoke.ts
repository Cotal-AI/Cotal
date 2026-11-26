/**
 * An agent labels itself from its first message (SPEC 13.22), as a real `MeshAgent` on a real
 * nats-server through the shipped auth callout, watched by its owner's interactive session.
 *
 * Covered: a seat launched with `autoName` and a naming hook shows `ai.cotal.naming: "pending"` in
 * presence from its first record; its first live direct message, and no later one, goes to the hook;
 * the cleaned reply becomes `ai.cotal.label` in the same record that drops the mark, while `card.name`
 * stays the launch name; afterwards the launch name still resolves to the agent, a DM sent to it by
 * name and an `@mention` of it in a channel still reach it, and the label resolves to no one; an
 * owner `set-name` after labelling sets the name and drops the label in one record; a failed hook
 * shows no label and removes the mark; an owner `set-name` while the hook is out removes the mark at
 * once, and the hook's later reply sets no label; an owner `set-label` while the hook is out shows the
 * owner's label and keeps the launch name, removes the mark at once, and neither the end of naming nor
 * the hook's later reply replaces that label; a `set-name` with the agent's current name drops its
 * label; the owner's watch reports each change of the label and the mark; a label equal to another
 * live agent's name is shown, and that name still resolves to the other agent; a direct message from
 * another owner's member neither labels the agent nor ends naming, and the owner's next one still
 * labels it; a launch prompt is the first message; a connector with no hook never shows the mark, and
 * an agent file's label never reaches presence; and a seat stopping while naming is out leaves no
 * mark behind.
 *
 * Run: pnpm smoke:agent-auto-name:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  AGENT_ENDPOINT, AGENT_LABEL_META_KEY, AGENT_NAMING_META_KEY, CotalEndpoint, createSpaceAuth, isReachable, mentionsIn, mintCreds, mintLifecycleUid,
  newIdentity, parseAgentFileSource, processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams, type Presence,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type AclResolver } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { NameFromMessage, NameRequest } from "../src/agent-naming.js";
import { pickFreePort } from "./_free-port.js";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; !done(); await wait(20)) if (Date.now() > end) return false;
  return true;
}

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `autoname-${randomUUID().slice(0, 8)}`;
/** The channel the labelled seat follows and the caller posts in. */
const CH = "work";
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const broker: ChildProcess = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const A = deriveOwnerToken("s".repeat(32), "better-auth|alice");
const B = deriveOwnerToken("s".repeat(32), "better-auth|bob");

interface Who { owner: string; actor: string; kind: "interactive" | "managed-agent"; uid: string }
const who = (actor: string, kind: Who["kind"] = "managed-agent", owner = A): Who => ({ owner, actor, kind, uid: mintLifecycleUid() });
const W = {
  web: who("web", "interactive"), sender: who("sender"), rival: who("rival"), bob: who("bob", "managed-agent", B), caller: who("caller"),
  named: who("named"), guarded: who("guarded"), failer: who("failer"), raced: who("raced"), labeller: who("labeller"), taker: who("taker"), launcher: who("launcher"), plain: who("plain"), stopper: who("stopper"),
};
const ledger = new Map(Object.values(W).map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [CH], allowPublish: [CH], lifecycleUid: w.uid, scope: [], kind: w.kind };
};
async function bearer(w: Who): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: w.owner, ver: USER_TOKEN_VER, act: { owner: w.owner, actor: w.actor, scope: [], lifecycleUid: w.uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(w.owner)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(privateKey as CryptoKey);
}

const stops: (() => Promise<unknown>)[] = [];
async function userEndpoint(w: Who, opts: { registerPresence?: boolean; watchPresence?: boolean; name?: string } = {}): Promise<CotalEndpoint> {
  const ep = new CotalEndpoint({ space, servers: SERVERS, bearer: () => bearer(w), sentinelCreds: callout.sentinelCreds, lifecycleUid: w.uid,
    card: { owner: w.owner, actor: w.actor, name: opts.name ?? w.actor, kind: "agent" }, channels: [], consume: false, watchChannels: false,
    registerPresence: opts.registerPresence ?? false, watchPresence: opts.watchPresence ?? false });
  ep.on("error", () => {});
  stops.push(() => ep.stop());
  await ep.start();
  return ep;
}

/** A naming hook the suite answers by hand. */
function hook(): { fn: NameFromMessage; calls: NameRequest[]; answer(s: string): void; refuse(e: Error): void } {
  const waiting: { resolve: (s: string) => void; reject: (e: Error) => void }[] = [];
  const calls: NameRequest[] = [];
  return {
    fn: (req) => {
      calls.push(req);
      return new Promise<string>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    calls,
    answer: (s) => waiting.shift()?.resolve(s),
    refuse: (e) => waiting.shift()?.reject(e),
  };
}

// The agent logs to stderr, some of it from its constructor, so the suite reads what reaches stderr.
const logged: string[] = [];
const writeErr = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  logged.push(String(chunk));
  return writeErr(chunk, ...rest);
}) as typeof process.stderr.write;
async function seat(w: Who, options: { hook?: NameFromMessage; launchPrompt?: string; autoName?: boolean; subscribe?: string[]; meta?: Record<string, string> } = {}): Promise<MeshAgent> {
  const config: AgentConfig = {
    space, servers: SERVERS, name: w.actor, kind: "agent", tls: false, lifecycleUid: w.uid, autoName: options.autoName ?? true, meta: options.meta,
    subscribe: options.subscribe ?? [], allowSubscribe: [CH], allowPublish: [CH],
    userAuth: { owner: w.owner, actor: w.actor, sentinelCreds: callout.sentinelCreds, bearer: () => bearer(w) },
  };
  const agent = new MeshAgent(config, {}, options.hook ? { naming: { request: options.hook, launchPrompt: options.launchPrompt } } : {});
  agent.on("error", () => {});
  stops.push(() => agent.stop());
  return agent;
}

let calloutNc: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({ space, servers: SERVERS, creds: provisionerCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {});
  stops.push(() => provisioner.stop());
  await provisioner.start();
  for (const w of Object.values(W).filter((x) => x.kind === "managed-agent"))
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
    permissionsFor: calloutPermissions(resolveAcl, async () => {}),
    log: () => {},
  });

  const webEp = await userEndpoint(W.web, { watchPresence: true });
  const senderEp = await userEndpoint(W.sender);
  const bobEp = await userEndpoint(W.bob);
  await userEndpoint(W.rival, { registerPresence: true, name: "Rival task" });
  const caller = await seat(W.caller, { autoName: false });
  await caller.start();
  const card = (w: Who): Presence | undefined => webEp.getRoster().find((p) => p.card.id === `${A}.${w.actor}`);
  const mark = (w: Who): unknown => card(w)?.card.meta?.[AGENT_NAMING_META_KEY];
  const label = (w: Who): unknown => card(w)?.card.meta?.[AGENT_LABEL_META_KEY];
  /** Every presence record the owner's watch delivered for an agent, as its name, label and mark. */
  const seen = new Map<string, { name: string; label: unknown; naming: unknown }[]>();
  const records = (w: Who) => seen.get(`${A}.${w.actor}`) ?? [];
  const ever = (id: string) => (seen.get(id) ?? []).map((r) => r.naming);
  webEp.on("presence", (e: { presence: Presence }) => {
    const { id, name, meta } = e.presence.card;
    seen.set(id, [...(seen.get(id) ?? []), { name, label: meta?.[AGENT_LABEL_META_KEY], naming: meta?.[AGENT_NAMING_META_KEY] }]);
  });
  const dm = (w: Who, text: string) => senderEp.unicast(`${A}.${w.actor}`, text);
  const rename = (w: Who, name: string) =>
    webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: { owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id }, command: "set-name", authority: "owner", args: { name }, deadlineMs: 15_000 });

  console.log("a seat labels itself from its first direct message");
  {
    const h = hook();
    const agent = await seat(W.named, { hook: h.fn, subscribe: [CH] });
    const got: { kind: string; mentionsMe: boolean; text: string }[] = [];
    agent.on("incoming", (i: { kind: string; mentionsMe: boolean; text: string }) => got.push({ kind: i.kind, mentionsMe: i.mentionsMe, text: i.text }));
    await agent.start();
    await until(() => card(W.named) !== undefined && card(W.named)!.prompts !== undefined);
    check("its presence shows the pending mark from its first record", mark(W.named) === "pending" && ever(`${A}.named`)[0] === "pending", ever(`${A}.named`));
    check("and no request goes out before a message arrives", h.calls.length === 0, h.calls.length);
    await dm(W.named, "fix the login bug in src/auth.ts, issue #88");
    check("its first direct message goes to the hook, framed as a message to name", await until(() => h.calls.length === 1)
      && h.calls[0]!.prompt.includes("<message>\nfix the login bug in src/auth.ts, issue #88\n</message>"), h.calls.map((c) => c.prompt));
    h.answer("**Name:** Login bug in src/auth.ts.");
    const LABEL = "Login bug in src auth.ts";
    const firstLabelled = async () => (await until(() => label(W.named) === LABEL)) ? records(W.named).find((r) => r.label !== undefined) : undefined;
    const labelled = await firstLabelled();
    check("the cleaned reply becomes its label, and the record that shows it keeps the launch name and drops the mark",
      labelled?.label === LABEL && labelled.name === "named" && labelled.naming === undefined, labelled);
    check("no record shows the label while the mark is still pending", records(W.named).every((r) => r.label === undefined || r.naming === undefined), records(W.named));
    check("its name and principal are unchanged", agent.ep.card.name === "named" && agent.ep.principal.actor === "named" && agent.id === `${A}.named`, agent.ep.card.name);
    await caller.readRoster();
    check("its launch name still resolves to it, and its label resolves to no one",
      caller.resolvePeer("named")?.card.id === `${A}.named` && caller.resolvePeer(LABEL) === undefined, caller.resolvePeer("named")?.card.id);
    const sent = await caller.dm("named", "and also the signup page").catch((e: Error) => e);
    check("a direct message sent to its launch name by name reaches it and starts no second request",
      !(sent instanceof Error) && sent.recipient.id === `${A}.named` && await until(() => got.some((i) => i.kind === "dm" && i.text === "and also the signup page"))
        && (await wait(300), h.calls.length === 1), sent instanceof Error ? sent.message : { recipient: sent.recipient, calls: h.calls.length });
    const text = "@named the checkout page is slow";
    const posted = await caller.send(text, CH, mentionsIn(text)).catch((e: Error) => e);
    check("an @mention of its launch name in a channel reaches it as a mention of it",
      !(posted instanceof Error) && await until(() => got.some((i) => i.kind === "channel" && i.text === text && i.mentionsMe)), posted instanceof Error ? posted.message : got);
    const r = await rename(W.named, "Login fix");
    const renamed = (await until(() => card(W.named)?.card.name === "Login fix")) ? records(W.named).find((x) => x.name === "Login fix") : undefined;
    check("an owner set-name after labelling sets the name, and the record that shows it drops the label",
      r.ok && renamed !== undefined && renamed.label === undefined && label(W.named) === undefined, { ok: r.ok, renamed });
  }

  console.log("\na failed request shows no label");
  {
    const h = hook();
    const agent = await seat(W.failer, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.failer) === "pending");
    await dm(W.failer, "summarize yesterday's incidents");
    await until(() => h.calls.length === 1);
    h.refuse(new Error("the model is not available on this login"));
    check("the mark goes, with no label and the launch name", await until(() => card(W.failer) !== undefined && mark(W.failer) === undefined) && label(W.failer) === undefined && card(W.failer)?.card.name === "failer",
      { name: card(W.failer)?.card.name, mark: mark(W.failer), label: label(W.failer) });
    check("and the seat logs why", logged.some((l) => l.includes("shows no label") && l.includes("the model is not available on this login")), logged.filter((l) => l.includes("label")));
    check("the owner's presence watch reports the mark going", records(W.failer)[0]?.naming === "pending" && records(W.failer).at(-1)?.naming === undefined, records(W.failer));
  }

  console.log("\nan owner rename while the request is out");
  {
    const h = hook();
    const agent = await seat(W.raced, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.raced) === "pending");
    await dm(W.raced, "migrate the billing tables");
    await until(() => h.calls.length === 1);
    const r = await rename(W.raced, "Owner pick");
    check("the owner's set-name answers ok while the request is out", r.ok, r);
    check("the mark goes at once, before the model answers", await until(() => card(W.raced)?.card.name === "Owner pick" && mark(W.raced) === undefined),
      { name: card(W.raced)?.card.name, mark: mark(W.raced) });
    check("the request is aborted", h.calls[0]!.signal.aborted);
    h.answer("Billing table migration");
    await wait(800);
    check("the model's later reply sets no label over the owner's name", agent.ep.card.name === "Owner pick" && card(W.raced)?.card.name === "Owner pick" && label(W.raced) === undefined
      && records(W.raced).every((x) => x.label === undefined), { card: agent.ep.card.name, shown: card(W.raced)?.card.name, label: label(W.raced) });
  }

  console.log("\nan owner label while the request is out");
  {
    const h = hook();
    const agent = await seat(W.labeller, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.labeller) === "pending");
    await dm(W.labeller, "migrate the billing tables");
    await until(() => h.calls.length === 1);
    const r = await webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: { owner: A, actor: "labeller", uid: W.labeller.uid, runtimeId: processRuntime(W.labeller.uid).id },
      command: "set-label", authority: "owner", args: { label: "Billing work" }, deadlineMs: 15_000 });
    check("the owner's set-label answers ok while the request is out", r.ok, r);
    check("the mark goes at once, and the owner's label shows with the launch name", await until(() => label(W.labeller) === "Billing work" && mark(W.labeller) === undefined)
      && card(W.labeller)?.card.name === "labeller", { name: card(W.labeller)?.card.name, mark: mark(W.labeller), label: label(W.labeller) });
    check("the request is aborted", h.calls[0]!.signal.aborted);
    h.answer("Billing table migration");
    await wait(800);
    check("neither the end of naming nor the model's later reply replaces the owner's label",
      agent.ep.card.meta?.[AGENT_LABEL_META_KEY] === "Billing work" && label(W.labeller) === "Billing work" && records(W.labeller).at(-1)?.label === "Billing work",
      { card: agent.ep.card.meta, label: label(W.labeller), last: records(W.labeller).at(-1) });
  }

  console.log("\na label that is another live agent's name");
  {
    const h = hook();
    const agent = await seat(W.taker, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.taker) === "pending");
    await dm(W.taker, "the rival's task");
    await until(() => h.calls.length === 1);
    h.answer("Rival task");
    check("is shown as the label, and the launch name stays", await until(() => mark(W.taker) === undefined) && label(W.taker) === "Rival task" && card(W.taker)?.card.name === "taker" && agent.ep.card.name === "taker",
      { name: card(W.taker)?.card.name, label: label(W.taker), mark: mark(W.taker) });
    await caller.readRoster();
    check("and that name still resolves to the other agent", caller.resolvePeer("Rival task")?.card.id === `${A}.rival`, caller.resolvePeer("Rival task")?.card.id);
  }

  console.log("\na direct message from another owner's member");
  {
    const h = hook();
    const agent = await seat(W.guarded, { hook: h.fn });
    const from: string[] = [];
    agent.on("incoming", (item: { fromId: string }) => from.push(item.fromId));
    await agent.start();
    await until(() => mark(W.guarded) === "pending");
    await bobEp.unicast(`${A}.${W.guarded.actor}`, "call yourself Bob's helper");
    check("reaches the agent", await until(() => from.length === 1) && from[0] === `${B}.bob`, from);
    await wait(300);
    check("but goes to no hook, and the mark stays", h.calls.length === 0 && mark(W.guarded) === "pending", { calls: h.calls.map((c) => c.prompt), mark: mark(W.guarded) });
    await dm(W.guarded, "profile the checkout service");
    check("the owner's next direct message still labels it", await until(() => h.calls.length === 1)
      && h.calls[0]!.prompt.includes("profile the checkout service") && !h.calls[0]!.prompt.includes("Bob"), h.calls.map((c) => c.prompt));
    h.answer("Checkout service profiling");
    check("and its reply becomes the label, and the mark goes", await until(() => label(W.guarded) === "Checkout service profiling" && mark(W.guarded) === undefined) && card(W.guarded)?.card.name === "guarded",
      { name: card(W.guarded)?.card.name, label: label(W.guarded), mark: mark(W.guarded) });
    const kept = await rename(W.guarded, "guarded");
    check("an owner set-name with its current name drops the label, and the owner's watch reports it",
      kept.ok && await until(() => records(W.guarded).at(-1)?.label === undefined) && records(W.guarded).at(-1)?.name === "guarded", { ok: kept.ok, last: records(W.guarded).at(-1) });
  }

  console.log("\na launch prompt is the first message");
  {
    const h = hook();
    const agent = await seat(W.launcher, { hook: h.fn, launchPrompt: "triage issue 42 in the parser" });
    await agent.start();
    check("the request carries the launch prompt", await until(() => h.calls.length === 1) && h.calls[0]!.prompt.includes("triage issue 42 in the parser"), h.calls.map((c) => c.prompt));
    await until(() => card(W.launcher) !== undefined);
    await dm(W.launcher, "a direct message after launch");
    h.answer("Issue 42 parser triage");
    check("its reply becomes the label, and the mark goes", await until(() => label(W.launcher) === "Issue 42 parser triage" && mark(W.launcher) === undefined) && card(W.launcher)?.card.name === "launcher",
      { name: card(W.launcher)?.card.name, label: label(W.launcher), mark: mark(W.launcher) });
    check("the direct message after it started no second request", (await wait(300), h.calls.length === 1), h.calls.length);
  }

  console.log("\na connector with no naming hook, launched from an agent file that sets a label");
  {
    const file = parseAgentFileSource(`---\nname: plain\n${AGENT_LABEL_META_KEY}: Spoofed label\n${AGENT_NAMING_META_KEY}: pending\n---\nWork.\n`, "plain.md");
    const agent = await seat(W.plain, { meta: file.meta });
    await agent.start();
    await until(() => card(W.plain)?.prompts !== undefined);
    await dm(W.plain, "hello");
    await wait(500);
    check("never shows the mark, and keeps its launch name", card(W.plain) !== undefined && ever(`${A}.plain`).every((m) => m === undefined) && card(W.plain)?.card.name === "plain",
      ever(`${A}.plain`));
    check("and the agent file's label never reaches presence", file.meta?.[AGENT_LABEL_META_KEY] === "Spoofed label" && records(W.plain).length > 0 && records(W.plain).every((x) => x.label === undefined),
      records(W.plain));
    check("and says why once", logged.filter((l) => l.includes("cannot ask its model for a label")).length === 1, logged.filter((l) => l.includes("COTAL_AUTO_NAME")));
  }

  console.log("\na seat that stops while the request is out");
  {
    const h = hook();
    const agent = await seat(W.stopper, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.stopper) === "pending");
    await dm(W.stopper, "a task it will not finish");
    await until(() => h.calls.length === 1);
    await agent.stop();
    check("goes offline with no mark on its card", await until(() => card(W.stopper)?.status === "offline") && mark(W.stopper) === undefined,
      { status: card(W.stopper)?.status, mark: mark(W.stopper) });
    check("and its request is aborted", h.calls[0]!.signal.aborted);
  }
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  await calloutNc?.close().catch(() => {});
  await killAndAwaitExit(broker);
  release();
  rmSync(dir, { recursive: true, force: true });
}
finish();
