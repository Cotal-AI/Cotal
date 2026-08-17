/**
 * THE PAIR THE FENCE DOES NOT COVER: A NEW CALLER AND A RESPONDER THAT PREDATES IT.
 *
 * `smoke:bind-fence` grades the fence against responders that HAVE it. Every instance in that
 * fixture refuses a mismatched bind before running the command, which is why the caller may
 * re-issue there for any command at all. This suite grades the other half of the population, and
 * it is the half that decides whether the change is safe: a responder that does not know the
 * `bind` field ignores it (§5) and EXECUTES. Its reply carries no refusal marker, so it proves
 * nothing about whether the command ran — and a caller that re-issued on it would duplicate the
 * effect. The re-issue must be withheld there and only there.
 *
 * WHY IT NEEDED A HAND-ROLLED RESPONDER. `serveEndpoint` cannot produce this scenario: its fence
 * refuses a mismatched bind before the handler, so a request it EXECUTES is one whose bind matched,
 * and a matching bind is by definition not a split. The unfenced responder below therefore answers
 * the class rail itself — the same subject, queue group, subject-derived reply and attributed
 * identity the real serve boundary uses, and nothing else of it. It is what a pre-fence responder
 * looks like from the caller's side, which is all this grades.
 *
 * THE INSTRUMENTS ARE DIRECT COUNTS AT THE RESPONDER, NOT PUBLISH COUNTS. `attempts` counts the
 * requests that arrived, `executions` the ones that ran. The distinction is the whole reason this
 * file exists: under the fence a SECOND publish carries the FIRST execution, so "how many messages
 * left the caller" and "how many times did the command run" stopped agreeing — and a suite that
 * measured the first would report a caller withholding a re-issue and a responder refusing one as
 * the same event.
 *
 * Also graded here, because the same fixture is the only place they are reachable: the refusal must
 * be an answer to THIS request from THIS responder (a forged `boundTo` or `servedBy` is refused,
 * not honored — a caller acts on this marker by re-issuing, so it is derived rather than believed),
 * and a re-issue that cannot be resolved surfaces the ORIGINAL refusal rather than the resolve's
 * own timeout.
 *
 * And the COMPOSED pair (cell 6), which is the one arm needing both populations at once: a fenced
 * hop 1 authorizes a re-issue, an unfenced hop 2 RUNS it and then trips the caller's own currency
 * check. Two errors asserting opposite things, and the one that must reach the caller is the
 * second — subordinating it to the first reports `WAS NOT RUN` for a command that ran.
 *
 * Open mode, ephemeral loopback broker, no creds. Needs `nats-server` on PATH.
 * Run: pnpm smoke:unfenced-responder
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint, EpEnvelopeError, EP_BIND_REFUSED,
  compileContract, deriveReplySubject, epClassQueueGroup, epServeFilter, isRepeatSafeCommand,
  mintLifecycleUid, newIdentity, parseEndpointRequest, parseEpSubject, replyRefusedBeforeEffect,
  respondedButUnbound, DEV_OWNER,
  type EndpointReply, type EpCaller, type ResolvedService,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Declared, not implied: a live suite can end in ways that redden no line, and `fail === 0` reads
 *  as PASS in every one of them. Measured by this lane's own crash controls — a mid-run exit prints
 *  nothing at all, and an import-time throw does not even reach this handler. */
