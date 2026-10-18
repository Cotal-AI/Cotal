/**
 * Private tool-result journal and the handle-only `tool-result` command (no NATS) — run with:
 *   pnpm --dir extensions/connector-core exec tsx smoke/tool-result-journal.smoke.ts
 *
 * Drives the shipped ToolResultJournal, captureToolResults and toolResultCommandDef handler and
 * contracts. Broker confinement of the handle subject (a same-space principal without the grant,
 * or a neighbouring space, cannot publish the request at all) needs a live mesh and is NOT
 * exercised here; these cells prove the handler's own narrowing and the journal's states.
 */
import assert from "node:assert/strict";
import { AGUI_EVENT_TYPE, type AguiEvent } from "../src/agui.js";
import { ToolResultJournal, captureToolResults, TOOL_RESULT_DEFAULTS } from "../src/tool-result-journal.js";
import { toolResultCommandDef, toolResultRevokeCommandDef, TOOL_RESULT_COMMAND } from "../src/tool-result-command.js";

const HOLDER = "u_owner.web";
const consent = (id = "c".repeat(22), exp = Number.MAX_SAFE_INTEGER, holder = HOLDER) => ({ id, holder: { id: holder }, exp, issuer: { keyId: "host" }, iat: 0 });

let checks = 0;
const ok = (value: unknown, message: string): void => { assert.ok(value, message); checks++; };
const eq = (a: unknown, b: unknown, message: string): void => { assert.deepEqual(a, b, message); checks++; };

const THREAD = "0f3c9d1e-session";
const start = (toolCallId: string): AguiEvent => ({ type: AGUI_EVENT_TYPE.TOOL_CALL_START, toolCallId, toolCallName: "Bash", timestamp: 0 }) as unknown as AguiEvent;
const result = (toolCallId: string, content: string, isError = false): AguiEvent =>
  ({ type: AGUI_EVENT_TYPE.TOOL_CALL_RESULT, messageId: `m-${toolCallId}`, toolCallId, content, timestamp: 0, ...(isError ? { cotal: { isError: true } } : {}) }) as unknown as AguiEvent;
const args = (toolCallId: string): AguiEvent => ({ type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS, toolCallId, delta: "{\"secret\":\"arg\"}", timestamp: 0 }) as unknown as AguiEvent;

// ---- default deny: nothing before consent -------------------------------------------------------
{
  const off = new ToolResultJournal();
  ok(off.sharing === "off", "a new journal is off");
  off.observe(THREAD, [start("t1"), result("t1", "CANARY-OFF")]);
  off.applyConsent(consent());
  eq(off.answer(THREAD, "t1", HOLDER), { state: "missing" }, "a result produced before consent was never captured");
  const late = new ToolResultJournal();
  late.applyConsent(consent("d".repeat(22), 0));
  ok(late.sharing === "off", "an already-expired consent enables nothing");
}

// ---- states, exact ids, falsey results ---------------------------------------------------------
{
  const j = new ToolResultJournal();
  j.applyConsent(consent());
  j.observe(THREAD, [start("t1"), args("t1")]);
  eq(j.answer(THREAD, "t1", HOLDER), { state: "pending", threadId: THREAD, toolCallId: "t1" }, "a started call is pending");
  j.observe(THREAD, [result("t1", "CANARY-1")]);
  const a = j.answer(THREAD, "t1", HOLDER);
  ok(a.state === "available" && a.content === "CANARY-1" && !a.truncated && a.bytes === 8 && !a.isError, "a reported result is available verbatim");
  ok(!JSON.stringify(a).includes("secret"), "arguments are never captured");
  eq(j.answer("other-thread", "t1", HOLDER), { state: "missing" }, "the same call id on another thread is a different key");
  eq(j.answer(THREAD, "t-never", HOLDER), { state: "missing" }, "an unseen id is missing, never inferred");
  for (const [id, content] of [["e", ""], ["z", "0"], ["f", "false"], ["n", "null"]] as const) {
    j.observe(THREAD, [result(id, content)]);
    const got = j.answer(THREAD, id, HOLDER);
    ok(got.state === "available" && got.content === content && got.bytes === Buffer.byteLength(content), `the falsey result ${JSON.stringify(content)} stays an actual result`);
  }
  j.observe(THREAD, [result("x", "boom", true)]);
  const err = j.answer(THREAD, "x", HOLDER);
  ok(err.state === "available" && err.isError, "an error result keeps its error flag");
  j.observe(THREAD, [result("t1", "REPLAYED-DIFFERENT")]);
  const again = j.answer(THREAD, "t1", HOLDER);
  ok(again.state === "available" && again.content === "CANARY-1", "a replayed transcript cannot rewrite a held result");
}

