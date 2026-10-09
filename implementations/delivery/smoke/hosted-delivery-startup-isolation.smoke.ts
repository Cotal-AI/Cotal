import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, credsAuthenticator, NoRespondersError, RequestError, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable,
  mintCreds, mintMembershipObserverCreds, mintLifecycleUid, newIdentity, serverConfig,
  setupSpaceStreams, controlServiceSubject, CONTROL_DELIVERY, DEV_OWNER, LEASE_TTL_MS, type SecretStore,
} from "@cotal-ai/core";
import { deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, type HostedServiceHandle } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startDeliveryService } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

if (process.platform !== "linux") throw new Error("startup isolation proof requires Linux process-generation witnesses");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return true; await wait(80); }
  return false;
}
function generation(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
const composition = { injected: true as const };
type Input = { servers: string; root: string; spaces: string[]; accounts: string[]; values: [string, string][][] };
type Command = { op: "release" } | { op: "restart"; credential: string; hold: boolean } | { op: "close" };
class HeldStore implements SecretStore {
  readonly identity: { kind: "injected"; coordinate: string };
  readonly values: Map<string, string>;
  hold = false;
  release: (() => void) | undefined;
  constructor(readonly space: string, entries: [string, string][]) {
    this.identity = { kind: "injected", coordinate: `startup:${space}` };
    this.values = new Map(entries);
  }
  async get(key: string): Promise<string | undefined> {
    if (this.hold && key === membershipRwCredsKey(this.space, composition)) {
      this.hold = false;
      await new Promise<void>((resolve) => { this.release = resolve; process.send?.({ event: "held" }); });
    }
    return this.values.get(key);
  }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async create(key: string, value: string): Promise<boolean> { if (this.values.has(key)) return false; this.values.set(key, value); return true; }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

if (process.env.COTAL_STARTUP_PROOF_CHILD === "1") {
  const data: Input = JSON.parse(readFileSync(process.env.COTAL_STARTUP_PROOF_INPUT!, "utf8"));
  const stores = data.spaces.map((space, i) => new HeldStore(space, data.values[i]));
  const inputs = data.spaces.map((space, i) => ({
    context: { accountPublicKey: data.accounts[i], lifecycleUid: `startup-${i}` },
    space, servers: data.servers, store: stores[i], storeIdentity: stores[i].identity,
    stateDir: join(data.root, `context-${i}`),
  }));
  const sibling = await startDeliveryService(inputs[1]);
  process.send?.({ event: "sibling-ready", state: (await sibling.readiness()).state });
  let target: HostedServiceHandle | undefined;
  let starting: Promise<void> | undefined;
  const start = (hold: boolean): void => {
    stores[0].hold = hold;
    starting = startDeliveryService(inputs[0]).then(async (handle) => {
      target = handle;
      process.send?.({ event: "target-ready", state: (await handle.readiness()).state });
    }).catch((error: Error) => { process.send?.({ event: "target-refused", message: error.message }); });
  };
  let commands = Promise.resolve();
  process.on("message", (message: Command) => {
    commands = commands.then(async () => {
      if (message.op === "release") { stores[0].release?.(); return; }
      if (message.op === "restart") {
        await starting;
        await target?.close();
        target = undefined;
        await stores[0].put(deliveryCredsKey(data.spaces[0], composition), message.credential);
        start(message.hold);
        return;
      }
      if (message.op === "close") {
        stores[0].release?.();
        await starting;
        await target?.close();
        await sibling.close();
        process.send?.({ event: "closed" });
        process.disconnect();
      }
    }).catch((error: Error) => { process.send?.({ event: "command-error", message: error.message }); process.exitCode = 1; });
  });
  start(true);
} else {
  let checks = 0;
  const check = (label: string, value: boolean): void => { assert.ok(value, label); checks++; console.log(`  ✓ ${label}`); };
  const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const auth = await createBrokerAuth("hosted-startup-isolation");
  const spaces = [`startup-a-${Date.now()}`, `startup-b-${Date.now()}`];
  const accounts = await Promise.all(spaces.map((space) => createSpaceAccountAuth(auth, space)));
  const auths = accounts.map((account) => composeSpaceAuth(auth, account));
  const config = join(root, "server.conf");
  writeFileSync(config, serverConfig(auth, accounts, { transport: { kind: "plaintext" }, port, host: "127.0.0.1", storeDir: join(root, "js") }), { mode: 0o600 });
  const nats = spawn("nats-server", ["-c", config], { stdio: "ignore" });
  const brokerGeneration = generation(nats.pid!);
  const release = teardownOnSignal(nats, root);
  let child: ChildProcess | undefined;
  let childGeneration: string | undefined;
  let inspector: CotalEndpoint | undefined;
  const callers: NatsConnection[] = [];
  try {
    check("owned broker is ready at its recorded generation", Boolean(brokerGeneration) && await until(() => isReachable(servers)));
    const identities = [newIdentity(), newIdentity()];
    const values: [string, string][][] = [];
    for (let i = 0; i < spaces.length; i++) {
      await setupSpaceStreams({ servers, space: spaces[i], creds: await mintCreds(auths[i], newIdentity(), "provisioner") });
      values.push([
        [deliveryCredsKey(spaces[i], composition), await mintCreds(auths[i], identities[i], "delivery")],
        [membershipRwCredsKey(spaces[i], composition), await mintCreds(auths[i], newIdentity(), "membership-rw")],
        [membershipObserverCredsKey(spaces[i], composition), await mintMembershipObserverCreds(auths[i], newIdentity())],
      ]);
    }
    const inputPath = join(root, "child-input.json");
    const input: Input = { servers, root, spaces, accounts: accounts.map((a) => a.account.pub), values };
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    const id = newIdentity();
    inspector = new CotalEndpoint({ space: spaces[0], servers, creds: await mintCreds(auths[0], id, "delivery"), card: { id: id.id, name: "startup-inspector", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
    inspector.on("error", () => {});
    await inspector.start();
    const ask = await Promise.all(spaces.map(async (space, i) => {
      const actor = newIdentity(), uid = mintLifecycleUid();
      const nc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auths[i], actor, "agent", { lifecycleUid: uid }))), inboxPrefix: `_INBOX_${actor.id}` });
      callers.push(nc);
      return async (): Promise<boolean> => {
        const subject = controlServiceSubject(space, CONTROL_DELIVERY, DEV_OWNER, actor.id);
        try {
          await nc.request(subject, JSON.stringify({ op: "listMemberships", args: { lifecycleUid: uid }, from: { id: `${DEV_OWNER}.${actor.id}`, name: "startup-probe", kind: "agent" } }), { timeout: 1500, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
          return true;
        } catch (error) {
          if (error instanceof NoRespondersError || (error instanceof RequestError && error.isNoResponders())) return false;
          throw error;
        }
      };
    }));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", COTAL_STARTUP_PROOF_CHILD: "1", COTAL_STARTUP_PROOF_INPUT: inputPath, COTAL_DELIVERY_BROKER_GONE_MS: "2500", COTAL_DELIVERY_BROKER_GONE_BACKSTOP_MS: "3000" };
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "COTAL_HOME", "COTAL_SEAT_ROOT", "TMPDIR"]) {
      env[key] = join(root, key.toLowerCase()); mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
    }
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    childGeneration = generation(child.pid!);
    assert.ok(childGeneration, "owned child generation recorded");
    const events: { event: string; state?: string; message?: string }[] = [];
    let expired = false, fatal = false;
    child.on("message", (message: { event: string; state?: string; message?: string }) => { events.push(message); });
    child.stdout?.on("data", (data: Buffer) => process.stdout.write(`CHILD ${data.toString()}`));
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString(); process.stdout.write(`CHILD ${text}`);
      expired ||= text.includes("credential expired, awaiting proved renewal");
      fatal ||= text.includes("credential expired without renewal");
    });
    const count = (event: string) => events.filter((e) => e.event === event).length;
    check("healthy sibling returns ready in the owned child", await until(async () => events.some((e) => e.event === "sibling-ready" && e.state === "ready")));
    check("healthy sibling answers before held startup", await ask[1]());
    check("target reaches the real async store read", await until(async () => count("held") === 1));
    check("target owns a ready lease while its startup promise is pending", await until(async () => Boolean((await inspector!.readDeliveryLease(0))?.ready)));
    check("held startup has not returned ready", count("target-ready") === 0);
    check("sibling keeps answering during the held store read", await ask[1]());
    child.send({ op: "release" } satisfies Command);
    check("positive control finishes the same startup when the read is released", await until(async () => count("target-ready") === 1));
    check("positive control serves the target control rail", await ask[0]());
    child.send({ op: "restart", hold: true, credential: await mintCreds(auths[0], identities[0], "delivery", { expiresInSeconds: 12 }) } satisfies Command);
    check("short-lived target holds the same store boundary", await until(async () => count("held") === 2));
    check("short-lived target has a real lease before expiry", await until(async () => Boolean((await inspector!.readDeliveryLease(0))?.ready)));
    check("actual credential expiry arrives while startup is held", await until(async () => expired, 19_000));
    check("actual health backstop fires for the held target", await until(async () => fatal, 6000));
    await wait(3000); // also crosses the old CLI early-stop hard-exit budget
    check("hosted startup fault leaves the sibling process alive", child.exitCode === null && child.signalCode === null && generation(child.pid!) === childGeneration);
    check("healthy sibling answers after the target startup fault", await ask[1]());
    check("the broker was not restarted to produce the fault", generation(nats.pid!) === brokerGeneration);
    child.send({ op: "release" } satisfies Command);
    check("late store completion rejects the failed startup", await until(async () => events.some((e) => e.event === "target-refused" && /stopped|expired/.test(e.message ?? ""))));
    check("failed startup never publishes a second ready handle", count("target-ready") === 1);
    check("failed startup leaves no target control responder", await until(async () => !(await ask[0]())));
    check("late resource cleanup leaves the sibling serving", await ask[1]());
    // An expired credential cannot release its lease; the native TTL remains the authority.
    check("native lease expiry permits a replacement without deleting a foreign row", await until(async () => (await inspector!.readDeliveryLease(0)) === undefined, LEASE_TTL_MS + 5000));
    child.send({ op: "restart", hold: false, credential: await mintCreds(auths[0], identities[0], "delivery") } satisfies Command);
    check("fresh target startup succeeds after the failed context", await until(async () => count("target-ready") === 2));
    check("fresh target serves real control requests", await ask[0]());
    check("sibling remains serving after replacement", await ask[1]());
    child.send({ op: "close" } satisfies Command);
    check("child acknowledges closing both contexts", await until(async () => count("closed") === 1));
    check("child exits naturally after cleanup", await until(async () => child!.exitCode !== null || child!.signalCode !== null) && child.exitCode === 0 && child.signalCode === null);
    check("owned child generation is gone", generation(child.pid!) === undefined);
    check("owned broker generation survives the isolated fault and cleanup", generation(nats.pid!) === brokerGeneration && await isReachable(servers));
    assert.equal(checks, 28, "all startup isolation checks ran");
    console.log(`hosted delivery startup isolation: ${checks} passed, 0 failed`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      assert.equal(generation(child.pid!), childGeneration, "refuse to signal an unowned child generation");
      await killAndAwaitExit(child, "SIGKILL");
    }
    for (const caller of callers) await caller.close();
    await inspector?.stop();
    assert.equal(generation(nats.pid!), brokerGeneration, "refuse to signal an unowned broker generation");
    await killAndAwaitExit(nats, "SIGKILL");
    release();
    assert.equal(generation(nats.pid!), undefined, "owned broker generation gone before deleting fixture state");
    rmSync(root, { recursive: true, force: true });
  }
}