const EXPECTED_CELLS = 34;
process.on("exit", () => {
  const ran = pass + fail;
  if (ran !== EXPECTED_CELLS) {
    console.log(`\nSUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    process.exitCode = 1;
  }
});

const SPACE = "unfenced-probe";
const EP = "unfenced-svc";
const IID_REAL = "u".repeat(26);          // the incarnation that actually answers
const GHOST = "g".repeat(26);             // the incarnation the caller believes it resolved
const OTHER = "h".repeat(26);
const EPOCH = 3;

const argsContract = compileContract({ root: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { ran: { type: "boolean" } }, required: ["ran"], additionalProperties: false } });

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "unfenced-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));

const enc = new TextEncoder(), dec = new TextDecoder();
const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

/** What the hand responder does with a bind it cannot satisfy. `unfenced` is the pair under test;
 *  the rest are fenced responders whose refusal is, in one way each, not derivable by the caller. */
type Mode = "unfenced" | "fenced" | "forged-boundTo" | "forged-servedBy";
let mode: Mode = "unfenced";
/**
 * THE MODE FOR THE **NEXT** REQUEST, consumed once (cell 6 only, `null` everywhere else).
 *
 * Every arm above fixes `mode` for the whole call, so both hops of a recovery always meet a
 * responder with the SAME knowledge of the field — and the one pair that matters most cannot be
 * built that way: hop 1 fenced (so a re-issue is made at all) and hop 2 UNFENCED (so the re-issue
 * runs and then throws on the caller's own currency check). That is not a contrived shape; it is
 * what a class queue looks like mid-rolling-upgrade, and it is the shape under which re-wrapping
 * the re-issue hands the caller `WAS NOT RUN` for a command that ran.
 */
let modeAfterThisRequest: Mode | null = null;
/** THE INSTRUMENTS, and they answer two different questions. `attempts` counts every `poke` REQUEST
 *  that reached this responder — that is the caller's decision to try again, observed at the far
 *  end rather than inferred from a publish count. `executions` counts the ones that RAN. Under the
 *  fence those two stopped agreeing, and keeping both is what makes "one attempt, one execution"
 *  distinguishable from "two attempts, one execution" — the difference between a caller that
 *  withheld a re-issue and a responder that refused one. */
let attempts = 0;
let executions = 0;

const sub = nc.subscribe(epServeFilter(SPACE, "one", EP), {
  queue: epClassQueueGroup(EP),
  callback: (err, msg) => {
    if (err) return;
    const parsed = parseEpSubject(msg.subject);
    if (parsed?.plane !== "request") return;
    const env = parseEndpointRequest(JSON.parse(dec.decode(msg.data)));
    // ONLY `poke`. The class-rail filter also carries `describe`, and answering it would give this
    // endpoint a resolvable surface — which would quietly turn the fenced arm's re-issue into a
    // SUCCESS and take away the retired-endpoint case cell 4 exists to grade. Left unanswered on
    // purpose: a describe that times out is what a gone endpoint looks like.
    if (env.op.command !== "poke") return;
    attempts++;
    const bind = env.bind;
    let reply: EndpointReply;
    if (mode === "unfenced" || bind === undefined || (bind.instanceId === IID_REAL && bind.epoch === EPOCH)) {
      // A RESPONDER THAT DOES NOT KNOW THE FIELD. It never reads `bind`, so it runs the command and
      // answers success — exactly as every responder did before the fence existed, and exactly what
      // §5 requires of one that meets an unknown optional field.
      executions++;
      reply = { v: 1, id: env.id, ok: true, data: { ran: true } };
    } else {
      const servedBy = mode === "forged-servedBy" ? { instanceId: OTHER, epoch: EPOCH } : { instanceId: IID_REAL, epoch: EPOCH };
      const boundTo = mode === "forged-boundTo" ? { instanceId: OTHER, epoch: EPOCH } : { instanceId: bind.instanceId, epoch: bind.epoch };
      reply = {
        v: 1, id: env.id, ok: false,
        error: {
          code: "failed-precondition",
          message: `${EP}.${env.op.command} WAS NOT RUN - this is ${IID_REAL} epoch ${EPOCH} (SPEC 13.2)`,
          details: [{ kind: EP_BIND_REFUSED, endpoint: EP, command: env.op.command, boundTo, servedBy }],
          // A FENCED responder refusing before dispatch MUST state this (SPEC 13.3), and since the
          // caller now requires it before re-issuing, a fixture that omitted it was modelling a
          // responder the spec forbids and would never be repaired.
          outcome: "not-executed",
        },
      };
    }
    nc.publish(deriveReplySubject(SPACE, parsed, { instanceId: IID_REAL, epoch: EPOCH }), enc.encode(JSON.stringify(reply)));
    // Flipped AFTER the reply so this request was decided entirely by the mode it was sent under.
    if (modeAfterThisRequest !== null) { mode = modeAfterThisRequest; modeAfterThisRequest = null; }
  },
});

const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
const ep = new CotalEndpoint({
  space: SPACE, servers: `nats://127.0.0.1:${PORT}`, card: { name: "unfenced-caller", kind: "endpoint" },
  consume: false, watchPresence: false, registerPresence: false, lifecycleUid: caller.uid,
});
ep.on("error", () => {});
await ep.start();

const record = (responderId: string): ResolvedService => ({
  endpoint: EP, owner: DEV_OWNER, caller,
  responder: { instanceId: responderId, epoch: EPOCH },
  commands: new Map([["poke", {
    command: "poke", contract: { input: argsContract, output: outContract },
    class: "ephemeral", targeted: false, modes: ["one"], capability: "poke",
  }]]),
});

/**
 * THE RESOLVE CACHE, WITH RE-RESOLUTION MADE OBSERVABLE — and this is the fixture's load-bearing
 * device, so it is worth being exact about what it does and does not stand in for.
 *
 * A recovery drops the stale bind and then RE-RESOLVES. This endpoint answers no `describe` (there
 * is no real serve behind it), so a re-resolve would always time out — which would make every
 * "the command did not run twice" cell below true for the wrong reason: not because the caller
 * withheld the re-issue, but because a re-issue could not have reached anyone. A mutation removing
 * the guard would then survive, and the cell that matters most would be measuring the fixture.
 *
 * So `delete` re-seeds: the endpoint behaves as one that is still resolvable, and a re-issue really
 * does reach the responder and really can execute a second time. `reseedTo` chooses what the
 * re-resolve finds — GHOST for "the handle is still stale", IID_REAL for "the re-resolve found the
 * live incarnation", `null` for "the endpoint is gone", which is the retired case.
 *
 * WHAT IT IS NOT: it does not simulate a describe, and it cannot — the reply, the store fetch and
 * the digest verification are not exercised anywhere in this file. The claim it supports is only
 * about what the CALLER does with a resolve it obtained, which is the whole subject here. The one
 * substitution that could matter is the bind the second attempt carries; the responder under test
 * is unfenced by construction and ignores it, so the substitution is unobservable to it.
 */
let reseedTo: string | null = GHOST;
let deletions = 0;
class ObservableResolveCache extends Map<string, ResolvedService> {
  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) {
      deletions++;
      if (reseedTo !== null) super.set(key, record(reseedTo));
    }
    return had;
  }
}
const cache = new ObservableResolveCache();
(ep as unknown as { resolvedServices: Map<string, ResolvedService> }).resolvedServices = cache;
/** Seed the resolve the way a long-lived client holds one, bound to an incarnation that is not the
 *  one answering. Deterministic on purpose: waiting for a natural split grades the same code on a
 *  coin flip, and `smoke:queue-win` measured class-queue delivery as sticky on one box. */