// ---- hostile and large output ------------------------------------------------------------------
{
  const j = new ToolResultJournal({ maxContentBytes: 64 });
  j.applyConsent(consent());
  const hostile = `<img src="https://x.test/a?token=abc"><script>alert(1)</script>${"\u{1F600}".repeat(40)}`;
  j.observe(THREAD, [result("h", hostile)]);
  const got = j.answer(THREAD, "h", HOLDER);
  ok(got.state === "available" && got.truncated && got.bytes === Buffer.byteLength(hostile), "an oversized result is cut and reports its full size");
  ok(got.state === "available" && Buffer.byteLength(got.content) <= 64 && hostile.startsWith(got.content), "the cut is a prefix within the byte bound");
  ok(got.state === "available" && !got.content.includes("�") && !/[\uD800-\uDBFF]$/.test(got.content), "the cut never splits a code point");
  ok(got.state === "available" && typeof got.content === "string", "content stays inert text for the consumer to render as text");
}

// ---- retention bounds --------------------------------------------------------------------------
{
  let now = 1_000;
  const j = new ToolResultJournal({ maxEntries: 2, ttlMs: 100, now: () => now });
  j.applyConsent(consent());
  j.observe(THREAD, [result("a", "A")]);
  j.observe(THREAD, [result("b", "B")]);
  j.observe(THREAD, [result("c", "C")]);
  eq(j.answer(THREAD, "a", HOLDER), { state: "expired" }, "capacity eviction answers expired, not missing");
  ok(j.answer(THREAD, "c", HOLDER).state === "available", "the newest results stay");
  now += 101;
  eq(j.answer(THREAD, "c", HOLDER), { state: "expired" }, "an aged result expires");
  ok(TOOL_RESULT_DEFAULTS.maxEntries > 0 && TOOL_RESULT_DEFAULTS.maxContentBytes > 0 && TOOL_RESULT_DEFAULTS.ttlMs > 0, "defaults are bounded");
}

// ---- consent lapse is bounded by exp ------------------------------------------------------------
{
  let now = 1_000;
  const j = new ToolResultJournal({ now: () => now });
  j.applyConsent(consent("g".repeat(22), 2_000));
  j.observe(THREAD, [result("l1", "BEFORE-LAPSE")]);
  ok(j.answer(THREAD, "l1", HOLDER).state === "available", "inside the consent window the result is readable");
  now = 2_000;
  eq(j.answer(THREAD, "l1", HOLDER), { state: "not-shared" }, "at exp the consent lapses and held results are discarded");
  j.observe(THREAD, [result("l2", "AFTER-LAPSE")]);
  j.applyConsent(consent("h".repeat(22), 3_000));
  eq(j.answer(THREAD, "l2", HOLDER), { state: "missing" }, "nothing is captured while no consent is active");
}

// ---- capture through the mapper seam -----------------------------------------------------------
{
  const j = new ToolResultJournal();
  j.applyConsent(consent());
  const events = [start("m1"), result("m1", "MAPPED")];
  const mapped = captureToolResults(() => ({ runId: "r1", events }), j, THREAD)({});
  ok(mapped !== null && "events" in mapped && mapped.events === events, "the wrapped mapper returns the same batch to the emitter");
  ok(j.answer(THREAD, "m1", HOLDER).state === "available", "the journal saw the mapped result");
}

