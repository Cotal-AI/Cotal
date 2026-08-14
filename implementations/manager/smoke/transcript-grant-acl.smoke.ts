/**
 * Auth-mode event-grant smoke — proves the manager grants an agent publish rights on its OWN event
 * channel (whatever the resolved connector's `eventChannel(principal)` returns) when events are
 * enabled, scopes the grant to exactly that channel, and FAILS LOUD when events are requested for a
 * connector that cannot emit. This catches manager-grant ↔ connector-publish-channel drift at the
 * cred/ACL layer — which typecheck can't, since the manager sources the channel through the optional
 * `Connector.eventChannel` contract method.
 *
 * IT ALSO GRADES THE ORDERING, which is the half a string comparison cannot reach. The channel keys
 * on the agent's PRINCIPAL, and in static mode the actor half is an nkey that does not exist until
 * `newIdentity()` runs inside the spawn. So a grant naming the minted id is proof that the
 * derivation happens AFTER the mint; a grant naming the display name is proof it does not. The
 * derivation used to sit at accept, before any identity existed, which is exactly why it keyed on
 * the name and fused distinct principals onto one channel.
 *
 * Broker-backed: closure (i) provisions each spawn through a short-lived EPHEMERAL provisioner
 * connection (residual-2 — the DM/DLV consumer-create surface lives only for the spawn window, never as
 * a standing supervisor grant), so `startAgent` connects for real before minting. We boot our OWN
 * JWT-auth nats-server (collision-robust — see _boot-broker) + provision the space, let the real spawn
 * path run end to end, then DECODE the written creds JWT to read the minted publish ACL.
 * Run with: pnpm smoke:transcript-grant
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/manager.js";
import {
  createSpaceAuth,
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
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// The chat-publish subjects allowed by a minted creds file (decode the JWT's nats.pub.allow).
function pubAcl(path: string): string[] {
  const jwt = readFileSync(path, "utf8").split("\n").find((l) => l && !l.startsWith("-") && l.split(".").length === 3)!;
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return ((claims.nats?.pub?.allow as string[] | undefined) ?? []).filter((s) => s.includes(".chat.") && !s.startsWith("$JS"));
}

// A dedicated space + its own JWT-auth broker, so the manager's minted provisioner cred is trusted.
const space = `tr-grant-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-transcript-grant-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
// A persona with a known non-transcript post ACL, so we can tell the transcript grant apart from it.
writeFileSync(
  join(agentsDir, "mirror-bot.md"),
  "---\nname: mirrorbot\nrole: worker\nsubscribe: [work]\nallowSubscribe: [work]\nallowPublish: [work]\n---\nbody\n",
);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth; // real trust material; the broker enforces it

const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
// The spawn path reads `ref().id` (spawner audit id) plus, for the #159 B1 readiness race, `on`/`off`/
// `getRoster` — the fake reports every managed agent as joined so a spawn resolves "started". Provisioning
// runs on the real ephemeral provisioner conn (withProvisioner), not this endpoint.
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  // A real presence record carries the incarnation's lifecycleUid (SPEC 13.1/§6); the manager's
  // readiness fence requires it to equal the minted uid, so the fake roster must carry it too.
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid })),
};

// The same mapping the real connectors expose (connector-core's `eventChannel`): the manager grants
// whatever the connector returns, so an emitting connector hands back this and a non-emitting one
// omits the method. Takes the PRINCIPAL — a name-keyed stub would not satisfy the contract type.
const tr = (p: { owner: string; actor: string }): string => `events.${p.owner}.${p.actor}`;
const base = { kind: "connector" as const, requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: "true", args: [], env: {} }) };
registry.register({ ...base, name: "smoke-mirror", eventChannel: tr } satisfies Connector);
registry.register({ ...base, name: "smoke-nomirror" } satisfies Connector); // no eventChannel → doesn't mirror

const credsDir = join(workspaceRoot, ".cotal", "auth", "creds");

try {
  // `cotal up` pre-creates the streams + buckets the ephemeral provisioner then binds/writes against.
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // 1 — transcript ON + a mirroring connector: the agent is granted pub on its OWN tr-<name>.
  {
    const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-mirror", events: true });
    check("spawn with events succeeds", reply.ok === true, reply);
    const uid = reply.ok ? String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "") : "";
    const pub = pubAcl(join(credsDir, `mirrorbot.${uid}.creds`));
    // The nkey the spawn minted for this agent — the actor half of its principal, unknowable before
    // the spawn ran, which is what makes the next cell an ordering proof rather than a spelling one.
    const minted = (mgr as unknown as { agents: Map<string, { id: string }> }).agents.get("mirrorbot")!.id;
    const want = tr({ owner: DEV_OWNER, actor: minted });
    check("auth-mode grant is EXACTLY what the connector's eventChannel returns, no drift",
      pub.some((s) => s.endsWith(`.${want}`)), [pub, want]);
    // THE ANTI-FALLBACK CELL, at the real entry point. If the derivation ever reverts to the display
    // name — including as a fallback for some mode — the minted credential says so here, at the
    // authority that enforces it, rather than in a unit that builds its own inputs.
    check("the grant names the MINTED PRINCIPAL and the display name appears NOWHERE in it",
      !pub.some((s) => (s.split(".chat.")[1] ?? "").includes("mirrorbot")), pub);
  }

  // 2 — transcript OFF: no transcript channel is granted (only the persona's own post ACL).
  {
    const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-mirror" }); // auto-numbered → mirrorbot-2
    check("spawn without events succeeds", reply.ok === true && reply.data?.name === "mirrorbot-2", reply);
    const uid = reply.ok ? String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "") : "";
    const pub = pubAcl(join(credsDir, `mirrorbot-2.${uid}.creds`));
    // Check the CHANNEL segment (after `.chat.<owner>.<actor>.`), not the whole subject.
    check("no event channel granted when events is off", !pub.some((s) => (s.split(".chat.")[1] ?? "").includes("events.")), pub);
  }

  // 3 — transcript ON + a connector that does NOT mirror: fail loud, never a silently-skipped grant.
  {
    const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-nomirror", events: true });
    check("events on a non-emitting connector fails loud", reply.ok === false && /does not support event publishing/.test(reply.error ?? ""), reply);
  }
} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(`\nTRANSCRIPT-GRANT/ACL SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
