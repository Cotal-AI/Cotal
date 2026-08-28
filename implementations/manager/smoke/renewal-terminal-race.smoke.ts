/**
 * A renewal admitted before terminalization is drained before the static terminal revokes its
 * credential family and deletes its material. A renewal arriving after the synchronous latch is
 * refused. The test drives both orderings through the real manager, lifecycle journal, filesystem
 * secret store, and JWT broker.
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
  createSpaceAuth, gateObserve, headCandidate, mintCreds, newIdentity, standaloneConnectOpts,
  registry, DEV_OWNER, setupSpaceStreams, recordsBucket, epAuthBucket, parseLedgerRow, credRowKey,
  type AgentHandle, type Connector, type LaunchSpec, type Presence, type CredentialLedgerRow,
  type LifecycleStateTransport, type SecretStore,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { staticLifecycleTransport, readStaticSlot } from "../src/static-lifecycle.js";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";

const ATTEMPTS = 4;
const SCENARIO_CELLS = ATTEMPTS * 17;
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

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function untilAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
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

class PausingSecretStore implements SecretStore {
  private pause?: {
    reached: (key: string) => void;
    release: Promise<void>;
  };

  constructor(private readonly base: SecretStore) {}

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
    return this.base.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    const pause = this.pause;
    if (pause) {
      pause.reached(key);
      await pause.release;
    }
    await this.base.put(key, value);
  }

  delete(key: string): Promise<void> {
    return this.base.delete(key);
  }
}

const space = `renewal-race-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers, stop: stopBroker } = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-renewal-race-"));
const secrets = new PausingSecretStore(workspaceSecretStore(workspaceRoot));
const aliases = Array.from({ length: ATTEMPTS }, (_, i) => `racer_${i + 1}`);
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const name of aliases)
  writeFileSync(
    join(workspaceRoot, ".cotal", "agents", `${name}.md`),
    `---\nname: ${name}\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
  );

saveSpaceAuth(authDir(workspaceRoot), auth);
const mgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, secretStore: secrets });
(mgr as unknown as { auth: unknown }).auth = auth;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
(mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
(mgr as unknown as { ep: Record<string, unknown> }).ep = {
  ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {},
  waitForPresenceSnapshot: () => Promise.resolve(), getRoster: (): Presence[] => [],
};
registry.register({ kind: "connector", name: "smoke-race", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) } as Connector);

type Agent = {
  id: string;
  name: string;
  lifecycleUid: string;
  terminalizing?: boolean;
  staticCredentialRenewal?: Promise<void>;
  secretPaths?: { creds?: string };
};
type RetirementHold = { lifecycleUid: string; lastError?: string };
const M = mgr as unknown as {
  agents: Map<string, Agent>;
  retiring: Map<string, RetirementHold>;
  renewManagedStaticCred(a: Agent): Promise<void>;
  despawnAuthorized(a: Agent, graceful: boolean, trackNonAdmin: boolean): { ok: boolean };
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

try {
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();
  (mgr as unknown as { awaitReadiness(): Promise<{ ok: true }> }).awaitReadiness = async () => ({ ok: true });

  for (const name of aliases) {
    console.log(`\n${name}: accepted renewal then terminal`);
    const spawned = await mgr.startAgent({ name, agent: "smoke-race" });
    check(`${name}: spawn succeeds`, spawned.ok, spawned);
    const agent = M.agents.get(name);
    check(`${name}: the spawned lifecycle is managed`, agent !== undefined);
    if (!agent) throw new Error(`${name}: setup failed before the race`);

    const view = await openLifecycleView(name, agent.id, agent.lifecycleUid);
    const pause = secrets.armNextPut();
    try {
      const credsPath = agent.secretPaths?.creds;
      const accepted = M.renewManagedStaticCred(agent)
        .then(() => "completed" as const)
        .catch((error: Error) => `refused: ${error.message}` as const);
      check(`${name}: renewal publishes its accepted flight before returning`, agent.staticCredentialRenewal !== undefined);

      const pausedKey = await bounded(pause.reached, 5_000);
      check(`${name}: renewal reaches the real secret-store put after journaling`, typeof pausedKey === "string" && pausedKey.endsWith(".creds"), pausedKey);

      const stopped = M.despawnAuthorized(agent, false, true);
      check(`${name}: despawn accepts the terminal`, stopped.ok, stopped);
      check(`${name}: the terminal latch closes synchronously`, agent.terminalizing === true);
      check(`${name}: terminalization registers the lifecycle hold`, M.retiring.get(name)?.lifecycleUid === agent.lifecycleUid, M.retiring.get(name));

      let lateOutcome: string | undefined;
      const late = M.renewManagedStaticCred(agent)
        .then(() => { lateOutcome = "completed"; })
        .catch((error: Error) => { lateOutcome = `refused: ${error.message}`; });
      await until(() => lateOutcome !== undefined, 250);
      check(`${name}: a renewal arriving after the terminal latch is refused`, lateOutcome?.startsWith("refused: renewManagedStaticCred: the lifecycle is terminalizing") === true, lateOutcome);

      const terminalMovedWhilePaused = await untilAsync(async () => {
        const slot = await readStaticSlot(view.transport, DEV_OWNER, name);
        return slot?.row.phase !== "active";
      }, 750);
      check(`${name}: the durable terminal does not pass an accepted renewal still in flight`, !terminalMovedWhilePaused);

      pause.release();
      const acceptedOutcome = await accepted;
      await late;
      check(`${name}: the renewal accepted before terminalization settles before cleanup`, acceptedOutcome === "completed", acceptedOutcome);

      const retired = await until(() => !M.retiring.has(name));
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
      check(`${name}: the journal exposes the credential family it retired`, rows.length > 0, rows);
      check(`${name}: no credential row remains active after retirement`, rows.length > 0 && rows.every((row) => row.state === "revoked"), rows);
      check(`${name}: no credential file remains after retirement`, credsPath !== undefined && !existsSync(credsPath), credsPath);
    } finally {
      pause.release();
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
