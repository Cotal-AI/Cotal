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
 * WHAT THE RESUME HALF PROVES. A resume ADOPTS the credential the spawn wrote rather than minting a
 * second one, so the question a restart raises is not "is the grant re-derived correctly" but "does
 * the record carry it forward at all", and there are two ways to lose it: the inventory can drop the
 * channel from `allowPublish`, or it can drop the ARMING flag and bring the session back holding a
 * grant it will never publish to. Cells below assert both halves survive the round trip.
 *
 * ⚠️ THIS PARAGRAPH USED TO CLAIM THAT A RESUME REFUSES WHEN THE INVENTORY'S `allowPublish` NO
 * LONGER MATCHES THE ADOPTED AUTHORITY'S. That is true in USER mode and was never true in static,
 * where the retained-authority check pins the credential's path, its identity and the broker's
 * acceptance of it and says nothing about its ACL. A security review found the consequence: the
 * managed row is re-armed straight from the inventory, `renewManagedStaticCred` re-mints the JWT out
 * of that row at half TTL, and a foreign concrete event channel written into an admin-supplied
 * document therefore became a minted read on another agent's tool inputs and outputs one renewal
 * later. Section 7 is the reproduction, and it exists because a comment asserting a refusal that
 * does not happen is worse than no comment: it is the reason nobody looked.
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
  mintLifecycleUid,
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

/** The chat-SUBSCRIBE subjects a minted creds file admits. The publish side says what an agent may
 *  put on its own event channel; this side says what it may READ, which is the question a plane
 *  carrying full tool inputs and outputs actually raises. */
