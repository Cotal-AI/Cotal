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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { Objm } from "@nats-io/obj";
import { Kvm } from "@nats-io/kv";
import {
  CotalEndpoint,
  chatStream,
  type CotalMessage,
  isReachable,
  setupSpaceStreams,
  deleteSpace,
  artifactBucket,
  objectStoreStream,
  spaceBackupInventory,
  validateSpaceBackupInventory,
  ARTIFACT_STORE_MAX_BYTES,
  possessionBucket,
  attachmentBucket,
  ensureArtifactIndexStores,
  putAttachmentIfAbsent,
  attachmentKey,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { stopBrokerAndClean } from "./_stop-broker.js";

const SPACE = "artstore";
const LC_PROBE = "01h" + "z".repeat(22) + "a";
const PORT = await pickFreePort();
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
  check("space setup creates the possession index store",
    after.includes(`KV_${possessionBucket(SPACE)}`), after.filter((n) => n.includes("artpossess")));
  check("space setup creates the attachment index store",
    after.includes(`KV_${attachmentBucket(SPACE)}`), after.filter((n) => n.includes("artattach")));

  // ---- THE SUBTRACTION LIST IS PINNED, AND THIS CELL IS WHY -------------------------------------
  //
  // Subtracting an unenumerated bucket by name is an honest workaround for ONE known, filed hole
  // (#356). It becomes something worse the moment it reads as the house style: the next person adding
  // a bucket meets a file where "if yours is not in the inventory, subtract it by name" is the
  // established pattern, and a third hole gets normalised in without anyone deciding to.
  //
  // So the list is pinned to exactly the known set. Growing it now REDDENS a cell and costs a
  // sentence, which makes adding to it a deliberate act rather than an edit nobody sees. When #356
  // lands, this cell fails too — correctly — and the subtraction goes away with it.
  {
    const subtracted = after.filter(isUnenumeratedAuthority).sort();
    const expected = [`KV_cotal_auth_${SPACE}`, `KV_cotal_records_${SPACE}`].sort();
    check("the by-name subtraction is EXACTLY the known #356 set — it may not grow",
      JSON.stringify(subtracted) === JSON.stringify(expected), { subtracted, expected });
  }

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

  // ---- THE INDEX BUCKETS DRIFT TOO, and for one revision nothing checked ------------------------
  //
  // The two cells above prove the OBJECT store refuses a drifted predecessor. The index buckets sat
  // fifteen lines away in the same file behind two bare `kvm.create()` calls with no verify at all —
  // and it is the index whose config the source calls LOAD-BEARING: "possession must OUTLIVE the
  // lifecycle that earned it … a ttl here would re-fire the exact branch the `confirmAttach` design
  // exists to close". The strongest paragraph in the file guarded the weakest three lines.
  //
  // THE CONSEQUENCE IS ASSERTED, NOT JUST THE REFUSAL. A cell that only checks for a thrown message
  // passes against a verify that fires on the wrong field. So this first PROVES the drifted bucket
  // really does destroy possession — the row is written and is gone a second later — and only then
  // asserts that setup refuses to adopt it. Without the first half, the refusal is a guard with no
  // demonstrated harm behind it.
  const idrift = `${SPACE}idx`;
  const inc = await connect({ servers });
  const ikvm = new Kvm(inc);
  const bad = await ikvm.create(possessionBucket(idrift), { history: 5, ttl: 500 });
  await bad.put("d.p.lc", new TextEncoder().encode("1"));
  check("PRE a possession row written to the drifted bucket is present at t=0",
    (await bad.get("d.p.lc")) !== null);
  await new Promise((r) => setTimeout(r, 1200));
  const reaped = await bad.get("d.p.lc");
  check("PRE and it is GONE 1.2s later — the ttl really does reap possession",
    reaped === null || reaped.operation === "DEL", reaped?.operation ?? reaped);
  await inc.close();
  let idxRefusal = "";
  try { await setupSpaceStreams({ servers, space: idrift }); idxRefusal = "ADOPTED A REAPING INDEX"; }
  catch (e) { idxRefusal = (e as Error).message; }
  check("setup REFUSES a pre-existing possession index whose ttl would reap it",
    idxRefusal.includes("has drifted"), idxRefusal);
  check("the refusal names the TTL, which is the load-bearing field",
    idxRefusal.includes("ttl is"), idxRefusal);
  await deleteSpace({ servers, space: idrift });

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

  // max_age: the consequence again rather than the field. A put SUCCEEDS and the bytes are gone
  // moments later, while every reference already published survives - a dangling-reference wave
  // arriving from a config field instead of from GC.
  const aged = `${SPACE}aged`;
  const anc = await connect({ servers });
  const ab = artifactBucket(aged);
  await (await jetstreamManager(anc)).streams.add({
    name: objectStoreStream(ab), subjects: [`$O.${ab}.C.>`, `$O.${ab}.M.>`],
    max_bytes: ARTIFACT_STORE_MAX_BYTES, discard: "new" as never, storage: "file" as never,
    retention: "limits" as never, allow_rollup_hdrs: true, max_age: 1_000_000_000,
  });
  const aos = await new Objm(jetstream(anc)).create(ab);
  await aos.put({ name: "vanishing" }, ReadableStream.from([new Uint8Array([1, 2, 3])]));
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

  // A hidden message limit overriding the advertised cap: loud rather than silent, but still a bound
  // nobody configured. One 1-byte object costs 2 messages (chunk + meta), so max_msgs=2 admits
  // exactly one artifact while 4 GiB sits free.
  const capped = `${SPACE}capped`;
  const cnc = await connect({ servers });
  const cb = artifactBucket(capped);
  await (await jetstreamManager(cnc)).streams.add({
    name: objectStoreStream(cb), subjects: [`$O.${cb}.C.>`, `$O.${cb}.M.>`],
    max_bytes: ARTIFACT_STORE_MAX_BYTES, discard: "new" as never, storage: "file" as never,
    retention: "limits" as never, allow_rollup_hdrs: true, max_msgs: 2,
  });
  const cos = await new Objm(jetstream(cnc)).create(cb);
  await cos.put({ name: "first" }, ReadableStream.from([new Uint8Array([1])]));
  let secondErr = "";
  try { await cos.put({ name: "second" }, ReadableStream.from([new Uint8Array([1])])); }
  catch (e) { secondErr = (e as Error).message; }
  await cnc.close();
  check("a message-capped store refuses a second artifact with the byte cap free",
    secondErr.length > 0, secondErr || "second put unexpectedly succeeded");
  let capRefusal = "";
  try { await setupSpaceStreams({ servers, space: capped }); capRefusal = "ADOPTED A HIDDEN-LIMIT STORE"; }
  catch (e) { capRefusal = (e as Error).message; }
  check("setup REFUSES a store whose real bound is not its byte cap", capRefusal.includes("max_msgs"),
    capRefusal);
  await deleteSpace({ servers, space: capped });

  // ---- the publish ack is the only addressable handle on what was just written ----------------
  //
  // The artifact plane's attach step names its own already-published message, and `seq` is the ONLY
  // way to name it: JetStream's `MsgRequest` is `{seq}` or `{last_by_subj}` — there is no
  // get-by-msgID, because the dedupe cache is a write-side filter rather than a read index. So this
  // cell pins the property that step depends on: the number `multicastWithAck` hands back really
  // does address the entry it just wrote.
  //
  // It drives the SHIPPED endpoint, not a re-implementation — a hand-rolled `js.publish` here would
  // prove the NATS client works and say nothing about our code.
  {
    const ep = new CotalEndpoint({
      servers,
      space: SPACE,
      card: { name: "acker", role: "publisher", kind: "agent" },
      heartbeatMs: 500,
      ttlMs: 2000,
    });
    ep.on("error", () => {}); // a torn-down space emits on close; not this cell's subject
    try {
      await ep.start();
      const first = await ep.multicastWithAck("first", { channel: "general" });
      const second = await ep.multicastWithAck("second", { channel: "general" });

      check("multicastWithAck returns a real stream sequence", Number.isInteger(first.seq) && first.seq > 0, first.seq);
      check("a later publish gets a higher sequence", second.seq > first.seq, [first.seq, second.seq]);
      check("an ordinary publish is not flagged duplicate", first.duplicate === false, first.duplicate);

      // The load-bearing one: read BACK by that seq and confirm it is the very message we sent.
      // Anything weaker — that seq is a number, that it increments — would survive an off-by-one
      // that makes the attach step confirm the WRONG entry, which is the failure this exists to
      // catch.
      // A FRESH connection, like `live()` above and for the same reason: the suite's `nc`/`jsm` were
      // closed before this block, and reusing them dies with ClosedConnectionError rather than
      // failing an assertion.
      const rnc = await connect({ servers });
      let round: CotalMessage | undefined;
      try {
        const stored = await (await jetstreamManager(rnc)).streams.getMessage(chatStream(SPACE), { seq: first.seq });
        round = stored ? (JSON.parse(new TextDecoder().decode(stored.data)) as CotalMessage) : undefined;
      } finally { await rnc.close(); }
      check("the returned seq addresses the entry just published", round?.id === first.msg.id,
        { wanted: first.msg.id, got: round?.id });
      check("and it is that message's content, not merely its id", round?.parts?.[0]?.kind === "text"
        && (round.parts[0] as { text?: string }).text === "first", round?.parts?.[0]);

      // `multicast` still returns the message, unchanged: 155 call sites depend on it and this
      // slice moved none of them.
      const plain = await ep.multicast("plain", { channel: "general" });
      check("multicast still returns the CotalMessage itself", typeof plain?.id === "string" && plain.channel === "general", plain);
    } finally {
      await ep.stop().catch(() => {});
    }
  }

  // ---- THE FIFTH LIST: RESTORE ---------------------------------------------------------------
  //
  // This suite's own header says a space resource must appear in five lists and that being in four
  // of them reads as correct. It then covered FOUR: it drives setup and teardown, and never restore.
  // The index stores duly shipped absent from the restore list, under a changeset asserting they
  // were in all five — the second four-of-five in one slice, caught by a reviewer rather than here.
  //
  // WHAT THIS CELL CAN AND CANNOT PROVE, stated because the distinction is the whole finding. The
  // end-to-end instrument is `smoke:backup-restore:live`, which is NOT in `smoke:ci` (it is reached
  // by `pnpm check`), so the PR gate contains no cell that drives a real restore. What is provable
  // here is the property that restore's own assertion turns on: that the shipped helper brings a
  // space MISSING its index stores back to a state the inventory validator accepts. The state below
  // is constructed to be exactly the one a restore produced before the fix — the other four excluded
  // stores present, these two absent.
  {
    const rspace = `${SPACE}restore`;
    await setupSpaceStreams({ servers, space: rspace });
    const rnc = await connect({ servers });
    const rkvm = new Kvm(rnc);
    // Reproduce the broken post-restore state: remove ONLY the two index buckets. Deleted at the
    // STREAM level, which is how the broker holds a KV bucket and how `deleteSpace` removes one.
    //
    // TOLERANT OF ALREADY-ABSENT, and that is not defensive habit — it is what keeps this block from
    // destroying the suite it belongs to. A bare `delete` throws `StreamNotFoundError` when the
    // bucket is missing, which is exactly the state a mutation of the creation helper produces: the
    // first version of this line ABORTED the whole suite under that mutation, so the cells below
    // never reported and the kill set read as smaller than it was. A step whose only job is to
    // arrange a precondition must never be able to fail the run.
    const rjsm = await jetstreamManager(rnc);
    const removeIfPresent = async (stream: string) => {
      try { await rjsm.streams.delete(stream); } catch { /* already absent: the precondition holds */ }
    };
    await removeIfPresent(`KV_${possessionBucket(rspace)}`);
    await removeIfPresent(`KV_${attachmentBucket(rspace)}`);

    // Only THIS space's streams. The broker still holds the main suite space and its drift cases,
    // and feeding the whole list to an exact-set-equality validator reports them all as `unexpected`.
    // `artstore` is a prefix of `artstorerestore`, so this must match on the SUFFIX: a `startsWith`
    // or an `includes` here would sweep the other space in and the cell would fail for a reason that
    // has nothing to do with restore.
    const mine = async () => minusKnown(await live()).filter((n) => n.endsWith(rspace));

    // NEGATIVE CONTROL FIRST — the instrument must be able to SEE the absence. Without this the
    // green below would be indistinguishable from a validator that accepts anything, which is the
    // precise shape that let four-of-five pass twice.
    //
    // AND IT ASSERTS THE EXACT NAMES, not the substrings `artpossess`/`artattach`. The first version
    // of this cell matched substrings and PASSED against a message that named the OTHER space's
    // buckets — a cell reporting a green for a reason unrelated to what it tests, written while
    // fixing a defect of that same class.
    let sawGap = "";
    try { validateSpaceBackupInventory(rspace, await mine()); sawGap = "VALIDATOR IS BLIND"; }
    catch (e) { sawGap = (e as Error).message; }
    check("the validator SEES a space whose index stores are missing (negative control)",
      sawGap.includes(`KV_${possessionBucket(rspace)}`) && sawGap.includes(`KV_${attachmentBucket(rspace)}`),
      sawGap);

    // Drive the SHIPPED helper — the one `restore.ts` now calls, not a re-implementation of it.
    await ensureArtifactIndexStores(rkvm, rspace);
    let healed = "";
    try { validateSpaceBackupInventory(rspace, await mine()); healed = "ok"; }
    catch (e) { healed = (e as Error).message; }
    check("the restore-side helper brings the space back to a validating inventory", healed === "ok", healed);
    await rnc.close();
    await deleteSpace({ servers, space: rspace });
  }

  // AND THAT RESTORE ACTUALLY CALLS IT. The cells above prove the helper works; they cannot prove
  // the restore path reaches it, and a helper nothing calls is the four-of-five failure wearing a
  // green suite. POSITIVE-CONTROLLED: the pattern must first find the call site it is known to have
  // (space setup), or a pattern that matches nothing reports the same clean result as a codebase
  // with no caller at all.
  {
    const restoreSrc = readFileSync(new URL("../../../implementations/cli/src/lib/restore.ts", import.meta.url), "utf8");
    const setupSrc = readFileSync(new URL("../src/streams.ts", import.meta.url), "utf8");
    const CALL = /\bensureArtifactIndexStores\s*\(/;
    check("(positive control) the sweep finds the known space-setup call site", CALL.test(setupSrc));
    check("the RESTORE path calls the shared index-store helper", CALL.test(restoreSrc));
  }

  // ---- INSERT-IF-ABSENT, AGAINST A REAL KV -----------------------------------------------------
  //
  // `confirmAttach` hands a fresh `createdAt` on EVERY call, so if the attachment write upserts, a
  // second confirm refreshes the clock every §7 sweep ages a row from — turning any legitimate
  // publisher into an unbounded-retention primitive without it ever calling `pin`. The contract was
  // stated in a comment and enforced NOWHERE; a driven attack rewrote `createdAt` 1000 → 9999.
  //
  // AGAINST A REAL BUCKET, and that is the point. The attach suite's double is an append-only array
  // with no create-if-absent and no revisions, so it cannot express the difference between an insert
  // and an upsert — the same "double more forgiving than the broker" shape that let a revoked
  // possession row read as present. Only `kv.create` against nats-server can refuse a live PUT.
  {
    const ispace = `${SPACE}ifabsent`;
    await setupSpaceStreams({ servers, space: ispace });
    const inc = await connect({ servers });
    const ikv = await new Kvm(inc).open(attachmentBucket(ispace));
    const D2 = "sha256:" + "ef".repeat(32);

    await putAttachmentIfAbsent(ikv, D2, "general", { attacherLifecycleUid: LC_PROBE, createdAt: 1000 });
    const first = await ikv.get(attachmentKey(D2, "general"));
    check("the first attach writes the row", first !== null && first.operation === "PUT", first?.operation);

    // The SECOND confirm, with a later clock — exactly what a repeat `confirmAttach` produces.
    await putAttachmentIfAbsent(ikv, D2, "general", { attacherLifecycleUid: LC_PROBE, createdAt: 9999 });
    const second = await ikv.get(attachmentKey(D2, "general"));
    const row = JSON.parse(new TextDecoder().decode(second!.value)) as { createdAt: number };
    check("a REPEAT attach leaves `createdAt` UNCHANGED — attach is lifetime-neutral",
      row.createdAt === 1000, row);
    check("and it did not stack a second revision", second!.revision === first!.revision,
      { first: first!.revision, second: second!.revision });

    // NEGATIVE CONTROL: the bucket really does refuse a live PUT, so the green above is the helper
    // working and not the store quietly accepting everything.
    let raw = "";
    try { await ikv.create(attachmentKey(D2, "general"), new TextEncoder().encode("x")); raw = "KV ACCEPTED A DUPLICATE CREATE"; }
    catch (e) { raw = (e as Error).message; }
    check("(negative control) the real KV refuses `create` over a live PUT",
      raw !== "KV ACCEPTED A DUPLICATE CREATE", raw);

    await inc.close();
    await deleteSpace({ servers, space: ispace });
  }

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
  const survivors = await stopBrokerAndClean(broker, sd);
  check("S39 TEARDOWN proved the broker dead BEFORE removing its scratch", survivors.length === 0,
    survivors);
}

console.log(`\nartifact-store: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
