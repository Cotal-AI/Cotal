/**
 * Managed-static renewal and terminalization have one order: an admitted renewal drains before
 * retirement enumerates, revokes, and cleans its credential family; a later renewal refuses. The
 * fixture exercises both terminal entry paths (despawn and natural process exit), and reaches the
 * renewal once directly and once through the production half-TTL sweep.
 *
 * Run: pnpm smoke:renewal-terminal-race
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, gateObserve, headCandidate, mintCreds, newIdentity, principalKey, rawDigest,
  standaloneConnectOpts, registry, DEV_OWNER, setupSpaceStreams, recordsBucket, epAuthBucket,
  parseLedgerRow, credRowKey, type AgentHandle, type AttachSession,
  type Connector, type LaunchSpec, type Presence, type CredentialLedgerRow,
  type EvictionResult, type LifecycleStateTransport, type SecretStore,
} from "@cotal-ai/core";
import { agentSecretKeyForFile, putSpaceAuth } from "@cotal-ai/workspace";
import {
  appendStaticCredentialRow, recordSlotCredential, staticLifecycleTransport, readStaticSlot,
} from "../src/static-lifecycle.js";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";

const SCENARIOS = [
  { name: "racer_despawn", renewal: "direct", terminal: "despawn" },
  { name: "racer_exit", renewal: "sweep", terminal: "natural-exit" },
] as const;
const SCENARIO_CELLS = SCENARIOS.length * 23;
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function enterNextEpochSecond(): Promise<void> {
  const second = Math.floor(Date.now() / 1_000);
  await until(() => Math.floor(Date.now() / 1_000) > second, 1_500);
}

class PausingSecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  private readonly deleted = new Set<string>();
  private pause?: { reached: (key: string) => void; release: Promise<void> };

  armNextPut(): { reached: Promise<string>; release: () => void } {
    if (this.pause) throw new Error("a secret-store put is already paused");
    let reached!: (key: string) => void;
    let release!: () => void;
    const reachedPromise = new Promise<string>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.pause = { reached, release: releasePromise };
    return {
      reached: reachedPromise,
      release: () => {
        release();
        this.pause = undefined;
      },
    };
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  async put(key: string, value: string): Promise<void> {
    const pause = this.pause;
    if (pause) {
      pause.reached(key);
      await pause.release;
    }
    this.deleted.delete(key);
    this.values.set(key, value);
  }

  delete(key: string): Promise<void> {
    this.deleted.add(key);
    this.values.delete(key);
    return Promise.resolve();
  }

  wasDeleted(key: string): boolean {
    return this.deleted.has(key);
  }
}

class ControlledHandle implements AgentHandle {
  readonly kind = "fake";
  private state: "running" | "exited" = "running";
  private readonly exitListeners = new Set<() => void>();
  private readonly session: AttachSession;

  constructor(readonly name: string) {
    this.session = {
      cols: 80,
      rows: 24,
      backlog: () => Buffer.alloc(0),
      onData: () => () => {},
      onExit: (listener) => {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
      },
      write: () => {},
      resize: () => {},
    };
  }

  status(): "running" | "exited" {
    return this.state;
  }

  stop(): void {
    this.state = "exited";
  }

  interrupt(): void {}

  attach(): AttachSession {
    return this.session;
  }

  exitNaturally(): boolean {
    this.state = "exited";
    const listeners = [...this.exitListeners];
    for (const listener of listeners) listener();
    return listeners.length > 0;
  }
}

const space = `renewal-race-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers, stop: stopBroker } = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-renewal-race-"));
const secrets = new PausingSecretStore();
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const { name } of SCENARIOS)
  writeFileSync(
    join(workspaceRoot, ".cotal", "agents", `${name}.md`),
    `---\nname: ${name}\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
  );

await putSpaceAuth(secrets, auth);
const mgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, secretStore: secrets });
(mgr as unknown as { staticLifecycleEvict?: (principal: string) => Promise<EvictionResult> }).staticLifecycleEvict =
  async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true });
(mgr as unknown as { auth: unknown }).auth = auth;
const handles = new Map<string, ControlledHandle>();
(mgr as unknown as { runtime: { kind: string; spawn: (name: string, spec: LaunchSpec) => AgentHandle } }).runtime = {
  kind: "fake",
  spawn: (name) => {
    const handle = new ControlledHandle(name);
    handles.set(name, handle);
    return handle;
  },
};
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {},
  waitForPresenceSnapshot: () => Promise.resolve(), getRoster: (): Presence[] => [],
};
registry.register({ kind: "connector", name: "smoke-race", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) } as Connector);

type Agent = {
  id: string;
  name: string;
  lifecycleUid: string;
  seed?: string;
  role?: string;
  launch: { allowSubscribe: string[]; allowPublish?: string[]; capabilities?: string[] };
  terminalizing?: boolean;
  staticCredentialRenewal?: Promise<void>;
  secretPaths?: { creds?: string };
};
type RetirementHold = { lifecycleUid: string; lastError?: string };
const M = mgr as unknown as {
  agents: Map<string, Agent>;
  retiring: Map<string, RetirementHold>;
  renewManagedStaticCred(agent: Agent): Promise<void>;
  renewDaemonCreds(): Promise<void>;
  despawnAuthorized(agent: Agent, graceful: boolean, trackNonAdmin: boolean): { ok: boolean };
};

async function openLifecycleView(alias: string, actor: string, uid: string): Promise<{
  nc: NatsConnection;
  transport: LifecycleStateTransport;
}> {
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", {
    lifecycleExecutor: { owner: DEV_OWNER, actor, lifecycleUid: uid, alias },
  });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const kvm = new Kvm(nc);
  return {
    nc,
    transport: staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space))),
  };
}

async function stageExpiringCredential(agent: Agent, transport: LifecycleStateTransport, key: string, path: string): Promise<number> {
  if (!agent.seed) throw new Error(`${agent.name}: no static seed`);
  const exp = Math.floor(Date.now() / 1_000) + 1;
  const creds = await mintCreds(auth, { id: agent.id, seed: agent.seed }, "agent", {
    allowSubscribe: agent.launch.allowSubscribe,
    allowPublish: agent.launch.allowPublish,
    role: agent.role,
    capabilities: agent.launch.capabilities,
    lifecycleUid: agent.lifecycleUid,
    expiresAt: exp,
  });
  const credentialId = rawDigest(creds).replace("sha256:", "sha256-");
  await recordSlotCredential(transport, DEV_OWNER, agent.name, agent.lifecycleUid, credentialId);
  await appendStaticCredentialRow(transport, {
    lifecycleUid: agent.lifecycleUid,
    credentialId,
    holderPrincipal: principalKey(DEV_OWNER, agent.id).key,
    exp,
  });
  await secrets.put(key, creds);
  writeFileSync(path, creds, { mode: 0o600 });
  return exp;
}

try {
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();
  (mgr as unknown as { awaitReadiness(): Promise<{ ok: true }> }).awaitReadiness = async () => ({ ok: true });

  for (const scenario of SCENARIOS) {
    const { name } = scenario;
    console.log(`\n${name}: ${scenario.renewal} renewal then ${scenario.terminal}`);
    const spawned = await mgr.startAgent({ name, agent: "smoke-race" });
    check(`${name}: spawn succeeds`, spawned.ok, spawned);
    const agent = M.agents.get(name);
    check(`${name}: the spawned lifecycle is managed`, agent !== undefined);
    if (!agent) throw new Error(`${name}: setup failed before the race`);

    const credsPath = agent.secretPaths?.creds;
    if (!credsPath) throw new Error(`${name}: no managed credential path`);
    const secretKey = agentSecretKeyForFile(credsPath, space);
    const view = await openLifecycleView(name, agent.id, agent.lifecycleUid);
    let pause: ReturnType<PausingSecretStore["armNextPut"]> | undefined;
    try {
      if (scenario.renewal === "sweep") {
        const exp = await stageExpiringCredential(agent, view.transport, secretKey, credsPath);
        await until(() => Math.floor(Date.now() / 1_000) >= exp, 2_000);
      } else {
        await enterNextEpochSecond();
      }
      pause = secrets.armNextPut();

      const beforeSlot = await readStaticSlot(view.transport, DEV_OWNER, name);
      const beforeIds = beforeSlot?.row.credentialIds ?? [];
      check(`${name}: the pre-renewal credential family is non-empty`, beforeIds.length > 0, beforeIds);

      const accepted = (scenario.renewal === "sweep"
        ? M.renewDaemonCreds()
        : M.renewManagedStaticCred(agent))
        .then(() => "completed" as const)
        .catch((error: Error) => `refused: ${error.message}` as const);

      const pausedKey = await bounded(pause.reached, 5_000);
      check(`${name}: renewal reaches the secret-store put after journaling`, pausedKey === secretKey, pausedKey);
      check(`${name}: renewal publishes its accepted flight`, agent.staticCredentialRenewal !== undefined);

      const duringSlot = await readStaticSlot(view.transport, DEV_OWNER, name);
      const duringIds = duringSlot?.row.credentialIds ?? [];
      const newIds = duringIds.filter((id) => !beforeIds.includes(id));
      check(`${name}: renewal records exactly one new credential id`, newIds.length === 1, { beforeIds, duringIds });
      const newEntry = newIds[0] ? await view.transport.getAuth(credRowKey(agent.lifecycleUid, newIds[0])) : undefined;
      const newRow = newEntry && newIds[0] ? parseLedgerRow(newEntry.value, credRowKey(agent.lifecycleUid, newIds[0])) : undefined;
      check(`${name}: the newly recorded renewal row is active before terminalization`, newRow?.state === "active", newRow);

      let terminalEntered = false;
      if (scenario.terminal === "despawn")
        terminalEntered = M.despawnAuthorized(agent, false, true).ok;
      else
        terminalEntered = handles.get(name)?.exitNaturally() === true && !M.agents.has(name);
      check(`${name}: ${scenario.terminal} enters the terminal path`, terminalEntered);
      check(`${name}: the terminal latch closes synchronously`, agent.terminalizing === true);
      check(`${name}: terminalization registers the lifecycle hold`, M.retiring.get(name)?.lifecycleUid === agent.lifecycleUid, M.retiring.get(name));

      let lateOutcome: string | undefined;
      const late = M.renewManagedStaticCred(agent)
        .then(() => "completed" as const)
        .catch((error: Error) => `refused: ${error.message}` as const)
        .then((outcome) => { lateOutcome = outcome; return outcome; });
      await until(() => lateOutcome !== undefined, 250);
      check(`${name}: a renewal arriving after the terminal latch is refused`, lateOutcome?.startsWith("refused: renewManagedStaticCred: the lifecycle is terminalizing") === true, lateOutcome);
      const lateSettled = await bounded(late, 1_000);
      check(`${name}: the post-latch renewal promise settles within its budget`, lateSettled !== undefined, lateOutcome);

      const terminalMovedWhilePaused = await until(async () => {
        const slot = await readStaticSlot(view.transport, DEV_OWNER, name);
        const hold = M.retiring.get(name);
        return slot?.row.phase !== "active" || hold === undefined || hold.lastError !== undefined;
      }, 3_000);
      check(`${name}: the durable terminal does not pass an accepted renewal still in flight`, !terminalMovedWhilePaused, M.retiring.get(name));

      pause.release();
      const acceptedOutcome = await bounded(accepted, 10_000);
      check(`${name}: the accepted renewal entry settles before cleanup`, acceptedOutcome === "completed", acceptedOutcome);
      const flightReleased = await until(() => agent.staticCredentialRenewal === undefined, 1_000);
      check(`${name}: a settled renewal releases its single-flight slot`, flightReleased);

      const retired = await until(() => !M.retiring.has(name), 10_000);
      check(`${name}: retirement drains the accepted renewal and reaches its terminal`, retired, M.retiring.get(name));

      const slot = await readStaticSlot(view.transport, DEV_OWNER, name);
      const gate = await gateObserve(view.transport, agent.lifecycleUid);
      const head = await headCandidate(view.transport, DEV_OWNER, agent.id);
      check(`${name}: the durable slot is retired`, slot?.row.phase === "retired", slot?.row);
      check(`${name}: the issuance gate is retired`, gate?.row.state === "retired", gate?.row);
      check(`${name}: the lifecycle head is retired`, head?.mapping.state === "retired", head?.mapping);

      const rows: CredentialLedgerRow[] = [];
      for (const id of slot?.row.credentialIds ?? []) {
        const entry = await view.transport.getAuth(credRowKey(agent.lifecycleUid, id));
        if (entry !== undefined) rows.push(parseLedgerRow(entry.value, credRowKey(agent.lifecycleUid, id)));
      }
      check(`${name}: the retired family includes the renewal generation`, newIds.length === 1 && rows.some((row) => row.credentialId === newIds[0]), rows);
      check(`${name}: no credential row remains active after retirement`, rows.length > 0 && rows.every((row) => row.state === "revoked"), rows);
      check(`${name}: the secret-store credential key is deleted`, secrets.wasDeleted(secretKey) && await secrets.get(secretKey) === undefined, secretKey);
      check(`${name}: no credential file remains after retirement`, !existsSync(credsPath), credsPath);
    } finally {
      pause?.release();
      await view.nc.drain().catch(() => view.nc.close());
    }
  }
} finally {
  await mgr.stop().catch(() => {});
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

check(`every scenario cell ran — ${SCENARIO_CELLS} expected`, pass + fail === SCENARIO_CELLS, { pass, fail, expected: SCENARIO_CELLS });
if (fail) {
  console.error(`\nRENEWAL-TERMINAL RACE SMOKE FAILED (${pass} passed, ${fail} failed)`);
  process.exit(1);
}
console.log(`\nRENEWAL-TERMINAL RACE SMOKE OK ✅  (${pass} passed, 0 failed)`);
