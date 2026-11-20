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
 * seat process starts.
 *
 * Exclusions (SPEC §9): a spawner whose lists remove channels hands on a part of what it holds,
 * which keeps those exclusions, and never the wildcard without them. The served door reads the
 * `{ allow, exclude }` form, the `callerAcl` default keeps the caller's exclusions, and a renewal
 * re-mints them for a broker at the exclusion floor and refuses below it.
 * Run with: pnpm smoke:spawn-grant-bound
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import {
  createSpaceAuth,
  eventChannel,
  mintCreds,
  mintGeneration,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  registry,
  SealRecipient,
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
import { requestDeliveryAdminZeroMemberships } from "./_fake-delivery-admin.js";

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
// The same spawner, started with its own event plane armed, and one to retire.
persona("herald", "allowSubscribe: [review, ops]\nallowPublish: [review]\ncapabilities: [spawn]\n");
persona("retiree", "allowSubscribe: [review]\nallowPublish: [review]\ncapabilities: [spawn]\n");
persona("boss", "capabilities: [admin]\n");
persona("inside", "subscribe: [review]\nallowPublish: [review]\n");
persona("reader", "allowSubscribe: [general]\n");
persona("poster", "allowSubscribe: [ops]\nallowPublish: [ops]\n");
persona("spawner", "capabilities: [spawn]\n");
persona("runner", "capabilities: [run]\n");
persona("vitals", "capabilities: [machine-vitals]\n");
persona("helper", "");
persona("worker", "role: worker\n");
persona("deputy", "capabilities: [role:worker]\n");
persona("dispatcher", "capabilities: [spawn, role:worker]\n");
persona("silent", "allowSubscribe: []\n");
// Exclusions: a spawner that reads and posts team.> minus team.secret, and the children it may and
// may not hand on, as persona files.
const teamMinusSecret = '{ allow: ["team.>"], exclude: [team.secret] }';
persona("xlead", `allowSubscribe: ${teamMinusSecret}\nallowPublish: ${teamMinusSecret}\ncapabilities: [spawn]\n`);
persona("xkeep", `allowSubscribe: ${teamMinusSecret}\nallowPublish: ${teamMinusSecret}\n`);
persona("xsibling", "allowSubscribe: [team.a]\nallowPublish: [team.a]\n");
persona("xunder", 'allowSubscribe: ["team.x.>"]\n');
persona("xdrop", 'allowSubscribe: ["team.>"]\n');
persona("xsecret", "allowSubscribe: [team.secret]\n");
persona("xpostdrop", 'allowPublish: ["team.>"]\n');
// Pattern exclusions: team.> minus every team.*.private, and team.> minus the team.secret.> subtree.
persona("plead", 'allowSubscribe: { allow: ["team.>"], exclude: ["team.*.private"] }\ncapabilities: [spawn]\n');
persona("slead", 'allowSubscribe: { allow: ["team.>"], exclude: ["team.secret.>"] }\ncapabilities: [spawn]\n');

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
type Seat = { id: string; name: string; lifecycleUid: string; issued?: { generation: string }; secretPaths?: { creds?: string } };
const M = mgr as unknown as {
  managerInstanceId: string;
  agents: Map<string, Seat>;
  retirement: {
    retiring: Map<string, unknown>;
    deprovision: (a: Seat) => Promise<void>;
  };
  namesCapacity: {
    freeSlot: (a: unknown, floor: boolean, cause: import("../src/manager.js").FreeSlotCause) => void;
  };
};
M.managerInstanceId = mintLifecycleUid();
(mgr as unknown as { staticLifecycleEvict?: (principal: string) => Promise<unknown> }).staticLifecycleEvict = async (principal) =>
  ({ principal, kicked: 1, remaining: 0, scanComplete: true, verifiedGone: true });
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  requestDeliveryAdmin: requestDeliveryAdminZeroMemberships,
  getRoster: () => [...M.agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};
const con: Connector = { kind: "connector", name: "smoke-gb", requires: ["node"], eventChannel, buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(con);

const spawnAs = (caller: EpCaller | undefined, name: string, extra: Record<string, unknown> = {}): Promise<ControlReply> =>
  mgr.startAgent({ name, agent: "smoke-gb", events: false, ...extra }, caller ? principalKey(caller.owner, caller.actor).key : undefined, undefined, caller);
/** The minted chat ACL of a spawn that succeeded, or `undefined`, so no credential cell can pass on
 *  a refused spawn. */
const minted = (reply: ControlReply) => {
  const d = reply.data as { name?: string; lifecycleUid?: string } | undefined;
  return reply.ok && d?.name && d.lifecycleUid
    ? credAcl(agentLifecycleSecretFilePaths(workspaceRoot, space, d.name, d.lifecycleUid).creds)
    : undefined;
};
const reads = (acl: { sub: string[] } | undefined, ch: string) => acl !== undefined && acl.sub.some((s) => s.endsWith(`.${ch}`));
/** The chat deny rows of a minted credential: what its exclusions remove (SPEC §9). */
const denyRows = (creds: string): { sub: string[]; pub: string[] } => {
  const jwt = creds.split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const nats = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")).nats ?? {};
  const chat = (rows: string[] | undefined) => (rows ?? []).filter((r) => r.includes(".chat."));
  return { sub: chat(nats.sub?.deny), pub: chat(nats.pub?.deny) };
};
const denies = (path: string) => denyRows(readFileSync(path, "utf8"));
const credsOf = (reply: ControlReply) => {
  const d = reply.data as { name?: string; lifecycleUid?: string } | undefined;
  return reply.ok && d?.name && d.lifecycleUid ? agentLifecycleSecretFilePaths(workspaceRoot, space, d.name, d.lifecycleUid).creds : undefined;
};
const deniedRead = (reply: ControlReply, ch: string) => { const p = credsOf(reply); return p !== undefined && denies(p).sub.some((r) => r.endsWith(`.chat.*.*.${ch}`)); };
const deniedPost = (reply: ControlReply, ch: string) => { const p = credsOf(reply); return p !== undefined && denies(p).pub.some((r) => r.endsWith(`.${ch}`)); };
const noDeny = (reply: ControlReply) => { const p = credsOf(reply); return p !== undefined && denies(p).sub.length === 0 && denies(p).pub.length === 0; };
const posts = (acl: { pub: string[] } | undefined, ch: string) => acl !== undefined && acl.pub.some((s) => s.endsWith(`.${ch}`));
const empty = (acl: { sub: string[]; pub: string[] } | undefined) => acl !== undefined && acl.sub.length === 0 && acl.pub.length === 0;
const refused = (reply: ControlReply, part: RegExp) => reply.ok === false && part.test(reply.error ?? "");
const seatOf = (name: string) => [...M.agents.values()].find((x) => x.name === name)!;
const issuedCallerOf = (name: string): IssuedCaller => {
  const a = seatOf(name);
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
    const j = await spawnAs(caller, "inside", { join: ["general"] });
    check("a join the spawner cannot read is bounded too", refused(j, /allowSubscribe general/), j);
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
    const quiet = await spawnAs(caller, "silent", { callerAcl: { allowSubscribe: ["review"], allowPublish: ["review"] } });
    check("an explicit [] persona spawns", quiet.ok === true, quiet);
    check("and takes no callerAcl default", empty(minted(quiet)), minted(quiet));
  }
  {
    const r = await spawnAs(caller, "helper", { events: true });
    check("a spawner without its own event plane cannot arm a helper's", refused(r, /events \(the helper's own event plane/), r);
    const herald = await spawnAs(undefined, "herald", { events: true });
    check("control: the composition root spawns a spawner with its event plane", herald.ok === true, herald);
    const h = await spawnAs(issuedCallerOf("herald"), "helper", { events: true });
    check("a spawner with its own event plane arms its helper's", h.ok === true, h);
    const acl = minted(h);
    const child = seatOf(String((h.data as { name?: string } | undefined)?.name));
    check("and the helper posts its own event channel", acl !== undefined && child !== undefined && posts(acl, eventChannel({ owner: DEV_OWNER, actor: child.id })), acl);
  }

  console.log("role");
  {
    const r = await spawnAs(caller, "worker");
    check("a role the spawner holds no queue for is refused, naming the token that hands it on", refused(r, /role worker \(a spawner hands on a role it was given as its own or as the `role:worker` capability\)/), r);
    const t = await spawnAs(caller, "deputy");
    check("and so is the role:<r> token for it", refused(t, /capabilities role:worker/), t);
    const d = await spawnAs(undefined, "dispatcher");
    check("control: the composition root spawns a spawner holding role:worker", d.ok === true, d);
    const seat = seatOf("dispatcher");
    const raw = (() => {
      const path = agentLifecycleSecretFilePaths(workspaceRoot, space, seat.name, seat.lifecycleUid).creds;
      const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
      return (JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")).nats?.pub?.allow ?? []) as string[];
    })();
    check("its credential binds the worker task queue", raw.some((s) => s.startsWith("$JS.API.CONSUMER.MSG.NEXT.") && s.endsWith(".svc_worker")), raw.filter((s) => s.includes("svc_")));
    const w = await spawnAs(issuedCallerOf("dispatcher"), "worker");
    check("it hands the role on", w.ok === true, w);
    const dt = await spawnAs(issuedCallerOf("dispatcher"), "deputy");
    check("and the role:worker token", dt.ok === true, dt);
  }

  console.log("no evidence");
  {
    const bare: EpCaller = { owner: caller.owner, actor: caller.actor, uid: caller.uid };
    const r = await spawnAs(bare, "inside");
    check("a caller with no issued generation hands on no grant", refused(r, /holds no issued evidence.*no issued generation.*allowSubscribe review/), r);
    const h = await spawnAs(bare, "helper", { callerAcl: { allowSubscribe: ["review"], allowPublish: ["review"] } });
    check("a channel-less persona still spawns for it", h.ok === true, h);
    check("with no callerAcl default", empty(minted(h)), minted(h));
    const ev = await spawnAs(bare, "helper", { events: true });
    check("nor an event plane", refused(ev, /holds no issued evidence.*events \(the helper's own event plane/), ev);
    const stale = { ...caller, generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600) } as IssuedCaller;
    const s = await spawnAs(stale, "inside");
    check("evidence that does not resolve hands on no grant", refused(s, /holds no issued evidence.*does not resolve/), s);
    const retiree = await spawnAs(undefined, "retiree");
    check("control: the composition root spawns a spawner to retire", retiree.ok === true, retiree);
    const gone = issuedCallerOf("retiree");
    const before = await spawnAs(gone, "inside");
    check("control: before retirement its evidence resolves", before.ok === true, before);
    const seat = seatOf("retiree");
    M.namesCapacity.freeSlot(seat, false, "process-exit");
    await M.retirement.deprovision(seat);
    for (let i = 0; i < 300 && M.retirement.retiring.has("retiree"); i++) await new Promise((r) => setTimeout(r, 100));
    check("control: the retirement completed", !M.retirement.retiring.has("retiree"));
    const after = await spawnAs(gone, "inside");
    check("a retired spawner's evidence does not resolve, so it hands on no grant", refused(after, /holds no issued evidence.*does not resolve/), after);
  }

  console.log("exclusions: a spawner hands on its exclusions with every wildcard they cut");
  {
    const xlead = await spawnAs(undefined, "xlead");
    check("control: the composition root spawns a spawner minus team.secret, minted with its deny rows",
      xlead.ok === true && reads(minted(xlead), "team.>") && deniedRead(xlead, "team.secret") && deniedPost(xlead, "team.secret"), xlead);
    const x = issuedCallerOf("xlead");
    const keep = await spawnAs(x, "xkeep");
    check("(b) a child that keeps the exclusion is admitted, and minted the wildcard with its deny rows",
      keep.ok === true && reads(minted(keep), "team.>") && deniedRead(keep, "team.secret") && posts(minted(keep), "team.>") && deniedPost(keep, "team.secret"), keep);
    const sib = await spawnAs(x, "xsibling");
    check("(a) a concrete sibling under the excluded wildcard is admitted, with no exclusion of its own",
      sib.ok === true && reads(minted(sib), "team.a") && posts(minted(sib), "team.a") && noDeny(sib), sib);
    const under = await spawnAs(x, "xunder");
    check("(c) a wildcard no exclusion cuts is admitted", under.ok === true && reads(minted(under), "team.x.>"), under);
    const drop = await spawnAs(x, "xdrop");
    check("(d) the wildcard without the exclusion is refused, naming the wildcard",
      refused(drop, /more than the spawner holds: allowSubscribe team\.>\. /), drop);
    const secret = await spawnAs(x, "xsecret");
    check("(e) the excluded channel itself is refused", refused(secret, /allowSubscribe team\.secret/), secret);
    const postDrop = await spawnAs(x, "xpostdrop");
    check("a post wildcard without the post exclusion is refused too", refused(postDrop, /more than the spawner holds: allowPublish team\.>\. /), postDrop);
    const wider = await spawnAs(x, "helper", { allowSubscribe: ["team.>"], excludeSubscribe: ["team.*"] });
    check("a raw override that keeps a wider exclusion is admitted", wider.ok === true && deniedRead(wider, "team.*"), wider);
    const orphan = await spawnAs(x, "helper", { excludeSubscribe: ["team.secret"] });
    check("an exclusion with no list beside it is refused", refused(orphan, /needs the allowSubscribe list/), orphan);
    const join = await spawnAs(x, "xkeep", { join: ["team.secret"] });
    check("a join on the excluded channel is refused, a join on a sibling admitted",
      refused(join, /subscribe "team\.secret" is excluded/) && (await spawnAs(x, "xkeep", { join: ["team.b"] })).ok === true, join);
  }
  {
    const plead = await spawnAs(undefined, "plead");
    check("control: the composition root spawns a spawner minus team.*.private", plead.ok === true, plead);
    const p = issuedCallerOf("plead");
    const keep = await spawnAs(p, "helper", { allowSubscribe: ["team.a.>"], excludeSubscribe: ["team.a.private"] });
    check("a pattern part keeps the pattern exclusion's share: team.a.> minus team.a.private is admitted", keep.ok === true && deniedRead(keep, "team.a.private"), keep);
    const pub = await spawnAs(p, "helper", { allowSubscribe: ["team.a.public"] });
    check("a concrete sibling of the private channels is admitted", pub.ok === true && reads(minted(pub), "team.a.public"), pub);
    const wide = await spawnAs(p, "helper", { allowSubscribe: ["team.a.>"] });
    check("team.a.> alone is refused", refused(wide, /more than the spawner holds: allowSubscribe team\.a\.>\. /), wide);
    const priv = await spawnAs(p, "helper", { allowSubscribe: ["team.a.private"] });
    check("a channel the pattern excludes is refused", refused(priv, /allowSubscribe team\.a\.private/), priv);
    const slead = await spawnAs(undefined, "slead");
    check("control: the composition root spawns a spawner minus team.secret.>", slead.ok === true, slead);
    const sl = issuedCallerOf("slead");
    const same = await spawnAs(sl, "helper", { allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret.>"] });
    const widerPattern = await spawnAs(sl, "helper", { allowSubscribe: ["team.>"], excludeSubscribe: ["team.*.>"] });
    check("team.> minus team.secret.>, or minus the wider team.*.>, is admitted", same.ok === true && widerPattern.ok === true, [same, widerPattern]);
    const narrower = await spawnAs(sl, "helper", { allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret.a"] });
    check("team.> minus only team.secret.a is refused", refused(narrower, /more than the spawner holds: allowSubscribe team\.>\. /), narrower);
  }

  console.log("exclusions: the served door, the callerAcl default and renewal");
  {
    const x = issuedCallerOf("xlead");
    const callerKey = principalKey(x.owner, x.actor).key;
    const opStart = (args: Record<string, unknown>) =>
      (mgr as unknown as { opStart: (a: Record<string, unknown>, c: string, admin: boolean, h: undefined, r: "inst", ac: EpCaller) => Promise<ControlReply> })
        .opStart({ agent: "smoke-gb", events: false, ...args }, callerKey, false, undefined, "inst", x);
    const door = await opStart({ name: "helper", allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: { allow: ["team.>"], exclude: ["team.secret"] } });
    check("the door reads { allow, exclude } and mints the exclusion", door.ok === true && reads(minted(door), "team.>") && deniedRead(door, "team.secret") && deniedPost(door, "team.secret"), door);
    const doorDrop = await opStart({ name: "helper", allowSubscribe: ["team.>"] });
    check("the door bounds the plain wildcard as the persona path does", refused(doorDrop, /more than the spawner holds: allowSubscribe team\.>\. /), doorDrop);
    const doorNothing = await opStart({ name: "helper", allowSubscribe: { allow: ["team.>"], exclude: ["ops"] } });
    check("the door refuses an exclusion that removes nothing", refused(doorNothing, /removes nothing/), doorNothing);
    const doorWhole = await opStart({ name: "helper", allowPublish: { allow: ["team.a"], exclude: ["team.a"] } });
    check("the door refuses an exclusion that removes a whole entry", refused(doorWhole, /excluded in full/), doorWhole);
    const scoped = await opStart({ name: "helper", callerAcl: { allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: ["team.a"] } });
    check("a channel-less persona takes the callerAcl default with its exclusions",
      scoped.ok === true && reads(minted(scoped), "team.>") && deniedRead(scoped, "team.secret") && posts(minted(scoped), "team.a"), scoped);
    const bare = await opStart({ name: "helper", callerAcl: { allowSubscribe: ["team.>", "team.a"], allowPublish: [] } });
    check("a callerAcl that drops the exclusion keeps only what is held: the wildcard goes, the sibling stays",
      bare.ok === true && !reads(minted(bare), "team.>") && reads(minted(bare), "team.a") && noDeny(bare), bare);

    // Renewal re-mints the exclusions under the same issuance, for a broker at the floor only.
    const keepName = (door.data as { name?: string } | undefined)?.name;
    const seat = keepName ? seatOf(keepName) : undefined;
    const renew = (a: unknown) => (mgr as unknown as { renewManagedStaticCred: (a: unknown) => Promise<void> }).renewManagedStaticCred(a);
    const before = seat?.secretPaths?.creds ? readFileSync(seat.secretPaths.creds, "utf8") : undefined;
    // A renewal in the spawn's own second signs the same claims, so let the clock move first.
    await new Promise((r) => setTimeout(r, 1100));
    let renewed: unknown;
    try { await renew(seat); renewed = true; } catch (e) { renewed = (e as Error).message; }
    const after = seat?.secretPaths?.creds ? readFileSync(seat.secretPaths.creds, "utf8") : undefined;
    check("a renewal re-signs the credential and keeps the exclusion",
      renewed === true && after !== before && deniedRead(door, "team.secret") && deniedPost(door, "team.secret") && reads(minted(door), "team.>"), renewed);
    // A static chat session opens with its exclusions minted, for a broker at the floor only.
    const chatOpen = async (lists: Record<string, unknown>): Promise<string | { sub: string[]; pub: string[] }> => {
      const recipient = new SealRecipient();
      try {
        const r = await (mgr as unknown as { openStaticChatSession: (raw: unknown) => Promise<{ sealer: string; sealed: string }> })
          .openStaticChatSession({ label: "smoke", ttl: 60, sealTo: recipient.publicKey, ...lists });
        return denyRows((recipient.openJson(r.sealed, r.sealer) as { creds: string }).creds);
      } catch (e) { return (e as Error).message; }
    };
    const fencedChat = { allowSubscribe: { allow: ["team.>"], exclude: ["team.secret"] }, allowPublish: { allow: ["team.>"], exclude: ["team.audit"] } };
    const chat = await chatOpen(fencedChat);
    check("a static chat session opens with its read and post exclusions minted",
      typeof chat === "object" && chat.sub.some((r) => r.endsWith(".chat.*.*.team.secret")) && chat.pub.some((r) => r.endsWith(".team.audit")), chat);
    const M2 = mgr as unknown as { withIssuer: <T>(fn: (i: { brokerVersion: string | undefined }) => Promise<T>) => Promise<T> };
    const realIssuer = M2.withIssuer.bind(mgr);
    M2.withIssuer = (fn) => realIssuer((i) => fn({ ...i, brokerVersion: "2.12.6" }));
    try {
      let below: unknown;
      try { await renew(seat); below = "renewed"; } catch (e) { below = (e as Error).message; }
      check("a renewal for a broker below the exclusion floor is refused", typeof below === "string" && /channel exclusions need nats-server 2\.12\.7/.test(below), below);
      const spawnBelow = await spawnAs(x, "xkeep");
      check("so is a spawn that carries an exclusion", refused(spawnBelow, /channel exclusions need nats-server 2\.12\.7/), spawnBelow);
      const plain = await spawnAs(x, "xsibling");
      check("and a spawn without one is not", plain.ok === true, plain);
      const chatBelow = await chatOpen(fencedChat);
      check("a static chat session that carries an exclusion is refused too", typeof chatBelow === "string" && /channel exclusions need nats-server 2\.12\.7/.test(chatBelow), chatBelow);
      const chatPlain = await chatOpen({ allowSubscribe: ["team.>"] });
      check("and one without an exclusion opens", typeof chatPlain === "object", chatPlain);
    } finally {
      M2.withIssuer = realIssuer;
    }
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
    const sub = await spawnAs(issuedCallerOf("boss"), "spawner");
    check("control: the admin spawner seats a spawn holder without admin", sub.ok === true, sub);
    // A refused control carries its refusal forward, so the suite still reaches its marker.
    const subName = (sub.data as { name?: string } | undefined)?.name;
    const w = sub.ok && subName ? await spawnAs(issuedCallerOf(subName), "reader") : sub;
    check("that helper is bounded: the admin exemption is not inherited", refused(w, /allowSubscribe general/), w);
  }
} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(`\nSPAWN-GRANT-BOUND SMOKE ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
