/**
 * v0.4 endpoint envelope smoke (broker-free) — the SPEC §13.3 consuming-boundary contract:
 * every shape violation rejects with the exact catalog code the spec assigns
 * (unsupported-version / bad-request / contract-mismatch / op-mismatch / target-mismatch /
 * sender-mismatch / class-mismatch), the auth slot digests as carried bytes, and invocation-time
 * schema failure (`bad-request`) stays distinct from registration-time `contract-invalid`.
 *
 * Run: pnpm smoke:ep-envelope   (no broker; part of smoke:ci)
 */
import { createHash } from "node:crypto";
import {
  EP_ERROR_CODES, isEpErrorCode, EpEnvelopeError,
  parseEndpointRequest, parseEndpointReply, parseEndpointEvent,
  checkRequestSubjectAgreement, assertClassMatches, assertArgsValid, authDigest,
  epRequestSubject, parseEpSubject, type ParsedEpRequest,
  compileContractSchema, VOID_SCHEMA, VOID_SCHEMA_DIGEST, SCHEMA_PROFILE,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = (n: string, code: string, fn: () => unknown) => {
  try { fn(); c(n, false, "no throw"); }
  catch (e) { c(n, e instanceof EpEnvelopeError && e.code === code, e instanceof EpEnvelopeError ? e.code : (e as Error).message); }
};

const UID = "u".repeat(26);
const caller = { owner: "u_abc", actor: "worker", uid: UID };
const NONCE = "n".repeat(24);
const D = VOID_SCHEMA_DIGEST;

// ── error catalog ──
c("catalog is the §13.3 list (21 codes), all self-valid", EP_ERROR_CODES.length === 21 && EP_ERROR_CODES.every(isEpErrorCode));
c("reverse-DNS extension code accepted", isEpErrorCode("com.acme.throttled"));
c("two-label code refused (extensions are reverse-DNS)", !isEpErrorCode("acme.throttled"));
c("over-64-byte code refused", !isEpErrorCode(`com.acme.${"x".repeat(64)}`));
c("uppercase / wildcard codes refused", !isEpErrorCode("com.acme.Throttled") && !isEpErrorCode("com.acme.>"));

// ── signed-artifact binding ──
const authSlot = '{ "grant":  "exactly-as-carried" }';
c("authDigest digests the carried bytes exactly",
  authDigest(authSlot) === "sha256:" + createHash("sha256").update(authSlot, "utf8").digest("hex"));
c("authDigest never re-canonicalizes (whitespace changes the digest)",
  authDigest(authSlot) !== authDigest('{"grant":"exactly-as-carried"}'));

// ── request shape ──
const goodReq = {
  v: 1, id: "req-1",
  op: { endpoint: "manager", command: "spawn", inputDigest: D, outputDigest: D },
  class: "ephemeral", replyExpected: true, deadlineMs: 5000,
  args: { name: "x" }, from: { id: "u_abc.worker", name: "worker" },
  correlation: { traceparent: "00-abc-def-01" },
  auth: authSlot,
  unknownField: "ignored (§5), never kept",
};
const req = parseEndpointRequest(goodReq);
c("request parses and picks exactly the defined fields",
  req.id === "req-1" && req.op.inputDigest === D && req.auth === authSlot && !("unknownField" in req));
c("correlation is picked through", req.correlation?.traceparent === "00-abc-def-01");
rejects("v !== 1 is unsupported-version, checked before any shape", "unsupported-version",
  () => parseEndpointRequest({ v: 2, garbage: true }));
rejects("missing digest on a non-describe command is contract-mismatch", "contract-mismatch",
  () => parseEndpointRequest({ ...goodReq, op: { endpoint: "manager", command: "spawn", outputDigest: D } }));
c("describe needs no digests (the discovery bootstrap)",
  parseEndpointRequest({ ...goodReq, op: { endpoint: "manager", command: "describe" } }).op.command === "describe");
rejects("a malformed digest is bad-request", "bad-request",
  () => parseEndpointRequest({ ...goodReq, op: { ...goodReq.op, inputDigest: "sha256:xyz" } }));
rejects("a journal submission with replyExpected true is bad-request", "bad-request",
  () => parseEndpointRequest({ ...goodReq, class: "journal" }));
rejects("a call without deadlineMs is bad-request", "bad-request",
  () => parseEndpointRequest({ ...goodReq, deadlineMs: undefined }));
rejects("a journal submission without deadlineMs is bad-request (the decision deadline)", "bad-request",
  () => parseEndpointRequest({ ...goodReq, class: "journal", replyExpected: false, deadlineMs: undefined }));
c("a cast needs no deadline",
  parseEndpointRequest({ ...goodReq, replyExpected: false, deadlineMs: undefined }).replyExpected === false);
rejects("a zero deadline is bad-request (bounded, never degenerate)", "bad-request",
  () => parseEndpointRequest({ ...goodReq, deadlineMs: 0 }));
rejects("record as a request class is bad-request (a state contract, never a request class)", "bad-request",
  () => parseEndpointRequest({ ...goodReq, class: "record" }));
rejects("non-object args is bad-request", "bad-request",
  () => parseEndpointRequest({ ...goodReq, args: [1] }));
rejects("a malformed target lifecycleUid is bad-request", "bad-request",
  () => parseEndpointRequest({ ...goodReq, target: { owner: "u_abc", actor: "a", lifecycleUid: "SHORT" } }));

// ── body <-> subject agreement ──
const parse = (s: string) => parseEpSubject(s) as ParsedEpRequest;
const untargeted = parse(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", caller, nonce: NONCE }));
const ownerSub = parse(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", target: { mode: "owner", tOwner: "u_abc" }, caller, nonce: NONCE }));
const selfSub = parse(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "restart", target: { mode: "self" }, caller, nonce: NONCE }));
const handleSub = parse(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "attach", target: { mode: "handle", tOwner: "u_t", tActor: "svc", tUid: "h".repeat(26) }, caller, nonce: NONCE }));
const bodyTarget = { owner: "u_abc", actor: "runner", lifecycleUid: "t".repeat(26) };

