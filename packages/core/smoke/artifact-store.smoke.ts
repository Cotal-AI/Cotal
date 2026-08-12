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
  ARTIFACT_STORE_MAX_BYTES,
} from "../src/index.js";

const SPACE = "artstore";
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-artstore-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
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

  // PRE-EXISTING GAP, NOT AN ACCEPTED ONE. `setupSpaceStreams` also creates the two SPEC 13.12
  // authority stores via `ensureAuthorityStores`, and they are in NEITHER the backup inventory NOR
  // `deleteSpace`'s explicit array — verified absent on origin/main, so this predates the artifact
  // plane. Live consequences today: `validateSpaceBackupInventory` against a real space throws
  // `unexpected [...]`, and `cotal down -f` leaks both buckets permanently, since teardown is the
  // sole STREAM.DELETE holder. Subtracted HERE, by name, so this suite still guards the artifact
  // store's own five-list membership instead of being weakened to accommodate someone else's hole.
  // Reported to the control-surface owners; when they are enumerated, DELETE THESE TWO LINES and the
  // assertions below tighten automatically.
  // Matched by PREFIX, not by exact name: the gap is per-space, so every space this suite creates
  // leaks its own pair. Naming only the first space's would have quietly re-reddened the moment a
  // second space appeared — which is exactly what happened when the drift case was added.
  const isUnenumeratedAuthority = (n: string) =>
    n.startsWith("KV_cotal_auth_") || n.startsWith("KV_cotal_records_");
  const minusKnown = (names: string[]) => names.filter((n) => !isUnenumeratedAuthority(n));

  const after = await live();
  check("space setup creates the artifact object store", after.includes(OBJ), after);

  // THE LOAD-BEARING CELL. Exact set-equality between what the broker holds and what the inventory
  // declares — so a store created but unenumerated fails here, and one enumerated but never created
  // fails here too. Both directions, one assertion.
  let validated = "";
  try { validateSpaceBackupInventory(SPACE, minusKnown(after)); validated = "ok"; }
  catch (e) { validated = (e as Error).message; }
  check("the live stream set matches the backup inventory exactly", validated === "ok", validated);

  // Excluded from the backup ARTIFACT, but still a stream the space owns and must account for.
  const inv = spaceBackupInventory(SPACE);
  check("the store is EXCLUDED from the backup artifact", inv.excluded.some((s) => s.name === OBJ));
  check("it is NOT in the backed-up set", !inv.full.includes(OBJ));
  check("its exclusion class is `artifact`", inv.excluded.find((s) => s.name === OBJ)?.class === "artifact");

  // The quota is the only thing bounding artifact storage: a fresh bucket ships max_bytes -1 and the
  // space account is provisioned disk_storage -1, so an unset cap is unbounded growth, not a default.
  const si = await jsm.streams.info(OBJ);
  check("the store carries an EXPLICIT max_bytes", si.config.max_bytes === ARTIFACT_STORE_MAX_BYTES,
    si.config.max_bytes);
  check("its max_bytes is not the unbounded default", si.config.max_bytes !== -1);
  check("its subjects are the object-store grammar", JSON.stringify(si.config.subjects) ===
    JSON.stringify([`$O.${artifactBucket(SPACE)}.C.>`, `$O.${artifactBucket(SPACE)}.M.>`]), si.config.subjects);
  // Hitting the cap must REFUSE the write, never evict older artifacts: a reference published
  // yesterday quietly ceasing to resolve is the silent failure this design refuses everywhere else.
  check("it discards NEW on overflow (refuse, never evict a live artifact)", si.config.discard === "new",
    si.config.discard);

  await nc.close();

  // DRIFT. `Objm.create` is create-if-MISSING: measured, creating at max_bytes 1024 and then calling
  // create again with 4096 leaves the stream at 1024 — it neither updates nor refuses. Since
  // setupSpaceStreams is idempotent and re-runs on every `cotal up`, a bare create would adopt a
  // pre-existing or hand-widened store FOREVER while the code read as if it enforced a cap. An
  // unenforced cap is not a smaller cap, it is no cap: account disk is provisioned unlimited.
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
  check("setup REFUSES a pre-existing store whose cap has drifted", refused.includes("has drifted"), refused);
  check("the refusal names the actual and expected caps", refused.includes("1024") &&
    refused.includes(String(ARTIFACT_STORE_MAX_BYTES)), refused);
  await deleteSpace({ servers, space: drifted });

  // WRONG BINDING, RIGHT NUMBERS. The sharper version of the same hole: a stream under the object
  // store's NAME with the correct cap and the correct discard, but bound to other subjects, is not
  // an object store — artifact puts can never land on it. A cap-only verify adopts it and setup
  // reports SUCCESS. This cell exists because the drift cells above would pass while it happened.
  const hijack = `${SPACE}bind`;
  const hnc = await connect({ servers });
  await (await jetstreamManager(hnc)).streams.add({
    name: objectStoreStream(artifactBucket(hijack)),
    subjects: ["foreign.capture.>"],
    max_bytes: ARTIFACT_STORE_MAX_BYTES,   // deliberately CORRECT
    discard: "new" as never,               // deliberately CORRECT
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
    max_bytes: ARTIFACT_STORE_MAX_BYTES, discard: "new" as never, storage: "file" as never,
    retention: "limits" as never, allow_rollup_hdrs: false,
  });
  // First: prove the drift actually breaks writes, so the assertion below guards a real failure
  // rather than a cosmetic field difference.
  let putErr = "";
  try {
    const os = await new Objm(jetstream(fnc)).create(fb);
    await os.put({ name: "probe" }, ReadableStream.from([new Uint8Array([1, 2, 3])]));
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

  await deleteSpace({ servers, space: SPACE });
  const gone = await live();
  check("teardown removes the object store", !gone.includes(OBJ), gone);
  check("teardown leaves no space stream behind, bar the known-unenumerated pair",
    minusKnown(gone).length === 0, gone);
  // Stated rather than asserted: this suite EXPECTS the leak below until it is fixed elsewhere. If
  // this line ever prints nothing, the gap closed and KNOWN_UNENUMERATED should go.
  if (gone.some(isUnenumeratedAuthority))
    console.log("  ! pre-existing leak (Cotal #356), not this slice:", gone.filter(isUnenumeratedAuthority).join(", "));
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nartifact-store: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
