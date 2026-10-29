/**
 * The delegation bound at the mint on a STATIC mesh (SPEC 13.15). A spawner hands its helper any
 * part of what its issued credential carries and never more, whichever door the grant arrives by:
 * the persona file, the raw overrides, or the `callerAcl` default. A spawner whose evidence does not
 * resolve hands on no grant. The composition root, an operator instrument and an admin spawner are
 * exempt.
 *
 * Broker-backed: the spawner is a real managed seat, issued by the real spawn path, so its evidence
 * is the one the issuer recorded. The manager resolves it from the real issuer store. Each cell
 * passes the spawner's issued caller to `startAgent` the way the served `spawn` door passes the
 * subject's caller (manager.ts, the `spawn` handler). The runtime and the endpoint are fakes, so no
 * seat process starts. Run with: pnpm smoke:spawn-grant-bound
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import {
  createSpaceAuth,
  mintCreds,
  mintGeneration,
  newIdentity,
  principalKey,
  registry,
  setupSpaceStreams,
  DEV_OWNER,
  type AgentHandle,
  type Connector,
  type ControlReply,
  type EpCaller,
  type IssuedCaller,
  type LaunchSpec,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, mintControlInstrument } from "@cotal-ai/workspace";
import { bootBroker } from "./_boot-broker.js";
import { credAcl } from "./_cred-acl.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
};

const space = `grant-bound-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-grant-bound-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
const persona = (file: string, body: string) => writeFileSync(join(agentsDir, `${file}.md`), `---\nname: ${file}\n${body}---\nbody\n`);
// The spawner: reads review and ops, posts review, may spawn.
persona("lead", "allowSubscribe: [review, ops]\nallowPublish: [review]\ncapabilities: [spawn]\n");
persona("boss", "capabilities: [admin]\n");
persona("inside", "subscribe: [review]\nallowPublish: [review]\n");
persona("reader", "allowSubscribe: [general]\n");
persona("poster", "allowSubscribe: [ops]\nallowPublish: [ops]\n");
persona("spawner", "capabilities: [spawn]\n");
persona("runner", "capabilities: [run]\n");
persona("vitals", "capabilities: [machine-vitals]\n");
persona("helper", "");

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
const M = mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string; issued?: { generation: string } }> };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...M.agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};
const con: Connector = { kind: "connector", name: "smoke-gb", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(con);

const spawnAs = (caller: EpCaller | undefined, name: string, extra: Record<string, unknown> = {}): Promise<ControlReply> =>
  mgr.startAgent({ name, agent: "smoke-gb", events: false, ...extra }, caller ? principalKey(caller.owner, caller.actor).key : undefined, undefined, caller);
const minted = (reply: ControlReply) => {
  const d = reply.data as { name?: string; lifecycleUid?: string } | undefined;
  return reply.ok && d?.name && d.lifecycleUid
    ? credAcl(agentLifecycleSecretFilePaths(workspaceRoot, space, d.name, d.lifecycleUid).creds)
    : { sub: [] as string[], pub: [] as string[] };
};
const reads = (acl: { sub: string[] }, ch: string) => acl.sub.some((s) => s.endsWith(`.chat.${ch}`) || s.endsWith(`.${ch}`));
const posts = (acl: { pub: string[] }, ch: string) => acl.pub.some((s) => s.endsWith(`.${ch}`));
const refused = (reply: ControlReply, part: RegExp) => reply.ok === false && part.test(reply.error ?? "");
const issuedCallerOf = (name: string): IssuedCaller => {
  const a = [...M.agents.values()].find((x) => x.name === name)!;
  return { owner: DEV_OWNER, actor: a.id, uid: a.lifecycleUid, generation: a.issued!.generation } as IssuedCaller;
};

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const lead = await spawnAs(undefined, "lead");
  check("control: the composition root spawns the spawner", lead.ok === true, lead);
  const caller = issuedCallerOf("lead");

  console.log("bounded spawner");
  {
    const r = await spawnAs(caller, "inside");
    check("a persona inside the spawner's channels spawns", r.ok === true, r);
    const acl = minted(r);
    check("and is minted what the persona names", reads(acl, "review") && posts(acl, "review"), acl);
  }
  {
    const r = await spawnAs(caller, "reader");
    check("reading a channel the spawner cannot read is refused by name", refused(r, /more than the spawner holds: allowSubscribe general/), r);
  }
  {
    const r = await spawnAs(caller, "poster");
    check("posting where the spawner may only read is refused by name", refused(r, /allowPublish ops/) && !/allowSubscribe ops/.test(r.error ?? ""), r);
  }
  {
    const r = await spawnAs(caller, "inside", { allowSubscribe: ["review", "general"] });
    check("a raw override is bounded like the persona", refused(r, /allowSubscribe general/), r);
  }
  {
    const r = await spawnAs(caller, "spawner");
    check("the spawner hands on spawn, which it holds", r.ok === true, r);
    const run = await spawnAs(caller, "runner");
    check("run, which it does not hold, is refused", refused(run, /capabilities run/), run);
    const v = await spawnAs(caller, "vitals");
    check("a token no agent mint maps is refused", refused(v, /capabilities machine-vitals/), v);
  }
  {
    const r = await spawnAs(caller, "helper", { callerAcl: { allowSubscribe: ["review", "general"], allowPublish: ["review", "general"] } });
    check("a channel-less persona takes the callerAcl default", r.ok === true, r);
    const acl = minted(r);
    check("clamped to what the spawner's evidence holds", reads(acl, "review") && posts(acl, "review") && !reads(acl, "general") && !posts(acl, "general"), acl);
  }

  console.log("no evidence");
  {
    const bare: EpCaller = { owner: caller.owner, actor: caller.actor, uid: caller.uid };
    const r = await spawnAs(bare, "inside");
    check("a caller with no issued generation hands on no grant", refused(r, /holds no issued evidence.*no issued generation.*allowSubscribe review/), r);
    const h = await spawnAs(bare, "helper", { callerAcl: { allowSubscribe: ["review"], allowPublish: ["review"] } });
    check("a channel-less persona still spawns for it", h.ok === true, h);
    const acl = minted(h);
    check("with no callerAcl default", acl.sub.length === 0 && acl.pub.length === 0, acl);
    const stale = { ...caller, generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600) } as IssuedCaller;
    const s = await spawnAs(stale, "inside");
    check("evidence that does not resolve hands on no grant", refused(s, /holds no issued evidence.*does not resolve/), s);
  }

  console.log("exempt");
  {
    const r = await spawnAs(undefined, "reader");
    check("the composition root is exempt", r.ok === true, r);
    const { epCaller } = await mintControlInstrument({ server: SERVERS, space, tlsRequired: false, auth }, "privileged");
    const i = await spawnAs(epCaller, "reader");
    check("an operator instrument is exempt", i.ok === true, i);
    const boss = await spawnAs(undefined, "boss");
    check("control: the composition root spawns an admin seat", boss.ok === true, boss);
    const b = await spawnAs(issuedCallerOf("boss"), "reader");
    check("a spawner holding the admin set is exempt", b.ok === true, b);
  }
} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(`\nSPAWN-GRANT-BOUND SMOKE ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
