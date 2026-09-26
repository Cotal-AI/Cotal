/**
 * The per-space artifact Object Store, proved against a REAL broker: created by space setup, agreeing
 * with the backup inventory, and gone after teardown.
 *
 * WHY THIS SUITE EXISTS. A space resource has to appear in five separate lists — create, delete,
 * grants, backup inventory, restore — and being in four of them is the failure that reads as correct.
 * The two that a hermetic test cannot catch are create and delete, because both are claims about what
 * a broker actually holds. So this enumerates the broker's OWN stream list rather than a synthesized
 * one, which is what makes `validateSpaceBackupInventory` meaningful here: the inventory is exact
 * set-equality, so running it against reality proves the create list and the backup list AGREE. A
 * check built from `spaceBackupInventory()` on both sides would pass with the store never created.
 *
 * The object store is easy to leak and impossible to reap once leaked: `$O.<bucket>.>` lives outside
 * the `cotal.<space>.>` grammar, so no space-prefix sweep sees it, and teardown is the sole
 * `STREAM.DELETE` holder — a stream missing from its explicit list can never be removed by anything.
 *
 * Run: pnpm smoke:artifact-store   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  spaceBackupInventory,
  validateSpaceBackupInventory,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

/** The stock `max_bytes` every artifact store created before the reservation was removed carries.
 *  Deliberately spelled out here rather than imported: the shipped code no longer exports it, and a
 *  test that took the number from the implementation could not tell a reconcile from a no-op. */
const LEGACY_CAP = 4 * 1024 * 1024 * 1024;
/** A cap nobody stocked: a deliberate operator decision, which setup must still refuse. */
const DELIBERATE_CAP = 3 * 1024 * 1024 * 1024;

/** A one-chunk web stream. `ReadableStream.from` is Node's own and is absent from the lib types
 *  the artifact store's `put` is declared against, so build the stream with the constructor both
 *  sides agree on rather than reaching for an undeclared static. */
const bytesStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });

