/**
 * LIVE conservation across a `down --preserve-state` cut, and a restored mesh that actually works.
 *
 *  1. CONSERVATION / NO CURSOR MOVEMENT — an auth mesh carrying REAL Plane-3 state (a durable channel
 *     member with a pending CHAT -> INBOX -> DLV handoff, and a TASK role durable with one acked and
 *     one unresolved item) is cut and backed up. Neither the cut nor the backup that claims it moves
 *     a consumer cursor: every checkpoint floor in the artifact equals the floor read from the LIVE
 *     broker before the cut, the artifact carries exactly the pre-cut durable set, every stream
 *     conserves its message count and sequence frontier, and after an ordinary `up` both unacked
 *     pre-cut items replay (at-least-once) while the acked one stays gone.
 *  2. FIRST POST-RESTORE CHAT + PENDING INBOX AUTHORIZATION — `up --restore` of a full artifact
 *     yields a mesh that WORKS: the member's pre-cut pending entry is still delivered under its
 *     preserved authorization, and a first NEW post reaches it over a Plane-3 path rebuilt entirely
 *     from checkpoints (fan-out -> dinbox -> re-auth against the restored ACL/MEMBERS -> DLV).
 *
 * The pre-cut sample is read through the same least-privilege `backup`/`inspect` credential, over the
 * same STREAM.INFO + CONSUMER.LIST verbs, that `backup create` uses on its clone — so the sample and
 * the artifact are directly comparable. Sampling waits for the delivery daemon to drain first: the
 * contract promises conservation, not equality with a racy mid-handoff read.
 *
 * Run: pnpm smoke:backup-conservation:live   (needs `nats-server` on PATH; local-only, temp roots)
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  DEV_OWNER,
  FANOUT_DURABLE,
  INBOX_READER_DURABLE,
  chatStream,
  dlvDurable,
  dlvStream,
  dmDurable,
  dmStream,
  inboxStream,
  mintCreds,
  newIdentity,
  provisionAgent,
  spaceBackupInventory,
  standaloneConnectOpts,
  taskDurable,
  taskStream,
  type CotalMessage,
  type Delivery,
  type Identity,
  type MessageMeta,
  type SpaceAuth,
} from "@cotal-ai/core";
import { authDir, loadSoleSpaceAuth } from "@cotal-ai/workspace";

const freePort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  opts?: { timeoutMs?: number; detail?: () => string },
) => {
  const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${label}${opts?.detail?.() ?? ""}`);
};

const worktree = resolve(import.meta.dirname, "..", "..");
const cliPath = join(worktree, "bin", "cotal.ts");
const tsx = join(worktree, "node_modules", ".bin", "tsx");

/** The seeded durable-class channel and the member's role (its TASK work queue). */
const CHANNEL = "ops";
const ROLE = "reviewer";
/** Posted while the member is offline: the pending INBOX -> DLV handoff it still owes. */
const PENDING_POST = "pending-handoff";
/** Posted only after a restore, to prove the rebuilt Plane-3 path actually carries new traffic. */
const POST_RESTORE_POST = "post-restore-post";
/** Two anycast items: the member acks the first, the second is queued while it is offline. */
const TASK_ACKED = "task-acked";
const TASK_UNRESOLVED = "task-unresolved";

// ---- mesh harness ---------------------------------------------------------

interface Mesh {
  root: string;
  home: string;
  server: string;
  space: string;
  run(...args: string[]): SpawnSyncReturns<string>;
  must(label: string, result: SpawnSyncReturns<string>): void;
  journal(): { state: string; restore?: { attemptId: string } };
}

