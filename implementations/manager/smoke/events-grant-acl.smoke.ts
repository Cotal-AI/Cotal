/**
 * THE EVENT GRANT IS KEYED ON THE PRINCIPAL, AND THIS SUITE IS WHERE THAT IS ENFORCED RATHER THAN
 * DOCUMENTED.
 *
 * An agent's AG-UI event plane lands on a channel derived from the principal it was ALLOCATED, never
 * from its display name. The difference is not cosmetic. A display name is UI convenience: this mesh
 * permits two live agents to carry one, and the manager itself auto-numbers collisions, so a
 * name-keyed channel fuses two principals onto one subject and, in auth mode, authorizes both onto it
 * from a value that identifies neither. The cells below decode the JWT the manager actually minted
 * and check the granted subject against the principal, not against a substring.
 *
 * BROKER-BACKED, because the property lives in the credential rather than in a variable. Each spawn
 * provisions through a short-lived ephemeral provisioner connection, so `startAgent` connects for
 * real before minting; we boot our own JWT-auth nats-server, let the real spawn path run end to end,
 * then read the publish ACL out of the written creds.
 *
 * WHAT THE RESUME HALF PROVES, AND WHY IT IS NOT A SECOND MINT. A resume ADOPTS the credential the
 * spawn wrote; it does not re-mint one, and it refuses outright if the adopted authority's
 * `allowPublish` no longer matches the inventory's. So the question a restart raises is not "is the
 * grant re-derived correctly" but "does the record carry it forward at all", and there are two ways
 * to lose it: the inventory can drop the channel from `allowPublish`, or it can drop the ARMING flag
 * and bring the session back holding a grant it will never publish to. The last cells assert both
 * halves survive the round trip.
 *
 * Run with: pnpm smoke:events-grant
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager, type ManagerResumeInventory } from "../src/manager.js";
import {
  createSpaceAuth,
  registry,
  mintCreds,
  newIdentity,
  principalKey,
  eventChannel,
  eventChannelPrincipal,
  setupSpaceStreams,
  DEV_OWNER,
  type Connector,
  type LaunchSpec,
  type AgentHandle,
} from "@cotal-ai/core";
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
let cells = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  cells++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// The chat-publish subjects allowed by a minted creds file (decode the JWT's nats.pub.allow).
function pubAcl(path: string): string[] {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return ((claims.nats?.pub?.allow as string[] | undefined) ?? []).filter((s) => s.includes(".chat.") && !s.startsWith("$JS"));
}

/** The channel a chat subject names. A chat subject is `cotal.<space>.chat.<owner>.<actor>.<channel>`,
 *  so the channel is what remains after BOTH principal segments; taking the whole tail would let the
 *  agent's own nkey satisfy a substring check about the channel. */
const channelOf = (subject: string): string => subject.split(".chat.")[1]?.split(".").slice(2).join(".") ?? "";

