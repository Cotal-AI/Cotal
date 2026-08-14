/**
 * #286 — the reconciled TTL is ACTUALLY ENFORCED: a record written after the reconcile really does
 * age out. Behavioural, not configurational.
 *
 * This exists because a review found that the read-back proves less than it appeared to. On the
 * supported floor (nats-server 2.12.1) a stream update is applied in two places: the in-memory
 * `mset.cfg`, and the file store. `stream.go` ignores the error from `mset.store.UpdateConfig`, and
 * `filestore.go` restores the old config and returns BEFORE age enforcement starts when
 * `writeStreamMeta()` fails — while `STREAM.INFO` answers from the in-memory copy. So a
 * metadata-write fault can yield UPDATE OK, a read-back showing the intended `max_age`, and a store
 * with no expiry timer. Every field the reconcile can read comes from the config that DID update.
 *
 * No check at that seam can close it. The thing that can is asking the mesh a different question:
 * not "what does the config say" but "did the record go away". That is what this suite does — write
 * a key, wait past the TTL, and require it to be GONE. On a healthy server that proves enforcement
 * is running rather than merely configured. It does NOT detect the fault case (a storage-fault
 * injection would), and this file does not claim to.
 *
 * OPEN MODE deliberately: a bare connection holds KV value-write rights, so the record can be
 * written without an agent credential. The TTL'd buckets are not mode-gated — an open mesh carries
 * the same three and drifts identically — so the enforcement being proven is the same enforcement.
 *
 * Needs `nats-server` on PATH. Run: pnpm smoke:presence-ttl-expiry-open
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { isReachable, reconcileSpaceTtls, presenceBucket, deliveryBucket, managerBucket } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "./_ephemeral-only.js";

// Fence layer 4 first: this environment carries the LIVE broker in COTAL_SERVERS, and this suite
// deliberately writes records and waits for them to vanish. Against production that is a write to
// the bucket every agent's liveness depends on.
scrubAmbientBrokerEnv();

const PRESENCE_MS = 6_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
assertEphemeralBroker(SERVERS);
const space = `ttlexpiry-${randomUUID().slice(0, 8)}`;

const dir = mkdtempSync(join(tmpdir(), "cotal-ttlexpiry-"));
writeFileSync(join(dir, "server.conf"), `port: ${PORT}\njetstream { store_dir: "${join(dir, "js")}" }\n`);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => { v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? "")); };

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await sleep(200); }

  const nc = await connect({ servers: SERVERS });
  const kvm = new Kvm(nc);
  const jsm = await jetstreamManager(nc);
  const bucket = presenceBucket(space);
  const maxAge = async () => (await jsm.streams.info(`KV_${bucket}`)).config.max_age;

  // The pre-TTL deployment shape. All three TTL'd buckets are staged, not just presence: the
  // reconcile walks the whole inventory, so a fixture with one bucket would fail on a missing
  // stream rather than on the property under test.
  await kvm.create(bucket, {});
  await kvm.create(deliveryBucket(space), {});
  await kvm.create(managerBucket(space), {});
  check("staged a pre-TTL presence bucket (max_age=0)", (await maxAge()) === 0, await maxAge());

  // The fix, through the same entry point `cotal up` uses on an already-running mesh.
  await reconcileSpaceTtls({ servers: SERVERS, space });
  check("reconcile set max_age to 6s (the CONFIG claim)", (await maxAge()) === PRESENCE_MS * 1e6, (await maxAge()) / 1e6);

  // ---- the part the config cannot tell us -------------------------------------------------------
  const kv = await kvm.open(bucket);
  await kv.put("liveness.probe", new TextEncoder().encode("present"));
  const immediately = await kv.get("liveness.probe");
  check("a record written after the reconcile is readable immediately", immediately?.string() === "present");

  // Well past the 6s TTL. JetStream's age enforcement is periodic, so allow margin rather than
  // racing the sweep — a flake here would be read as a product failure.
  await sleep(PRESENCE_MS + 6_000);

  const after = await kv.get("liveness.probe");
  // THE CELL. If the store never started its expiry timer — the split-state failure the read-back
  // cannot see — the record is still here and this reddens, while `max_age` still reads 6s.
  check("...and is GONE after the TTL elapses — expiry IN FORCE on a HEALTHY server (this cell does NOT detect the metadata-write-fault case; nothing at this seam can)", after === null, after?.string());
  check("...while max_age still reports 6s (so the cell above proves enforcement, not config drift)", (await maxAge()) === PRESENCE_MS * 1e6);

  await nc.close();
  console.log(`\nPRESENCE-TTL-EXPIRY-OPEN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  srv.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
