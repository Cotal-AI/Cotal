/**
 * Production native-lifecycle lookup: sealed sessionbinding scan, then a sessionop
 * point-read on the mint-writer residual. A released label without a matching receipt
 * stays live. CREATE is not widened.
 *
 * PRODUCTION CALLER: provider.ts static nativeLifecycleBindings ->
 * queryNativeLifecycleBindingsWithAuthority; resident service.ts
 * queryNativeLifecycleBindings uses the same apply helper on the mint-writer KV.
 *
 * Run: pnpm smoke:native-lifecycle-lookup:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  serverConfig,
  sessionBindingKey,
  sessionOperationKey,
  updateSessionOperation,
  type ResourceKey,
} from "@cotal-ai/core";
import { nativeLifecycleReceiptReadGrants, openAuthorityClient } from "../src/authority-client.js";
import { queryNativeLifecycleBindingsWithAuthority, recordsScannerGrants } from "../src/records-scanner.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `nll-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const PRINCIPAL = "u_alice.manager";

const resource = (stableSessionId: string): ResourceKey => ({
  hostIdentity: "host-1",
  provider: "com.cotal.claude",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId,
  resourceGeneration: "g-1",
});
const binding = (resourceKey: ResourceKey, bindingId: string, operationId: string, state: "managed" | "released") => ({
  bindingId,
  resourceKey,
  incarnationProof: { nativeHostIncarnation: "h-1", sessionIncarnation: bindingId, evidence: { pid: bindingId } },
  controllerEpoch: 7,
  managerPrincipal: PRINCIPAL,
  mode: "cooperative-exclusive" as const,
  rights: ["control", "release"] as const,
  state,
  operationId,
  desiredRevision: 1,
});
const opBase = (resourceKey: ResourceKey, operationId: string, bindingId: string) => ({
  operationId,
  resourceKey,
  incarnationProof: { nativeHostIncarnation: "h-1", sessionIncarnation: bindingId, evidence: { pid: bindingId } },
  bindingId,
  expectedBindingRevision: 1,
  expectedControllerEpoch: 7,
  authenticatedActor: "u_alice.operator",
  action: "release" as const,
  intendedResult: { bindingState: "released", nativeState: "preserved" },
});
const coopProof = {
  kind: "dispatcher-retirement" as const,
  admissionClosed: true as const,
  dispatcherSettled: true as const,
  retiredStatePersisted: true as const,
  liveRequestCollector: "complete" as const,
  unprovenLiveRequestIds: [] as const,
  proves: "cooperative-retirement" as const,
};
const nativeProof = {
  kind: "receiver-receipt" as const,
  receiver: "native-1",
  highestEpoch: 7,
  proves: "native-effect" as const,
};

const lookup = (managerPrincipal = PRINCIPAL) => queryNativeLifecycleBindingsWithAuthority({
  server: SERVERS, space, dataAccount, managerPrincipal, log: quiet,
});

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

  console.log("A. production lookup keeps an unproven released row live");
  const empty = await lookup();
  c("production lookup of an empty store is known-empty, not unknown", empty.status === "known" && empty.bindings.length === 0, empty);

  const unprovenRes = resource("s-unproven");
  await createRecordEntry(kv, sessionBindingKey(unprovenRes), binding(unprovenRes, "binding-unproven", "op-unproven", "released"));
  const unproven = await lookup();
  c("PRODUCTION CALLER queryNativeLifecycleBindingsWithAuthority: released-unproven stays live",
    unproven.status === "known" && unproven.bindings.some((row) => row.bindingId === "binding-unproven"),
    unproven);

  console.log("B. matching receipts complete the released label");
  const nativeRes = resource("s-native");
  const nativePrepared = await prepareSessionOperation(kv, opBase(nativeRes, "op-native", "binding-native"));
  await updateSessionOperation(kv, {
    ...nativePrepared.record,
    state: "terminal-success",
    result: { bindingState: "released" },
    proofOrigin: nativeProof,
  }, (await kv.get(sessionOperationKey(nativeRes, "op-native")))!.revision);
  await createRecordEntry(kv, sessionBindingKey(nativeRes), binding(nativeRes, "binding-native", "op-native", "released"));
  const afterNative = await lookup();
  c("native-effect proven release is not live",
    afterNative.status === "known"
      && !afterNative.bindings.some((row) => row.bindingId === "binding-native")
      && afterNative.bindings.some((row) => row.bindingId === "binding-unproven"),
    afterNative);

  const coopBareRes = resource("s-coop-bare");
  const coopBarePrepared = await prepareSessionOperation(kv, opBase(coopBareRes, "op-coop-bare", "binding-coop-bare"));
  await updateSessionOperation(kv, {
    ...coopBarePrepared.record,
    state: "terminal-success",
    result: { bindingState: "released" },
    proofOrigin: coopProof,
  }, (await kv.get(sessionOperationKey(coopBareRes, "op-coop-bare")))!.revision);
  await createRecordEntry(kv, sessionBindingKey(coopBareRes), binding(coopBareRes, "binding-coop-bare", "op-coop-bare", "released"));
  const afterCoopBare = await lookup();
  c("cooperative-retirement without preserved native lifetime remains live",
    afterCoopBare.status === "known" && afterCoopBare.bindings.some((row) => row.bindingId === "binding-coop-bare"),
    afterCoopBare);

  const coopOkRes = resource("s-coop-ok");
  const coopOkPrepared = await prepareSessionOperation(kv, opBase(coopOkRes, "op-coop-ok", "binding-coop-ok"));
  await updateSessionOperation(kv, {
    ...coopOkPrepared.record,
    state: "terminal-success",
    result: { bindingState: "released", nativeState: "preserved" },
    proofOrigin: coopProof,
  }, (await kv.get(sessionOperationKey(coopOkRes, "op-coop-ok")))!.revision);
  await createRecordEntry(kv, sessionBindingKey(coopOkRes), binding(coopOkRes, "binding-coop-ok", "op-coop-ok", "released"));
  const afterCoopOk = await lookup();
  c("fully-validated cooperative release with preserved native lifetime does not block shutdown",
    afterCoopOk.status === "known" && !afterCoopOk.bindings.some((row) => row.bindingId === "binding-coop-ok"),
    afterCoopOk);

  console.log("C. receipt-read is a residual slice, not a second CREATE");
  const receiptGrants = nativeLifecycleReceiptReadGrants(space, "nativelookup01");
  const scanGrants = recordsScannerGrants(space, "nativelookup01");
  c("receipt-read grants carry STREAM.MSG.GET and DIRECT.GET and no CONSUMER.CREATE",
    receiptGrants.publish.some((row) => row.includes("STREAM.MSG.GET"))
      && receiptGrants.publish.some((row) => row.includes("DIRECT.GET"))
      && !receiptGrants.publish.some((row) => row.includes("CONSUMER.CREATE"))
      && !receiptGrants.publish.some((row) => row.startsWith(`$KV.cotal_records_${space}.`)),
    receiptGrants.publish);
  c("sealed scanner CREATE remains confined to oblig and sessionbinding",
    scanGrants.publish.filter((row) => row.includes("CONSUMER.CREATE")).sort().join("|") === [
      `$JS.API.CONSUMER.CREATE.KV_${recordsBucket(space)}.cotal-records-scan.$KV.cotal_records_${space}.oblig.>`,
      `$JS.API.CONSUMER.CREATE.KV_${recordsBucket(space)}.cotal-records-scan.$KV.cotal_records_${space}.sessionbinding.*`,
    ].sort().join("|"),
    scanGrants.publish);

  await wide.close();
} finally {
  await releaseBroker();
}
console.log(`\nnative-lifecycle-lookup: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
