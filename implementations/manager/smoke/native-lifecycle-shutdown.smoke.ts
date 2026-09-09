/**
 * PRODUCTION CALLER: caught SIGINT/SIGTERM -> Manager.stopForSignal() and the
 * served `status` command -> managerStatusData() both call nativeLifecycleBindings().
 * `cotal supervise` wires that through nativeLifecycleLookupForSupervisor -> the
 * registered auth provider -> queryNativeLifecycleBindingsWithAuthority (sealed
 * sessionbinding scan, then sessionop receipt point-read). Injected Manager.nativeLifecycleBindings
 * stubs do not grade this.
 *
 * Run: pnpm smoke:native-lifecycle-shutdown
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  createRecordEntry,
  createSpaceAuth,
  ensureAuthorityStores,
  isReachable,
  prepareSessionOperation,
  recordsBucket,
  registry,
  serverConfig,
  sessionBindingKey,
  sessionOperationKey,
  updateSessionOperation,
  type AgentHandle,
  type AuthProvider,
  type LaunchSpec,
  type NativeLifecycleBindingLookup,
  type ResourceKey,
} from "@cotal-ai/core";
import { queryNativeLifecycleBindingsWithAuthority } from "../../auth/src/records-scanner.js";
import { openAuthorityClient } from "../../auth/src/authority-client.js";
import { nativeLifecycleLookupForSupervisor } from "../src/commands.js";
import { Manager } from "../src/manager.js";
import type { ManagerStatus } from "../src/manager-service-contract.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label: string, condition: boolean, extra?: unknown): void => {
  console.log(`${condition ? "ok" : "not ok"} - ${label}${condition ? "" : `: ${String(extra ?? "")}`}`);
  if (!condition) failures++;
};

const space = `nls${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const root = mkdtempSync(join(tmpdir(), "nls-root-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const PRINCIPAL = "u_alice.manager";

const fakeHandle = (name: string): AgentHandle => ({
  name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {},
  attach: () => { throw new Error("no attach"); },
});

const provider: Pick<AuthProvider, "kind" | "name" | "nativeLifecycleBindings"> = {
  kind: "auth-provider",
  name: "native-lifecycle-shutdown-auth",
  nativeLifecycleBindings: async (input) => queryNativeLifecycleBindingsWithAuthority({
    server: input.server,
    space: input.space,
    dataAccount,
    managerPrincipal: input.managerPrincipal,
    log: quiet,
  }),
};
registry.register(provider as unknown as AuthProvider);

const resource = (stableSessionId: string): ResourceKey => ({
  hostIdentity: "host-1",
  provider: "com.cotal.claude",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId,
  resourceGeneration: "g-1",
});
const binding = (resourceKey: ResourceKey, bindingId: string, operationId: string, state: "managed" | "released") => ({
  bindingId, resourceKey,
  incarnationProof: { nativeHostIncarnation: "h-1", sessionIncarnation: bindingId, evidence: { pid: bindingId } },
  controllerEpoch: 7, managerPrincipal: PRINCIPAL, mode: "cooperative-exclusive" as const,
  rights: ["control", "release"] as const, state, operationId, desiredRevision: 1,
});
const opBase = (resourceKey: ResourceKey, operationId: string, bindingId: string) => ({
  operationId, resourceKey,
  incarnationProof: { nativeHostIncarnation: "h-1", sessionIncarnation: bindingId, evidence: { pid: bindingId } },
  bindingId, expectedBindingRevision: 1, expectedControllerEpoch: 7,
  authenticatedActor: "u_alice.operator", action: "release" as const,
  intendedResult: { bindingState: "released", nativeState: "preserved" },
});

function managerWithLookup(): Manager {
  const lookup = nativeLifecycleLookupForSupervisor(root, space, SERVERS);
  const manager = new Manager({
    space,
    runtime: "pty",
    workspaceRoot: root,
    nativeLifecycleLookup: lookup,
  });
  (manager as unknown as { runtime: unknown }).runtime = {
    kind: "fake",
    spawn: (name: string, _spec: LaunchSpec) => fakeHandle(name),
  };
  (manager as unknown as { ep: unknown }).ep = {
    ref: () => ({ id: PRINCIPAL, name: "manager", role: "manager" }),
    getRoster: () => [],
    waitForPresenceSnapshot: async () => {},
    on: () => {},
    off: () => {},
    releaseManagerLease: async () => {},
    stop: async () => {},
  };
  (manager as unknown as { attach: unknown }).attach = { stop: async () => {} };
  return manager;
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  const wide = await openAuthorityClient({
    server: SERVERS, space, dataAccount, label: `harness:${space}`,
    grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet,
  });
  await ensureAuthorityStores(await jetstreamManager(wide.nc), new Kvm(wide.nc), space);
  const kv = await new Kvm(wide.nc).open(recordsBucket(space));

  const supervisor = nativeLifecycleLookupForSupervisor(root, space, SERVERS);
  const empty = await supervisor(PRINCIPAL);
  check("shipped supervisor entry point reaches the auth closed lookup as known-empty",
    empty.status === "known" && empty.bindings.length === 0, empty);

  const unprovenRes = resource("s-unproven");
  await createRecordEntry(kv, sessionBindingKey(unprovenRes), binding(unprovenRes, "binding-unproven", "op-unproven", "released"));

  const manager = managerWithLookup();
  const internals = manager as unknown as {
    nativeLifecycleBindings(): Promise<NativeLifecycleBindingLookup>;
    managerStatusData(): Promise<ManagerStatus>;
    stopPreservingNative(): Promise<void>;
    stop(): Promise<void>;
  };
  let native = 0, legacy = 0;
  internals.stopPreservingNative = async () => { native++; };
  internals.stop = async () => { legacy++; };

  const statusUnproven = await internals.managerStatusData();
  check("PRODUCTION CALLER managerStatusData: released-unproven is a live binding",
    statusUnproven.nativeLifecycle.status === "known"
      && statusUnproven.nativeLifecycle.liveBindings === 1
      && statusUnproven.nativeLifecycle.liveBindingIds.includes("binding-unproven"),
    statusUnproven.nativeLifecycle);

  await manager.stopForSignal();
  check("PRODUCTION CALLER stopForSignal: released-unproven selects preserve-native cleanup",
    native === 1 && legacy === 0, { native, legacy });

  const nativeRes = resource("s-native");
  const prepared = await prepareSessionOperation(kv, opBase(nativeRes, "op-native", "binding-native"));
  await updateSessionOperation(kv, {
    ...prepared.record,
    state: "terminal-success",
    result: { bindingState: "released" },
    proofOrigin: { kind: "receiver-receipt", receiver: "native-1", highestEpoch: 7, proves: "native-effect" },
  }, (await kv.get(sessionOperationKey(nativeRes, "op-native")))!.revision);
  await createRecordEntry(kv, sessionBindingKey(nativeRes), binding(nativeRes, "binding-native", "op-native", "released"));

  const manager2 = managerWithLookup();
  const internals2 = manager2 as unknown as {
    managerStatusData(): Promise<ManagerStatus>;
    stopPreservingNative(): Promise<void>;
    stop(): Promise<void>;
  };
  let native2 = 0, legacy2 = 0;
  internals2.stopPreservingNative = async () => { native2++; };
  internals2.stop = async () => { legacy2++; };
  const statusProven = await internals2.managerStatusData();
  check("managerStatusData still counts the unproven release after a proven native-effect row",
    statusProven.nativeLifecycle.status === "known"
      && statusProven.nativeLifecycle.liveBindingIds.includes("binding-unproven")
      && !statusProven.nativeLifecycle.liveBindingIds.includes("binding-native"),
    statusProven.nativeLifecycle);

  await manager2.stopForSignal();
  check("stopForSignal keeps preserve-native while any unproven released row remains",
    native2 === 1 && legacy2 === 0, { native2, legacy2 });

  await wide.close();
} finally {
  await releaseBroker();
}
console.log(`\nNATIVE-LIFECYCLE-SHUTDOWN SMOKE ${failures === 0 ? "OK" : "FAILED"} (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