const space = `ev-grant-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-events-grant-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
// A persona with a known non-event post ACL, so the event grant is distinguishable from it.
writeFileSync(
  join(agentsDir, "event-bot.md"),
  "---\nname: eventbot\nrole: worker\nsubscribe: [work]\nallowSubscribe: [work]\nallowPublish: [work]\n---\nbody\n",
);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth; // real trust material; the broker enforces it

const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};

// The launch each connector renders is captured, so the ARMING half of the record can be read on the
// way back out of a resume without a real child process.
let lastLaunchEvents: boolean | undefined;
let lastLaunchAllowPublish: string[] | undefined;
const base = {
  kind: "connector" as const,
  requires: ["node"],
  buildLaunch: (o: { events?: boolean; allowPublish?: string[] }): LaunchSpec => {
    lastLaunchEvents = o.events;
    lastLaunchAllowPublish = o.allowPublish;
    return { command: "true", args: [], env: {} };
  },
};
registry.register({ ...base, name: "smoke-emitter", eventChannel } satisfies Connector);
registry.register({ ...base, name: "smoke-silent" } satisfies Connector); // no eventChannel → cannot emit

const credsDir = join(workspaceRoot, ".cotal", "auth", "creds");

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // 1 — events ON + an emitting connector: the grant names the ALLOCATED principal.
  let armedName = "";
  let armedChannel = "";
  {
    const reply = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter", events: true });
    check("spawn with events succeeds", reply.ok === true, reply);
    const data = (reply.ok ? reply.data : {}) as { lifecycleUid?: string; name?: string; id?: string };
    const uid = String(data.lifecycleUid ?? "");
    armedName = String(data.name ?? "");
    const actor = (mgr as unknown as { agents: Map<string, { id: string }> }).agents.get(armedName)!.id;
    const pub = pubAcl(join(credsDir, `${armedName}.${uid}.creds`));
    const granted = pub.map(channelOf).filter((c) => c.startsWith("events."));
    armedChannel = granted[0] ?? "";
    check("exactly one event channel is granted", granted.length === 1, granted);
    check(
      "the granted channel is the connector's own derivation for the allocated principal",
      armedChannel === eventChannel({ owner: DEV_OWNER, actor }),
      { granted: armedChannel, expected: eventChannel({ owner: DEV_OWNER, actor }) },
    );
    // A full derivation, not a prefix test: the channel must PARSE BACK to the principal that was
    // allocated. A grant that merely starts with "events." proves nothing about who it names.
    const parsed = eventChannelPrincipal(armedChannel);
    check("the channel round-trips to the allocated principal", parsed !== null && parsed.owner === DEV_OWNER && parsed.actor === actor, { parsed, actor });
    // THE LOAD-BEARING NEGATIVE. Name-keying is the failure this design exists to prevent, and it is
    // invisible in every cell above: `events.local.eventbot` would satisfy "starts with events." and
    // would round-trip to a well-formed principal too. Only the name's ABSENCE separates them.
    check(
      "the display name does NOT appear in the granted channel",
      !armedChannel.includes(armedName),
      { granted: armedChannel, name: armedName },
    );
    check("the persona's own post ACL is untouched", pub.some((s) => channelOf(s) === "work"), pub);
  }

  // 2 — events OFF: nothing is granted. Without this, a grant added unconditionally passes cell 1.
  {
    const reply = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter" });
    check("spawn without events succeeds", reply.ok === true, reply);
    const data = (reply.ok ? reply.data : {}) as { lifecycleUid?: string; name?: string };
    const pub = pubAcl(join(credsDir, `${String(data.name)}.${String(data.lifecycleUid)}.creds`));
    check("no event channel is granted when events are off", !pub.map(channelOf).some((c) => c.startsWith("events.")), pub);
    check("and the launch is not armed either", lastLaunchEvents !== true, lastLaunchEvents);
  }

  // 3 — events ON + a connector that cannot emit: refuse, never a silently-skipped grant.
  {
    const before = (mgr as unknown as { reserved: Set<string> }).reserved.size;
    const reply = await mgr.startAgent({ name: "event-bot", agent: "smoke-silent", events: true });
    check("events on a non-emitting connector fails loud", reply.ok === false && /does not publish an AG-UI event plane/.test(reply.error ?? ""), reply);
    // The refusal runs after the name is reserved, so it has to give the name back. A leaked reserve
    // is silent: it costs the next spawn its un-suffixed name and nothing reports why.
    check("the refusal releases the reserved name", (mgr as unknown as { reserved: Set<string> }).reserved.size === before, before);
  }

  // 4 — RESTART. The record has to carry BOTH halves: the channel and the arming.
  let preserved: ManagerResumeInventory | undefined;
  {
    const captured: ManagerResumeInventory[] = [];
    const plan = await mgr.preserveState({ attemptId: "ev-grant-attempt", persistInventory: async (inv) => { captured.push(inv); } });
    preserved = plan.inventory;
    check("preservation produced an inventory", plan.inventory.agents.length > 0, plan.failures);
    const entry = plan.inventory.agents.find((a) => a.name === armedName);
    check("the armed agent is in the inventory", entry !== undefined, plan.inventory.agents.map((a) => a.name));
    check("the inventory carries the arming flag, not just the grant", entry?.launch.events === true, entry?.launch);
    check(
      "the inventory carries the SAME principal-keyed channel, not a re-derivation",
      entry?.launch.allowPublish?.includes(armedChannel) === true,
      { allowPublish: entry?.launch.allowPublish, expected: armedChannel },
    );
    check("the persisted copy carries it too", captured[0]?.agents.find((a) => a.name === armedName)?.launch.events === true, captured[0]?.agents.length);
    // And the unarmed sibling stays unarmed across the same round trip, so the flag is being carried
    // per agent rather than set for the whole inventory.
    const sibling = plan.inventory.agents.find((a) => a.name !== armedName);
    check("an unarmed agent stays unarmed in the same inventory", sibling !== undefined && sibling.launch.events === false, sibling?.launch);
  }

  // 5 — the record an OLDER manager wrote. An upgrade restarts the manager against an inventory
  // written by the previous version, which has no `events` field at all. Refusing that document
  // would lose every agent the restart was meant to preserve, so absent reads as off, which is what
  // it means: that session was not publishing a plane, because there was none to publish.
  {
    const { parseResumeControlArgs } = await import("../src/resume.js");
    const entry = JSON.parse(JSON.stringify({ ...preserved, agents: [preserved!.agents[0]] }));
    delete entry.agents[0].launch.events;
    // The refusal this cell is about is a THROW, so it has to be caught here: an uncaught one would
    // abort the suite before either assertion printed, and a cell that never runs cannot fail.
    let parsed: ReturnType<typeof parseResumeControlArgs> | null = null;
    let refusal: string | null = null;
    try { parsed = parseResumeControlArgs({ attemptId: "old-record", inventory: entry }); }
    catch (e) { refusal = String((e as Error).message); }
    check("an inventory written before the event plane still parses", parsed?.inventory.agents.length === 1, refusal ?? parsed);
    check("and its agent reads as unarmed rather than being refused", parsed?.inventory.agents[0]?.launch.events === false, refusal ?? parsed?.inventory.agents[0]?.launch);
  }
} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

// A count, because several cells above only run when the spawn before them succeeded: a regression
// that refuses every spawn DELETES them rather than failing them, and the run still prints a verdict.
const EXPECTED = 18;
check(`every cell ran - ${EXPECTED} expected`, cells === EXPECTED + 1, `${cells} cells reported`);

console.log(`\nEVENTS-GRANT/ACL SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
