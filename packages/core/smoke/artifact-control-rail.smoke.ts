/**
 * `confirmAttach` OVER THE CONTROL RAIL — a request arriving on `ctl.delivery`, not a function call.
 *
 * WHY THIS SUITE EXISTS. `artifact-e2e` drives the verb with a REAL broker underneath it, and its
 * own header names what it still does not cover: the verb was never wired into
 * `handleDeliveryControl`, so every suite built its own `caller` string and its own deps by hand. A
 * killed mutation shows the test DEPENDS on the code; it does not show a real ENTRY POINT reaches
 * it. Everything below arrives as an actual NATS request on the delivery subject and is answered by
 * the shipped handler.
 *
 * WHY IT SENDS RAW REQUESTS RATHER THAN CALLING A CLIENT METHOD. The most dangerous wiring defect
 * available is the handler reading a caller-asserted `lifecycleUid`, and no client method would ever
 * offer that argument — a suite driving the client could not express the attack at all. So these
 * requests are built on the wire, which is also exactly what an attacker holding the delivery-ctl
 * publish grant can do. `W3` sends the parameter the op does not have.
 *
 * THE LIFECYCLE RULING THIS PROVES (registered before the build, at ledger `3df4579`): the handler
 * resolves the lifecycle SERVER-SIDE via the trusted registry and MUST NOT read `args.lifecycleUid`.
 * The absence of the parameter is the enforcement — a parameter that is present and ignored is a
 * defect waiting for a refactor to honour it.
 *
 * WHAT IS STILL NOT COVERED, so a green here is not over-read: this suite proves the RAIL, not the
 * GRANT. The daemon runs with the broker's full credential, so it says nothing about whether a
 * least-privilege delivery cred holds read on possession and read+create+delete on attachment and
 * NOTHING on possession-write. That asymmetry is argued in the plan and is still unproven by any
 * suite. Fan-out is also untouched.
 *
 * Run: pnpm smoke:artifact-control-rail   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  ARTIFACT_PART_KIND,
  ATTACH_REFUSAL,
  aclBucket,
  aclKey,
  attachmentBucket,
  chatStream,
  controlServiceSubject,
  CONTROL_DELIVERY,
  deleteSpace,
  isReachable,
  possessionBucket,
  possessionKey,
  principalKey,
  setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { stopBrokerAndClean } from "./_stop-broker.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

/**
 * A refusal cell asserts WHICH refusal, through a helper that cannot pass on a different one.
 * The commonest thing this catches is a fixture aimed at the wrong OBJECT, tripping another guard
 * first and producing a green cell for the wrong reason.
 */
const refuses = (name: string, reply: { ok: boolean; error?: string }, expected: string) =>
  check(name, reply.ok === false && reply.error === expected, reply);