// ---- the handle-only command -------------------------------------------------------------------
{
  const self = { owner: "u_owner", actor: "seat", lifecycleUid: "a".repeat(26) };
  const j = new ToolResultJournal();
  j.applyConsent(consent());
  j.observe(THREAD, [result("t9", "CANARY-9")]);
  const def = toolResultCommandDef(j, self);
  ok(def.command === TOOL_RESULT_COMMAND, "the command name is tool-result");
  const call = (target: unknown, a: unknown = { threadId: THREAD, toolCallId: "t9" }) =>
    def.handler({ subject: { target, caller: { owner: "u_owner", actor: "web", uid: "h".repeat(26) } }, request: { args: a } } as never);
  const refused = (target: unknown, code: string, message: string): void => {
    assert.throws(() => call(target), (e: { code?: string }) => e.code === code, message); checks++;
  };
  const answer = call({ mode: "handle", tOwner: self.owner, tActor: self.actor, tUid: self.lifecycleUid }) as { state: string; content?: string };
  ok(answer.state === "available" && answer.content === "CANARY-9", "a redeemed handle on this agent reads the canary");
  refused(null, "permission-denied", "the untargeted form is refused");
  for (const mode of ["self", "owner", "any", "child", "ledger"])
    refused(mode === "self" ? { mode } : { mode, tOwner: self.owner }, "permission-denied", `${mode} mode cannot read results`);
  refused({ mode: "exact", tOwner: self.owner, tActor: self.actor, tUid: self.lifecycleUid }, "permission-denied", "exact mode cannot read results");
  refused({ mode: "handle", tOwner: "u_neighbor", tActor: self.actor, tUid: self.lifecycleUid }, "target-mismatch", "a handle on another owner's agent is refused");
  refused({ mode: "handle", tOwner: self.owner, tActor: "other", tUid: self.lifecycleUid }, "target-mismatch", "a handle on a sibling agent is refused");
  refused({ mode: "handle", tOwner: self.owner, tActor: self.actor, tUid: "b".repeat(26) }, "expired", "a handle on a previous or later lifecycle is refused");
  const other = toolResultCommandDef(j, self);
  const asNeighbour = other.handler({ subject: { target: { mode: "handle", tOwner: self.owner, tActor: self.actor, tUid: self.lifecycleUid }, caller: { owner: "u_owner", actor: "other-viewer", uid: "h".repeat(26) } }, request: { args: { threadId: THREAD, toolCallId: "t9" } } } as never) as { state: string };
  ok(asNeighbour.state === "not-shared", "a holder no consent names reads not-shared, even with a handle");
  const revoke = toolResultRevokeCommandDef(j, self);
  const revokeAs = (owner: string, actor: string) => revoke.handler({ subject: { target: { mode: "handle", tOwner: self.owner, tActor: self.actor, tUid: self.lifecycleUid }, caller: { owner, actor, uid: "h".repeat(26) } }, request: { args: { id: "c".repeat(22) } } } as never) as { state: string };
  ok(revokeAs("u_owner", "other-viewer").state === "unknown", "only the consent's holder can withdraw it");
  ok(revokeAs("u_owner", "web").state === "revoked", "the holder withdraws its consent");
  eq(j.answer(THREAD, "t9", HOLDER), { state: "not-shared" }, "withdrawing the last consent discards held results");
  j.applyConsent(consent("e".repeat(22)));
  j.retire();
  refused({ mode: "handle", tOwner: self.owner, tActor: self.actor, tUid: self.lifecycleUid }, "expired", "after revoke or retirement a held handle reads nothing");
  eq(j.answer(THREAD, "t9", HOLDER), { state: "not-shared" }, "retirement discards every held result");
  assert.throws(() => j.applyConsent(consent("f".repeat(22)))); checks++;
  j.observe(THREAD, [result("t10", "LATE")]);
  eq(j.answer(THREAD, "t10", HOLDER), { state: "not-shared" }, "a result arriving after retirement is not captured");

  ok(def.contract.input.validate({ threadId: THREAD, toolCallId: "t9" }) === true, "the input contract admits exact ids");
  ok(def.contract.input.validate({ threadId: THREAD, toolCallId: "t9", near: true }) === false, "the input contract refuses extra fields");
  ok(def.contract.input.validate({ threadId: THREAD }) === false, "the input contract needs a tool-call id");
  for (const state of [{ state: "available", threadId: THREAD, toolCallId: "t", content: "", truncated: false, bytes: 0, isError: false, capturedAt: 1 }, { state: "pending", threadId: THREAD, toolCallId: "t" }, { state: "not-shared" }, { state: "missing" }, { state: "expired" }])
    ok(def.contract.output.validate(state) === true, `the output contract admits ${state.state}`);
  ok(def.contract.output.validate({ state: "available", html: "<b>x</b>" }) === false, "the output contract refuses unknown fields");
}

console.log(`tool-result-journal smoke: ${checks} checks passed`);