function subAcl(path: string): string[] {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return ((claims.nats?.sub?.allow as string[] | undefined) ?? []).filter((s) => s.includes(".chat.") && !s.startsWith("$JS"));
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

/** A manager wired for this smoke. Called twice: a restart is a NEW manager adopting an inventory
 *  the old one wrote, and section 7 has to be that rather than a same-instance call. */
const newManager = (): Manager => {
  const m = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
  (m as unknown as { auth: unknown }).auth = auth; // real trust material; the broker enforces it
  (m as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
    kind: "fake",
    spawn: (name) => fakeHandle(name),
  };
  (m as unknown as { ep: Record<string, unknown> }).ep = {
    ref: () => ({ id: "smoke-mgr" }),
    on: () => {},
    off: () => {},
    waitForPresenceSnapshot: async () => {},
    getRoster: () =>
      [...(m as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map(
        (a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid }),
      ),
  };
  return m;
};
const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
// Carried from section 1 to section 9: the refusal text an operator actually sees, and the channel
// it refused. Section 9 cannot raise its own refusal, because by then this manager is in preserving
// mode and every spawn is fenced for a different reason.
let remedyRefusal = "";
let remedyChannel = "";
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

    // THE READ SIDE, stated from the credential rather than from the design. An event channel
    // carries a session's full tool inputs and outputs, so "who can subscribe to it" is the
    // question that matters most, and it is answered here: arming a session grants it PUBLISH on
    // its own channel and adds NOTHING to what it may read. An agent reads what its persona's
    // access set says and nothing else, so no agent gains sight of another's plane by being armed.
    const sub = subAcl(join(credsDir, `${armedName}.${uid}.creds`));
    check(
      "arming grants no event channel on the READ side",
      !sub.map(channelOf).some((c) => c.startsWith("events.")),
      sub,
    );
    check(
      "including its OWN: an armed agent is not subscribed to the plane it publishes",
      !sub.map(channelOf).includes(armedChannel),
      { sub, armedChannel },
    );
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


  // 4 — THE OWN-CHANNEL RULE. A spawn may be granted the event plane of the agent it is CREATING,
  // and no other.
  //
  // Why this rule exists where it does. `subscribe`, `allowSubscribe` and `allowPublish` are
  // caller-supplied on every spawn door. On a per-user-auth mesh the ledger's spawner envelope
  // already refuses a delegation wider than the spawner's own grant. On a STATIC mesh there is no
  // ledger, so nothing attenuates a caller-supplied ACL at all, and a caller that may spawn may
  // mint its child a read on any subject it names. An event channel is the subject worth naming:
  // it carries the session's tool inputs and outputs verbatim.
  //
  // The rule does not ask WHO the caller is. On a static mesh that question has no answer worth
  // acting on: the reach a static caller holds is true by construction of everyone who can reach
  // the handler. It asks whether the event channel names the agent being created, which the
  // manager knows because it has just allocated the principal.
  //
  // ⚠️ THE EXEMPTION HALF IS NOT REACHABLE AT THIS DOOR, and saying so precisely is the point. In
  // static mode the SPAWN seam's allocated actor is a freshly minted nkey (`newIdentity()` inside
  // the accept body), so no caller can name the child's own channel before it exists and every
  // concrete event channel a static caller supplies to a SPAWN is by construction foreign. The
  // exemption is reachable at the RESUME door even here, because a document names the identity it
  // is re-arming: sections 7 and 8 each carry a clean control that resumes an inventory holding the
  // armed agent's OWN channel and asserts this rule does not refuse it. It is reachable at the
  // SPAWN door in USER mode, where the allocated actor IS the requested name, and it is
  // load-bearing there: without it a legitimate spawn that carries its child's own channel forward
  // would be refused. That door is graded against a real user-mode mesh in
  // `implementations/auth/smoke/user-spawn.smoke.ts`, whose event cells are refusals and the
  // wildcard pass-through; the admitted-own-channel spawn is what this suite cannot see.
  // Section 9 mints with the profile THIS refusal names, so its text and the channel it refused are
  // carried out of this block rather than re-derived from a second, differently-fenced manager.
  {
    const foreign = eventChannel({ owner: DEV_OWNER, actor: "UVICTIMPRINCIPALNOTOURS" });
    remedyChannel = foreign;

    // (a) over the READ set, which is the form that matters: this is a read amplification.
    const before = (mgr as unknown as { reserved: Set<string> }).reserved.size;
    const rowsBefore = (mgr as unknown as { agents: Map<string, unknown> }).agents.size;
    const r1 = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter", allowSubscribe: [foreign] });
    remedyRefusal = r1.error ?? "";
    check(
      "a spawn asking for ANOTHER agent's event channel to READ is refused",
      r1.ok === false && /another agent's event channel/.test(r1.error ?? ""),
      r1,
    );
    check("the refusal releases the reserved name", (mgr as unknown as { reserved: Set<string> }).reserved.size === before, before);
    // Nothing was minted. A refusal that returned an error but left a credential on disk would pass
    // the cell above and hand out the channel anyway, which is the failure the cell is about.
    // COUNTED, not name-guessed. The manager auto-numbers a collision, so naming the row a refused
    // spawn "would have" taken bakes in an assumption about the suffix that is green whenever the
    // guess is wrong. The count cannot be wrong in that direction.
    check(
      "and no managed row survives it",
      (mgr as unknown as { agents: Map<string, unknown> }).agents.size === rowsBefore,
      { before: rowsBefore, after: (mgr as unknown as { agents: Map<string, unknown> }).agents.size },
    );

    // (b) over the POST set. One filter reads both fields; a filter that read only `allowSubscribe`
    // would pass (a) and still let a caller mint publish rights onto another agent's plane, which
    // is a forgery surface rather than a read one.
    const r2 = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter", allowPublish: [foreign] });
    check(
      "a spawn asking to POST to another agent's event channel is refused too",
      r2.ok === false && /another agent's event channel/.test(r2.error ?? ""),
      r2,
    );

    // (c) THE LOAD-BEARING CONTROL. Every cell above is satisfied by a manager that refuses this
    // spawn for any reason at all — a bad connector, a name collision, a broken persona. The same
    // spawn minus the foreign channel has to SUCCEED, or the three cells above are measuring the
    // spawn and not the channel.
    const r3 = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter", allowSubscribe: ["work"] });
    check("the SAME spawn without the foreign channel succeeds", r3.ok === true, r3);

    // (d) THE STATED LIMIT, asserted so it cannot quietly stop being true. `isEventChannel` derives
    // a principal and refuses anything that is not exactly two principal tokens, so a WILDCARD is
    // not an event channel to it. `events.<owner>.>` therefore passes this rule untouched and is
    // governed by ordinary ACL authority, which on a user mesh is the delegation envelope and on a
    // static mesh is the spawn credential itself. This closes the concrete form and not the
    // wildcard form. Writing the gap down as a cell is what stops a later reader assuming it is
    // closed, and what makes a future closure show up as a red here rather than as a silent
    // behaviour change.
    // `work` rides along because the persona's own read set has to stay inside the supplied
    // `allowSubscribe`: without it the spawn dies at provisioning on an unrelated and correct check
    // ("subscribe \"work\" is not within allowSubscribe"), and the cell would report a refusal it
    // did not cause. That is what it did on its first run.
    const r4 = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter", allowSubscribe: ["work", `events.${DEV_OWNER}.>`] });
    check("a WILDCARD event pattern is NOT refused by this rule — the stated limit", r4.ok === true, r4);

    // (e) and the arming grant still lands on top of a legal caller-supplied set, so the filter is
    // not collateral damage to the feature it protects.
    const r5 = await mgr.startAgent({ name: "event-bot", agent: "smoke-emitter", events: true, allowSubscribe: ["work"] });
    check("arming still grants the child its OWN plane alongside a legal ACL", (() => {
      if (!r5.ok) return false;
      const d = r5.data as { name?: string; lifecycleUid?: string };
      const actor = (mgr as unknown as { agents: Map<string, { id: string }> }).agents.get(String(d.name))!.id;
      const pub = pubAcl(join(credsDir, `${String(d.name)}.${String(d.lifecycleUid)}.creds`));
      return pub.map(channelOf).includes(eventChannel({ owner: DEV_OWNER, actor }));
    })(), r5);
  }

  // 5 — RESTART. The record has to carry BOTH halves: the channel and the arming.
  //
  // ⚠️ EVERY SPAWNING CELL MUST SIT ABOVE THIS ONE. `preserveState` puts the manager into
  // preserving mode and it never leaves: from here on every `startAgent` returns
  // "manager is in preserving mode". A refusal cell placed below would go GREEN on that refusal
  // instead of the one it names, and its sibling "no row survives it" would go green too. That
  // is not hypothetical: it is what the own-channel cells did on their first run.
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

  // 6 — the record an OLDER manager wrote. An upgrade restarts the manager against an inventory
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


  // 7 — THE RESUME DOOR. The rule has to hold on every seam that ARMS an acl, not only on spawn.
  //
  // This is a reproduction, not a hypothesis. A resume document is admin-supplied JSON; the managed
  // row is re-armed from it, and `renewManagedStaticCred` re-mints the static credential out of that
  // row at half TTL. So a foreign concrete event channel written into an inventory was a minted read
  // on another agent's tool inputs and outputs one renewal later, past a fence that only ever looked
  // at spawns. Static's retained-authority check pins the credential's PATH, its IDENTITY and the
  // broker's acceptance of it, and nothing about its ACL, so nothing else stopped it.
  {
    const foreign = eventChannel({ owner: DEV_OWNER, actor: "UVICTIMPRINCIPALNOTOURS" });
    const smuggled = JSON.parse(JSON.stringify(preserved)) as ManagerResumeInventory;
    const victimEntry = smuggled.agents[0]!;
    victimEntry.launch.allowSubscribe = [...(victimEntry.launch.allowSubscribe ?? []), foreign];

    // Driven through `resumePreserved`, the real door, rather than through the private validator:
    // the defect was that a door did not call the rule, so calling the rule directly would prove
    // the rule and not the door.
    // A SECOND manager, because that is what a restart is: the instance above is in preserving mode
    // and refuses every resume with "manager is in preserving mode", which is a refusal that would
    // satisfy these cells without the rule existing at all. It did, on the first run.
    const mgr2 = newManager();
    const r = await mgr2.resumePreserved(smuggled);
    const refusal = JSON.stringify(r);
    check(
      "an inventory naming ANOTHER agent's event channel is refused at the resume door",
      /another agent's event channel/.test(refusal),
      refusal.slice(0, 400),
    );
    check("and the refusal names the channel it refused", refusal.includes(foreign), refusal.slice(0, 400));
    check(
      "no row is armed from the smuggled record",
      !(mgr2 as unknown as { agents: Map<string, { launch: { allowSubscribe?: string[] } }> }).agents.has(victimEntry.name) ||
        !((mgr2 as unknown as { agents: Map<string, { launch: { allowSubscribe?: string[] } }> }).agents.get(victimEntry.name)!.launch.allowSubscribe ?? []).includes(foreign),
      [...(mgr2 as unknown as { agents: Map<string, unknown> }).agents.keys()],
    );

    // THE OTHER HALF OF THE SAME DOOR. Both cells above smuggle through `allowSubscribe`, so a
    // resume door that read only the read-set would keep every one of them green while a document
    // could still mint PUBLISH rights onto another agent's plane, which is forgery rather than
    // eavesdropping. The spawn seam has that cell already; the resume seam did not, and the gap was
    // invisible because the mutation that covers the resume door zeroes the WHOLE list at once.
    {
      const mgr3 = newManager();
      const post = JSON.parse(JSON.stringify(preserved)) as ManagerResumeInventory;
      const e3 = post.agents[0]!;
      e3.launch.allowPublish = [...(e3.launch.allowPublish ?? []), foreign];
      const rp = JSON.stringify(await mgr3.resumePreserved(post));
      check(
        "an inventory naming another agent's event channel to POST to is refused at the resume door too",
        /another agent's event channel/.test(rp) && rp.includes(foreign),
        rp.slice(0, 400),
      );
    }

    // THE CONTROL. Every cell above is satisfied by a resume that refuses for any reason at all, and
    // this one refuses easily: the manager is in preserving mode, the names are taken, the broker is
    // shared. So the SAME document without the foreign channel has to reach a DIFFERENT outcome, and
    // the discriminator is the refusal TEXT rather than ok/not-ok, because a legitimate resume here
    // fails for its own unrelated reasons.
    const clean = JSON.parse(JSON.stringify(preserved)) as ManagerResumeInventory;
    const rc = JSON.stringify(await newManager().resumePreserved(clean));
    check(
      "the SAME inventory without the foreign channel is NOT refused by this rule",
      !/another agent's event channel/.test(rc),
      rc.slice(0, 400),
    );
  }

  // 8 - THE ACTOR HALF IS THE PRINCIPAL, and a resume document supplies `name` and
  // `identity.actor` independently. In user mode the row this document re-arms is keyed by
  // `identity.actor`: it is what the provider adopts below, what the incarnation bind reads, and
  // what the minted credential carries. Judging the channel against `name` would judge it against
  // the half that does not own the plane, so a record whose NAME is the victim and whose PRINCIPAL
  // is somebody else would arm the victim's plane for that somebody else.
  //
  // A user-mode entry reaches this rule on a static manager because the rule runs BEFORE the mode
  // check that refuses it. That is exactly why the discriminator here is the refusal TEXT: both
  // arms are refused, and only one of them is refused by this rule.
  {
    const owner = "resumeowner";
    const victimName = "victimseat";
    const build = (withForeign: boolean): ManagerResumeInventory => {
      const inv = JSON.parse(JSON.stringify({ ...preserved, agents: [preserved!.agents[0]] })) as ManagerResumeInventory;
      const e = inv.agents[0]! as unknown as { name: string; identity: unknown; launch: { allowSubscribe?: string[]; allowPublish?: string[] } };
      e.name = victimName;
      // The record was written for a STATIC agent that was armed with its own plane, and rewriting
      // its identity would make that plane foreign too. Strip every event channel first so the one
      // this cell adds is the only difference between the two arms.
      const noEvents = (list?: string[]): string[] | undefined => list?.filter((ch) => !ch.startsWith("events."));
      e.launch.allowSubscribe = noEvents(e.launch.allowSubscribe);
      e.launch.allowPublish = noEvents(e.launch.allowPublish);
      // Its identity files are the REAL retained credential of the static agent this record was
      // copied from: pointing them at invented paths only proves that the reference check runs
      // first, which is not what this cell is about.
      const cred = (preserved!.agents[0]!.identity as unknown as { credential: { path: string; sha256: string } }).credential;
      e.identity = {
        mode: "user",
        owner,
        actor: "attackerseat",
        lifecycleUid: "aaaaaaaa",
        actorToken: { kind: "file", path: cred.path, sha256: cred.sha256 },
        sentinelCredential: { kind: "file", path: cred.path, sha256: cred.sha256 },
        health: { kind: "file", path: cred.path },
      };
      if (withForeign)
        e.launch.allowSubscribe = [...(e.launch.allowSubscribe ?? []), eventChannel({ owner, actor: victimName })];
      return inv;
    };
    const rf = JSON.stringify(await newManager().resumePreserved(build(true)));
    check(
      "a user-mode record whose NAME is the victim and whose PRINCIPAL is not is refused",
      /another agent's event channel/.test(rf),
      rf.slice(0, 400),
    );
    const rc2 = JSON.stringify(await newManager().resumePreserved(build(false)));
    check(
      "the SAME record without that channel is refused for its own reason, not by this rule",
      !/another agent's event channel/.test(rc2),
      rc2.slice(0, 400),
    );
  }

  // ===== 9. THE REMEDY THE REFUSAL NAMES IS THE ONE THAT ACTUALLY NARROWS =====
  //
  // A refusal is only as good as the command it hands the operator, and this one was wrong. The
  // text used to name `--profile observer --allow-subscribe <channel>`; `mint` reads
  // `--allow-subscribe` ONLY for the agent profile, and the observer arm of `permissionsFor`
  // hardcodes `chat.>`. So an operator following the refusal to the letter got a reader of the
  // WHOLE chat plane while believing they had scoped one channel, which is the opposite of what
  // the sentence around it promises. A live mint against a real broker is what found it.
  //
  // This cell is what keeps the sentence and the mint from drifting apart again: it PARSES the
  // profile out of the manager's own refusal string rather than hardcoding one, so rewording the
  // remedy back to a profile that ignores the flag reddens HERE instead of in a terminal.
  {
    // BOTH FIELDS COME OUT OF THE REFUSAL, not just the profile. An engineering lens pointed out
    // that grading the profile while minting the suite's OWN channel leaves the channel field
    // ungraded: a refusal printing `--allow-subscribe events.wrong.wrong` would keep every cell
    // here green, which is the defect this section exists for, one field over. So the mint runs on
    // the channel the refusal PRINTED and the result is compared against the channel the manager
    // actually refused.
    const named = /cotal mint <reader> --profile (\S+) --allow-subscribe (\S+)/.exec(remedyRefusal);
    check("the refusal prints a mint command, naming a profile and a channel", named !== null, remedyRefusal.slice(0, 400));
    const profile = named?.[1] ?? "";
    const printedChannel = named?.[2] ?? "";
    check("the channel it prints is the channel it refused", printedChannel === remedyChannel, { printedChannel, refused: remedyChannel });
    const foreign = printedChannel;
    const credsPath = join(workspaceRoot, "remedy.creds");
    writeFileSync(
      credsPath,
      await mintCreds(auth, newIdentity(), profile as Parameters<typeof mintCreds>[2], {
        allowSubscribe: [foreign],
        lifecycleUid: mintLifecycleUid(),
      }),
    );
    const granted = subAcl(credsPath);
    check(
      "the profile the refusal names mints a reader of EXACTLY that one channel on the chat plane",
      granted.length === 1 && channelOf(granted[0]!) === remedyChannel,
      { profile, granted, refused: remedyChannel },
    );
    // ANY wildcard tail, not the one literal shape the observer arm happens to emit. `subAcl` has
    // already filtered to chat subjects, so a trailing `>` here is a wildcard over some part of the
    // plane whatever its prefix: `<space>.chat.>` and `<space>.chat.*.*.>` both fail this, and only
    // the first would fail an `endsWith(".chat.>")` written against today's observer arm.
    check(
      "and hands out no wildcard over the chat plane",
      granted.every((s) => !s.endsWith(">")),
      { profile, granted },
    );
  }

} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

// A count, because several cells above only run when the spawn before them succeeded: a regression
// that refuses every spawn DELETES them rather than failing them, and the run still prints a verdict.
const EXPECTED = 38;
check(`every cell ran - ${EXPECTED} expected`, cells === EXPECTED + 1, `${cells} cells reported`);

console.log(`\nEVENTS-GRANT/ACL SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
