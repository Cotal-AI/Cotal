/**
 * Persona identity + ACL smoke — proves a manager spawn resolves the persona by FILENAME but takes
 * the mesh IDENTITY from inside the file (`name:`), and mints the file's read/post ACL — never a
 * silent default. Regression guard for the "spawned-by-display-name → default-ACL agent" bug.
 * Broker-backed: closure (i) provisions each spawn through a real short-lived ephemeral provisioner
 * connection (residual-2), so `startAgent` connects before minting — we boot our OWN JWT-auth
 * nats-server (collision-robust — see _boot-broker) + provision the space, run the real spawn path,
 * then DECODE the written creds JWT to read the minted ACL. Run with: pnpm smoke:persona-acl
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import { firstFreeName,
  createSpaceAuth,
  eventChannel,
  registry,
  mintCreds,
  newIdentity,
  principalKey,
  setupSpaceStreams,
  DEV_OWNER,
  type Connector,
  type LaunchSpec,
  type AgentHandle,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";
import { bootBroker } from "./_boot-broker.js";
import { credAcl } from "./_cred-acl.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

/** `ControlReply.data` is `unknown` on the wire, so the identity a reply reports is read through
 *  one narrow view rather than four spot casts. */
const replyName = (r: { data?: unknown }): string | undefined =>
  (r.data as { name?: string } | undefined)?.name;