const seed = () => { deletions = 0; cache.set(EP, record(GHOST)); };
const poke = () => ep.invokeService(EP, "poke", { n: 1 }, { deadlineMs: 1500 });

try {
  // ---- 0. THE CONTROL THAT MAKES EVERY "DID NOT RE-ISSUE" BELOW MEAN SOMETHING ------------------
  console.log("\n0. the command under test is one a caller may NOT repeat");
  // Without this, "the caller did not re-issue" is indistinguishable from "the caller had no reason
  // to": a repeat-safe command would be re-issued by the OTHER recovery path and the arms below
  // would grade nothing. `poke` on an unclassified endpoint is unsafe by the allowlist's polarity.
  c("`poke` on this endpoint is NOT repeat-safe, so a re-issue is a decision and not a default",
    !isRepeatSafeCommand(EP, "poke"));
  c("...and the fenced arm's re-issue is therefore attributable to the refusal alone",
    !isRepeatSafeCommand(EP, "poke") && isRepeatSafeCommand(EP, "describe"));

  // THE TRIPWIRE. `REPEAT_SAFE_COMMANDS` is a stand-in for §13.7 `effect`, which rides
  // `protocol.v: 2` and cannot reach the wire while the descriptor is pinned to 1: the responder
  // cannot publish a 2, the registry refuses one, so no caller in this tree can ever read an
  // author-declared `read`/`write`. That pin is the whole reason the allowlist is not the
  // descriptor-derived repeat-safety §13.7 forbids — it derives nothing from a descriptor, because
  // there is nothing there to derive from.
  //
  // The dangerous direction is allowlist-says-safe against author-declares-`write`, and it opens
  // the moment someone lifts the pin. This cell fires FIRST. It is a source-text assertion and
  // says so: it grades that the pin is still written, not that the two fences behave — the schema
  // constant is module-private and the behaviour has no reachable seam from here. That is enough
  // for a tripwire, whose whole job is to be impossible to remove silently.
  const servePinned = /protocol: \{ type: "object", required: \["v"\], properties: \{ v: \{ const: 1 \} \} \}/
    .test(readFileSync(new URL("../src/endpoint-serve.ts", import.meta.url), "utf8"));
  c("the describe descriptor is still pinned to protocol.v 1 — if this is red, §13.7 `effect` can " +
    "now reach the wire and REPEAT_SAFE_COMMANDS (endpoint-grants.ts) must go, not coexist with it",
    servePinned);

  // ---- 1. THE PAIR UNDER TEST ------------------------------------------------------------------
  // A RE-ISSUE HERE WOULD REACH THE RESPONDER AND WOULD EXECUTE. `reseedTo = GHOST` makes the
  // re-resolve succeed, so "one execution" below is a statement about the caller's decision and not
  // about whether a second attempt was even possible. Without this the cell would be true in a
  // fixture where nothing could ever run twice, which is the vacuous form of the same green.
  console.log("\n1. UNFENCED responder: it ignores the bind and runs the command");
  mode = "unfenced";
  reseedTo = GHOST;
  seed();
  const before = ep.splitRecoveryCount;
  let threw: unknown;
  try { await poke(); } catch (e) { threw = e; }
  c("the split SURFACES to the caller — it is not swallowed",
    threw !== undefined, threw);
  c("...carrying the responder-answered marker, which says the command MAY have run",
    respondedButUnbound(threw), threw instanceof Error ? threw.message.slice(0, 160) : threw);
  c("...and NOT the bind-refused marker, which would claim it did not",
    !replyRefusedBeforeEffect(threw instanceof EpEnvelopeError ? threw.toEpError() : undefined));
  // THE ASSERTION THE WHOLE FILE EXISTS FOR, and it is a direct count, not a publish proxy.
  c("EXACTLY ONE ATTEMPT REACHED THE RESPONDER: the caller did not re-issue",
    attempts === 1, { attempts, executions });
  c("...and exactly one EXECUTION, against a responder that had already run it once",
    executions === 1, executions);
  c("...and no split was RECOVERED, because nothing proved it was safe to recover",
    ep.splitRecoveryCount === before, { before, after: ep.splitRecoveryCount });
  c("...while the stale bind is still dropped, so a deliberate re-issue re-resolves",
    deletions === 1, deletions);

  // ---- 2. THE TWIN: THE SAME CALL AGAINST A FENCED RESPONDER -----------------------------------
  // Same handle, same command, same forced mismatch. The only thing that changed is whether the
  // responder knows the field — and that is what decides whether the caller may try again.
  console.log("\n2. FENCED responder, re-issue reaching a handle that is still stale");
  mode = "fenced";
  reseedTo = GHOST;
  seed();
  const execBefore = executions, splitsBefore = ep.splitRecoveryCount, attBefore = attempts;
  let second: EndpointReply | undefined;
  let fencedThrew: unknown;
  try { second = (await poke()).reply; } catch (e) { fencedThrew = e; }
  c("the command did NOT run — the execution count is unmoved from the unfenced arm's 1",
    executions === execBefore, { execBefore, executions });
  c("...although TWO attempts reached the responder, so the re-issue really was made",
    attempts === attBefore + 2, { attBefore, attempts });
  c("...and the caller COUNTED a recovery, which the unfenced arm did not",
    ep.splitRecoveryCount === splitsBefore + 1, { splitsBefore, after: ep.splitRecoveryCount });
  c("...and the SECOND refusal is returned rather than recovered again: one re-issue, not a loop",
    fencedThrew === undefined && second?.ok === false && replyRefusedBeforeEffect(second?.error),
    fencedThrew ?? second);

  // ---- 3. THE RE-ISSUE THAT LANDS: ONE REFUSAL, ONE EXECUTION ----------------------------------
  // The case the whole change is for. The re-resolve finds the live incarnation, the second attempt
  // carries a bind it can satisfy, and the command runs — ONCE. Counted at the responder, so
  // "exactly one" is a direct observation and not an inference from how many messages went out.
  console.log("\n3. FENCED responder, re-issue reaching the LIVE incarnation");
  mode = "fenced";
  reseedTo = IID_REAL;
  seed();
  const execBefore3 = executions, splits3 = ep.splitRecoveryCount;
  const landed = await poke();
  c("the re-issued call SUCCEEDS", landed.reply.ok === true, landed.reply);
  c("...and the command ran EXACTLY ONCE across both attempts", executions === execBefore3 + 1,
    { execBefore3, executions });
  c("...and the recovery was counted, so the split rate stays measurable", ep.splitRecoveryCount === splits3 + 1,
    { splits3, after: ep.splitRecoveryCount });

  // ---- 4. A RE-ISSUE THAT CANNOT BE RESOLVED SURFACES THE REFUSAL, NOT THE RESOLVE --------------
  // The retired-endpoint case: the handle is stale AND the endpoint is gone. What must NOT happen is
  // the caller being handed a describe deadline it never asked about while the refusal — the one
  // fact that says its handle is stale and that nothing ran — is discarded on the way.
  console.log("\n4. the re-issue could not resolve — what the caller is told");
  mode = "fenced";
  reseedTo = null;
  seed();
  const exec4 = executions;
  let goneThrew: unknown;
  try { await poke(); } catch (e) { goneThrew = e; }
  const msg = goneThrew instanceof Error ? goneThrew.message : String(goneThrew);
  c("it still states the command was not run", /WAS NOT RUN/.test(msg), msg.slice(0, 200));
  // NOT `/describe|resolve/`: that matched the UNWRAPPED error too, because the unwrapped error IS
  // the describe failure — so the cell was green with the fix and green without it, and graded
  // nothing on its own. Measured, not suspected: both mutations below reported 2 red where this
  // cell should have made 3. Anchored instead on the phrase only the wrapper emits, so the cell
  // fails when the refusal is replaced by the resolve rather than subordinated to it.
  c("...and names the resolve failure as the reason the repair could not be attempted",
    /re-issue could not be resolved: /.test(msg), msg.slice(0, 200));
  c("...and still carries the bind-refused marker, so a caller keys on the same fact either way",
    replyRefusedBeforeEffect(goneThrew instanceof EpEnvelopeError ? goneThrew.toEpError() : undefined),
    goneThrew instanceof EpEnvelopeError ? goneThrew.details : goneThrew);
  // §13.3: `WAS NOT RUN` in the message is prose; `outcome` is the field a caller keys on, and an
  // omitted one MUST be read as `unknown`. Every cell above is satisfied by prose plus the marker,
  // so a rethrow that dropped the outcome told a reader one thing and a machine the opposite, on
  // the one path whose entire purpose is to be conclusive.
  c("...and says so STRUCTURALLY, not only in prose (an omitted outcome reads as `unknown`)",
    (goneThrew instanceof EpEnvelopeError ? goneThrew.outcome : undefined) === "not-executed",
    { outcome: goneThrew instanceof EpEnvelopeError ? goneThrew.outcome ?? "(absent)" : "(not an EpEnvelopeError)" });
  c("...and nothing ran on the way to saying so", executions === exec4, { exec4, executions });

  // ---- 5. THE REFUSAL MUST BE DERIVABLE, NOT MERELY PRESENT ------------------------------------
  // A caller acts on this marker by re-issuing a command it would otherwise never repeat. Both
  // halves of the fence's comparison are knowable to the caller, so both are checked: a refusal
  // computed from another request, or claiming another server, is refused rather than honored.
  console.log("\n5. a forged refusal does not move the caller's hand");
  for (const [label, m] of [["boundTo", "forged-boundTo"], ["servedBy", "forged-servedBy"]] as const) {
    mode = m;
    // Stated, not inherited from the previous arm: a re-issue here WOULD reach the responder, so
    // "nothing was re-issued" is the caller declining and not the endpoint being gone.
    reseedTo = GHOST;
    seed();
    const e0 = executions, s0 = ep.splitRecoveryCount;
    let forgedThrew: unknown;
    try { await poke(); } catch (e) { forgedThrew = e; }
    c(`a refusal whose ${label} the caller cannot derive is refused as internal`,
      forgedThrew instanceof EpEnvelopeError && forgedThrew.code === "internal",
      forgedThrew instanceof Error ? forgedThrew.message.slice(0, 180) : forgedThrew);
    c(`...and nothing was re-issued on it (${label})`,
      executions === e0 && ep.splitRecoveryCount === s0, { executions, e0, splits: ep.splitRecoveryCount, s0 });
  }

  // ---- 6. THE COMPOSED PAIR: FENCED HOP 1, UNFENCED HOP 2 --------------------------------------
  // The gap this suite had. Cells 1-5 each grade ONE responder held at ONE mode for a whole call,
  // so none of them can produce the case where the RE-ISSUE is the thing that goes wrong on its
  // own terms. Here hop 1 refuses before running (the fence works, a re-issue is authorized), the
  // re-resolve still finds a stale bind, and hop 2 meets a responder that has never heard of the
  // field: it RUNS the command and answers, and the caller's post-reply currency check throws.
  //
  // Two errors are now in play and they assert OPPOSITE things. The wrong answer is to subordinate
  // the second to the first — a caller told `WAS NOT RUN` plus `bind-refused` for a command that
  // executed will make its next attempt believing it is the first. So what must reach the caller
  // is hop 2's own `respondedButUnbound`: a responder answered, and the effect may have landed.
  console.log("\n6. fenced refusal, then a re-issue that RAN and still failed");
  mode = "fenced";
  modeAfterThisRequest = "unfenced";
  reseedTo = GHOST;
  seed();
  const exec6 = executions, att6 = attempts, splits6 = ep.splitRecoveryCount;
  let composed: unknown;
  try { await poke(); } catch (e) { composed = e; }
  const msg6 = composed instanceof Error ? composed.message : String(composed);
  c("TWO attempts reached the responder: the refusal really was recovered",
    attempts === att6 + 2, { att6, attempts });
  c("...and the SECOND one EXECUTED, because that responder does not read `bind`",
    executions === exec6 + 1, { exec6, executions });
  c("...the call still THROWS: the reply came from an incarnation the handle is not bound to",
    composed !== undefined, composed);
  c("...carrying `respondedButUnbound` — a responder answered, so the effect MAY have landed",
    respondedButUnbound(composed), msg6.slice(0, 180));
  c("...and NOT `bind-refused`, which would assert the opposite of what just happened",
    !replyRefusedBeforeEffect(composed instanceof EpEnvelopeError ? composed.toEpError() : undefined),
    composed instanceof EpEnvelopeError ? composed.details : composed);
  c("...and not the first hop's `WAS NOT RUN`, for a command that ran",
    !/WAS NOT RUN/.test(msg6), msg6.slice(0, 200));
  c("...and no THIRD attempt: an unsafe command is not auto-retried on that marker",
    attempts === att6 + 2 && executions === exec6 + 1, { attempts, executions });
  c("...while the recovery is counted exactly once, for the hop that was actually recovered",
    ep.splitRecoveryCount === splits6 + 1, { splits6, after: ep.splitRecoveryCount });
} finally {
  sub.unsubscribe();
  await ep.stop().catch(() => {});
  await nc.drain().catch(() => nc.close());
  broker.kill("SIGKILL");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