async function openMesh(label: string, space: string): Promise<Mesh> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-${label}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-${label}-home-`)));
  const server = `nats://127.0.0.1:${await freePort()}`;
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) =>
    spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  return {
    root, home, server, space, run,
    must: (name, result) => {
      assert.equal(result.status, 0, `${label} ${name}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    },
    journal: () => JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")),
  };
}

// ---- the live pre-cut sampler ---------------------------------------------

interface StreamState { messages: number; first_seq: number; last_seq: number }
interface ConsumerState { ackFloor: number; pending: number }

interface SpaceSample {
  streams: Record<string, StreamState>;
  /** `<stream>/<durable>` -> that durable's cursor state. */
  consumers: Record<string, ConsumerState>;
}

interface RawConsumer {
  name: string;
  ack_floor: { stream_seq: number };
  num_pending: number;
}

const jsRequest = async <T>(nc: NatsConnection, subject: string, body: unknown): Promise<T> => {
  const reply = await nc.request(subject, JSON.stringify(body), { timeout: 10_000 });
  const response = JSON.parse(reply.string()) as T & { error?: { description?: string } };
  if (response.error) throw new Error(response.error.description ?? `JetStream request failed: ${subject}`);
  return response;
};

interface Sampler {
  read(): Promise<SpaceSample>;
  close(): Promise<void>;
}

/** A read-only view of the live space through the exact credential `backup create` inspects with:
 *  STREAM.INFO + CONSUMER.LIST over the eight backed-up streams and nothing else — no body read, no
 *  mutation verb, no consumer of its own to perturb what it measures. */
async function openSampler(mesh: Mesh, auth: SpaceAuth): Promise<Sampler> {
  const creds = await mintCreds(auth, newIdentity(), "backup", {
    backup: { operation: "inspect", selection: "full" },
  });
  const nc = await connect({ servers: mesh.server, ...standaloneConnectOpts({ creds, tls: false }) });
  return {
    close: async () => { await nc.drain().catch(() => {}); },
    read: async () => {
      const streams: Record<string, StreamState> = {};
      const consumers: Record<string, ConsumerState> = {};
      for (const stream of spaceBackupInventory(mesh.space).full) {
        const { state } = await jsRequest<{ state: StreamState }>(nc, `$JS.API.STREAM.INFO.${stream}`, {});
        streams[stream] = { messages: state.messages, first_seq: state.first_seq, last_seq: state.last_seq };
        for (let offset = 0;;) {
          const page = await jsRequest<{ consumers?: RawConsumer[]; total: number; offset: number }>(
            nc, `$JS.API.CONSUMER.LIST.${stream}`, { offset },
          );
          for (const c of page.consumers ?? [])
            consumers[`${stream}/${c.name}`] = { ackFloor: c.ack_floor.stream_seq, pending: c.num_pending };
          const next = page.offset + (page.consumers?.length ?? 0);
          if (next >= page.total) break;
          if (next <= offset) throw new Error(`consumer pagination stalled on ${stream}`);
          offset = next;
        }
      }
      return { streams, consumers };
    },
  };
}

/** The delivery daemon has drained: the fan-out consumed every CHAT post and the trusted reader
 *  transferred and acked every dinbox entry. Only past this point is a cursor sample stable — before
 *  it, a moved floor is the handoff finishing, not the cut misbehaving. */
const daemonDrained = (sample: SpaceSample, space: string): boolean =>
  sample.consumers[`${chatStream(space)}/${FANOUT_DURABLE}`]?.ackFloor === sample.streams[chatStream(space)]?.last_seq &&
  sample.consumers[`${inboxStream(space)}/${INBOX_READER_DURABLE}`]?.ackFloor === sample.streams[inboxStream(space)]?.last_seq;

// ---- the member -----------------------------------------------------------

/** A message as the member saw it. `durable` separates the Plane-3 backstop copy (a real JetStream
 *  ack) from the live core-sub / history copy (whose ack is a no-op). */
interface Received {
  text: string;
  kind: MessageMeta["kind"];
  durable: boolean;
}

interface Member {
  endpoint: CotalEndpoint;
  seen: Received[];
  saw(text: string, opts?: { durable?: boolean }): boolean;
  report(): string;
}

/** A durable channel member that is also the role's TASK worker. It acks only what it is told to, so
 *  the cut inherits genuinely unresolved work instead of a drained mesh. */
function memberEndpoint(mesh: Mesh, identity: Identity, creds: string, ackable: Set<string>): Member {
  const seen: Received[] = [];
  const errors: string[] = [];
  const endpoint = new CotalEndpoint({
    space: mesh.space,
    servers: mesh.server,
    creds,
    card: { id: identity.id, name: "member", role: ROLE, kind: "agent" },
    channels: [CHANNEL],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  endpoint.on("error", (e: Error) => errors.push(e.message));
  endpoint.on("message", (m: CotalMessage, d: Delivery, meta: MessageMeta) => {
    const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    seen.push({ text, kind: meta.kind, durable: d.durable });
    if (ackable.has(text)) d.ack();
  });
  return {
    endpoint,
    seen,
    saw: (text, opts) =>
      seen.some((r) => r.text === text && (opts?.durable === undefined || r.durable === opts.durable)),
    report: () => `\nseen: ${JSON.stringify(seen)}\nerrors: ${JSON.stringify(errors)}`,
  };
}

/** Provision the member, establish its durable membership, let it resolve exactly one TASK item, then
 *  take it offline and queue work it still owes. Leaves the mesh with one pending INBOX -> DLV handoff
 *  and one unresolved TASK item, neither ever delivered — so a post-cut replay is immediate and the
 *  test never has to wait out a 60s canonical ack_wait to observe at-least-once. */
async function seedPlane3State(mesh: Mesh, auth: SpaceAuth, sampler: Sampler): Promise<{ identity: Identity; creds: string }> {
  const provisioner = new CotalEndpoint({
    space: mesh.space,
    servers: mesh.server,
    creds: await mintCreds(auth, newIdentity(), "provisioner"),
    card: { name: "provisioner", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  provisioner.on("error", () => {});
  await provisioner.start();
  const identity = newIdentity();
  let creds: string;
  try {
    // Pre-creates the member's bind-only DM/DLV durables, records the read ACL the delivery daemon
    // re-authorizes every durable entry against, and ensures the role's TASK queue.
    creds = await provisionAgent(provisioner, auth, identity, {
      subscribe: [CHANNEL], allowSubscribe: [CHANNEL], allowPublish: [CHANNEL], role: ROLE,
    });
  } finally {
    await provisioner.stop();
  }

  const poster = new CotalEndpoint({
    space: mesh.space,
    servers: mesh.server,
    creds: await mintCreds(auth, newIdentity(), "operator"),
    card: { name: "poster", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  poster.on("error", () => {});
  await poster.start();

  const member = memberEndpoint(mesh, identity, creds, new Set([TASK_ACKED]));
  try {
    await member.endpoint.start();
    // The self-join at connect arms the Plane-3 backstop for the durable-class boot channel; without
    // it the posts below would never reach dinbox and the whole scenario would pass vacuously.
    await waitUntil(() => member.endpoint.hasDurableMembership(CHANNEL), "member durable membership", {
      detail: member.report,
    });
    await poster.anycast(ROLE, TASK_ACKED);
    await waitUntil(() => member.saw(TASK_ACKED), "the member resolves one TASK item", { detail: member.report });
    await waitUntil(
      async () => (await sampler.read()).consumers[`${taskStream(mesh.space)}/${taskDurable(ROLE)}`]?.ackFloor === 1,
      "the resolved TASK item advances the durable's ACK floor",
    );
  } finally {
    await member.endpoint.stop();
  }

  try {
    // Offline member: both posts land as work it still owes, delivered to nobody.
    await poster.multicast(PENDING_POST, { channel: CHANNEL });
    await poster.anycast(ROLE, TASK_UNRESOLVED);
  } finally {
    await poster.stop();
  }
  return { identity, creds };
}

/** Wait for the seeded state to settle into exactly the shape the scenarios assert on, and return
 *  that stable pre-cut sample. */
async function stablePreCutSample(mesh: Mesh, sampler: Sampler, identity: Identity): Promise<SpaceSample> {
  const dlvKey = `${dlvStream(mesh.space)}/${dlvDurable(DEV_OWNER, identity.id)}`;
  const taskKey = `${taskStream(mesh.space)}/${taskDurable(ROLE)}`;
  let sample!: SpaceSample;
  await waitUntil(
    async () => {
      sample = await sampler.read();
      return daemonDrained(sample, mesh.space) &&
        sample.consumers[dlvKey]?.pending === 1 &&
        sample.consumers[taskKey]?.pending === 1;
    },
    "the delivery daemon to drain into a stable pre-cut state",
    { detail: () => `\nsample: ${JSON.stringify(sample)}` },
  );
  // Fail loud if the seeding went vacuous: an all-zero-floor mesh would satisfy every conservation
  // assertion below without exercising a single cursor.
  assert.equal(sample.consumers[dlvKey]?.ackFloor, 0, "the member's handoff is pending and unacked at the cut");
  assert.equal(sample.consumers[taskKey]?.ackFloor, 1, "the resolved TASK item left a non-zero ACK floor at the cut");
  assert.ok(
    sample.consumers[`${chatStream(mesh.space)}/${FANOUT_DURABLE}`].ackFloor >= 1,
    "the fan-out carries a non-zero floor: real CHAT traffic crossed the cut",
  );
  assert.ok(
    sample.consumers[`${inboxStream(mesh.space)}/${INBOX_READER_DURABLE}`].ackFloor >= 1,
    "the trusted reader carries a non-zero floor: a real INBOX -> DLV handoff crossed the cut",
  );
  return sample;
}

interface Checkpoint {
  stream: string;
  name: string;
  ackFloorStreamSequence: number;
  streamState: StreamState;
}

interface Manifest {
  streams: Array<{ stream: string; state: StreamState }>;
}

// ---- scenario 1: conservation / no cursor movement ------------------------

async function conservationScenario(): Promise<void> {
  const mesh = await openMesh("backup-conservation", "backup_conservation");
  const { run, must } = mesh;
  const artifact = join(mesh.root, "full-backup");
  try {
    must("up", run("up", "--detach", "--server", mesh.server, "--space", mesh.space));
    must("seed registry", run("channels", "set", CHANNEL, "--desc", "conserved", "--space", mesh.space));
    const auth = loadSoleSpaceAuth(authDir(mesh.root));
    assert.ok(auth, "an auth mesh retains its SpaceAuth");

    const sampler = await openSampler(mesh, auth);
    let preCut: SpaceSample;
    let identity: Identity;
    let creds: string;
    try {
      ({ identity, creds } = await seedPlane3State(mesh, auth, sampler));
      preCut = await stablePreCutSample(mesh, sampler, identity);
    } finally {
      await sampler.close();
    }

    must("preserve cut", run("down", "--preserve-state"));
    assert.equal(mesh.journal().state, "ready");
    must("full backup", run("backup", "create", artifact));

    // No cursor moved after the marker: every floor in the artifact is the floor the live broker
    // reported before the cut, and the artifact carries exactly the pre-cut durable set.
    const checkpoints = JSON.parse(readFileSync(join(artifact, "checkpoints.json"), "utf8")) as Checkpoint[];
    for (const checkpoint of checkpoints) {
      const live = preCut.consumers[`${checkpoint.stream}/${checkpoint.name}`];
      assert.ok(live, `${checkpoint.stream}/${checkpoint.name} existed before the cut`);
      assert.equal(
        checkpoint.ackFloorStreamSequence, live.ackFloor,
        `${checkpoint.stream}/${checkpoint.name} ACK floor did not move across the cut`,
      );
    }
    assert.deepEqual(
      checkpoints.map((c) => `${c.stream}/${c.name}`).sort(),
      [
        `${chatStream(mesh.space)}/${FANOUT_DURABLE}`,
        `${dlvStream(mesh.space)}/${dlvDurable(DEV_OWNER, identity.id)}`,
        `${dmStream(mesh.space)}/${dmDurable(DEV_OWNER, identity.id)}`,
        `${inboxStream(mesh.space)}/${INBOX_READER_DURABLE}`,
        `${taskStream(mesh.space)}/${taskDurable(ROLE)}`,
      ].sort(),
      "the artifact carries exactly the five canonical durables the seeded mesh held",
    );
    // The live mesh also runs transient ordered consumers (`oc_*`) over the registry KV buckets — the
    // manager's and daemon's watchers. They are excluded by contract, and the cut disconnects their
    // owners, so no KV-bucket consumer may reach the artifact.
    assert.equal(
      checkpoints.some((c) => c.stream.startsWith("KV_")), false,
      "no KV-bucket consumer enters the artifact",
    );

    // Stream message counts are conserved: nothing was dropped, purged, or advanced by the cut.
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as Manifest;
    assert.deepEqual(
      manifest.streams.map((s) => s.stream).sort(),
      [...spaceBackupInventory(mesh.space).full].sort(),
      "the artifact covers every backed-up stream",
    );
    for (const record of manifest.streams) {
      const live = preCut.streams[record.stream];
      assert.ok(live, `${record.stream} was sampled before the cut`);
      assert.equal(record.state.messages, live.messages, `${record.stream} conserved its message count`);
      assert.equal(record.state.first_seq, live.first_seq, `${record.stream} conserved its first sequence`);
      assert.equal(record.state.last_seq, live.last_seq, `${record.stream} conserved its sequence frontier`);
    }

    // Ordinary resume over the SAME store: the unresolved pre-cut work must still be claimable by the
    // same principal, and the resolved item must stay resolved.
    must("ordinary same-principal resume", run("up", "--detach", "--server", mesh.server, "--space", mesh.space));
    const resumed = memberEndpoint(mesh, identity, creds, new Set([PENDING_POST, TASK_UNRESOLVED]));
    try {
      await resumed.endpoint.start();
      await waitUntil(
        () => resumed.saw(PENDING_POST, { durable: true }),
        "the pending pre-cut handoff replays to the resumed member over the backstop",
        { detail: resumed.report },
      );
      await waitUntil(() => resumed.saw(TASK_UNRESOLVED), "the unresolved pre-cut TASK item replays", {
        detail: resumed.report,
      });
      assert.equal(
        resumed.seen.some((r) => r.text === TASK_ACKED), false,
        "an item at or below the contiguous ACK floor never replays",
      );
    } finally {
      await resumed.endpoint.stop();
    }
    must("down", run("down"));
  } finally {
    run("down");
    rmSync(mesh.root, { recursive: true, force: true });
    rmSync(mesh.home, { recursive: true, force: true });
  }
}

// ---- scenario 2: first post-restore CHAT + pending INBOX authorization -----

async function restoredMeshWorksScenario(): Promise<void> {
  const mesh = await openMesh("backup-restored-mesh", "backup_restored_mesh");
  const { run, must } = mesh;
  const artifact = join(mesh.root, "full-backup");
  try {
    must("up", run("up", "--detach", "--server", mesh.server, "--space", mesh.space));
    must("seed registry", run("channels", "set", CHANNEL, "--desc", "restored", "--space", mesh.space));
    const auth = loadSoleSpaceAuth(authDir(mesh.root));
    assert.ok(auth, "an auth mesh retains its SpaceAuth");

    const sampler = await openSampler(mesh, auth);
    let identity: Identity;
    let creds: string;
    try {
      ({ identity, creds } = await seedPlane3State(mesh, auth, sampler));
      await stablePreCutSample(mesh, sampler, identity);
    } finally {
      await sampler.close();
    }

    must("preserve cut", run("down", "--preserve-state"));
    must("full backup", run("backup", "create", artifact));
    must("restore", run("up", "--restore", artifact, "--detach", "--server", mesh.server, "--space", mesh.space));
    const restored = mesh.journal();
    assert.equal(restored.state, "active");

    // The restored registry is the one that was backed up.
    const listed = run("channels", "list", "--space", mesh.space);
    must("list restored registry", listed);
    assert.match(listed.stdout, new RegExp(`#${CHANNEL}`));

    const member = memberEndpoint(mesh, identity, creds, new Set([PENDING_POST, POST_RESTORE_POST]));
    const poster = new CotalEndpoint({
      space: mesh.space,
      servers: mesh.server,
      creds: await mintCreds(auth, newIdentity(), "operator"),
      card: { name: "poster", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: false,
    });
    poster.on("error", () => {});
    try {
      await poster.start();
      await member.endpoint.start();
      // The pre-cut pending entry survives restore and is still deliverable under the authorization
      // the artifact preserved — the DLV durable was rebuilt from its checkpoint, not from the archive.
      await waitUntil(
        () => member.saw(PENDING_POST, { durable: true }),
        "the pre-cut pending entry is delivered under its preserved authorization",
        { detail: member.report },
      );
      // ...and the restored mesh carries NEW traffic: a first post-restore CHAT reaches the existing
      // member over the whole rebuilt Plane-3 path (fan-out -> dinbox -> re-auth against the restored
      // ACL/MEMBERS -> DLV), not merely over its live core subscription.
      await waitUntil(() => member.endpoint.hasDurableMembership(CHANNEL), "restored durable membership", {
        detail: member.report,
      });
      await poster.multicast(POST_RESTORE_POST, { channel: CHANNEL });
      await waitUntil(
        () => member.saw(POST_RESTORE_POST, { durable: true }),
        "the first post-restore CHAT reaches the existing member over the rebuilt backstop",
        { detail: member.report },
      );
    } finally {
      await member.endpoint.stop();
      await poster.stop();
    }
    must("down", run("down"));
    assert.ok(restored.restore, "a committed restore records its attempt");
    must("cleanup fallback", run("clean", "restore-fallback", "--attempt", restored.restore.attemptId, "--force"));
  } finally {
    run("down");
    rmSync(mesh.root, { recursive: true, force: true });
    rmSync(mesh.home, { recursive: true, force: true });
  }
}

await conservationScenario();
await restoredMeshWorksScenario();
console.log("backup conservation live smoke: ok (2 scenarios)");
