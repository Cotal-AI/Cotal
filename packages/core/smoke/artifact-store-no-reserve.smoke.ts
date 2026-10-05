/**
 * The artifact Object Store RESERVES NOTHING, proved on a real broker with a real `max_file_store`.
 *
 * WHY THIS SUITE EXISTS. nats-server reserves a stream's whole `max_bytes` against the server's
 * `max_file_store` the moment the stream is created, empty or not, and refuses the next stream with
 * JetStream error **10047** (`insufficient storage resources available`) once the reservations would
 * pass the cap. Every space's artifact store used to be created at 4 GiB, so the per-space artifact
 * quota bounded how many SPACES a broker could hold rather than how many bytes a space could write.
 * On the owner's production host nine spaces reserved 36.56 GiB of a 36.75 GiB cap while all nine
 * artifact stores together held 6,060 bytes, and the tenth space could not be provisioned.
 *
 * Nothing hermetic can see any of this. The reservation is the BROKER's accounting, the refusal is
 * the broker's, and `reserved_storage` is a number only the broker reports — a suite that inspected
 * the config this code sends would pass with the defect fully present. So every cell here is
 * measured against a live nats-server started with a real cap, and the first one FAILS ON THE OLD
 * CODE: it provisions more spaces than the old 4 GiB reservation could ever have fitted.
 *
 * The auth-mode half is separate on purpose. The legacy reconcile is a `STREAM.UPDATE` on
 * `OBJ_<bucket>`, and under auth mode the credential doing it is the scoped `provisioner`, which
 * holds an enumerated `$JS` allow-list. Open mode proves the reconcile works; only the auth-mode
 * cell proves the credential is ALLOWED to do it, and without that grant the first `cotal up` after
 * the upgrade would die on a permissions violation on every authed mesh.
 *
 * Run: pnpm smoke:artifact-store-no-reserve   (needs nats-server on PATH; part of smoke:ci)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { Objm } from "@nats-io/obj";
import {
  isReachable,
  setupSpaceStreams,
  deleteSpace,
  artifactBucket,
  objectStoreStream,
  openServerConfig,
  serverConfig,
  createSpaceAuth,
  mintCreds,
  newIdentity,
  standaloneConnectOpts,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

/** The stock `max_bytes` an artifact store created before this change carries. Spelled out rather
 *  than imported: the shipped code no longer exports it, and a test that read the number out of the
 *  implementation could not tell a reconcile from a no-op. */
const LEGACY_CAP = 4 * 1024 * 1024 * 1024;
/** A positive cap that is NOT the stock value: somebody's deliberate decision, still refused. */
const DELIBERATE_CAP = 3 * 1024 * 1024 * 1024;
/** The broker's file-store cap for the provisioning cells.
 *
 *  CHOSEN BELOW 4 GiB, AND THAT IS WHAT MAKES THE FIRST CELL A REGRESSION TEST RATHER THAN A
 *  TAUTOLOGY. A `max_bytes` the server cannot promise is refused outright, so under the old code the
 *  FIRST space could not be provisioned at all here, never mind six. A roomier cap would not prove it:
 *  at 5 GiB the old 4 GiB create would be admitted and then reconciled away, and the cell would pass
 *  on a mutant that reinstated it. Measured — restoring the create cap under a 5 GiB cap left this
 *  cell green, and the mutation proof reported it as WRONG-RED.
 *
 *  Each space's 64 MiB membership bucket genuinely reserves, so six spaces need 384 MiB of the 1 GiB.
 *  The cap is never filled with real bytes, so the suite needs no disk for it. */
const FILE_STORE_CAP = 1024 * 1024 * 1024;
/** The reconcile phase's cap, which must be ROOMY where the provisioning phase's must be tight: it
 *  plants a store at the legacy 4 GiB on purpose, and the broker refuses a `max_bytes` it cannot
 *  promise. 6 GiB holds that reservation with room for the membership bucket beside it. */
const RECONCILE_STORE_CAP = 6 * 1024 * 1024 * 1024;
const SPACES = 6;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
/** Run `setupSpaceStreams` and RETURN its refusal rather than throwing.
 *
 *  Every phase below goes through this, and the reason is that a suite whose cells are reached by a
 *  throw cannot grade the thing it is about. `ensureArtifactStore` refuses by throwing, so a broken
 *  reconcile kills the process on the line BEFORE the cell that would have named it: the run still
 *  exits nonzero, but it reports an uncaught stack instead of a failed claim, and a mutation that
 *  removes the reconcile then reddens nothing by name. Measured: the mutation proof reported
 *  WRONG-RED for exactly that reason until each phase caught its own refusal. */
const trySetup = async (opts: { servers: string; space: string; creds?: string }): Promise<string> => {
  try { await setupSpaceStreams(opts); return ""; }
  catch (e) { return (e as Error).message; }
};

/** Start a broker, run `body`, and always tear it down. Each phase gets its own broker because
 *  `max_file_store` is fixed at start and the phases need different caps. An auth-mode broker
 *  preloads an account for `authSpace`, which must be the space the body provisions: a credential
 *  minted for one space cannot touch another's streams, which is the point of the mode. */
