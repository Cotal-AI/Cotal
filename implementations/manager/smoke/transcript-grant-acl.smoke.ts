/**
 * Auth-mode transcript-grant smoke — proves the manager grants an agent publish rights on its OWN
 * transcript channel (whatever the resolved connector's `eventChannel(name)` returns) when
 * transcript mirroring is enabled, scopes the grant to exactly that channel, and FAILS LOUD when
 * transcript is requested for a connector that doesn't mirror. This catches manager-grant ↔
 * connector-publish-channel drift at the cred/ACL layer — which typecheck can't, since the manager now
 * sources the channel through the optional `Connector.eventChannel` contract method.
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

// The exact `tr-<name>` sanitizer the real connectors use (connector-core); the manager grants whatever
// the connector returns, so a mirroring connector hands back this and a non-mirroring one omits the method.
const tr = (n: string): string => `tr-${n.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
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
    check("auth-mode grant includes the connector's event channel (events.mirrorbot)", pub.some((s) => s.includes(".events.mirrorbot")), pub);
    check("the granted channel is the connector's eventChannel, no drift", pub.some((s) => s.includes(`.${tr("mirrorbot")}`)), pub);
  }

  // 2 — transcript OFF: no transcript channel is granted (only the persona's own post ACL).
  {
    const reply = await mgr.startAgent({ name: "mirror-bot", agent: "smoke-mirror" }); // auto-numbered → mirrorbot-2
    check("spawn without events succeeds", reply.ok === true && reply.data?.name === "mirrorbot-2", reply);
    const uid = reply.ok ? String((reply.data as { lifecycleUid?: string }).lifecycleUid ?? "") : "";
    const pub = pubAcl(join(credsDir, `mirrorbot-2.${uid}.creds`));
    // Check the CHANNEL segment (after `.chat.<id>.`), not the whole subject — else the space name
    // itself (here `tr-grant-…`) would false-match `.tr-`.
    check("no event channel granted when events is off", !pub.some((s) => (s.split(".chat.")[1] ?? "").includes(".events.")), pub);
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
