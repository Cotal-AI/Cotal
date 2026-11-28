/**
 * The three artifact index stores on a real broker (artifact plane 4.0; the A1 engineering review's
 * E7). Setup creates them with the shape every fencing read depends on, a drifted bucket is refused
 * rather than adopted, the running-space reconcile creates them on a space that predates them, and a
 * space delete removes them. Every expected name is written out, never derived from the helper the
 * code under test uses, so a list that drops a store on both sides is still caught.
 *
 * The backup, restore and scoped teardown are covered against a real CLI stack by
 * `smoke:artifact-index-restore:live` (E15).
 *
 * Run: pnpm smoke:artifact-index-stores
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, setupSpaceStreams, deleteSpace, ensureArtifactIndexStores, reconcileArtifactIndexStores,
  spaceDeletionStreams, spaceResourceDefinitions,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = 0, fail = 0;
const c = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); } else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const streamsOf = async (): Promise<string[]> => {
  const nc = await connect({ servers });
  try {
    const names: string[] = [];
    for await (const s of (await jetstreamManager(nc)).streams.list()) names.push(s.config.name);
    return names;
  } finally { await nc.close(); }
};
const literal = (space: string) => [`KV_cotal_artattach_${space}`, `KV_cotal_artpossess_${space}`, `KV_cotal_artreserve_${space}`];

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${PORT}`);

  console.log("1. setup creates the three stores with the fencing shape");
  {
    const space = "artidx";
    await setupSpaceStreams({ servers, space });
    const present = await streamsOf();
    c("setupSpaceStreams creates all three index stores by their literal names", literal(space).every((s) => present.includes(s)), present);
    const nc = await connect({ servers });
    const jsm = await jetstreamManager(nc);
    for (const stream of literal(space)) {
      const { config } = await jsm.streams.info(stream);
      c(`${stream}: allow_direct false, file storage, history 1, no byte cap, no age`,
        config.allow_direct === false && String(config.storage) === "file" && config.max_msgs_per_subject === 1 && config.max_bytes === -1 && config.max_age === 0,
        config);
    }
    c("a second setup is idempotent", await setupSpaceStreams({ servers, space }).then(() => true, () => false));
    c("the stores are in the space's deletion list", literal(space).every((s) => spaceDeletionStreams(space).includes(s)));
    c("the stores are in the space's resource definitions",
      literal(space).every((s) => spaceResourceDefinitions(space).resources.some((r) => r.stream === s)));
    await nc.close();
  }

  console.log("2. a drifted bucket is refused, not adopted");
  {
    const space = "artdrift";
    const nc = await connect({ servers });
    // A bucket under the attachment name that allows Direct Get: every fencing read would then be
    // able to ride a follower read, so setup must refuse it.
    await new Kvm(nc).create(`cotal_artattach_${space}`, { history: 1, allow_direct: true });
    let refusal = "";
    try { await ensureArtifactIndexStores(await jetstreamManager(nc), new Kvm(nc), space); } catch (e) { refusal = (e as Error).message; }
    c("ensureArtifactIndexStores refuses a bucket that allows Direct Get, naming the bucket and the field",
      refusal.includes(`KV_cotal_artattach_${space}`) && refusal.includes("allow_direct"), refusal);
    // A bucket under the possession name with no per-row size bound: an unbounded row is a storage lever.
    await new Kvm(nc).create(`cotal_artpossess_${space}`, { history: 1, allow_direct: false });
    let sizeRefusal = "";
    try { await ensureArtifactIndexStores(await jetstreamManager(nc), new Kvm(nc), `${space}`); } catch (e) { sizeRefusal = (e as Error).message; }
    const jsm2 = await jetstreamManager(nc);
    let sizeOnly = "";
    try {
      const { assertArtifactIndexStoreConfig } = await import("../src/index.js");
      assertArtifactIndexStoreConfig((await jsm2.streams.info(`KV_cotal_artpossess_${space}`)).config, `cotal_artpossess_${space}`);
    } catch (e) { sizeOnly = (e as Error).message; }
    c("a bucket with no per-row size bound is refused, naming max_msg_size",
      sizeRefusal.length > 0 && sizeOnly.includes(`KV_cotal_artpossess_${space}`) && sizeOnly.includes("max_msg_size"), sizeOnly);
    await nc.close();
  }

  console.log("3. the running-space reconcile creates missing stores and says so");
  {
    const space = "artlate";
    await setupSpaceStreams({ servers, space });
    const nc = await connect({ servers });
    const jsm = await jetstreamManager(nc);
    // Simulate a space created before the stores existed.
    for (const stream of literal(space)) await jsm.streams.delete(stream);
    await nc.close();
    const created = await reconcileArtifactIndexStores({ servers, space });
    c("reconcile reports the three stores it created", JSON.stringify([...created].sort()) === JSON.stringify([...literal(space)].sort()), created);
    const again = await reconcileArtifactIndexStores({ servers, space });
    c("a second reconcile creates nothing and reports nothing", again.length === 0, again);
    const present = await streamsOf();
    c("the reconciled stores are present on the broker", literal(space).every((s) => present.includes(s)), present);
  }

  console.log("4. deleting the space removes the stores");
  {
    const space = "artidx";
    await deleteSpace({ servers, space });
    const present = await streamsOf();
    c("no index store survives deleteSpace", literal(space).every((s) => !present.includes(s)), present.filter((s) => s.includes(space)));
  }
} finally {
  await releaseBroker();
}

console.log(`\nartifact-index-stores: ${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