const SPACE = "artstore";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; } else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${PORT}`);

  const OBJ = objectStoreStream(artifactBucket(SPACE));

  await setupSpaceStreams({ servers, space: SPACE });
  const nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);

  // The broker's own list, not one built from the inventory the assertion is about. Takes a fresh
  // connection each call: the post-teardown enumeration has to outlive the one used before it.
  const live = async (): Promise<string[]> => {
    const c = await connect({ servers });
    try {
      const m = await jetstreamManager(c);
      const names: string[] = [];
      for await (const si of m.streams.list()) names.push(si.config.name);
      return names;
    } finally { await c.close(); }
  };

  const after = await live();
  check("space setup creates the artifact object store", after.includes(OBJ), after);

  // THE LOAD-BEARING CELL. Exact set-equality between what the broker holds and what the inventory
  // declares — so a store created but unenumerated fails here, and one enumerated but never created
  // fails here too. Both directions, one assertion.
  let validated = "";
  try { validateSpaceBackupInventory(SPACE, after); validated = "ok"; }
  catch (e) { validated = (e as Error).message; }
  check("the live stream set matches the backup inventory exactly", validated === "ok", validated);

  // Excluded from the backup ARTIFACT, but still a stream the space owns and must account for.
  const inv = spaceBackupInventory(SPACE);
  check("the store is EXCLUDED from the backup artifact", inv.excluded.some((s) => s.name === OBJ));
  check("it is NOT in the backed-up set", !inv.full.includes(OBJ));
  check("its exclusion class is `artifact`", inv.excluded.find((s) => s.name === OBJ)?.class === "artifact");

  // NO BYTE CAP, and that is the point. A positive `max_bytes` is RESERVED in full against the
  // server's `max_file_store` the moment the stream is created, empty or not, so a per-space artifact
  // quota bounds how many SPACES a broker can hold rather than how many bytes a space can write (see
  // `artifact-store-no-reserve.smoke.ts`, which measures that on a capped broker). At -1 the store
  // reserves nothing and is bounded by the broker's real file-store usage, exactly like the space's
  // chat, DM, inbox and delivery streams.
  const si = await jsm.streams.info(OBJ);
  check("the store carries NO byte cap, so it reserves nothing", si.config.max_bytes === -1,
    si.config.max_bytes);
  check("its subjects are the object-store grammar", JSON.stringify(si.config.subjects) ===
    JSON.stringify([`$O.${artifactBucket(SPACE)}.C.>`, `$O.${artifactBucket(SPACE)}.M.>`]), si.config.subjects);
  // Hitting the bound must REFUSE the write, never evict older artifacts: a reference published
  // yesterday quietly ceasing to resolve is the silent failure this design refuses everywhere else.
  check("it discards NEW on overflow (refuse, never evict a live artifact)", si.config.discard === "new",
    si.config.discard);

  await nc.close();

  // DRIFT. `Objm.create` is create-if-MISSING: measured, creating at max_bytes 1024 and then calling
  // create again with 4096 leaves the stream at 1024 — it neither updates nor refuses. Since
  // setupSpaceStreams is idempotent and re-runs on every `cotal up`, a bare create would adopt a
  // pre-existing or hand-shaped store FOREVER while the code read as if it had configured it.
  //
  // The cells above cannot see this — they only ever exercise FRESH creation, which is exactly why
  // this one exists. A suite that only tests the path it built is a guard that cannot fire.
  const drifted = `${SPACE}drift`;
  const dnc = await connect({ servers });
  await new Objm(jetstream(dnc)).create(artifactBucket(drifted), { max_bytes: 1024 });
  await dnc.close();
  let refused = "";
  try { await setupSpaceStreams({ servers, space: drifted }); refused = "ADOPTED IT"; }
  catch (e) { refused = (e as Error).message; }
  check("setup REFUSES a pre-existing store carrying a cap", refused.includes("has drifted"), refused);
  check("the refusal names the actual cap and the expected -1", refused.includes("max_bytes is 1024") &&
    refused.includes("expected -1"), refused);
  await deleteSpace({ servers, space: drifted });

  // THE LEGACY RECONCILE, and its boundary. A store at exactly the stock 4 GiB was created by the code
  // this change replaces and is still reserving 4 GiB of the broker's file store, so setup must
  // CONVERGE it to -1 rather than refuse it — otherwise the defect stays on every existing mesh. A cap
  // at any OTHER positive value was somebody's deliberate decision and is still refused: setup never
  // silently widens a bound it did not set. Both halves here, because either alone reads as correct.
  const legacy = `${SPACE}legacy`;
  const lnc = await connect({ servers });
  await new Objm(jetstream(lnc)).create(artifactBucket(legacy), { max_bytes: LEGACY_CAP });
  const beforeReconcile = (await (await jetstreamManager(lnc)).streams.info(objectStoreStream(artifactBucket(legacy)))).config.max_bytes;
  await lnc.close();
  check("a store planted at the legacy stock cap really holds it", beforeReconcile === LEGACY_CAP, beforeReconcile);
  let legacyErr = "";
  try { await setupSpaceStreams({ servers, space: legacy }); } catch (e) { legacyErr = (e as Error).message; }
  const rnc = await connect({ servers });
  const afterReconcile = (await (await jetstreamManager(rnc)).streams.info(objectStoreStream(artifactBucket(legacy)))).config.max_bytes;
  await rnc.close();
  check("setup RECONCILES a legacy 4 GiB store to -1 (releasing its reservation)",
    legacyErr === "" && afterReconcile === -1, `${legacyErr} max_bytes=${afterReconcile}`);
  await deleteSpace({ servers, space: legacy });

  const deliberate = `${SPACE}deliberate`;
  const pnc = await connect({ servers });
  await new Objm(jetstream(pnc)).create(artifactBucket(deliberate), { max_bytes: DELIBERATE_CAP });
  await pnc.close();
  let deliberateRefusal = "";
  try { await setupSpaceStreams({ servers, space: deliberate }); deliberateRefusal = "WIDENED A DELIBERATE CAP"; }
  catch (e) { deliberateRefusal = (e as Error).message; }
  check("setup still REFUSES a cap that is not the legacy stock value",
    deliberateRefusal.includes("has drifted") && deliberateRefusal.includes(String(DELIBERATE_CAP)), deliberateRefusal);
  const qnc = await connect({ servers });
  const untouched = (await (await jetstreamManager(qnc)).streams.info(objectStoreStream(artifactBucket(deliberate)))).config.max_bytes;
  await qnc.close();
  check("the refused store is left exactly as the operator set it", untouched === DELIBERATE_CAP, untouched);
  await deleteSpace({ servers, space: deliberate });

  // WRONG BINDING, RIGHT NUMBERS. The sharper version of the same hole: a stream under the object
  // store's NAME with the correct cap and the correct discard, but bound to other subjects, is not
  // an object store — artifact puts can never land on it. A cap-only verify adopts it and setup
  // reports SUCCESS. This cell exists because the drift cells above would pass while it happened.
  const hijack = `${SPACE}bind`;
  const hnc = await connect({ servers });
  await (await jetstreamManager(hnc)).streams.add({
    name: objectStoreStream(artifactBucket(hijack)),
    subjects: ["foreign.capture.>"],
    max_bytes: -1,             // deliberately CORRECT
    discard: "new" as never,   // deliberately CORRECT
    storage: "file" as never,
  });
  await hnc.close();
  let bindRefusal = "";
  try { await setupSpaceStreams({ servers, space: hijack }); bindRefusal = "ADOPTED A NON-STORE"; }
  catch (e) { bindRefusal = (e as Error).message; }
  check("setup REFUSES a same-name stream bound to foreign subjects", bindRefusal.includes("has drifted"),
    bindRefusal);
  check("the refusal names the subjects, not just the cap", bindRefusal.includes("foreign.capture"),
    bindRefusal);
  await deleteSpace({ servers, space: hijack });

  // WRONG FLAGS, RIGHT EVERYTHING ELSE — and the cell proves the CONSEQUENCE, not just the config
  // difference. A store with canonical subjects, cap, discard, storage and retention but
  // `allow_rollup_hdrs:false` accepts provisioning and then rejects every put, because the object
  // store replaces an object's metadata with a rollup. Green provisioning, broken feature.
  const flags = `${SPACE}flags`;
  const fnc = await connect({ servers });
  const fjsm = await jetstreamManager(fnc);
  const fb = artifactBucket(flags);
  await fjsm.streams.add({
    name: objectStoreStream(fb), subjects: [`$O.${fb}.C.>`, `$O.${fb}.M.>`],
    max_bytes: -1, discard: "new" as never, storage: "file" as never,
    retention: "limits" as never, allow_rollup_hdrs: false,
  });
  // First: prove the drift actually breaks writes, so the assertion below guards a real failure
  // rather than a cosmetic field difference.
  let putErr = "";
  try {
    const os = await new Objm(jetstream(fnc)).create(fb);
    await os.put({ name: "probe" }, bytesStream(new Uint8Array([1, 2, 3])));
  } catch (e) { putErr = (e as Error).message; }
  await fnc.close();
  check("a rollup-denied store REJECTS every put (the consequence being guarded)",
    putErr.includes("rollup not permitted"), putErr || "put unexpectedly succeeded");

  let flagRefusal = "";
  try { await setupSpaceStreams({ servers, space: flags }); flagRefusal = "ADOPTED A WRITE-BROKEN STORE"; }
  catch (e) { flagRefusal = (e as Error).message; }
  check("setup REFUSES a store that would reject every put", flagRefusal.includes("allow_rollup_hdrs"),
    flagRefusal);
  await deleteSpace({ servers, space: flags });

  // max_age: the consequence again rather than the field. A put SUCCEEDS and the bytes are gone
  // moments later, while every reference already published survives - a dangling-reference wave
  // arriving from a config field instead of from GC.
  const aged = `${SPACE}aged`;
  const anc = await connect({ servers });
  const ab = artifactBucket(aged);
  await (await jetstreamManager(anc)).streams.add({
    name: objectStoreStream(ab), subjects: [`$O.${ab}.C.>`, `$O.${ab}.M.>`],
    max_bytes: -1, discard: "new" as never, storage: "file" as never,
    retention: "limits" as never, allow_rollup_hdrs: true, max_age: 1_000_000_000,
  });
  const aos = await new Objm(jetstream(anc)).create(ab);
  await aos.put({ name: "vanishing" }, bytesStream(new Uint8Array([1, 2, 3])));
  await wait(1800);
  const aged_state = (await (await jetstreamManager(anc)).streams.info(objectStoreStream(ab))).state.messages;
  await anc.close();
  check("an aged store silently DROPS a stored artifact (the consequence being guarded)",
    aged_state === 0, `messages still ${aged_state}`);
  let ageRefusal = "";
  try { await setupSpaceStreams({ servers, space: aged }); ageRefusal = "ADOPTED A LOSSY STORE"; }
  catch (e) { ageRefusal = (e as Error).message; }
  check("setup REFUSES a store that expires artifacts", ageRefusal.includes("max_age"), ageRefusal);
  await deleteSpace({ servers, space: aged });

  // A hidden message limit refusing artifacts long before the broker is full: loud rather than silent,
  // but still a bound nobody configured. One 1-byte object costs 2 messages (chunk + meta), so
  // max_msgs=2 admits exactly one artifact while the whole file store sits free.
  const capped = `${SPACE}capped`;
  const cnc = await connect({ servers });
  const cb = artifactBucket(capped);
  await (await jetstreamManager(cnc)).streams.add({
    name: objectStoreStream(cb), subjects: [`$O.${cb}.C.>`, `$O.${cb}.M.>`],
    max_bytes: -1, discard: "new" as never, storage: "file" as never,
    retention: "limits" as never, allow_rollup_hdrs: true, max_msgs: 2,
  });
  const cos = await new Objm(jetstream(cnc)).create(cb);
  await cos.put({ name: "first" }, bytesStream(new Uint8Array([1])));
  let secondErr = "";
  try { await cos.put({ name: "second" }, bytesStream(new Uint8Array([1]))); }
  catch (e) { secondErr = (e as Error).message; }
  await cnc.close();
  check("a message-capped store refuses a second artifact with the file store free",
    secondErr.length > 0, secondErr || "second put unexpectedly succeeded");
  let capRefusal = "";
  try { await setupSpaceStreams({ servers, space: capped }); capRefusal = "ADOPTED A HIDDEN-LIMIT STORE"; }
  catch (e) { capRefusal = (e as Error).message; }
  check("setup REFUSES a store whose real bound is not the broker's file store", capRefusal.includes("max_msgs"),
    capRefusal);
  await deleteSpace({ servers, space: capped });

  await deleteSpace({ servers, space: SPACE });
  const gone = await live();
  check("teardown removes the object store", !gone.includes(OBJ), gone);
  check("teardown leaves no space stream behind", gone.length === 0, gone);
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`\nartifact-store: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