const SPACE = "artrail";
const CHANNEL = "general";
const D = "sha256:" + "cd".repeat(32);
const LC_A = "01h" + "z".repeat(22) + "a";   // the publisher's incarnation
const LC_B = "01h" + "z".repeat(22) + "b";   // its same-alias successor

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-artrail-"));
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
  // ARM THE RAIL. This is the step every prior suite skipped: `startPlane3` binds the
  // `ctl.delivery` responder, and without it every request below would time out rather than refuse.
  await ep.startPlane3(async () => undefined);

  const CALLER = principalKey(ep.principal.owner, ep.principal.actor).key;

  const nc = await connect({ servers });
  const kvm = new Kvm(nc);
  const possession = await kvm.open(possessionBucket(SPACE));
  const acls = await kvm.open(aclBucket(SPACE));
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  /** Send a request the way a holder of the delivery-ctl publish grant would: on the subject that
   *  encodes the sender, with a payload `from` that must match it (serveControl fail-closes if it
   *  does not), and a reply target inside the sender's own subtree (the bound-reply guard). */
  const rail = async (
    op: string,
    args: Record<string, unknown>,
    who: { owner: string; actor: string } = ep.principal,
  ): Promise<{ ok: boolean; error?: string; data?: unknown }> => {
    const subject = controlServiceSubject(SPACE, CONTROL_DELIVERY, who.owner, who.actor);
    const from = { ...ep.ref(), id: principalKey(who.owner, who.actor).key };
    const m = await nc.request(subject, JSON.stringify({ op, args, from }), {
      timeout: 5000, noMux: true, reply: `${subject}.reply.${randomUUID()}`,
    });
    return m.json();
  };

  const liveAcl = (uid: string) =>
    acls.put(aclKey(CALLER, uid), enc({ allowSubscribe: [CHANNEL], issuedAllowSubscribe: [CHANNEL] }));

  // ---- the real publication, addressed by the ack's own seq ------------------------------------
  const part = { kind: ARTIFACT_PART_KIND, name: "f.bin", mediaType: "application/octet-stream", digest: D, size: 3 };
  const ack = await ep.multicastWithAck("here is a file", { channel: CHANNEL, parts: [part] as never });
  check("the publish ack carries a usable stream sequence", Number.isInteger(ack.seq) && ack.seq > 0, ack.seq);

  // The publisher's own incarnation, and the possession it EARNED by putting the bytes.
  await liveAcl(LC_A);
  await possession.put(possessionKey(D, CALLER, LC_A), enc({ ok: true }));

  // ---- W1-CONTROL — THE ARM THAT MUST SUCCEED, and it is named first for a reason --------------
  // This lane has been saved twice by the arm that must PASS rather than the arms that must refuse:
  // a fence that refuses EVERYONE is perfectly indistinguishable from a correct one across every
  // refusal cell below. A refusal suite cannot detect a verb that refuses too much; only this can.
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq });
    check("W1-CONTROL: a legitimate publisher's confirm SUCCEEDS over the rail", r.ok === true, r);
  }

  // ---- W6 — authorization is re-read FRESH, never cached across calls ---------------------------
  // The same request that just succeeded must now be refused, and the ONLY thing that changed is the
  // registry. A memoized `aclForAlias` lets a RETIRED lifecycle keep confirming attachments after
  // its successor exists, and every other cell in this suite stays green while it does.
  await acls.delete(aclKey(CALLER, LC_A));
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq });
    check("W6: the SAME confirm is refused once the ACL row is retired (fresh per call, never cached)",
      r.ok === false, r);
  }

  // ---- the successor arrives: same alias, its own incarnation, no possession --------------------
  await liveAcl(LC_B);

  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq });
    refuses("W2: a same-alias successor confirming its predecessor's digest gets notYours",
      r, ATTACH_REFUSAL.notYours);
  }

  // ---- W3 — THE ASSERTED LIFECYCLE, which is the whole reason the op has no such parameter ------
  // The successor names its PREDECESSOR's uid explicitly. If the handler read it, `hasPossession`
  // would be asked about a lifecycle that really does possess the digest and this would SUCCEED.
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq, lifecycleUid: LC_A });
    refuses("W3: an explicitly asserted predecessor lifecycleUid is IGNORED, not honoured",
      r, ATTACH_REFUSAL.notYours);
  }

  // W3b — THE STRUCTURAL HALF, and it is not redundant with W3. W3 proves the argument does not
  // WORK today; a later refactor "wiring up the unused parameter" would be an easy, well-meant
  // change that W3 catches only if someone re-runs it. This asserts the parameter is not read AT
  // ALL, which is the property the ruling actually states.
  //
  // TWO SYNTHETIC ARMS, because a source scan that matches nothing looks identical to a clean file.
  {
    const src = readFileSync(new URL("../src/endpoint.ts", import.meta.url).pathname, "utf8");
    const handler = src.slice(src.indexOf("private async deliveryConfirmAttach"));
    const body = handler.slice(0, handler.indexOf("\n  /** Serve one MEDIATED HISTORY READ"));
    const READS_ASSERTED_UID = /args\.lifecycleUid/;
    check("W3b: the confirmAttach handler never reads args.lifecycleUid — absence IS the enforcement",
      body.length > 0 && !READS_ASSERTED_UID.test(body), body.length);
    check("W3b POSITIVE CONTROL: the scan's pattern MATCHES a read of the asserted uid",
      READS_ASSERTED_UID.test('if (typeof args.lifecycleUid !== "string") return;'));
    // ANCHORED ON WHAT THE HANDLER STILL OWNS, and it has already earned its keep once: it was
    // anchored on `hasPossession`, that binding moved into the attach module so `endpoint.ts` would
    // stop naming the index mutators, and this control went red while `W3b` itself stayed green.
    // That is the whole point of it — `W3b` cannot tell "the parameter is absent" from "the slice is
    // not the code I think it is", and without this arm the scan would have quietly kept passing
    // over a body it no longer understood.
    check("W3b NEGATIVE CONTROL: the scan reached a real handler body, not an empty slice",
      body.includes("liveLifecycleFor") && body.includes("artifactIndexDeps") && body.includes("confirmAttach("),
      body.length);
  }

  // ---- W4 — a different principal entirely, refused by the sender compare before possession -----
  // Two different jobs, one collapsed name: this line rejects a DIFFERENT PRINCIPAL and is useless
  // against succession, which is what W2 covers.
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq },
      // `someoneelse`, not `someone-else`: `-` is the reserved principal name-form separator and
      // `assertValidOwnerToken` THROWS on it. A fixture that trips a guard before reaching the one
      // under test is the commonest way a refusal cell goes green for the wrong reason — here it
      // took the whole process instead, which is the loud version of the same fault.
      { owner: ep.principal.owner, actor: "someoneelse" });
    refuses("W4: a different alias gets notYours — indistinguishable from the successor's refusal",
      r, ATTACH_REFUSAL.notYours);
  }

  // ---- W5 — the caller's OWN ACL state, which is why it keeps a distinct name -------------------
  // Every other early refusal collapses because it would describe ANOTHER principal's entry.
  // `ambiguousAlias` describes the caller's own reservation breach, tells an attacker nothing about
  // a target, and an operator who must fix it cannot act on `notYours`.
  await liveAcl(LC_A); // now BOTH rows are live for the same alias
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq });
    refuses("W5: two live ACL rows refuse with the DISTINCT ambiguousAlias, not the collapsed name",
      r, ATTACH_REFUSAL.ambiguousAlias);
  }

  // ---- the rail's own shape: a malformed request names its OWN fault ----------------------------
  // These are not authorization and must not read like it — a client bug says nothing about any
  // principal's entries, so collapsing them into `notYours` would be a worse refusal, not a safer
  // one. Every check that could describe a TARGET collapses inside the verb; these cannot.
  {
    const r = await rail("confirmAttach", { channel: CHANNEL, seq: ack.seq });
    check("a blank digest is refused as a client fault, NOT as notYours",
      r.ok === false && r.error !== ATTACH_REFUSAL.notYours && /digest/.test(r.error ?? ""), r);
  }
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: 0 });
    check("a non-positive seq is refused as a client fault, NOT as notYours",
      r.ok === false && r.error !== ATTACH_REFUSAL.notYours && /seq/.test(r.error ?? ""), r);
  }
  {
    const r = await rail("confirmAttach", { digest: D, channel: "team.>", seq: ack.seq });
    check("a wildcard channel is refused as a client fault, NOT as notYours",
      r.ok === false && r.error !== ATTACH_REFUSAL.notYours, r);
  }

  // ---- and the rail still refuses an op it does not serve ---------------------------------------
  {
    const r = await rail("confirmAttachh", { digest: D, channel: CHANNEL, seq: ack.seq });
    check("an unknown op is refused by the delivery control service",
      r.ok === false && /not supported/.test(r.error ?? ""), r);
  }

  await nc.close();
  await ep.stop();
  await deleteSpace({ servers, space: SPACE });
} finally {
  await stopBrokerAndClean(broker, sd);
}

console.log(`\nartifact-control-rail: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
