/**
 * A hosted delivery composition must validate its injected $SYS scan pair before constructing the
 * endpoint or acquiring lease.0. This is the injected-store sibling of the workstation wrong-root
 * cell in gate-reconcile-cli-e2e: delivery authenticates as tenant A while the store returns tenant
 * B's observer. A complete scan of B would look healthy while answering the wrong tenancy.
 *
 * The pre-fix process reads only delivery.creds, acquires lease.0, and reaches READY before it ever
 * consults the foreign observer. The fixed process reads the observer/evictor pair, refuses naming
 * both accounts, and leaves no lease. Missing-observer and torn-pair startup are covered too, while
 * an absent evictor retains the documented pre-eviction deny-new-only posture. A correctly populated
 * injected store then boots in the same process as the positive control.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  composeSpaceAuth,
  createBrokerAuth,
  createSpaceAccountAuth,
  isReachable,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  rotateSystemAccount,
  serverConfig,
  setupSpaceStreams,
  type ParsedArgs,
  type SecretStore,
} from "@cotal-ai/core";
import {
  connectionEvictorCredsKey,
  deliveryCredsKey,
  findCotalRoot,
  membershipObserverCredsKey,
  membershipRwCredsKey,
  workspaceSecretStore,
} from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { runDelivery } from "../src/delivery.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await wait(100);
  }
  return undefined;
}

let passed = 0, failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`, detail ?? ""); }
}

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  async get(key: string): Promise<string | undefined> { this.reads.push(key); return this.values.get(key); }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const spaceA = `injected-admit-a-${Date.now()}`;
const spaceB = `injected-admit-b-${Date.now()}`;
const broker = await createBrokerAuth("injected-admission");
const accountA = await createSpaceAccountAuth(broker, spaceA);
const accountB = await createSpaceAccountAuth(broker, spaceB);
const authA = composeSpaceAuth(broker, accountA);
const authB = composeSpaceAuth(broker, accountB);
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-injected-admission-")));
mkdirSync(join(root, ".cotal"), { recursive: true });
const brokerDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(brokerDir, "server.conf"), serverConfig(broker, [accountA, accountB], {
  transport: { kind: "plaintext" }, port, storeDir: join(brokerDir, "js"),
}));
const nats = spawn("nats-server", ["-c", join(brokerDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, brokerDir);
const cwdBefore = process.cwd();
let inspector: CotalEndpoint | undefined;

try {
  for (let i = 0; i < 60 && !(await isReachable(servers)); i++) await wait(100);
  if (!(await isReachable(servers))) throw new Error("ephemeral broker did not start");
  await setupSpaceStreams({ servers, space: spaceA, creds: await mintCreds(authA, newIdentity(), "provisioner") });
  process.chdir(root);
  check("INJECTED ADMISSION control: cwd is pinned to the empty hosted root", findCotalRoot() === root, findCotalRoot());

  const composition = { injected: true as const };
  const deliveryKey = deliveryCredsKey(spaceA, composition);
  const rwKey = membershipRwCredsKey(spaceA, composition);
  const observerKey = membershipObserverCredsKey(spaceA, composition);
  const evictorKey = connectionEvictorCredsKey(spaceA, composition);
  const deliveryCreds = await mintCreds(authA, newIdentity(), "delivery");
  const rwCreds = await mintCreds(authA, newIdentity(), "membership-rw");
  const observerA = await mintMembershipObserverCreds(authA, newIdentity());
  const observerB = await mintMembershipObserverCreds(authB, newIdentity());
  const evictor = await mintConnectionEvictorCreds(authA, newIdentity());
  const foreignEvictor = await mintConnectionEvictorCreds(await rotateSystemAccount(authA), newIdentity());

  const inspectorId = newIdentity();
  inspector = new CotalEndpoint({
    space: spaceA, servers, creds: await mintCreds(authA, inspectorId, "delivery"),
    card: { id: inspectorId.id, name: "lease-inspector", kind: "endpoint" },
    channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  inspector.on("error", () => {});
  await inspector.start();

  const args: ParsedArgs = { values: { space: spaceA, server: servers }, positionals: [], raw: [] };
  const baseStore = async (): Promise<MemoryStore> => {
    const value = new MemoryStore();
    await value.put(deliveryKey, deliveryCreds);
    await value.put(rwKey, rwCreds);
    return value;
  };
  const rejectedStartup = async (store: MemoryStore): Promise<{ outcome?: string; refusal?: Error; lease: unknown }> => {
    let refusal: Error | undefined;
    void runDelivery(args, store).catch((error) => { refusal = error as Error; });
    const outcome = await until(async () => {
      if (refusal) return "refused";
      if (await inspector!.readDeliveryLease(0)) return "leased";
      return undefined;
    });
    return { outcome, refusal, lease: await inspector!.readDeliveryLease(0) };
  };

  const poisoned = await baseStore();
  await poisoned.put(observerKey, observerB);
  await poisoned.put(evictorKey, evictor);
  const foreign = await rejectedStartup(poisoned);
  check(
    "INJECTED ADMISSION: foreign observer refuses before endpoint construction and lease.0 acquisition",
    foreign.outcome === "refused" && foreign.lease === undefined &&
      foreign.refusal?.message.includes(accountA.account.pub) && foreign.refusal.message.includes(accountB.account.pub),
    { ...foreign, error: foreign.refusal?.message, reads: poisoned.reads },
  );
  check(
    "INJECTED ADMISSION: startup reads the required observer/evictor pair through target.source",
    poisoned.reads.includes(observerKey) && poisoned.reads.includes(evictorKey),
    poisoned.reads,
  );
  check(
    "INJECTED ADMISSION: refusal happens before endpoint start re-reads the delivery credential",
    poisoned.reads.filter((key) => key === deliveryKey).length === 1,
    poisoned.reads,
  );

  const missing = await baseStore();
  await missing.put(evictorKey, evictor);
  const absent = await rejectedStartup(missing);
  check(
    "INJECTED ADMISSION: missing observer refuses before lease.0 instead of serving an unscannable rail",
    absent.outcome === "refused" && absent.lease === undefined && /observer cred is not provisioned/.test(absent.refusal?.message ?? ""),
    { ...absent, error: absent.refusal?.message, reads: missing.reads },
  );

  const torn = await baseStore();
  await torn.put(observerKey, observerA);
  await torn.put(evictorKey, foreignEvictor);
  const mixed = await rejectedStartup(torn);
  check(
    "INJECTED ADMISSION: a present torn observer/evictor generation refuses before lease.0",
    mixed.outcome === "refused" && mixed.lease === undefined && /DIFFERENT system accounts/.test(mixed.refusal?.message ?? ""),
    { ...mixed, error: mixed.refusal?.message, reads: torn.reads },
  );

  // Workstation sibling: no membership.json is present, so the only evidence that can reject this
  // composition is the observer loaded through scanTarget.source itself. An explicit --creds file
  // supplies A's daemon identity while the root's per-space observer belongs to B.
  const workstation = { injected: false as const, root };
  const workstationSecrets = workspaceSecretStore(root);
  await workstationSecrets.put(membershipObserverCredsKey(spaceA, workstation), observerB);
  await workstationSecrets.put(connectionEvictorCredsKey(spaceA, workstation), evictor);
  const deliveryPath = join(root, "workstation-delivery.creds");
  writeFileSync(deliveryPath, deliveryCreds, { mode: 0o600 });
  let workstationRefusal: Error | undefined;
  void runDelivery({ values: { space: spaceA, server: servers, creds: deliveryPath }, positionals: [], raw: [] })
    .catch((error) => { workstationRefusal = error as Error; });
  const workstationOutcome = await until(async () => {
    if (workstationRefusal) return "refused";
    if (await inspector!.readDeliveryLease(0)) return "leased";
    return undefined;
  });
  check(
    "WORKSTATION ADMISSION: source observer tenancy refuses before lease.0 with no membership.json",
    workstationOutcome === "refused" && (await inspector.readDeliveryLease(0)) === undefined &&
      workstationRefusal?.message.includes(accountA.account.pub) && workstationRefusal.message.includes(accountB.account.pub),
    { outcome: workstationOutcome, error: workstationRefusal?.message, lease: await inspector.readDeliveryLease(0) },
  );

  // Positive control: an intact observer with no evictor keeps the pre-feature deny-new-only posture
  // and reaches READY. Eviction itself will still refuse loudly until the evictor is provisioned.
  if (foreign.outcome === "refused" && absent.outcome === "refused" && mixed.outcome === "refused") {
    const correct = await baseStore();
    await correct.put(observerKey, observerA);
    void runDelivery(args, correct);
    const ready = await until(async () => (await inspector!.readDeliveryLease(0))?.ready === true ? true : undefined, 20_000);
    check("INJECTED ADMISSION control: correctly tenanted observer with no evictor reaches READY", ready === true, {
      lease: await inspector.readDeliveryLease(0), reads: correct.reads,
    });
  }

  console.log(`\nINJECTED TENANCY ADMISSION ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
} catch (error) {
  failed++;
  console.error("  ✗ scenario threw:", (error as Error).stack ?? String(error));
  process.exitCode = 1;
} finally {
  try { await inspector?.stop(); } catch { /* broker may be stopping */ }
  await killAndAwaitExit(nats, "SIGKILL");
  process.chdir(cwdBefore);
  for (const path of [root, brokerDir]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  releaseBroker();
}
process.exit(process.exitCode ?? 0);