// A dedicated space + its own JWT-auth broker, so the manager's minted provisioner cred is trusted.
const space = `persona-acl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-persona-acl-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
// Filename (review-critic) ≠ in-file name (socrates); a non-default read/post ACL.
writeFileSync(
  join(agentsDir, "review-critic.md"),
  "---\nname: socrates\nrole: critic\nsubscribe: [review]\nallowSubscribe: [review, review.>]\nallowPublish: [review.>]\n---\nbody\n",
);
// A persona that says nothing about channels: the one the peer door scopes to its spawner.
writeFileSync(join(agentsDir, "helper.md"), "---\nname: helper\nrole: helper\n---\nbody\n");
// A persona that names ONE channel field: it has spoken about channels, so nothing is scoped to
// the spawner, and its post ACL stays the file's default (empty).
writeFileSync(join(agentsDir, "reader.md"), "---\nname: reader\nrole: reader\nsubscribe: [review]\n---\nbody\n");

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth; // real trust material; the broker enforces it

// Fake runtime (records the spec, launches nothing). Only `ref().id` is read from the endpoint on the
// spawn path (the spawner audit id); provisioning runs on the real ephemeral provisioner conn.
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = {
  kind: "fake",
  spawn: (name) => fakeHandle(name),
};
// ref().id (spawner audit) + on/off/getRoster for the #159 B1 readiness race — getRoster reports every
// managed agent as joined so a spawn resolves "started".
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};

const recCon: Connector = { kind: "connector", name: "smoke-rec2", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(recCon);

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // 1 — Spawn by FILENAME; identity comes from the file's name:, ACL from the file (not default).
  {
    const reply = await mgr.startAgent({ name: "review-critic", agent: "smoke-rec2", events: false });
    check("spawn by filename succeeds", reply.ok === true, reply);
    check("identity is the file's name: (socrates), not the filename", reply.ok && replyName(reply) === "socrates", reply.ok && replyName(reply));

    // Lifecycle-keyed cred file (`<name>.<uid>.creds`) — the reply's uid names this incarnation's file.
    const socratesUid = reply.ok ? String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "") : "";
    const acl = credAcl(agentLifecycleSecretFilePaths(workspaceRoot, space, "socrates", socratesUid).creds);
    check("read ACL is the persona's review scope", acl.sub.some((s) => s.endsWith(".review")) && acl.sub.some((s) => s.endsWith(".review.>")), acl.sub);
    check("post ACL is the persona's review.> (not default-deny)", acl.pub.some((s) => s.includes(".review.>")), acl.pub);
    check("NOT the silent default (general-only read)", !(acl.sub.length === 1 && acl.sub[0].endsWith(".general")), acl.sub);
  }

  // 2 — Spawning by the DISPLAY name (socrates) fails loud — there is no socrates.md; you spawn by file.
  {
    const reply = await mgr.startAgent({ name: "socrates", agent: "smoke-rec2", events: false });
    check("spawn by display-name fails loud (no socrates.md)", reply.ok === false && /no persona "socrates"/.test(reply.error ?? ""), reply);
  }

  // 3 — A second spawn of the same persona auto-numbers the IDENTITY. The expected name is
  //     DERIVED from the shipped allocator, never spelled: this cell hard-coded the separator and
  //     was the SIXTH place to do so, each in a different syntactic form, each invisible to the
  //     search aimed at the previous one.
  {
    const reply = await mgr.startAgent({ name: "review-critic", agent: "smoke-rec2", events: false });
    const expectSocrates = firstFreeName("socrates", (n) => n === "socrates");
  check(`control: the derived numbered identity differs from the base (${expectSocrates})`,
    expectSocrates !== "socrates" && expectSocrates.startsWith("socrates"), expectSocrates);
  check("second spawn auto-numbers the identity", reply.ok && replyName(reply) === expectSocrates, reply.ok && replyName(reply));
  }

  const launchOf = (name: string) =>
    [...(mgr as unknown as { agents: Map<string, { name: string; launch: { subscribe?: string[] } }> }).agents.values()].find((a) => a.name === name)?.launch;
  // A refused spawn minted nothing: an empty ACL keeps the cells after it red instead of throwing
  // on a blank lifecycle uid, so the suite still prints its marker.
  const aclOf = (reply: { ok: boolean; data?: unknown }, name: string) =>
    reply.ok
      ? credAcl(agentLifecycleSecretFilePaths(workspaceRoot, space, name, String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "")).creds)
      : { sub: [] as string[], pub: [] as string[] };
  const spawnerEvents = eventChannel({ owner: DEV_OWNER, actor: "alice" });

  // 4 — A persona that names no channel is scoped to its spawner's ACL (`callerAcl`), joins what
  //     `join` names and nothing else, and never inherits the spawner's event channel.
  {
    const callerAcl = { allowSubscribe: ["general", "review", spawnerEvents], allowPublish: ["general", spawnerEvents] };
    // An event channel that reaches the grant makes the accept body THROW (it asks for another
    // agent's event plane); caught here so a wrong grant reads as a red cell, not a dead suite.
    const reply = await mgr.startAgent({ name: "helper", agent: "smoke-rec2", events: false, callerAcl, join: ["review"] })
      .catch((e: unknown) => ({ ok: false as const, error: (e as Error).message }));
    check("a channel-less persona spawns under its spawner's ACL", reply.ok === true, reply);
    const acl = aclOf(reply, "helper");
    check("read ACL is the spawner's (general, review)", acl.sub.some((s) => s.endsWith(".general")) && acl.sub.some((s) => s.endsWith(".review")), acl.sub);
    check("post ACL is the spawner's (general)", acl.pub.some((s) => s.endsWith(".general")), acl.pub);
    check("the spawner's event channel is not inherited", ![...acl.sub, ...acl.pub].some((s) => s.includes(spawnerEvents)), acl);
    check("the seat joins only what join named", JSON.stringify(launchOf("helper")?.subscribe) === JSON.stringify(["review"]), launchOf("helper")?.subscribe);
  }

  // 5 — A persona that names channels is the authority: callerAcl is ignored, not merged.
  {
    const reply = await mgr.startAgent({ name: "review-critic", agent: "smoke-rec2", events: false, callerAcl: { allowSubscribe: ["general"], allowPublish: ["general"] } });
    check("a persona with channels still spawns when callerAcl rides along", reply.ok === true, reply);
    const acl = aclOf(reply, replyName(reply) ?? "");
    check("its ACL is the persona's, with nothing of the spawner's in it", acl.sub.some((s) => s.endsWith(".review")) && ![...acl.sub, ...acl.pub].some((s) => s.endsWith(".general")), acl);
  }

  // 5b — Naming any one channel field is speaking about channels: a persona with only `subscribe`
  //      keeps its empty post ACL even when the spawner's callerAcl would have granted one.
  {
    const reply = await mgr.startAgent({ name: "reader", agent: "smoke-rec2", events: false, callerAcl: { allowSubscribe: ["general", "review"], allowPublish: ["general", "review"] } });
    check("a persona naming only subscribe spawns when callerAcl rides along", reply.ok === true, reply);
    const acl = aclOf(reply, replyName(reply) ?? "");
    check("a persona naming only subscribe keeps its empty post ACL despite callerAcl", acl.sub.some((s) => s.endsWith(".review")) && acl.pub.length === 0 && !acl.sub.some((s) => s.endsWith(".general")), acl);
  }

  // 6 — `join` outside the resolved read ACL refuses; nothing widens.
  {
    const reply = await mgr.startAgent({ name: "helper", agent: "smoke-rec2", events: false, callerAcl: { allowSubscribe: ["general"], allowPublish: [] }, join: ["ops"] });
    check("a join outside the scoped read ACL is refused", reply.ok === false && /subscribe "ops" is not within allowSubscribe/.test(reply.error ?? ""), reply);
  }

  // 7 — Without callerAcl (the operator CLI path) a channel-less persona keeps the empty grant.
  {
    const reply = await mgr.startAgent({ name: "helper", agent: "smoke-rec2", events: false });
    check("a channel-less persona without callerAcl spawns", reply.ok === true, reply);
    const acl = aclOf(reply, replyName(reply) ?? "");
    check("and its chat ACL stays empty (no silent default)", acl.sub.length === 0 && acl.pub.length === 0, acl);
  }
} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(`\nPERSONA-IDENTITY/ACL SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