async function onBroker(
  what: "open" | { authSpace: string },
  cap: number | undefined,
  body: (ctx: { servers: string; creds?: string }) => Promise<void>,
): Promise<void> {
  const port = await pickFreePort();
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const servers = `nats://127.0.0.1:${port}`;
  const auth = what === "open" ? undefined : await createSpaceAuth(what.authSpace);
  const conf = join(dir, "server.conf");
  writeFileSync(conf, auth
    ? serverConfig(auth, [auth], { port, host: "127.0.0.1", storeDir: join(dir, "js"), maxFileStore: cap, transport: { kind: "plaintext" } })
    : openServerConfig({ port, host: "127.0.0.1", storeDir: join(dir, "js"), maxFileStore: cap, transport: { kind: "plaintext" } }));
  const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  const release = teardownOnSignal(broker, dir);
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
    if (!up) throw new Error(`broker never came up on ${port}`);
    // Under auth mode the identity `setupSpaceStreams` runs as is the scoped provisioner, not root.
    const creds = auth ? await mintCreds(auth, newIdentity(), "provisioner") : undefined;
    await body({ servers, creds });
  } finally {
    broker.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    release();
  }
}

/** The broker's OWN accounting, which is the whole point: `reserved_storage` from `$JS.API.INFO`. */
const reservedStorage = async (servers: string, creds?: string): Promise<number> => {
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
  try { return (await (await jetstreamManager(nc)).getAccountInfo()).reserved_storage; }
  finally { await nc.close(); }
};

const maxBytesOf = async (servers: string, space: string, creds?: string): Promise<number> => {
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
  try { return (await (await jetstreamManager(nc)).streams.info(objectStoreStream(artifactBucket(space)))).config.max_bytes; }
  finally { await nc.close(); }
};

const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });

