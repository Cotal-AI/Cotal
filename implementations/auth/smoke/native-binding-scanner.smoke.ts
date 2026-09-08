/** Focused real sealed-scanner query for native lifecycle bindings. */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  createEndpointStreams,
  createRecordEntry,
  isReachable,
  recordsKvStreamName,
  sessionBindingKey,
  type ResourceKey,
} from "@cotal-ai/core";
import { makeRecordsScannerOverConnection, recordsScannerGrants } from "../src/records-scanner.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => { if (value) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SPACE = "nativebindscan";
const CONN = "nativebindscan01";
const PORT = await pickFreePort();
const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const grants = recordsScannerGrants(SPACE, CONN);
writeFileSync(join(root, "server.conf"), [
  `port: ${PORT}`,
  `jetstream { store_dir: ${JSON.stringify(join(root, "js"))} }`,
  "authorization { users [",
  `  { user: "root", password: "pw" },`,
  `  { user: "scanner", password: "pw", permissions: { publish = ${JSON.stringify(grants.publish)}, subscribe = ${JSON.stringify(grants.subscribe)} } }`,
  "] }",
].join("\n"));
const broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
let rootNc: Awaited<ReturnType<typeof connect>> | undefined;
let scannerNc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 50 && !(await isReachable(`nats://root:pw@127.0.0.1:${PORT}`)); i++) await wait(100);
  rootNc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "root", pass: "pw" });
  const jsm = await jetstreamManager(rootNc);
  const kvm = new Kvm(rootNc);
  await createEndpointStreams(jsm, kvm, SPACE);
  const kv = await kvm.open(`cotal_records_${SPACE}`);
  scannerNc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "scanner", pass: "pw", inboxPrefix: `_INBOX_${CONN}` });
  const scanner = makeRecordsScannerOverConnection(scannerNc, SPACE);

  console.log("A. real caller reaches the sealed scanner, with known-empty distinct from failure");
  const empty = await scanner.scanNativeBindings("u_alice.manager");
  c("real sealed native-binding query proves a legacy-empty inventory", empty.status === "known" && empty.bindings.length === 0, empty);

  const resourceA: ResourceKey = { hostIdentity: "host-1", provider: "com.cotal.claude", nativeOwnerNamespace: "uid:1000", stableSessionId: "s-1", resourceGeneration: "g-1" };
  const resourceB: ResourceKey = { ...resourceA, stableSessionId: "s-2" };
  const binding = (resourceKey: ResourceKey, bindingId: string, managerPrincipal: string) => ({
    bindingId, resourceKey,
    incarnationProof: { nativeHostIncarnation: "h-1", sessionIncarnation: bindingId, evidence: { pid: bindingId } },
    controllerEpoch: 7, managerPrincipal, mode: "cooperative-exclusive", rights: ["control", "release"],
    state: "managed", operationId: `op-${bindingId}`, desiredRevision: 1,
  });
  await createRecordEntry(kv, sessionBindingKey(resourceA), binding(resourceA, "binding-a", "u_alice.manager"));
  await createRecordEntry(kv, sessionBindingKey(resourceB), binding(resourceB, "binding-b", "u_bob.manager"));
  const alice = await scanner.scanNativeBindings("u_alice.manager");
  c("closed query returns only THIS manager principal's live binding", alice.status === "known" && alice.bindings.length === 1 && alice.bindings[0]?.bindingId === "binding-a", alice);

  console.log("B. failure classes stay explicit and scanner authority remains closed");
  const malformedPrincipal = await scanner.scanNativeBindings("manager");
  c("malformed manager principal is explicit unknown, not empty", malformedPrincipal.status === "unknown" && /canonical/.test(malformedPrincipal.reason), malformedPrincipal);
  await kv.put(sessionBindingKey({ ...resourceA, stableSessionId: "s-3" }), new TextEncoder().encode("not-json"));
  const malformedRow = await scanner.scanNativeBindings("u_alice.manager");
  c("malformed binding row is explicit unknown, not empty", malformedRow.status === "unknown" && malformedRow.bindings.length === 0, malformedRow);
  let frozen = false;
  try { (scanner as { scanNativeBindings: unknown }).scanNativeBindings = async () => ({ status: "known", bindings: [] }); } catch { frozen = true; }
  c("sealed scanner handle is frozen against a silent-empty method swap", frozen && Object.isFrozen(scanner));
  c("scanner grants enumerate only oblig and sessionbinding families", grants.publish.filter((row) => row.includes("CONSUMER.CREATE")).sort().join("|") === [
    `$JS.API.CONSUMER.CREATE.${recordsKvStreamName(SPACE)}.cotal-records-scan.$KV.cotal_records_${SPACE}.oblig.>`,
    `$JS.API.CONSUMER.CREATE.${recordsKvStreamName(SPACE)}.cotal-records-scan.$KV.cotal_records_${SPACE}.sessionbinding.*`,
  ].sort().join("|"), grants.publish);
  c("scanner grants carry no records write or sessionop/sessiontrust/lifecycle enumeration", !grants.publish.some((row) => row.startsWith(`$KV.cotal_records_${SPACE}.`) || /sessionop|sessiontrust|lifecycle|uid/.test(row)), grants.publish);
  await scanner.close();
} finally {
  await scannerNc?.close().catch(() => {});
  await rootNc?.close().catch(() => {});
  await releaseBroker();
}
console.log(`\nnative-binding-scanner: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
