/**
 * The lease probe must work under the credential that actually calls it, and this fixture must be
 * able to SEE a permissions refusal.
 *
 * WHY THIS EXISTS AS A SEPARATE SUITE. `manager-lease-probe` runs an open mesh, which has no
 * permissions to violate. That is not a gap in its coverage, it is a dimension its universe does not
 * contain: a `readManagerLease` implemented as a whole-bucket scan passes every one of its cells and
 * then raises an Authorization Violation on every call against a real authed mesh, because the
 * supervisor's grant on this bucket is STREAM.INFO + STREAM.MSG.GET + the `lease.*` publish, with no
 * consumer verb. That happened. This suite is the dimension.
 *
 * TWO CELLS, AND THE SECOND IS THE POINT.
 *
 *   A. The shipped probe returns the live holder under a real supervisor credential, with a cleanly
 *      stopped sibling's tombstone present. Proves the STREAM.INFO + point-get shape is inside the
 *      grant rather than merely correct in the abstract.
 *
 *   B. A consumer bind on this bucket is REFUSED, and the SAME bind on the presence bucket is
 *      ALLOWED. The allowed arm is what makes the refusal mean something: a broken probe also fails,
 *      so a refusal on its own proves nothing. Same credential, same call, one run, opposite
 *      outcomes - that is the discriminator.
 *
 * Cell B deliberately performs `liveKvEntries`' two load-bearing calls rather than importing it. It
 * is a CONTROL, not a regression assertion: it is asking whether this fixture can observe a refusal
 * at all, and the broker's enforcement IS its subject. Nothing is reverted to test it, so the
 * attachment rule that forbids transcription in a regression cell does not apply here.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:manager-lease-grant
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { KvWatchInclude } from "@nats-io/kv/internal";
import {
  CotalEndpoint, isReachable, createSpaceAuth, serverConfig, mintCreds, newIdentity,
  setupSpaceStreams, managerBucket, presenceBucket, managerLeaseKey, principalKey, DEV_OWNER,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `leasegrant-${randomUUID().slice(0, 8)}`;
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-leasegrant-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const holder = principalKey(DEV_OWNER, "sup").key;
const lease = (instanceId: string) => ({ instanceId, holder, pid: 1, root: "/tmp", runtime: "pty", since: Date.now() });

/** `liveKvEntries`' two load-bearing calls, performed rather than imported. Returns the broker's
 *  verdict on binding a push consumer over `$KV.<bucket>.>` under this credential. */
async function consumerBind(creds: string, bucket: string): Promise<"allowed" | "denied"> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(nc).open(bucket);
    const b = kv as unknown as {
      _buildCC: (f: string, i: unknown, o: unknown) => unknown;
      js: { consumers: { getPushConsumer: (s: string, cc: unknown) => Promise<unknown> } };
      stream: string;
    };
    await b.js.consumers.getPushConsumer(b.stream, b._buildCC(">", KvWatchInclude.AllHistory, { headers_only: false }));
    return "allowed";
  } catch (e) {
    const m = (e as Error).message.toLowerCase();
    return m.includes("authorization") || m.includes("permission") ? "denied" : "allowed";
  } finally {
    await nc.drain().catch(() => { /* already gone */ });
  }
}

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);

  await setupSpaceStreams(SERVERS, space, auth);
  const supCreds = await mintCreds(auth, newIdentity(), "supervisor");

  console.log("CELL A - the shipped probe under a real supervisor credential");
  const seedNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(supCreds)), maxReconnectAttempts: 0 });
  const kv = await new Kvm(seedNc).open(managerBucket(space));
  await kv.put(managerLeaseKey("stopped"), enc(lease("stopped")));
  await kv.delete(managerLeaseKey("stopped"));       // the clean-stop tombstone
  await kv.put(managerLeaseKey("liveone"), enc(lease("liveone")));

  const ep = new CotalEndpoint({
    space, servers: SERVERS, creds: supCreds, card: { name: "sup", kind: "endpoint" },
    consume: false, watchPresence: false, registerPresence: false,
  });
  await ep.start();
  const got = await ep.readManagerLease();
  check("the probe returns a holder under the real grant (no authorization violation)", got !== undefined, got);
  check("the holder is the live instance, not the released one", got?.instanceId === "liveone", got?.instanceId);
  await ep.stop().catch(() => { /* fine */ });
  await seedNc.drain().catch(() => { /* fine */ });

  console.log("CELL B - can this fixture SEE a refusal at all? (the dimension the open-mesh suite lacks)");
  const onPresence = await consumerBind(supCreds, presenceBucket(space));
  const onManager = await consumerBind(supCreds, managerBucket(space));
  check("CONTROL: the same consumer bind IS allowed on the presence bucket", onPresence === "allowed", onPresence);
  check("a consumer bind on the manager lease bucket is REFUSED", onManager === "denied", onManager);
  check("the fixture discriminates (allowed and denied differ in one run, one credential)",
    onPresence !== onManager, { presence: onPresence, manager: onManager });
} finally {
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
}

console.log(`\nmanager-lease-grant: ${pass} checks passed`);