checkRequestSubjectAgreement(req, untargeted);
c("untargeted request agrees with its subject", true);
checkRequestSubjectAgreement(parseEndpointRequest({ ...goodReq, target: bodyTarget }), ownerSub);
c("owner-mode request with a matching body target agrees", true);
rejects("op.command disagreement is op-mismatch", "op-mismatch",
  () => checkRequestSubjectAgreement(parseEndpointRequest({ ...goodReq, op: { ...goodReq.op, command: "stop" } }), untargeted));
rejects("a body target on an untargeted subject is target-mismatch, never ignored", "target-mismatch",
  () => checkRequestSubjectAgreement(parseEndpointRequest({ ...goodReq, target: bodyTarget }), untargeted));
rejects("a body target on a self subject is target-mismatch", "target-mismatch",
  () => checkRequestSubjectAgreement(parseEndpointRequest({ ...goodReq, op: { ...goodReq.op, command: "restart" }, target: bodyTarget }), selfSub));
rejects("a missing body target on an owner-mode subject is target-mismatch", "target-mismatch",
  () => checkRequestSubjectAgreement(req, ownerSub));
rejects("the body target owner must equal the subject token", "target-mismatch",
  () => checkRequestSubjectAgreement(parseEndpointRequest({ ...goodReq, target: { ...bodyTarget, owner: "u_other" } }), ownerSub));
rejects("handle mode compares the whole redemption triple", "target-mismatch",
  () => checkRequestSubjectAgreement(
    parseEndpointRequest({ ...goodReq, op: { ...goodReq.op, command: "attach" }, target: { owner: "u_t", actor: "other", lifecycleUid: "h".repeat(26) } }),
    handleSub));
rejects("from.id must equal the subject sender principal", "sender-mismatch",
  () => checkRequestSubjectAgreement(parseEndpointRequest({ ...goodReq, from: { id: "u_abc.impostor", name: "x" } }), untargeted));
rejects("the declared class must equal the contract class", "class-mismatch",
  () => assertClassMatches(req, "journal"));

// ── reply / event shapes ──
const okReply = parseEndpointReply({ v: 1, id: "req-1", ok: true, data: { pid: 1 }, junk: 1 });
c("ok reply parses, unknown fields dropped", okReply.ok && (okReply.data as { pid: number }).pid === 1 && !("junk" in okReply));
const errReply = parseEndpointReply({ v: 1, id: "req-1", ok: false, error: { code: "expired", message: "mapping moved", details: [{ kind: "ai.cotal.mapping", revision: 4 }] } });
c("error reply parses with reverse-DNS detail kinds", errReply.error?.code === "expired" && errReply.error.details?.[0].kind === "ai.cotal.mapping");
rejects("an ok reply with an error is bad-request", "bad-request",
  () => parseEndpointReply({ v: 1, id: "r", ok: true, error: { code: "internal", message: "x" } }));
rejects("a failed reply with data is bad-request", "bad-request",
  () => parseEndpointReply({ v: 1, id: "r", ok: false, data: 1, error: { code: "internal", message: "x" } }));
rejects("an off-catalog non-reverse-DNS error code is bad-request", "bad-request",
  () => parseEndpointReply({ v: 1, id: "r", ok: false, error: { code: "Nope", message: "x" } }));
rejects("a non-reverse-DNS detail kind is bad-request", "bad-request",
  () => parseEndpointReply({ v: 1, id: "r", ok: false, error: { code: "internal", message: "x", details: [{ kind: "oops" }] } }));
rejects("reply version skew is unsupported-version", "unsupported-version",
  () => parseEndpointReply({ v: 0, id: "r", ok: true }));

const ev = parseEndpointEvent({ v: 1, topic: "ev.ai_cotal_lifecycle.started", ts: 1720500000000, data: null });
c("event parses (a null data field IS data)", ev.topic.startsWith("ev.") && ev.data === null);
rejects("an event without data is bad-request", "bad-request", () => parseEndpointEvent({ v: 1, topic: "t", ts: 1 }));
rejects("a negative ts is bad-request", "bad-request", () => parseEndpointEvent({ v: 1, topic: "t", ts: -1, data: 1 }));

// ── invocation-time schema validation, distinct from registration time ──
const validate = compileContractSchema({ root: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
c("valid args pass and are returned", (assertArgsValid(validate, { name: "x" }, SCHEMA_PROFILE.validateBudgetMs) as { name: string }).name === "x");
rejects("invalid args are the invocation-time bad-request", "bad-request",
  () => assertArgsValid(validate, {}, SCHEMA_PROFILE.validateBudgetMs));
const voidValidate = compileContractSchema({ root: VOID_SCHEMA });
c("absent args validate against the void schema as null", assertArgsValid(voidValidate, undefined, SCHEMA_PROFILE.validateBudgetMs) === null);
rejects("present args against the void schema are bad-request", "bad-request",
  () => assertArgsValid(voidValidate, { any: 1 }, SCHEMA_PROFILE.validateBudgetMs));

console.log(`\nENDPOINT ENVELOPE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