console.log("provisioning under a real max_file_store (open mode):");
await onBroker("open", FILE_STORE_CAP, async ({ servers }) => {
  // CELL 1, the regression. Under the old code each space's store was created at 4 GiB, which is more
  // than this whole file store, so the broker refused the very first space with 10047. Six spaces are
  // reachable only because the store now reserves nothing.
  const spaces = Array.from({ length: SPACES }, (_, i) => `noresv${i}`);
  let provisioned = 0;
  let refusal = "";
  for (const space of spaces) {
    refusal = await trySetup({ servers, space });
    if (refusal !== "") break;
    provisioned++;
  }
  check(`${SPACES} spaces provision under a file store SMALLER than the old 4 GiB per-space reservation`,
    provisioned === SPACES, `${provisioned} provisioned; refusal: ${refusal}`);

  // CELL 2. The broker's own reserved figure, not a config inspection. Only the 64 MiB membership
  // buckets reserve, so the total must stay far below one space's worth of the old artifact cap.
  const reserved = await reservedStorage(servers);
  check("the broker's reserved storage does not grow by 4 GiB per space",
    reserved < LEGACY_CAP, `reserved_storage=${reserved} (${(reserved / 2 ** 30).toFixed(2)} GiB)`);
  check("...and it is exactly the membership buckets, with nothing reserved for artifacts",
    reserved === SPACES * 64 * 1024 * 1024, reserved);

  // Each store individually, so a total that happened to add up cannot hide a capped store. Only the
  // spaces that actually got provisioned exist to be read, so a partial run grades what it has rather
  // than dying on a missing stream and losing the cells below.
  const created = spaces.slice(0, provisioned);
  const caps = await Promise.all(created.map((s) => maxBytesOf(servers, s)));
  check("every space's artifact store carries max_bytes -1",
    created.length > 0 && caps.every((c) => c === -1), caps);

  // CELL 5. A round trip, because a store that reserves nothing and also stores nothing is no fix.
  const nc = await connect({ servers });
  const os = await new Objm(jetstream(nc)).create(artifactBucket(created[0] ?? spaces[0]));
  const payload = new Uint8Array([7, 8, 9, 10]);
  await os.put({ name: "round-trip" }, bytesStream(payload));
  const got = await os.get("round-trip");
  const chunks: Uint8Array[] = [];
  if (got) for await (const c of got.data as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  const read = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await nc.close();
  check("an artifact still put/get round-trips through the uncapped store",
    read.equals(Buffer.from(payload)), read);

  for (const space of created) await deleteSpace({ servers, space });
});

console.log("\nthe legacy reconcile and its boundary (open mode):");
await onBroker("open", RECONCILE_STORE_CAP, async ({ servers }) => {
  // CELL 3. A store created by the OLD code, reconciled to -1 — and the RESERVATION RELEASED, which is
  // the fact that matters and the one a config read cannot see. Measured at the broker before and after.
  const legacy = "legacyresv";
  const nc = await connect({ servers });
  await new Objm(jetstream(nc)).create(artifactBucket(legacy), { max_bytes: LEGACY_CAP });
  await nc.close();
  const before = await reservedStorage(servers);
  check("a store planted at the legacy 4 GiB reserves that capacity at the broker",
    before === LEGACY_CAP, before);

  const legacyRefusal = await trySetup({ servers, space: legacy });
  const after = await reservedStorage(servers);
  check("setup reconciles the legacy 4 GiB store to -1",
    legacyRefusal === "" && (await maxBytesOf(servers, legacy)) === -1, legacyRefusal);
  check("...and the broker RELEASES the 4 GiB it had reserved",
    after === before - LEGACY_CAP + 64 * 1024 * 1024, `before=${before} after=${after}`);

  // A second pass must be a no-op, because setup re-runs on every `cotal up`.
  const repeatRefusal = await trySetup({ servers, space: legacy });
  check("a repeat setup leaves the reconciled store alone",
    repeatRefusal === "" && (await maxBytesOf(servers, legacy)) === -1, repeatRefusal);
  await deleteSpace({ servers, space: legacy });

  // CELL 4. Any OTHER positive cap is somebody's deliberate decision. Refused, and left untouched.
  const deliberate = "deliberateresv";
  const dnc = await connect({ servers });
  await new Objm(jetstream(dnc)).create(artifactBucket(deliberate), { max_bytes: DELIBERATE_CAP });
  await dnc.close();
  const refusal = (await trySetup({ servers, space: deliberate })) || "WIDENED IT";
  check("a store at any other positive max_bytes is still REFUSED as drift",
    refusal.includes("has drifted") && refusal.includes(String(DELIBERATE_CAP)), refusal);
  check("the refused store is left exactly as it was, never silently widened",
    (await maxBytesOf(servers, deliberate)) === DELIBERATE_CAP);
  await deleteSpace({ servers, space: deliberate });
});

console.log("\nthe legacy reconcile AS THE REAL PROVISIONER CREDENTIAL (auth mode):");
const AUTH_SPACE = `authresv${randomUUID().slice(0, 6)}`;
await onBroker({ authSpace: AUTH_SPACE }, undefined, async ({ servers, creds }) => {
  // THE GRANT. `ensureArtifactStore`'s reconcile is a STREAM.UPDATE on OBJ_<bucket>, and the
  // provisioner's `$JS` allow-list is enumerated, so without that entry this throws an authorization
  // violation rather than reconciling. Reaching the assert IS the proof the grant is right.
  const space = AUTH_SPACE;
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
  await new Objm(jetstream(nc)).create(artifactBucket(space), { max_bytes: LEGACY_CAP });
  await nc.close();
  check("the provisioner can CREATE a store at the legacy cap (staging the old deployment)",
    (await maxBytesOf(servers, space, creds)) === LEGACY_CAP);

  const err = await trySetup({ servers, space, creds });
  check("the provisioner credential is AUTHORIZED to reconcile the legacy cap to -1",
    err === "" && (await maxBytesOf(servers, space, creds)) === -1, err);
});

console.log("\nthe broker's file store is the operative bound (open mode):");
// A put is refused once the broker's REAL usage reaches `max_file_store`. That is the bound that
// replaced the per-space quota, and a suite that removed a cap without showing SOMETHING still says
// no would have proved only that artifacts are unbounded.
// Above the space's own 64 MiB membership-bucket reservation, which genuinely reserves and would
// otherwise leave no room to provision the space at all — the cap has to bound the ARTIFACTS here,
// not the setup. 256 MiB leaves about 192 MiB of real capacity to fill.
const PUT_CAP = 256 * 1024 * 1024;
const MEMBERSHIP_RESERVED = 64 * 1024 * 1024;
await onBroker("open", PUT_CAP, async ({ servers }) => {
  const space = "fullresv";
  const setupRefusal = await trySetup({ servers, space });
  check("the space provisions under a cap small enough to fill (the rig, stated)", setupRefusal === "", setupRefusal);
  if (setupRefusal !== "") return;
  const nc = await connect({ servers });
  const os = await new Objm(jetstream(nc)).create(artifactBucket(space));
  const blob = new Uint8Array(8 * 1024 * 1024);
  let stored = 0, putErr = "";
  for (let i = 0; i < 60 && putErr === ""; i++) {
    try { await os.put({ name: `blob-${i}` }, bytesStream(blob)); stored++; }
    catch (e) { putErr = (e as Error).message; }
  }
  const used = (await (await jetstreamManager(nc)).streams.info(objectStoreStream(artifactBucket(space)))).state.bytes;
  await nc.close();
  check("a put is REFUSED once the broker's real file-store cap is reached", putErr !== "",
    `${stored} stored, no refusal`);
  check("...and it refused because the store was actually full, not while nearly empty",
    used > (PUT_CAP - MEMBERSHIP_RESERVED) / 2, `${used} bytes stored under a ${PUT_CAP}-byte cap`);
  check("the refusal names a resource limit rather than a per-space quota",
    /storage|resources|maximum bytes/i.test(putErr), putErr);
  await deleteSpace({ servers, space });
});

console.log(`\nartifact-store-no-reserve: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
