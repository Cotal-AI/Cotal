/**
 * LIFECYCLE FILE-OWNERSHIP + ROSTER-ALLOCATION smoke (control-surface P2 slice 1, Unit A) — proves
 * by EXECUTION the two teardown/allocation defects the freeSlot split closes, at the manager unit
 * level (real JWT broker + real static-auth provisioning through the ephemeral provisioner; fake
 * runtime records the spec and launches nothing, same harness shape as persona-identity-acl).
 *
 * #2 LIFECYCLE-OWNED FILES. A manager-provisioned incarnation's secret family embeds its
 *    lifecycleUid (`<name>-<uid>.creds`), and teardown consumes ONLY the recorded/uid-derived
 *    paths. So a stale/replayed teardown for a RETIRED incarnation:
 *      - deletes exactly its own uid's file, and
 *      - can NOT reach a same-alias SUCCESSOR's file (a different uid), nor a name-keyed operator
 *        credential it holds no record of (the seeded `<name>.creds` near-miss).
 *
 * #4 ADVISORY ALLOCATION. `uniqueName` consults the LIVE presence roster (status !== "offline"),
 *    so a spawn against a name a live UNMANAGED peer already holds auto-numbers (foo -> foo-2)
 *    instead of minting a doomed sibling the broker refuses (the 30s launch-uncertain black hole).
 *    An OFFLINE row never occupies — a properly retired name stays reusable.
 *
 * Run: pnpm smoke:lifecycle-files   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
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
  type Presence,
} from "@cotal-ai/core";
import { agentCredsKey, agentSecretFilePaths, workspaceSecretStore } from "@cotal-ai/workspace";
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra) ?? ""}`}`);
  if (!cond) failures++;
}

const space = `lifecycle-files-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-lifecycle-files-ws-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
writeFileSync(
  join(agentsDir, "worker.md"),
  "---\nname: worker\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n",
);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { auth: unknown }).auth = auth;

// A settable synthetic roster: the manager reports its own managed agents as joined (so a spawn
// resolves "started"), PLUS whatever extra presence rows the test injects to model live/offline
// UNMANAGED peers for the #4 allocation check.
let extraRoster: Presence[] = [];
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: (): Presence[] => [
    ...[...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map(
      (a): Presence => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name, role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: a.lifecycleUid, ts: 0 }),
    ),
    ...extraRoster,
  ],
};

const con: Connector = { kind: "connector", name: "smoke-lf", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(con);

const credsDir = join(workspaceRoot, ".cotal", "auth", "creds");
const store = workspaceSecretStore(workspaceRoot);

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ── #2: lifecycle-keyed credential file ────────────────────────────────────
  const spawnA = await mgr.startAgent({ name: "worker", agent: "smoke-lf" });
  check("spawn A succeeds", spawnA.ok === true, spawnA);
  const uidA = spawnA.ok ? (spawnA.data as { lifecycleUid?: string }).lifecycleUid : undefined;
  check("spawn A reply carries a lifecycleUid", typeof uidA === "string" && /^[a-z0-9]{26,32}$/.test(uidA ?? ""), uidA);
  const credsA = join(credsDir, `worker-${uidA}.creds`);
  check("A's creds file is LIFECYCLE-KEYED (<name>-<uid>.creds), not <name>.creds", existsSync(credsA) && !existsSync(join(credsDir, "worker.creds")), { credsA, exists: existsSync(credsA), legacy: existsSync(join(credsDir, "worker.creds")) });

  // Model a same-alias SUCCESSOR (a different incarnation) and a seeded name-keyed OPERATOR cred —
  // neither of which the retired A's teardown holds any record of.
  const uidB = "b" + randomUUID().replace(/-/g, "").slice(0, 30);
  const credsB = join(credsDir, `worker-${uidB}.creds`);
  const legacyOperatorCred = join(credsDir, "worker.creds");
  await store.put(`auth/creds/worker-${uidB}.creds`, "SUCCESSOR-B-CREDENTIAL");
  writeFileSync(credsB, "SUCCESSOR-B-CREDENTIAL");
  await store.put(agentCredsKey("worker"), "OPERATOR-STANDING-CREDENTIAL");
  writeFileSync(legacyOperatorCred, "OPERATOR-STANDING-CREDENTIAL");

  // Replay A's TERMINAL teardown (the detached deprovision, targeted at A's retired incarnation).
  await (mgr as unknown as { deprovision: (a: { id: string; name: string; lifecycleUid: string; secretPaths?: { creds?: string } }) => Promise<void> }).deprovision({
    id: spawnA.ok ? (spawnA.data as { id: string }).id : "",
    name: "worker",
    lifecycleUid: uidA!,
    secretPaths: { creds: credsA },
  });

  check("A's own creds file was torn down", !existsSync(credsA));
  check("SUCCESSOR B's creds file SURVIVED the replayed A teardown", existsSync(credsB) === true);
  check("SUCCESSOR B's store row SURVIVED", (await store.get(`auth/creds/worker-${uidB}.creds`)) === "SUCCESSOR-B-CREDENTIAL");
  check("seeded name-keyed OPERATOR cred SURVIVED (uid teardown holds no record of it)", existsSync(legacyOperatorCred) && (await store.get(agentCredsKey("worker"))) === "OPERATOR-STANDING-CREDENTIAL", { file: existsSync(legacyOperatorCred) });

  // ── #4: roster-consulting allocation ───────────────────────────────────────
  // A LIVE unmanaged peer already holds "solo" → the next spawn of that persona must auto-number.
  writeFileSync(join(agentsDir, "solo.md"), "---\nname: solo\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n");
  extraRoster = [{ card: { id: principalKey(DEV_OWNER, newIdentity().id).key, name: "solo", role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: undefined, ts: 0 }];
  const spawnLive = await mgr.startAgent({ name: "solo", agent: "smoke-lf" });
  check("spawn against a LIVE unmanaged same-name peer auto-numbers (solo -> solo-2)", spawnLive.ok && (spawnLive.data as { name: string }).name === "solo-2", spawnLive.ok && (spawnLive.data as { name: string }).name);

  // An OFFLINE row never occupies — a retired name stays reusable.
  writeFileSync(join(agentsDir, "reuse.md"), "---\nname: reuse\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n");
  extraRoster = [{ card: { id: principalKey(DEV_OWNER, newIdentity().id).key, name: "reuse", role: "worker", kind: "agent", description: "", tags: [] }, status: "offline", lifecycleUid: undefined, ts: 0 }];
  const spawnReuse = await mgr.startAgent({ name: "reuse", agent: "smoke-lf" });
  check("an OFFLINE same-name row does NOT block reuse (reuse stays reuse)", spawnReuse.ok && (spawnReuse.data as { name: string }).name === "reuse", spawnReuse.ok && (spawnReuse.data as { name: string }).name);

  // Sanity: the legacy name-keyed builders still resolve for standing operator secrets.
  check("legacy name-keyed path builder is intact for operator secrets", basename(agentSecretFilePaths(workspaceRoot, "worker").creds) === "worker.creds");
} finally {
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(`\nLIFECYCLE FILE-OWNERSHIP SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
