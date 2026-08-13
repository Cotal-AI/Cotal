/**
 * The §8 minimum-progress contract, against a REAL broker configured below the floor.
 *
 * WRITTEN RED, BEFORE THE IMPLEMENTATION, AND THAT IS THE POINT. Two earlier versions of this rule
 * were prose, were read, were agreed with, and were wrong the same way twice — each stated a
 * constant where a computation belongs. A contract whose failures are of that shape is verified by
 * RUNNING it; a third careful read is a weaker instrument than one execution.
 *
 * WHY A LIVE BROKER RATHER THAN A STUBBED BUDGET. A stub would pass against a mistake in the very
 * computation under test — it would assert our arithmetic against our arithmetic. The floor is a
 * fact about what a broker and its client will actually accept, so the cells configure a real
 * `max_payload` and drive the real client.
 *
 * ENVELOPE-AGNOSTIC BY CONSTRUCTION. No cell names a Control-shaped width, field list, or envelope
 * name. Each supplies a `frame` builder and the module measures what it produces. Cotal #350 rules
 * the delivery verbs migrate from `ctl` to `ep`, whose envelope differs; a cell that hardcoded a
 * Control shape would be wrong today for the reason fidelity blocked and wrong tomorrow for a
 * second, independent reason.
 *
 * Run: pnpm smoke:artifact-chunk   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { connect } from "@nats-io/transport-node";
import { fitChunk, frameBytes, assertUploadFits, MinimumChunkError } from "../src/artifact-chunk.js";
import { isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

// EVERY CELL RECORDS ITS FIXTURE. This suite exists because a number was quoted without one, so it
// must not repeat the mistake: two seats on two boxes can otherwise disagree about a floor with
// neither of them wrong and no artifact to say why (Cotal #371 — this box resolves nats-server from
// PATH first).
const binPath = (() => {
  try { return execFileSync("which", ["nats-server"], { encoding: "utf8" }).trim(); }
  catch { return "(not on PATH)"; }
})();
const binVersion = (() => {
  try { return execFileSync("nats-server", ["-v"], { encoding: "utf8" }).trim(); }
  catch { return "(unknown)"; }
})();

// The envelope fixture, NAMED rather than assumed — every width that varies is stated, because each
// one of them is a way the old constant was wrong.
const FIXTURE = { uploadId: "a".repeat(32), fromId: "o.a", fromName: "agentname", role: "r" };
const uploadFrame = (seq: number) => (rawBytes: number) =>
  JSON.stringify({
    op: "putArtifactChunk",
    args: { uploadId: FIXTURE.uploadId, seq, bytes: Buffer.alloc(rawBytes).toString("base64") },
    from: { id: FIXTURE.fromId, name: FIXTURE.fromName, role: FIXTURE.role },
  });
// The REPLY envelope is a different shape and is sized separately — a fetch reply carries the bytes
// where the upload request carried them, and its wrapper is not the request's wrapper.
const fetchReplyFrame = (offset: number) => (rawBytes: number) =>
  JSON.stringify({
    ok: true,
    data: { bytes: Buffer.alloc(rawBytes).toString("base64"), offset, complete: false },
  });

console.log(`artifact-chunk fixture: nats-server ${binPath} ${binVersion}`);
console.log(`  envelope widths: uploadId=${FIXTURE.uploadId.length} from.id=${FIXTURE.fromId.length} ` +
  `from.name=${FIXTURE.fromName.length} role=${FIXTURE.role.length}`);
console.log(`  measured: zero-raw upload frame = ${Buffer.byteLength(uploadFrame(0)(0))}B, ` +
  `zero-raw fetch reply frame = ${Buffer.byteLength(fetchReplyFrame(0)(0))}B\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// TWO BROKERS, AND THE REASON IS THE FINDING THAT FORCED THIS SUITE'S FIRST REVISION.
//
// An earlier version used ONE broker at max_payload 100 for both directions, and it was wrong: at
// that setting the 149-byte upload frame is below its floor while the 59-byte reply frame is
// comfortably ABOVE its own. The reply cell asserted a refusal that a CORRECT implementation would
// never produce — so it would have gone green only against a broken one, and the way to "fix" it
// would have been to break the code until a bad cell passed.
//
// That 90-byte gap at zero payload IS the argument for fidelity's blocker: the directions have
// different envelopes, so they have different floors, and no single budget characterises both.
// Each direction now gets a broker below ITS OWN floor — a real broker, not a number passed in.
const brokers: { sd: string; proc: ReturnType<typeof spawn> }[] = [];
const startBroker = async (maxPayload: number): Promise<{ servers: string; budget: number }> => {
  const sd = mkdtempSync(join(tmpdir(), "cotal-artchunk-"));
  const port = await pickFreePort();
  writeFileSync(join(sd, "nats.conf"), `port: ${port}\nhost: 127.0.0.1\nmax_payload: ${maxPayload}\n`);
  const proc = spawn("nats-server", ["-c", join(sd, "nats.conf")], { stdio: "ignore" });
  brokers.push({ sd, proc });
  const servers = `nats://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${port} (max_payload ${maxPayload})`);
  const nc = await connect({ servers });
  const budget = Math.max(1, Math.floor((nc.info?.max_payload ?? 0) * 0.9));
  await nc.close();
  return { servers, budget };
};

try {
  // Below the UPLOAD floor (its 1-raw-byte frame is 153B). The reply frame fits here on purpose.
  const up1 = await startBroker(100);
  // Below the REPLY floor (its 1-raw-byte frame is 63B).
  const rep1 = await startBroker(64);
  const budget = up1.budget;
  console.log(`  upload-floor broker: budget=${up1.budget}   reply-floor broker: budget=${rep1.budget}\n`);
  const nc = await connect({ servers: up1.servers });

  // ---- C1: the floor refuses BY NAME rather than shrinking toward it -------------------------
  let c1: unknown;
  try { fitChunk({ budget, frame: uploadFrame(0), maxRaw: 1 << 17 }); c1 = "RETURNED"; }
  catch (e) { c1 = e; }
  check("C1 below-floor upload: refuses with MinimumChunkError, never returns a size",
    c1 instanceof MinimumChunkError, c1 instanceof Error ? c1.message.slice(0, 90) : c1);

  // ---- C2: zero is not progress -------------------------------------------------------------
  check("C2 the refusal is not a zero-length chunk (zero is a livelock, not a result)",
    !(typeof c1 === "number" && c1 === 0), c1);

  // ---- C3: the FETCH REPLY direction, below ITS OWN floor ------------------------------------
  let c3: unknown;
  try { fitChunk({ budget: rep1.budget, frame: fetchReplyFrame(0), maxRaw: 1 << 17 }); c3 = "RETURNED"; }
  catch (e) { c3 = e; }
  check("C3 below-floor fetch reply: refuses on its OWN envelope, at its OWN floor",
    c3 instanceof MinimumChunkError, c3 instanceof Error ? c3.message.slice(0, 90) : c3);

  // ---- C3b: THE INDEPENDENCE CELL — the same budget answers DIFFERENTLY per direction ---------
  // This is the cell the first revision was missing, and it is the one that actually pins
  // fidelity's blocker. At the upload-floor broker's budget the REQUEST cannot carry a byte and the
  // REPLY can, because their envelopes differ by 90 bytes at zero payload. An implementation that
  // derived one shared floor would fail HERE and nowhere else — it would pass C1 and C3 happily.
  let c3b: unknown;
  try { c3b = fitChunk({ budget, frame: fetchReplyFrame(0), maxRaw: 1 << 17 }); }
  catch (e) { c3b = e; }
  check("C3b the SAME budget that starves the request still carries a reply — sized separately",
    typeof c3b === "number" && c3b >= 1, c3b instanceof Error ? c3b.message.slice(0, 90) : c3b);

  // ---- C4: the client refuses BEFORE nc.request ----------------------------------------------
  // The daemon cannot refuse what it never receives: at this max_payload the client rejects
  // locally, so `ControlReply.error` is not a surface that exists for this failure.
  let c4 = "";
  try { assertUploadFits({ budget, frame: uploadFrame(0), rawBytes: 1 }); c4 = "ALLOWED IT"; }
  catch (e) { c4 = (e as Error).name; }
  check("C4 the upload floor refuses client-side, before any publish is attempted",
    c4 === "MinimumChunkError", c4);

  // Positive control on the client-local rejection itself: proves the hazard C4 guards is REAL on
  // this broker, so C4 is not guarding an imaginary condition.
  let local = "";
  try { await nc.request("ctl.x.y.z", uploadFrame(0)(0), { timeout: 300 }); local = "SENT"; }
  catch (e) { local = (e as Error).message; }
  check("(positive control) the raw client really does reject locally at this max_payload",
    /max_payload/.test(local), local);

  // ---- C5: DIGIT GROWTH — the boundary moves mid-transfer -------------------------------------
  // A plan computed once is a constant wearing a computation's clothes. `seq: 9` and `seq: 10` are
  // different envelopes, and a chunker that sizes once will cross the boundary underneath itself.
  const at9 = Buffer.byteLength(uploadFrame(9)(0));
  const at10 = Buffer.byteLength(uploadFrame(10)(0));
  check("C5a the envelope really does grow when seq gains a digit (the hazard is real)",
    at10 > at9, { at9, at10 });
  // Budget sits exactly between them: valid at seq 9, must be re-derived and refused at seq 10.
  const tight = at9;
  let c5b: unknown, c5c: unknown;
  try { c5b = frameBytes(uploadFrame(9), 0) <= tight; } catch (e) { c5b = e; }
  try { fitChunk({ budget: tight, frame: uploadFrame(10), maxRaw: 1 << 17 }); c5c = "RETURNED"; }
  catch (e) { c5c = e; }
  check("C5b a frame that fit at seq 9 is measured as fitting", c5b === true, c5b);
  check("C5c the SAME budget refuses at seq 10 — re-derived per call, not carried over",
    c5c instanceof MinimumChunkError, c5c instanceof Error ? c5c.message.slice(0, 90) : c5c);

  // ---- C6: MAXIMALITY — the returned size is the LARGEST that fits, not merely one that does ---
  //
  // Everything above asks "does it fit". Nothing asked "is it the biggest that fits", and those are
  // different questions: a binary search returning HALF the true boundary satisfies every cell in
  // this file — the frame fits, the size is positive, the floor still fires, refusals still refuse —
  // while every transfer on the mesh silently runs at a fraction of its intended throughput. A
  // correct-but-suboptimal result is indistinguishable from a correct one in any test that only
  // asks whether it fits, and because the failure is performance rather than correctness, nothing
  // else in the system will ever complain about it.
  //
  // The budget here is deliberately mid-sized so the BUDGET is the binding constraint. At the roomy
  // budget below, the search returns `maxRaw` and the cap is maxRaw — so `n + 1` there would probe
  // a limit this cell is not about. Asserted against the RETURNED value, never a hardcoded size.
  const tightBudget = 1000;
  const n = fitChunk({ budget: tightBudget, frame: uploadFrame(0), maxRaw: 1 << 17 });
  check("C6a the returned size fits the budget", frameBytes(uploadFrame(0), n) <= tightBudget,
    { n, bytes: frameBytes(uploadFrame(0), n), tightBudget });
  check("C6b one raw byte MORE does not fit — the size is maximal, not merely adequate",
    frameBytes(uploadFrame(0), n + 1) > tightBudget,
    { n, atN: frameBytes(uploadFrame(0), n), atNPlus1: frameBytes(uploadFrame(0), n + 1), tightBudget });

  // ---- CONTROL: a suite that only refuses is unfalsifiable ------------------------------------
  // A generous budget must produce a real, positive chunk size that actually fits.
  const roomy = 943_718;
  let ctl: unknown;
  try { ctl = fitChunk({ budget: roomy, frame: uploadFrame(0), maxRaw: 128 * 1024 }); }
  catch (e) { ctl = e; }
  check("CONTROL a roomy budget yields a positive raw size", typeof ctl === "number" && ctl >= 1, ctl);
  check("CONTROL that size's frame actually fits the budget",
    typeof ctl === "number" && Buffer.byteLength(uploadFrame(0)(ctl)) <= roomy,
    typeof ctl === "number" ? Buffer.byteLength(uploadFrame(0)(ctl)) : ctl);

  // ---- C7: assertUploadFits' OVERSIZE branch, which no cell reached ----------------------------
  //
  // C4 above uses a BELOW-FLOOR budget, so it exits at the floor check and returns before the size
  // check ever runs. `const actual = 0` — deleting the entire oversize arm — survived all thirteen
  // cells. The two failures are deliberately distinct and must stay distinct: the floor says the
  // transfer can NEVER proceed on this broker, the size says THIS call was sized wrong. Collapsing
  // them reports an unrecoverable condition as a retryable one.
  {
    const roomy2 = 943_718;
    // Above the floor by a wide margin, and the payload is far over it. So the floor check passes
    // and control reaches the branch C4 could not.
    let over: string = "ALLOWED IT";
    try { assertUploadFits({ budget: roomy2, frame: uploadFrame(0), rawBytes: 4 * 1024 * 1024 }); }
    catch (e) { over = `${(e as Error).name}:${(e as Error).message}`; }
    check("C7a an oversize chunk on a ROOMY broker is refused by the size check, not the floor",
      over.startsWith("Error:") && !over.startsWith("MinimumChunkError"), over);
    check("C7b and the refusal names the actual framed size and the budget — not a bare rejection",
      over.includes(String(roomy2)) && /frames to \d+ bytes/.test(over), over);
    // The floor is genuinely passed here, so C7a cannot be satisfied by the floor firing early.
    let floorOk = "";
    try { assertUploadFits({ budget: roomy2, frame: uploadFrame(0), rawBytes: 1 }); floorOk = "ok"; }
    catch (e) { floorOk = (e as Error).name; }
    check("C7c (guard) one raw byte DOES fit this budget, so C7a passed the floor to get there",
      floorOk === "ok", floorOk);
  }

  // ---- C8: fitChunk's maxRaw guard returns ZERO, and nothing checked the value -----------------
  // `if (maxRaw < 1) return 0` was unguarded: mutating it to `return 999` survived, because C2 only
  // ever examined the ERROR from a different fixture. A non-zero answer here would hand the caller a
  // chunk size larger than the ceiling it just declared.
  {
    const z = fitChunk({ budget: 943_718, frame: uploadFrame(0), maxRaw: 0 });
    check("C8 a maxRaw below one yields exactly zero, never a fabricated size", z === 0, z);
  }

  await nc.close();
} finally {
  // Only pids this suite recorded at creation — never a broad sweep.
  for (const b of brokers) { b.proc.kill("SIGKILL"); rmSync(b.sd, { recursive: true, force: true }); }
}

console.log(`\nartifact-chunk: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
