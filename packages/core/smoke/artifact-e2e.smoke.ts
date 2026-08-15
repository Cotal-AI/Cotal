/**
 * `confirmAttach` END-TO-END, against a REAL broker — the gap the S3 review bar names first.
 *
 * WHY THIS SUITE EXISTS. `confirmAttach` had ten green suites around it and had only ever run
 * against injected dependencies. **A suite can prove its own model rather than the system**, and
 * that shape is invisible from inside the suite: every double agreed with the code because the same
 * person wrote both. The slice's worst defect — a revoked possession row reading as PRESENT — passed
 * every cell in its own suite because the KV double returned `null` for absent keys and modelled no
 * tombstone. A double more forgiving than the real thing makes wrong code look right.
 *
 * So nothing here is stubbed. The entry is a REAL message published through the SHIPPED endpoint and
 * read back from JetStream by the `seq` the publish ack returned. The possession row is a REAL KV
 * row. The lifecycle comes from the REAL ACL registry, refusing ambiguity the way production does.
 * The attachment is written to the REAL attachment bucket through the shipped insert-if-absent
 * helper. If any of those disagrees with the double it replaced, this suite is where it shows.
 *
 * WHAT THIS SUITE CANNOT SEE, stated so a green here is not over-read. It calls `confirmAttach`
 * DIRECTLY, and its broker is OPEN — the daemon holds full authority. So this proves the verb's
 * LOGIC against real storage and is structurally incapable of measuring an authorization boundary:
 * a test that holds every grant measures the code path with that boundary REMOVED. That is not
 * hypothetical here — `smoke:artifact-control-rail` was 14/14 green while the rail was UNUSABLE in
 * production, both true at once.
 *
 * The boundary is covered ELSEWHERE rather than left open, and the PAIR is the claim:
 * `smoke:artifact-rail-authz:auth` drives a REQUEST ARRIVING ON THE RAIL, on the real minted
 * delivery credential, against a JWT-auth broker. This suite proves the logic; that one proves the
 * authority. Neither alone is enough and neither substitutes for the other.
 *
 * DO NOT restore the older note that said the verb is unwired and ungranted. It described the tree
 * before `c8d66fc5` (the verb served on `handleDeliveryControl`) and `bd11fb98` (the four broker
 * subjects its call graph needs, folded into the shipped allow-list), and it outlived both as a
 * SCOPE-LIMITING comment — the kind that points a reader AWAY from coverage that already exists.
 *
 * Run: pnpm smoke:artifact-e2e   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  ARTIFACT_PART_KIND,
  ATTACH_REFUSAL,
  aclBucket,
  aclKey,
  attachmentBucket,
  attachmentKey,
  chatStream,
  confirmAttach,
  deleteSpace,
  isArtifactPart,
  isReachable,
  possessionBucket,
  parseSubject,
  possessionKey,
  principalKey,
  readAclForAlias,
  readPossession,
  setupSpaceStreams,
  type ConfirmAttachDeps,
  type CotalMessage,
} from "../src/index.js";
// From the MODULE, never the barrel. `putAttachmentIfAbsent` and `deleteAttachment` are deliberately
// not on the public surface of `@cotal-ai/core` — the sweep in `artifact-single-writer` asserts their
// absence there — so this suite reaches the module directly, exactly as `artifact-attach.ts` does.
// Importing them through `../src/index.js` is what broke this suite at module instantiation: the
// SyntaxError produced NO failing cell, it produced NO CELLS AT ALL.
import { putAttachmentIfAbsent, deleteAttachment } from "../src/artifact-index.js";
import { pickFreePort } from "./_free-port.js";
import { stopBrokerAndClean } from "./_stop-broker.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const SPACE = "arte2e";
const CHANNEL = "general";
const D = "sha256:" + "ab".repeat(32);
const LC_A = "01h" + "z".repeat(22) + "a";
const LC_B = "01h" + "z".repeat(22) + "b";

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-arte2e-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${PORT}`);

  await setupSpaceStreams({ servers, space: SPACE });

  const ep = new CotalEndpoint({
    servers, space: SPACE,
    card: { name: "putter", role: "publisher", kind: "agent" },
    heartbeatMs: 500, ttlMs: 2000,
  });
  ep.on("error", () => {});
  await ep.start();

  // The caller alias, as the control rail would present it: `<owner>.<actor>`, NO lifecycle. That
  // absence is the whole reason the possession fence has to resolve one.
  const CALLER = principalKey(ep.principal.owner, ep.principal.actor).key;

  const nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const possession = await kvm.open(possessionBucket(SPACE));
  const attach = await kvm.open(attachmentBucket(SPACE));
  const acls = await kvm.open(aclBucket(SPACE));

  // A real live ACL row, so `readAclForAlias` resolves a real lifecycle rather than a constant.
  await acls.put(aclKey(CALLER, LC_A),
    new TextEncoder().encode(JSON.stringify({ allowSubscribe: [CHANNEL], issuedAllowSubscribe: [CHANNEL] })));

  // ---- PUBLISH FOR REAL, and address the entry by the ack's seq -------------------------------
  const part = { kind: ARTIFACT_PART_KIND, name: "f.bin", mediaType: "application/octet-stream", digest: D, size: 3 };
  const ack = await ep.multicastWithAck("here is a file", { channel: CHANNEL, parts: [part] as never });
  check("the publish ack carries a usable stream sequence", Number.isInteger(ack.seq) && ack.seq > 0, ack.seq);

  // ---- REAL DEPS. Every one of these replaced a double in the hermetic suite ------------------
  const deps: ConfirmAttachDeps = {
    async entryBySeq(seq) {
      const m = await jsm.streams.getMessage(chatStream(SPACE), { seq }).catch(() => null);
      if (m === null) return null;
      return { subject: m.subject, msg: JSON.parse(new TextDecoder().decode(m.data)) as CotalMessage };
    },
    async liveLifecycleFor(caller) {
      const row = await readAclForAlias(acls, caller);
      if (row === undefined) throw new Error("no live lifecycle");
      return row.lifecycleUid;
    },
    hasPossession: (digest, principal, lifecycleUid) => readPossession(possession, digest, principal, lifecycleUid),
    putAttachment: (digest, channel, row) => putAttachmentIfAbsent(attach, digest, channel, row),
    dropAttachment: (digest, channel) => deleteAttachment(attach, digest, channel),
    now: () => 1000,
  };

  // ---- E1 — NO POSSESSION YET: the real fence refuses -----------------------------------------
  {
    const r = await confirmAttach({ digest: D, channel: CHANNEL, seq: ack.seq }, CALLER, deps);
    check("E1 confirming without a possession row is refused by the REAL fence",
      r.ok === false && r.error === ATTACH_REFUSAL.notYours, r);
    const row = await attach.get(attachmentKey(D, CHANNEL));
    check("E1b and no attachment row was written", row === null || row.operation !== "PUT", row?.operation);
  }

  // ---- E2 — WITH possession at the live lifecycle: it attaches ---------------------------------
  await possession.put(possessionKey(D, CALLER, LC_A), new TextEncoder().encode("1"));
  {
    const r = await confirmAttach({ digest: D, channel: CHANNEL, seq: ack.seq }, CALLER, deps);
    check("E2 with a REAL possession row at the live lifecycle, confirm SUCCEEDS", r.ok === true, r);
    const row = await attach.get(attachmentKey(D, CHANNEL));
    check("E2b the attachment row is in the REAL bucket", row !== null && row.operation === "PUT", row?.operation);
    const parsed = row === null ? null : JSON.parse(new TextDecoder().decode(row.value)) as { attacherLifecycleUid: string };
    check("E2c it records the LIFECYCLE that confirmed it, never the alias",
      parsed?.attacherLifecycleUid === LC_A, parsed);
  }

  // ---- E3 — IDEMPOTENT AND LIFETIME-NEUTRAL, against the real store ----------------------------
  {
    const before = await attach.get(attachmentKey(D, CHANNEL));
    // A LATER clock on the repeat, which is exactly what a second `confirmAttach` produces.
    const r = await confirmAttach(
      { digest: D, channel: CHANNEL, seq: ack.seq }, CALLER, { ...deps, now: () => 9999 });
    check("E3 a repeat confirm still reports ok", r.ok === true, r);
    const after = await attach.get(attachmentKey(D, CHANNEL));
    const parsed = after === null ? null : JSON.parse(new TextDecoder().decode(after.value)) as { createdAt: number };
    check("E3b `createdAt` is UNCHANGED on the real bucket — attach is lifetime-neutral",
      parsed?.createdAt === 1000, parsed);
    check("E3c and no second revision was stacked", after?.revision === before?.revision,
      { before: before?.revision, after: after?.revision });
  }

  // ---- E4 — THE SUCCESSION FENCE, the property the whole design exists for ----------------------
  //
  // Same ALIAS, new lifecycle — a respawned agent. It never put the bytes, so its possession lookup
  // misses. This is the cell the hermetic suite could only model with a boolean stub; here the miss
  // is produced by a real lifecycle-keyed KV read against real rows.
  {
    await acls.delete(aclKey(CALLER, LC_A));
    await acls.put(aclKey(CALLER, LC_B),
      new TextEncoder().encode(JSON.stringify({ allowSubscribe: [CHANNEL], issuedAllowSubscribe: [CHANNEL] })));
    const D2 = "sha256:" + "cd".repeat(32);
    const ack2 = await ep.multicastWithAck(
      "another file", { channel: CHANNEL, parts: [{ ...part, digest: D2 }] as never });
    // The PREDECESSOR's possession row exists — under the predecessor's lifecycle.
    await possession.put(possessionKey(D2, CALLER, LC_A), new TextEncoder().encode("1"));

    // E4-pre / E4-pre2 — THE PRECONDITIONS, ASSERTED POSITIVELY.
    //
    // The refusal collapse is working as designed: "no such entry", "not yours" and "you do not
    // possess that digest" are deliberately ONE reply. That is the security property — and it also
    // destroys the discriminator this cell was relying on. Aimed at a seq with no entry behind it,
    // E4 stayed green (M23: 14/14, with `[PROBE] E4 ENTRY MISSING` printing), so a cell named for
    // succession was satisfied by a refusal that had nothing to do with succession.
    //
    // UNDER A COLLAPSED REFUSAL VOCABULARY A REFUSAL CELL MUST ESTABLISH ITS PRECONDITIONS
    // POSITIVELY, because the reply can no longer say why. Both preconditions below are therefore
    // about the ENTRY, not about the answer: past them, the only thing left that can produce
    // `notYours` is the possession fence.
    //
    // E4-pre reads `args.seq` — the value the confirm consumes — and not `ack2.seq` again. A
    // precondition that re-derives the value independently passes happily while the confirm points
    // somewhere else, which is the hole rather than the fix.
    //
    // E4-pre2 watches the DEPENDENCY instead of the reply: whatever seq reaches the verb, this
    // records what the VERB resolved. E4-pre alone cannot see a divergence introduced at the call
    // site; this can, and it is the same shape that makes the fetch-gate and refusal-collapse
    // instruments able to see a silent reintroduction.
    const args = { digest: D2, channel: CHANNEL, seq: ack2.seq };
    const target = await deps.entryBySeq(args.seq);
    const targetPart = target?.msg.parts?.find(isArtifactPart);
    const targetSubject = target === null ? null : parseSubject(target.subject);
    check("E4-pre the seq under test RESOLVES to this caller's D2 artifact entry on this channel",
      targetPart?.digest === D2 && targetSubject?.rest === CHANNEL && targetSubject?.sender === CALLER,
      { subject: target?.subject ?? null, digest: targetPart?.digest ?? null });

    let resolved: { subject: string; msg: CotalMessage } | null | undefined;
    const watched: ConfirmAttachDeps = {
      ...deps,
      async entryBySeq(seq) { resolved = await deps.entryBySeq(seq); return resolved; },
    };
    const r = await confirmAttach(args, CALLER, watched);
    check("E4-pre2 the VERB resolved a real entry, so the refusal below came from the fence",
      resolved !== undefined && resolved !== null,
      resolved === undefined ? "entryBySeq was never called" : resolved);
    check("E4 a SAME-ALIAS successor cannot attach its predecessor's bytes",
      r.ok === false && r.error === ATTACH_REFUSAL.notYours, r);
    check("E4b (guard) the successor's live lifecycle really did resolve to the NEW uid",
      (await readAclForAlias(acls, CALLER))?.lifecycleUid === LC_B,
      (await readAclForAlias(acls, CALLER))?.lifecycleUid);
  }

  // ---- E5 — A REVOKED possession row is ABSENT, not present -------------------------------------
  // The slice's worst defect, re-proved against the real store rather than against a double that
  // modelled no tombstone: `kv.get()` on a DELETED key returns `operation: "DEL"`, not null.
  {
    const D3 = "sha256:" + "9f".repeat(32);
    await possession.put(possessionKey(D3, CALLER, LC_B), new TextEncoder().encode("1"));
    check("E5-pre the row reads as possessed while it is live",
      await readPossession(possession, D3, CALLER, LC_B), "expected true");
    await possession.delete(possessionKey(D3, CALLER, LC_B));
    const raw = await possession.get(possessionKey(D3, CALLER, LC_B));
    check("E5a (fidelity) the REAL broker returns a DEL tombstone, not null — the double did not",
      raw !== null && raw.operation === "DEL", raw === null ? "null" : raw.operation);
    check("E5b and the shipped read treats the tombstone as ABSENT",
      (await readPossession(possession, D3, CALLER, LC_B)) === false, "expected false");
  }

  await ep.stop().catch(() => {});
  await nc.close();
  await deleteSpace({ servers, space: SPACE });
} finally {
  const survivors = await stopBrokerAndClean(broker, sd);
  check("E6 TEARDOWN proved the broker dead BEFORE removing its scratch", survivors.length === 0,
    survivors);
}

console.log(`\nartifact-e2e: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
