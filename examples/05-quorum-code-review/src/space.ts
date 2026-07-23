// Local space provisioning: a NATS/JetStream broker plus the three protocol seams the endpoint
// registry needs — a name authority, a per-instance issuance gate (§13.1), and the content-store
// reader — wired to the review contracts. These are the reference stub implementations the core
// smoke tests use; a production space provisions them through the auth/delivery layer instead.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  isReachable,
  openRecordsBucket,
  registerServiceInstance,
  writeServiceStatus,
  authorizeServeGrant,
  SERVICE_READY,
  type ServiceNameAuthority,
  type EpIssuanceBarrier,
  type EpServeGrant,
} from "@cotal-ai/core";
import { REVIEW_ENDPOINT, REVIEW_OWNER, clusterDigest, readClusterArtifact } from "./contracts.js";

const EPOCH = 1;

export interface Broker {
  url: string;
  stop: () => void;
}

/** Start a local nats-server with a big `max_payload` (a full patch rides the request body). */
export async function startBroker(): Promise<Broker> {
  const dir = mkdtempSync(join(tmpdir(), "cotal-review-broker-"));
  const port = 20000 + Math.floor(Math.random() * 40000);
  const conf = join(dir, "nats.conf");
  writeFileSync(
    conf,
    [`port: ${port}`, `host: "127.0.0.1"`, `max_control_line: 65536`, `max_payload: 8388608`, `jetstream { store_dir: "${join(dir, "js")}" }`, ""].join("\n"),
  );
  const child = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  let spawnError: Error | undefined;
  child.on("error", (e) => (spawnError = e));
  const url = `nats://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw new Error(`could not start nats-server (${spawnError.message}); install it: brew install nats-server`);
    if (await isReachable(url)) return { url, stop: () => child.kill("SIGKILL") };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`nats-server did not come up at ${url}`);
}

export async function connectNats(url: string): Promise<NatsConnection> {
  return connect({ servers: url });
}

/** The name authority: `ai.cotal.reviewer` is authorized only for the review owner (§13.9). */
export const reviewAuthority: ServiceNameAuthority = {
  authorize: (name, owner) => ({ authorized: name === REVIEW_ENDPOINT && owner === REVIEW_OWNER, revision: 0 }),
};

// Per-instance §13.1 issuance gate: a faithful freeze -> (spec write) -> reopen writer. Every
// registration serializes on its own (endpoint, instanceId) gate.
const gates = new Map<string, { state: "open" | "frozen" | "retired"; revision: number; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number }>();
function barrierFor(space: string, endpoint: string, instanceId: string): EpIssuanceBarrier {
  const key = `${space}/${endpoint}/${instanceId}`;
  if (!gates.has(key)) gates.set(key, { state: "open", revision: 1, generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0 });
  const g = gates.get(key)!;
  return {
    observe: () => ({ space, endpoint, lifecycleUid: instanceId, principal: `${REVIEW_OWNER}.reviewer`, ...g }),
    freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
    enumerate: () => [],
    revoke: () => {},
    evict: () => true,
    reopen: (token, succ) => {
      if (g.state !== "frozen" || g.revision !== token) return false;
      g.state = "open";
      g.generation = succ.generation;
      g.processEpoch = succ.processEpoch;
      g.registrationRevision = succ.registrationRevision;
      g.nameAuthorityRevision = succ.nameAuthorityRevision;
      g.revision++;
      return true;
    },
  };
}

/** Register one reviewer instance, mark it READY, and authorize its serve grant (§13.2/13.7/13.9).
 *  The returned grant is the ONLY door to serving — it binds the space, owner, epoch, and the full
 *  verified command surface. */
export async function provisionInstance(kv: KV, space: string, instanceId: string): Promise<EpServeGrant> {
  const spec = { endpoint: REVIEW_ENDPOINT, owner: REVIEW_OWNER, clusterDigests: [clusterDigest], protocol: { v: 1 as const } };
  const reg = await registerServiceInstance(kv, {
    space,
    spec,
    instanceId,
    registrant: { owner: REVIEW_OWNER },
    authority: reviewAuthority,
    barrier: barrierFor(space, REVIEW_ENDPOINT, instanceId),
    readClusterArtifact,
  });
  await writeServiceStatus(kv, {
    endpoint: REVIEW_ENDPOINT,
    instanceId,
    epoch: EPOCH,
    readProcessEpoch: () => EPOCH,
    status: { epoch: EPOCH, state: SERVICE_READY, observedSpecRevision: reg.registrationRevision },
  });
  return authorizeServeGrant(kv, {
    space,
    endpoint: REVIEW_ENDPOINT,
    instanceId,
    epoch: EPOCH,
    holder: { owner: REVIEW_OWNER },
    authority: reviewAuthority,
    readProcessEpoch: () => EPOCH,
    readClusterArtifact,
  });
}

export async function openSpaceKv(nc: NatsConnection, space: string): Promise<KV> {
  return openRecordsBucket(nc, space, { create: true });
}

export async function openJsm(nc: NatsConnection): Promise<JetStreamManager> {
  return jetstreamManager(nc);
}
