/**
 * Mediated channel-history read (Track D, D3, PHASE 1, SLICE 1) — RED FIRST.
 *
 * NOT a capability gap. A read-only connection can already page history today — measured, not
 * assumed: an `observer`-profile connection with no `lifecycleUid` returns messages from
 * `channelHistory`. It does so by holding **raw consumer-create on the chat stream**, which is
 * exactly what SPEC's "Mediated reads (normative)" rule refuses an untrusted holder: no raw
 * consumer / `DIRECT.GET` / `STREAM.MSG.GET`; those reads come from the trusted reader onto the
 * caller's own confined rail.
 *
 * So `readHistory` is a PRIVILEGE REDUCTION that aligns the code with a normative rule, served by
 * the delivery daemon on the rail it already owns (`ctl.delivery.<owner>.<actor>`, beside
 * `durableJoin`/`listMemberships`). The caller never names itself: `serveControl` fail-closes unless
 * the payload sender matches the broker-authenticated subject.
 *
 * Phase 1 is ADDITIVE — it adds the mediated path and removes nothing. Taking consumer-create away
 * from the observer profile is Phase 2, held and brokered separately, because the dashboard reads
 * history through that grant today.
 *
 * **SLICE 1 IS CURSORLESS.** Newest-N plus a `complete` flag, matching `channelHistory`'s existing
 * shape so the two production callers are a drop-in migration. Cursors are slice 2 (scale), and the
 * property that justifies the feature does not need them — see below. An earlier revision of this
 * file asserted cursor-from-START paging (`items[0] === "scrollback line 1"` for `limit: 2`); that
 * was the wrong shape twice over, since newest-N returns the LAST two, and it is now asserted as
 * newest-N.
 *
 * TWO PROPERTIES THAT DISTINGUISH THIS FROM THE CONSUMER PATH, and the reason it is worth shipping:
 * 1. A consumer pins its authorization at CREATE time, so a revoked ACL keeps serving the open
 *    consumer. The mediator re-reads authorization PER CALL, so a revocation stops the very next
 *    read.
 * 2. SPEC §9.6: current read ACL is the effective broker credential. The mediator authorizes
 *    against the live registry row ∩ the mint-time ceiling, so a registry widen WITHOUT a remint
 *    cannot grant history the caller's JWT still broker-denies. Without (2) the verb is a new
 *    capability wearing a privilege-reduction label (panel BLOCKING at 914fd7b0).
 *
 * Run: pnpm smoke:read-history:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, mintLifecycleUid,
  serverConfig, newIdentity, setupSpaceStreams, seedChannelRegistry, principalKey, DEV_OWNER,
  type CotalMessage,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

/** A message's text lives in `parts`, not a `text` field. Asserting on `m.text` compares
 *  `undefined === undefined` for the empty case and silently passes a page that carries nothing. */
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `read-history-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-readhist-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined;
let poster: CotalEndpoint | undefined, reader: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await seedChannelRegistry({
    servers: SERVERS, space, creds: mgrCreds,
    file: { defaults: { replay: true }, channels: { ops: { replay: true }, secret: { replay: true }, bulk: { replay: true }, "ops.private": { replay: true }, bulk2: { replay: true }, many: { replay: true } } },
  });

  mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start();

  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {}); await daemon.start();
  await daemon.startPlane3((owner, lifecycleUid) => daemon!.aclForOwner(owner, lifecycleUid));

  // Backlog worth reading back.
  const pId = newIdentity();
  const uidP = mintLifecycleUid();
  const pCreds = await provisionAgent(mgr, auth, pId, { allowSubscribe: ["ops", "bulk", "many"], allowPublish: ["ops", "bulk", "many"], subscribe: ["ops", "bulk", "many"], lifecycleUid: uidP });
  poster = new CotalEndpoint({ space, servers: SERVERS, creds: pCreds, channels: ["ops", "bulk", "many"], consume: false, lifecycleUid: uidP, watchPresence: false, registerPresence: false, card: { id: pId.id, name: "poster", kind: "agent" } });
  poster.on("error", () => {}); await poster.start();
  for (let i = 1; i <= 6; i++) await poster.multicast(`scrollback line ${i}`, { channel: "ops" });
  // A backlog whose full page CANNOT fit one NATS message: 20 x ~60 KB is over the 1 MB default
  // max_payload, so a count-only bound would build a reply the broker refuses to carry.
  const fat = "x".repeat(60_000);
  for (let i = 1; i <= 20; i++) await poster.multicast(`fat ${i} ${fat}`, { channel: "bulk" });
  // More than the server-side ceiling, so the ceiling can be OBSERVED rather than trusted.
  for (let i = 1; i <= 250; i++) await poster.multicast(`many ${i}`, { channel: "many" });
  await wait(600);

  // The CALLER: an ordinary provisioned agent whose ACL admits `ops` and not `secret`. It reads
  // through the mediator, so the interesting facts are about authorization, not about reachability.
  const rId = newIdentity();
  const uidR = mintLifecycleUid();
  const rCreds = await provisionAgent(mgr, auth, rId, { allowSubscribe: ["ops", "bulk", "bulk2", "many"], subscribe: ["ops", "bulk", "bulk2", "many"], lifecycleUid: uidR });
  reader = new CotalEndpoint({ space, servers: SERVERS, creds: rCreds, channels: [], consume: false, lifecycleUid: uidR, watchPresence: false, registerPresence: false, card: { id: rId.id, name: "reader", kind: "agent" } });
  reader.on("error", () => {}); await reader.start();

  // 1. It serves a caller inside its ACL, NEWEST-N — the same shape `channelHistory` returns, so the
  // production callers migrate without re-reading their own rendering order.
  const p1 = await reader.readHistory("ops", { limit: 2 });
  check("readHistory serves an in-ACL caller", (p1.items?.length ?? 0) === 2, p1);
  check("...the NEWEST n, oldest-first within the page", p1.items?.map(textOf).join("|") === "scrollback line 5|scrollback line 6", p1.items?.map(textOf));

  // 2. THE TRUNCATION SIGNAL IS HONEST. "there is older history behind this page" and "this is the
  // whole conversation" are different answers, and a UI that cannot tell them apart renders the
  // first as start-of-history. That is the cursorless form of the loud-truncation requirement.
  check("...and says it is NOT complete while older history remains", p1.complete === false, p1);

  const whole = await reader.readHistory("ops", { limit: 50 });
  check("a read that reaches the start of retained history says complete", whole.complete === true, whole);
  check("...and carries the whole backlog, oldest-first", whole.items?.length === 6 && textOf(whole.items[0]) === "scrollback line 1", whole.items?.map(textOf));

  // 3. A PAGE THAT CANNOT BE SENT IS NOT A PAGE. The reply rides one NATS message, so `limit` alone is
  // the wrong bound: a full page of large messages serializes past `max_payload`, the respond throws
  // inside serveControl's swallow, and the caller gets a bare request timeout indistinguishable from a
  // dead daemon. Before the byte bound this exact call threw "timeout" after 5s. The fix needs no new
  // vocabulary — trimming to the newest that fit IS `complete: false`.
  const t0 = Date.now();
  let fatErr = "";
  let fatPage: { items: CotalMessage[]; complete: boolean } | undefined;
  try { fatPage = await reader.readHistory("bulk", { limit: 20 }); }
  catch (e) { fatErr = (e as Error).message; }
  check("an oversized page is SERVED, not timed out", fatErr === "" && fatPage !== undefined, { fatErr, ms: Date.now() - t0 });
  check("...trimmed to the newest that fit under the payload budget", (fatPage?.items.length ?? 0) > 0 && (fatPage?.items.length ?? 0) < 20, { got: fatPage?.items.length });
  check("...and reported as incomplete, so a UI knows more remains", fatPage?.complete === false, fatPage?.complete);
  // Guarded, not `fatPage!`: when the page above fails this check must REPORT, not throw. A check that
  // crashes the runner takes every later check with it — including the ACL revocation one, the only
  // check here that must never be silently skipped.
  const fatNewest = fatPage?.items.length ? textOf(fatPage.items[fatPage.items.length - 1]) : "";
  check("...keeping the NEWEST, so the trim drops old messages not recent ones", fatNewest.startsWith("fat 20 "), { fatNewest: fatNewest.slice(0, 12) });

  // 4. A channel outside the ACL is refused, and SAYS so. An empty page would read as "no history",
  // which is the one answer a refusal must never be confusable with.
  let aclErr = "";
  let aclLeak: unknown;
  try { aclLeak = await reader.readHistory("secret", { limit: 10 }); }
  catch (e) { aclErr = (e as Error).message; }
  check("readHistory refuses a channel outside the caller's ACL", aclErr !== "", { aclLeak });
  // Assert it refused for the RIGHT REASON. `aclErr !== ""` and a loose /refus|denied/ both pass on
  // ANY error, including a wrong one — proven: with the ACL gate disabled these two still passed,
  // because the unreadable channels are empty and the handler failed further down with an unrelated
  // message that happened to contain "refused". A test that cannot tell the intended refusal from an
  // accidental one is not testing the gate.
  check("...specifically as an ACL refusal, naming the ACL", /not within your read ACL/.test(aclErr), { aclErr });

  // The OTHER confinement failure, and a different bug than the one above: a caller granted `ops` must
  // not reach `ops.private` by prefix. `channelInAllow` is NATS subject matching, where a literal token
  // does not cover a deeper subject — asserted here rather than trusted, because "the ACL entry is a
  // prefix of the channel" is exactly the shape a hand-rolled check gets wrong.
  let subErr = "";
  let subLeak: unknown;
  try { subLeak = await reader.readHistory("ops.private", { limit: 10 }); }
  catch (e) { subErr = (e as Error).message; }
  check("an ACL entry does not leak its SUB-channels (ops does not grant ops.private)", /not within your read ACL/.test(subErr), { subErr, subLeak });

  // AN EMPTY CHANNEL IS NOT AN ERROR. Found by the same mutation: because a channel with no messages
  // also "fits nothing", the payload guard refused it with "the newest message exceeds the payload
  // budget" — a confident and completely wrong explanation. Genuine emptiness must be an empty
  // COMPLETE page, distinguishable from both a refusal and a truncation.
  const empty = await reader.readHistory("bulk2", { limit: 10 }).catch((e: Error) => e);
  check("a channel with no history returns an empty COMPLETE page, not an error",
    !(empty instanceof Error) && empty.items.length === 0 && empty.complete === true, empty);

  // THE CEILING IS OBSERVED, NOT TRUSTED. A bound that is documented but never exercised is not a
  // bound — the pooled reader is privileged, so an unenforced ceiling means one request can pull a
  // channel's whole retained set through it. `many` holds 250; asking for 500 must yield 200.
  const capped = await reader.readHistory("many", { limit: 500 });
  check("a limit above the server ceiling is CLAMPED to it, not honoured", capped.items.length === 200, { got: capped.items.length });
  check("...and a clamped page is reported incomplete", capped.complete === false, capped.complete);
  check("...still the newest, so clamping does not silently page from the start",
    textOf(capped.items[capped.items.length - 1]) === "many 250", textOf(capped.items[capped.items.length - 1]));

  // A limit the caller got WRONG is refused loudly rather than quietly becoming the default. Silently
  // substituting 100 for `0` hands back a page the caller never asked for and cannot detect.
  for (const bad of [0, -1, 1.5, Number.NaN] as number[]) {
    let e = "";
    try { await reader.readHistory("ops", { limit: bad }); } catch (err) { e = (err as Error).message; }
    check(`limit ${String(bad)} is refused, not defaulted`, /limit must be a positive integer/.test(e), { bad, e });
  }
  let strErr = "";
  try { await reader.readHistory("ops", { limit: "10" as unknown as number }); } catch (e) { strErr = (e as Error).message; }
  check("a numeric STRING limit is refused (no coercion)", /limit must be a positive integer/.test(strErr), { strErr });

  const dflt = await reader.readHistory("ops");
  check("an omitted limit serves the default page", dflt.items.length === 6 && dflt.complete === true, { n: dflt.items.length });

  // 5. THE PROPERTIES THAT JUSTIFY THE FEATURE. A consumer pins its ACL at create time; the mediator
  // must (a) stop on the next read after a live-row revocation and (b) refuse a registry-only widen
  // that the caller's JWT does not back (SPEC §9.6). Fully testable without cursors.
  const p3 = await reader.readHistory("ops", { limit: 1 });
  check("a read is served while the ACL still admits the channel", (p3.items?.length ?? 0) === 1, p3);

  // 5a. Registry widen WITHOUT remint must NOT grant history. Seed a secret the reader has never
  // held in its JWT, widen only the registry row, and assert mediated read still refuses — while a
  // direct channelHistory on the same connection still gets a broker Permissions Violation. This is
  // the panel's executed BLOCKING at 914fd7b0; green here is the only proof the ceiling holds.
  {
    const sId = newIdentity();
    const uidS = mintLifecycleUid();
    const sCreds = await provisionAgent(mgr, auth, sId, {
      allowSubscribe: ["ops"], allowPublish: ["ops"], subscribe: ["ops"], lifecycleUid: uidS,
    });
    // Post the secret under a writer that may publish it.
    const wId = newIdentity();
    const uidW = mintLifecycleUid();
    const wCreds = await provisionAgent(mgr, auth, wId, {
      allowSubscribe: ["secret"], allowPublish: ["secret"], subscribe: ["secret"], lifecycleUid: uidW,
    });
    const writer = new CotalEndpoint({
      space, servers: SERVERS, creds: wCreds, channels: ["secret"], consume: false, lifecycleUid: uidW,
      watchPresence: false, registerPresence: false, card: { id: wId.id, name: "seeder", kind: "agent" },
    });
    writer.on("error", () => {});
    await writer.start();
    await writer.multicast("SECRET-CONTENT-SHOULD-NOT-LEAK", { channel: "secret" });
    await writer.stop().catch(() => {});

    const limited = new CotalEndpoint({
      space, servers: SERVERS, creds: sCreds, channels: ["ops"], consume: false, lifecycleUid: uidS,
      watchPresence: false, registerPresence: false, card: { id: sId.id, name: "limited", kind: "agent" },
    });
    limited.on("error", () => {});
    await limited.start();
    // Baseline: secret is refused under the minted ACL.
    let baseErr = "";
    try { await limited.readHistory("secret", { limit: 10 }); }
    catch (e) { baseErr = (e as Error).message; }
    check("pre-widen: secret is refused under the minted ACL", /not within your read ACL/i.test(baseErr), baseErr);

    // Plain commitAcl attempting to RAISE the ceiling must be refused by construction — if it
    // could write a wider allowSubscribe (even while leaving issued alone), durableJoin and any
    // other registry consumer would still see the raised list. Ceiling is writable ONLY via
    // reissue (provision). Predicted: throw naming the ceiling.
    let raiseErr = "";
    try { await mgr.commitAcl(principalKey(DEV_OWNER, sId.id).key, uidS, ["ops", "secret"]); }
    catch (e) { raiseErr = (e as Error).message; }
    check(
      "plain commitAcl cannot raise the mint-time ceiling (refused, not silently accepted)",
      /cannot raise ACL above mint-time ceiling/i.test(raiseErr),
      raiseErr,
    );

    // Even if a caller bypassed that throw and forced a wider row into the KV, history still
    // intersects with issued. We already refused the write; prove the read path still denies
    // secret under the unchanged row.
    let widenErr = "";
    let widenLeak: unknown;
    try { widenLeak = await limited.readHistory("secret", { limit: 10 }); }
    catch (e) { widenErr = (e as Error).message; }
    check(
      "mediated history still refuses secret after a refused raise attempt",
      /not within your read ACL/i.test(widenErr),
      { widenErr, widenLeak },
    );

    // Positive control: direct channelHistory is still broker-denied on this JWT.
    let directErr = "";
    try { await limited.channelHistory("secret", { limit: 10 }); }
    catch (e) { directErr = (e as Error).message; }
    check(
      "direct channelHistory still broker-denies secret (credential unchanged)",
      /Permissions Violation|permission/i.test(directErr),
      directErr,
    );

    // Ops still works — we did not break the live half.
    const stillOps = await limited.readHistory("ops", { limit: 1 });
    check("ops remains readable after a refused raise", (stillOps.items?.length ?? 0) >= 1, stillOps);

    // Stale-ceiling (safe direction): JWT reminted broader, registry ceiling NOT reissued.
    // Mediated must stay NARROWER than the live credential would allow — refuse secret. That is
    // the residual default_agent named: safe, and asserted rather than left to luck.
    // (channelHistory is NOT the control here: agent JWTs hold pinned chathist creates, while
    // channelHistory/streamHistory uses ordered consumers that need bare CONSUMER.CREATE.<CHAT>,
    // which agents deliberately do not hold. Comparing mediated to channelHistory would confuses
    // "credential lacks the channel" with "instrument uses the wrong create form".)
    {
      const broadCreds = await mintCreds(auth, sId, "agent", {
        allowSubscribe: ["ops", "secret"], allowPublish: ["ops", "secret"], lifecycleUid: uidS,
      });
      await limited.stop().catch(() => {});
      const broader = new CotalEndpoint({
        space, servers: SERVERS, creds: broadCreds, channels: ["ops", "secret"], consume: false,
        lifecycleUid: uidS, watchPresence: false, registerPresence: false,
        card: { id: sId.id, name: "broader", kind: "agent" },
      });
      broader.on("error", () => {});
      await broader.start();

      let staleMediatedErr = "";
      try { await broader.readHistory("secret", { limit: 10 }); }
      catch (e) { staleMediatedErr = (e as Error).message; }
      check(
        "stale ceiling: JWT broader than row → mediated stays NARROW (safe direction)",
        /not within your read ACL/i.test(staleMediatedErr),
        staleMediatedErr,
      );
      await broader.stop().catch(() => {});
    }

    // Reissue raises the ceiling: the same act as baking a broader list into the JWT. After
    // reissue, mediated admits secret. This is the legitimate broaden path — without it the
    // ceiling would be a one-way ratchet that could never follow a real remint.
    {
      await mgr.commitAcl(principalKey(DEV_OWNER, sId.id).key, uidS, ["ops", "secret"], { reissue: true });
      await wait(300);
      const after = new CotalEndpoint({
        space, servers: SERVERS, creds: sCreds, channels: ["ops"], consume: false, lifecycleUid: uidS,
        watchPresence: false, registerPresence: false, card: { id: sId.id, name: "reissued", kind: "agent" },
      });
      after.on("error", () => {});
      await after.start();
      // Note: JWT is still [ops]-only; mediated uses the daemon. Reissue without remint is the
      // operator path that trusts the provisioner — same trust as the original commitAcl write.
      // A full remint would also reissue; we isolate the ceiling raise here.
      const admitted = await after.readHistory("secret", { limit: 10 });
      const texts = (admitted.items ?? []).map(textOf).join("\n");
      check(
        "reissue raises the ceiling and mediated then admits secret",
        texts.includes("SECRET-CONTENT-SHOULD-NOT-LEAK"),
        { n: admitted.items?.length, texts: texts.slice(0, 80) },
      );
      await after.stop().catch(() => {});
    }
  }

  // 5b. Revoke on the SAME key provisioning wrote and the mediator reads: the ACL registry is keyed by
  // the PRINCIPAL (`<owner>.<actor>`), not by the raw nkey. Revoking under `rId.id` writes a row nothing
  // resolves, the original permissive row survives, and the read below succeeds — which reads exactly
  // like the mediator failing to re-check. A revocation that does not revoke turns the one check this
  // file exists for into a check of nothing.
  await mgr.commitAcl(principalKey(DEV_OWNER, rId.id).key, uidR, []);
  await wait(300);
  let revokedErr = "";
  let revokedLeak: unknown;
  try { revokedLeak = await reader.readHistory("ops", { limit: 1 }); }
  catch (e) { revokedErr = (e as Error).message; }
  check(
    "a revoked ACL stops the very NEXT read (re-read per call, not pinned at create)",
    /not within your read ACL|not permitted/i.test(revokedErr),
    { revokedErr, revokedLeak },
  );
} finally {
  await reader?.stop().catch(() => {});
  await poster?.stop().catch(() => {});
  await daemon?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  srv.kill("SIGKILL");
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
}
console.log(fail === 0 ? `\nREAD-HISTORY SMOKE OK ✅  (${pass} passed, 0 failed)` : `\nREAD-HISTORY SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
