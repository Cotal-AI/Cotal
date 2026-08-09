/**
 * R1 connect-reader ACL confinement smoke (SPEC 13.9) — proves the self-minted READER credential
 * ({@link authConnectReaderGrants}) holds EXACTLY its read surface and nothing adjacent:
 *
 *  ALLOWED: STREAM.INFO + leader STREAM.MSG.GET on both authority stores (the bind proof + the
 *  connect reads), its own scoped inbox.
 *  DENIED: any `$KV` WRITE on either store, CONSUMER.CREATE, DIRECT.GET (on records too, where
 *  the stream itself would serve it), and a foreign `_INBOX.` subscription.
 *
 * Plus the metadata-only assertion the space-wide MSG.GET residual leans on: a real ledger row's
 * key set is CLOSED and carries NO secret material.
 *
 * Run: pnpm smoke:connect-reader-acl:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { createSpaceAuth, epAuthBucket, isReachable, mintLifecycleUid, recordsBucket, serverConfig } from "@cotal-ai/core";
import { deriveOwnerToken } from "../src/index.js";
import { authConnectReaderGrants, authorizeConnectCredential, openConnectReader } from "../src/connect-reader.js";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { credRowKey, parseLedgerRow } from "../src/credential-ledger.js";
import type { ValidatedUserToken } from "../src/token.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const throwsSync = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

const space = `rdacl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), "cotal-rdacl-"));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const AUTH_STREAM = `KV_${epAuthBucket(space)}`;
const RECORDS_STREAM = `KV_${recordsBucket(space)}`;

/** "denied" iff the failure is an authorization rejection — anything else rethrows so a broken
 *  fixture (missing stream, bad subject) can never false-pass as confinement. */
async function denied(fn: () => Promise<unknown>): Promise<"allowed" | "denied"> {
  try {
    await fn();
    return "allowed";
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/permission|authorization|not authorized|timeout/i.test(msg)) return "denied";
    throw e;
  }
}

let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let readerClient: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  // ---- connId subject-hygiene: the grant builders route connId through assertInboxConnId, so a
  //      wildcard/metacharacter/dotted value can never widen the scoped `_INBOX_<connId>.>` grant.
  const okId = "abcd1234efgh";
  check("the reader grant builds a scoped inbox for a well-formed connId", authConnectReaderGrants(space, okId).subscribe[0] === `_INBOX_${okId}.>`);
  check("the writer grant builds a scoped inbox for a well-formed connId", authorityWriterGrants(space, okId).subscribe.includes(`_INBOX_${okId}.>`));
  for (const bad of [">", "*", "a.b", "", "x"]) {
    check(`reader grant REFUSES a subject-unsafe connId ${JSON.stringify(bad)}`, throwsSync(() => authConnectReaderGrants(space, bad)));
    check(`writer grant REFUSES a subject-unsafe connId ${JSON.stringify(bad)}`, throwsSync(() => authorityWriterGrants(space, bad)));
  }

  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // Seed through the REAL issuance path: stores ensured + head + open gate + stamped root row.
  writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => authorityWriterGrants(space, id), log: quiet });
  const { jetstreamManager } = await import("@nats-io/jetstream");
  const { ensureAuthorityStores } = await import("@cotal-ai/core");
  await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
  const reg = await openLifecycleRegistry(writer.nc, space);
  const uid = mintLifecycleUid();
  const credid = await ensureRootCredential(reg, { owner: OWNER, actor: "worker", lifecycleUid: uid, managerInstance: "smoke" });

  // ---- the reader connection under test ----
  readerClient = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-reader:${space}`, grants: (id) => authConnectReaderGrants(space, id), log: quiet });
  const rnc = readerClient.nc;

  // ALLOWED: the bind proof + the two leader reads (openConnectReader exercises INFO on both
  // stores; authorizeConnectCredential exercises MSG.GET on both — cred row + lifecycle head).
  const reader = await openConnectReader(rnc, space);
  check("ALLOWED: the reader binds + shape-proves both stores (STREAM.INFO)", true);
  const t = { owner: OWNER, act: { owner: OWNER, actor: "worker", scope: [], lifecycleUid: uid, credentialId: credid } } as unknown as ValidatedUserToken;
  await authorizeConnectCredential(reader, t, Date.now);
  check("ALLOWED: the connect check leader-reads the cred row AND the lifecycle head (STREAM.MSG.GET)", true);

  // DENIED: KV writes on both stores (the KV put awaits its JetStream ack, so a permission
  // rejection surfaces as an error/timeout instead of a silent fire-and-forget).
  const rkvm = new Kvm(rnc);
  const authKvR = await rkvm.open(epAuthBucket(space));
  check("DENIED: a cred-row WRITE on the auth store", (await denied(() => authKvR.put(credRowKey(uid, "forged0000000000000000000000"), new TextEncoder().encode("{}")))) === "denied");
  const recKvR = await rkvm.open(recordsBucket(space));
  check("DENIED: a lifecycle-head WRITE on the records store", (await denied(() => recKvR.put(`lifecycle.${OWNER}.worker`, new TextEncoder().encode("{}")))) === "denied");

  // DENIED: consumer creation (the reader must not be able to stand up its own scans/watches).
  check("DENIED: CONSUMER.CREATE on the auth store", (await denied(() => rnc.request(`$JS.API.CONSUMER.CREATE.${AUTH_STREAM}`, new TextEncoder().encode(JSON.stringify({ stream_name: AUTH_STREAM, config: { ack_policy: "none" } })), { timeout: 1500 }))) === "denied");

  // DENIED: DIRECT.GET — on records the STREAM would serve it (allow_direct=true), so only the
  // credential's missing grant stands between the reader and a follower-servable read.
  check("DENIED: DIRECT.GET on the records store", (await denied(() => rnc.request(`$JS.API.DIRECT.GET.${RECORDS_STREAM}`, new TextEncoder().encode(JSON.stringify({ last_by_subj: `$KV.${recordsBucket(space)}.lifecycle.${OWNER}.worker` })), { timeout: 1500 }))) === "denied");

  // DENIED: a foreign inbox subscription (reply-injection confinement: only `_INBOX_<connId>.>`).
  const foreign = await denied(async () => {
    const sub = rnc.subscribe("_INBOX.foreign.probe");
    await rnc.flush();
    await wait(300);
    // A sub permission violation kills the subscription server-side; a live one would false-pass.
    if (!sub.isClosed()) { sub.unsubscribe(); throw new Error("subscription stayed live"); }
  });
  check("DENIED: subscribing a foreign _INBOX. prefix", foreign === "allowed", "(closed by the server = denied at the sub layer)");

  // METADATA-ONLY: the row the space-wide MSG.GET residual exposes carries a CLOSED key set and
  // no secret material — pinned here so a future row-schema change that smuggles key bytes fails.
  const m = await registryStores(reg).authKv.get(credRowKey(uid, credid));
  const row = parseLedgerRow(m!.value, credRowKey(uid, credid));
  const allowedKeys = new Set(["credentialId", "holderPrincipal", "lifecycleUid", "endpoint", "sourceChain", "state", "exp"]);
  check("the ledger row's key set is CLOSED (metadata only, no secret material)",
    Object.keys(row).every((k) => allowedKeys.has(k)), Object.keys(row));

  console.log(`\nCONNECT-READER-ACL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await readerClient?.close().catch(() => {});
  await writer?.close().catch(() => {});
  srv.kill();
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
}
