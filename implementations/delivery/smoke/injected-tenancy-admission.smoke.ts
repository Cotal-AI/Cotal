/**
 * A hosted delivery composition must validate its injected $SYS scan pair before constructing the
 * endpoint or acquiring lease.0. This is the injected-store sibling of the workstation wrong-root
 * cell in gate-reconcile-cli-e2e: delivery authenticates as tenant A while the store returns tenant
 * B's observer. A complete scan of B would look healthy while answering the wrong tenancy.
 *
 * The pre-fix process reads only delivery.creds, acquires lease.0, and reaches READY before it ever
 * consults the foreign observer. The fixed process reads the observer/evictor pair, refuses naming
 * both accounts, and leaves no lease. A correctly populated injected store then boots in the same
 * process as the positive control.
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

  const inspectorId = newIdentity();
  inspector = new CotalEndpoint({
    space: spaceA, servers, creds: await mintCreds(authA, inspectorId, "delivery"),
    card: { id: inspectorId.id, name: "lease-inspector", kind: "endpoint" },
    channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  inspector.on("error", () => {});
  await inspector.start();

  const poisoned = new MemoryStore();
  await poisoned.put(deliveryKey, deliveryCreds);
  await poisoned.put(rwKey, rwCreds);
  await poisoned.put(observerKey, observerB);
  await poisoned.put(evictorKey, evictor);
  const args: ParsedArgs = { values: { space: spaceA, server: servers }, positionals: [], raw: [] };
  let refusal: Error | undefined;
  void runDelivery(args, poisoned).catch((error) => { refusal = error as Error; });
  const outcome = await until(async () => {
    if (refusal) return "refused";
    if (await inspector!.readDeliveryLease(0)) return "leased";
    return undefined;
  });
  const leaseAfterRefusal = await inspector.readDeliveryLease(0);
  check(
    "INJECTED ADMISSION: foreign observer refuses before endpoint construction and lease.0 acquisition",
    outcome === "refused" && leaseAfterRefusal === undefined &&
      refusal?.message.includes(accountA.account.pub) && refusal.message.includes(accountB.account.pub),
    { outcome, lease: leaseAfterRefusal, error: refusal?.message, reads: poisoned.reads },
  );
  check(
    "INJECTED ADMISSION: startup reads the required observer/evictor pair through target.source",
    poisoned.reads.includes(observerKey) && poisoned.reads.includes(evictorKey),
    poisoned.reads,
  );

  // Positive control: the same composition with tenant A's observer is admitted and reaches READY.
  if (outcome === "refused") {
    const correct = new MemoryStore();
    await correct.put(deliveryKey, deliveryCreds);
    await correct.put(rwKey, rwCreds);
    await correct.put(observerKey, observerA);
    await correct.put(evictorKey, evictor);
    void runDelivery(args, correct);
    const ready = await until(async () => (await inspector!.readDeliveryLease(0))?.ready === true ? true : undefined, 20_000);
    check("INJECTED ADMISSION control: the correctly tenanted injected composition reaches READY", ready === true, {
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
