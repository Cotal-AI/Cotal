/**
 * An agent names itself from its first message (SPEC 13.22), as a real `MeshAgent` on a real
 * nats-server through the shipped auth callout, watched by its owner's interactive session.
 *
 * Covered: a seat launched with `autoName` and a naming hook shows `ai.cotal.naming: "pending"` in
 * presence from its first record; its first live direct message, and no later one, goes to the hook,
 * and the cleaned reply becomes its name while the mark goes; a failed hook keeps the launch name and
 * removes the mark; an owner `set-name` while the hook is out removes the mark at once, and the hook's
 * later reply never overwrites the owner's name; a name another live agent holds is not taken; a direct
 * message from another owner's member neither names the agent nor ends naming, and the owner's next one
 * still names it; a launch prompt is the first message; a connector with no hook never shows the mark; and a seat stopping
 * while naming is out leaves no mark behind.
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
  AGENT_ENDPOINT, AGENT_NAMING_META_KEY, CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  processRuntime, provisionAgentDurables, serverConfig, setupSpaceStreams, type Presence,
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
  web: who("web", "interactive"), sender: who("sender"), rival: who("rival"), bob: who("bob", "managed-agent", B),
  named: who("named"), guarded: who("guarded"), failer: who("failer"), raced: who("raced"), taker: who("taker"), launcher: who("launcher"), plain: who("plain"), stopper: who("stopper"),
};
const ledger = new Map(Object.values(W).map((w) => [w.uid, w]));
const resolveAcl: AclResolver = (t) => {
  const w = ledger.get(t.act.lifecycleUid!);
  if (!w) throw new Error(`no ledger row for ${t.owner}.${t.act.actor}`);
  return { allowSubscribe: [], allowPublish: [], lifecycleUid: w.uid, scope: [], kind: w.kind };
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
async function seat(w: Who, options: { hook?: NameFromMessage; launchPrompt?: string } = {}): Promise<MeshAgent> {
  const config: AgentConfig = {
    space, servers: SERVERS, name: w.actor, kind: "agent", tls: false, lifecycleUid: w.uid, autoName: true,
    subscribe: [], allowSubscribe: [], allowPublish: [],
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
  const card = (w: Who): Presence | undefined => webEp.getRoster().find((p) => p.card.id === `${A}.${w.actor}`);
  const mark = (w: Who): unknown => card(w)?.card.meta?.[AGENT_NAMING_META_KEY];
  const ever = new Map<string, unknown[]>();
  webEp.on("presence", (e: { presence: Presence }) => {
    const id = e.presence.card.id;
    ever.set(id, [...(ever.get(id) ?? []), e.presence.card.meta?.[AGENT_NAMING_META_KEY]]);
  });
  const dm = (w: Who, text: string) => senderEp.unicast(`${A}.${w.actor}`, text);
  const rename = (w: Who, name: string) =>
    webEp.callPrincipal({ endpoint: AGENT_ENDPOINT, principal: { owner: w.owner, actor: w.actor, uid: w.uid, runtimeId: processRuntime(w.uid).id }, command: "set-name", authority: "owner", args: { name }, deadlineMs: 15_000 });

  console.log("a seat names itself from its first direct message");
  {
    const h = hook();
    const agent = await seat(W.named, { hook: h.fn });
    let incoming = 0;
    agent.on("incoming", () => incoming++);
    await agent.start();
    await until(() => card(W.named) !== undefined && card(W.named)!.prompts !== undefined);
    check("its presence shows the pending mark from its first record", mark(W.named) === "pending" && ever.get(`${A}.named`)?.[0] === "pending", ever.get(`${A}.named`));
    check("and no request goes out before a message arrives", h.calls.length === 0, h.calls.length);
    await dm(W.named, "fix the login bug in src/auth.ts, issue #88");
    check("its first direct message goes to the hook, framed as a message to name", await until(() => h.calls.length === 1)
      && h.calls[0]!.prompt.includes("<message>\nfix the login bug in src/auth.ts, issue #88\n</message>"), h.calls.map((c) => c.prompt));
    h.answer("**Name:** Login bug in src/auth.ts.");
    check("the cleaned reply becomes its name in presence, and the mark goes", await until(() => card(W.named)?.card.name === "Login bug in src auth.ts" && mark(W.named) === undefined),
      { name: card(W.named)?.card.name, mark: mark(W.named) });
    check("its principal is unchanged", agent.ep.principal.actor === "named" && agent.id === `${A}.named`, agent.ep.principal);
    await dm(W.named, "and also the signup page");
    check("a later direct message reaches the agent and starts no second request", await until(() => incoming >= 2) && (await wait(300), h.calls.length === 1), { incoming, calls: h.calls.length });
  }

  console.log("\na failed request keeps the launch name");
  {
    const h = hook();
    const agent = await seat(W.failer, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.failer) === "pending");
    await dm(W.failer, "summarize yesterday's incidents");
    await until(() => h.calls.length === 1);
    h.refuse(new Error("the model is not available on this login"));
    check("the mark goes and the launch name stays", await until(() => card(W.failer) !== undefined && mark(W.failer) === undefined) && card(W.failer)?.card.name === "failer",
      { name: card(W.failer)?.card.name, mark: mark(W.failer) });
    check("and the seat logs why", logged.some((l) => l.includes("kept its launch name") && l.includes("the model is not available on this login")), logged.filter((l) => l.includes("naming")));
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
    check("the model's later reply never overwrites the owner's name", agent.ep.card.name === "Owner pick" && card(W.raced)?.card.name === "Owner pick",
      { card: agent.ep.card.name, shown: card(W.raced)?.card.name });
  }

  console.log("\na name another live agent holds");
  {
    const h = hook();
    const agent = await seat(W.taker, { hook: h.fn });
    await agent.start();
    await until(() => mark(W.taker) === "pending");
    await dm(W.taker, "the rival's task");
    await until(() => h.calls.length === 1);
    h.answer("Rival task");
    check("is not taken: the launch name stays and the mark goes", await until(() => mark(W.taker) === undefined) && card(W.taker)?.card.name === "taker" && agent.ep.card.name === "taker",
      { name: card(W.taker)?.card.name, mark: mark(W.taker) });
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
    check("the owner's next direct message still names it", await until(() => h.calls.length === 1)
      && h.calls[0]!.prompt.includes("profile the checkout service") && !h.calls[0]!.prompt.includes("Bob"), h.calls.map((c) => c.prompt));
    h.answer("Checkout service profiling");
    check("and its reply becomes the name, and the mark goes", await until(() => card(W.guarded)?.card.name === "Checkout service profiling" && mark(W.guarded) === undefined),
      { name: card(W.guarded)?.card.name, mark: mark(W.guarded) });
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
    check("its reply becomes the name, and the mark goes", await until(() => card(W.launcher)?.card.name === "Issue 42 parser triage" && mark(W.launcher) === undefined),
      { name: card(W.launcher)?.card.name, mark: mark(W.launcher) });
    check("the direct message after it started no second request", (await wait(300), h.calls.length === 1), h.calls.length);
  }

  console.log("\na connector with no naming hook");
  {
    const agent = await seat(W.plain);
    await agent.start();
    await until(() => card(W.plain)?.prompts !== undefined);
    await dm(W.plain, "hello");
    await wait(500);
    check("never shows the mark, and keeps its launch name", card(W.plain) !== undefined && (ever.get(`${A}.plain`) ?? []).every((m) => m === undefined) && card(W.plain)?.card.name === "plain",
      ever.get(`${A}.plain`));
    check("and says why once", logged.filter((l) => l.includes("cannot ask its model for a name")).length === 1, logged.filter((l) => l.includes("COTAL_AUTO_NAME")));
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
