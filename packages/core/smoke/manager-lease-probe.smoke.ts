/**
 * `readManagerLease` under MULTI-MANAGER: the existence probe must answer "is any manager here"
 * from the live leases, never from whichever message happens to be newest under the wildcard.
 *
 * WHY THIS EXISTS. The lease KEY was demoted from one-per-space to `lease.<instanceId>` so several
 * managers can hold a space. The probe that READS it was left on the singleton-era shape: a single
 * `last_by_subj` get over `lease.*`, which returns the newest message under the wildcard REGARDLESS
 * OF KEY. A stopping peer's DEL tombstone is newer than a live sibling's last PUT, so the probe
 * answered "no manager here" while another was alive and renewing. Every caller reads that as an
 * empty space: `cotal spawn -f` stands a SECOND manager up against the live one, and
 * `waitLeaseGone` reports the space free. The fence was moved and the thing reading it was not.
 *
 * THE TRIGGER IS A CLEAN STOP, NOT A CRASH, and getting that backwards makes this suite pass while
 * the defect is present. Only an explicit `kv.delete` (what `releaseManagerLease` does) writes a
 * tombstone. A manager whose lease TTL-expires is removed by stream limits and leaves NOTHING
 * behind, so a repro that kills a manager comes back green and argues the bug is not real. CELL 3
 * pins that asymmetry so nobody "simplifies" CELL 2 into a kill.
 *
 * THE WINDOW IS REAL BUT SHORT — a live manager's next renew (TTL/2, so <=5s) overwrites the
 * tombstone as newest and the probe self-heals. That is why this forces the ordering rather than
 * racing it: the DEL is written, then the probe is read, with nothing in between. A test that
 * waited would go green on a fixed AND a broken build.
 *
 * ASSERT ON THE REASON, NOT THE VALUE. `undefined` had three causes wearing one return: a genuinely
 * empty space, a poisoned wildcard, and any failed read at all. CELL 1/2/4 separate the first two;
 * CELL 5 covers the third, where a read that FAILED must throw rather than report absence.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:manager-lease-probe
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { CotalEndpoint, isReachable, managerBucket, managerLeaseKey, MANAGER_LEASE_KEY } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

// An OS-assigned port, not a fixed one. A hard-coded port silently hands the suite whatever broker
// already owns it: the first run of this file bound nothing, talked to a leftover AUTHED server, and
// died with an Authorization Violation before reaching a single cell. That still exits non-zero, so a
// red-first proof would have counted it as the defect reproducing.
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "leaseprobe";
const store = mkdtempSync(join(tmpdir(), "cotal-leaseprobe-"));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store], { stdio: "ignore" });
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch { /* gone */ } rmSync(store, { recursive: true, force: true }); });

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const lease = (instanceId: string) => ({ instanceId, holder: `HOLDER_${instanceId}`, pid: 1, root: "/tmp", runtime: "pty", since: Date.now() });

try {
  // `isReachable` is a PREDICATE, not a barrier. Calling it once and proceeding raced the broker's
  // bind and failed with a connection refusal that had nothing to do with the probe under test.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (await isReachable(SERVER)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`fixture broker never came up on ${SERVER} - refusing to report a result about a server that never started`);
  const nc = await connect({ servers: SERVER });
  const kvm = new Kvm(nc);
  const bucket = managerBucket(SPACE);
  const kv = await kvm.create(bucket, { ttl: 10_000 });

  // The probe under test is the SHIPPED method on a real endpoint, not a transcription of it. A
  // suite that re-implements the read proves only that the copy agrees with itself.
  const ep = new CotalEndpoint({
    space: SPACE, servers: SERVER, card: { name: "probe", kind: "endpoint" },
    consume: false, watchPresence: false, registerPresence: false,
  });
  await ep.start();

  console.log("CELL 1 — two live managers, nothing deleted (control: the probe can see a holder at all)");
  await kv.put(managerLeaseKey("aaa"), enc(lease("aaa")));
  await kv.put(managerLeaseKey("bbb"), enc(lease("bbb")));
  const both = await ep.readManagerLease();
  check("two live leases -> a holder is reported", both !== undefined, both?.instanceId);
  check("the reported holder is one of the two live instances", both !== undefined && ["aaa", "bbb"].includes(both.instanceId), both?.instanceId);

  console.log("CELL 2 — B1: a peer STOPS CLEANLY while a sibling is live (the regression)");
  // The forced ordering. `kv.delete` is exactly what `releaseManagerLease` issues, and its DEL is
  // now the newest message under `lease.*`. No wait: the next renew would repair it.
  await kv.delete(managerLeaseKey("aaa"));
  const survivor = await ep.readManagerLease();
  check("a stopped peer does NOT hide the live sibling", survivor !== undefined, survivor);
  check("the survivor reported is the one still holding a lease", survivor?.instanceId === "bbb", survivor?.instanceId);

  // The sabotage stays applied for the rest of this cell: the tombstone is still the newest message
  // under the wildcard. A fix that only got faster than the DEL would fail here.
  const jsm = await jetstreamManager(nc);
  const newest = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${MANAGER_LEASE_KEY}.*` });
  check("the tombstone is genuinely still newest under the wildcard (the sabotage held)",
    newest?.header?.get("KV-Operation") === "DEL", newest?.subject);

  console.log("CELL 3 — a TTL-EXPIRED peer leaves no tombstone (why a kill-based repro proves nothing)");
  const ttlBucket = `${bucket}ttl`;
  const kvTtl = await kvm.create(ttlBucket, { ttl: 1500 });
  await kvTtl.put(managerLeaseKey("ccc"), enc(lease("ccc")));
  await new Promise((r) => setTimeout(r, 2200));
  const afterExpiry = await jsm.streams.getMessage(`KV_${ttlBucket}`, { last_by_subj: `$KV.${ttlBucket}.${MANAGER_LEASE_KEY}.*` })
    .then((m) => m?.header?.get("KV-Operation") ?? "PUT")
    .catch(() => "NO_MESSAGE");
  check("limits-based removal writes NO DEL marker (a crashed manager cannot poison the probe)",
    afterExpiry !== "DEL", afterExpiry);

  console.log("CELL 4 — a genuinely empty space still reports absence");
  await kv.delete(managerLeaseKey("bbb"));
  const empty = await ep.readManagerLease();
  check("every lease released -> undefined, and for the right reason (the scan proved empty)",
    empty === undefined, empty);

  console.log("CELL 5 — a read that FAILED must not be reported as absence");
  // Deterministic: the broker is stopped, so the read cannot succeed. Absence and failure are
  // different answers and only one of them may be undefined.
  srv.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  let threw: unknown;
  let returned: unknown = "<did-not-return>";
  try { returned = await ep.readManagerLease(); } catch (e) { threw = e; }
  check("a failed read throws rather than answering 'no manager here'",
    threw !== undefined && returned === "<did-not-return>", { threw: (threw as Error)?.message?.slice(0, 90), returned });

  await ep.stop().catch(() => { /* broker is already gone */ });
  await nc.close().catch(() => { /* already closed */ });
} finally {
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
}

console.log(`\nmanager-lease-probe: ${pass} checks passed`);
