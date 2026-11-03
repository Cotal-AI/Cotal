/**
 * Static chat adapter pure smoke (no broker, no manager, no session).
 *
 * SCOPE, stated honestly: this checks the two pure decisions of the static adapter: whether a
 * `chat-session-open` reply is used at all (its shape, that its sealed payload opens with this
 * adapter's one-time key, that every bound field matches, and that its credential is the identity
 * it names), and how a `chat-session-retire` reply becomes a close report. The manager's seal is
 * stood in for by core's `sealJson`, and the credential is minted locally from a throwaway space
 * signer and never reaches a broker. Admission, connection, eviction, the same-instance retire
 * route, the pinned control target and every native behavior are NOT covered here.
 */
import { SealRecipient, createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, sealJson } from "@cotal-ai/core";
import { STATIC_CHAT_TTL_SEC, readAdmission, retireReport } from "../src/chat/static-session.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)?.slice(0, 400)); }
}

const SPACE = "chatpure";
const IID = "m".repeat(26);
const expected = { space: SPACE, managerInstanceId: IID };
const auth = await createSpaceAuth(SPACE);
const identity = newIdentity();
const lifecycleUid = mintLifecycleUid();
const creds = await mintCreds(auth, identity, "agent", { lifecycleUid, expiresAt: Math.floor(Date.now() / 1000) + STATIC_CHAT_TTL_SEC });
const otherCreds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid, expiresAt: Math.floor(Date.now() / 1000) + STATIC_CHAT_TTL_SEC });
const alias = `chat_${"a".repeat(26)}`;
const expiresAt = Date.now() + STATIC_CHAT_TTL_SEC * 1000;

/** What the manager seals for `sealTo`, before any tampering. */
const payloadFor = (sealTo: string): Record<string, unknown> =>
  ({ v: 1, space: SPACE, managerInstanceId: IID, alias, actor: identity.id, lifecycleUid, expiresAt, sealTo, creds });
/** One reply as the manager builds it: the public fields beside the payload sealed to `sealTo`. */
const replyFor = (sealTo: string, payload = payloadFor(sealTo)): Record<string, unknown> =>
  ({ alias, actor: identity.id, lifecycleUid, expiresAt, ...sealJson(payload, sealTo) });
/** A fresh one-time recipient and the result of reading `make(itsKey)` with it. */
const readFresh = (make: (sealTo: string) => Record<string, unknown>, against = expected) => {
  const recipient = new SealRecipient();
  return readAdmission(make(recipient.publicKey), recipient, against);
};

console.log("1. an open reply is used only when it opens with this key and every bound field matches");
{
  const recipient = new SealRecipient();
  const reply = replyFor(recipient.publicKey);
  check("the reply carries no credential in the clear", !JSON.stringify(reply).includes(creds) && !JSON.stringify(reply).includes("NATS USER JWT") && !("creds" in reply));
  const admitted = readAdmission(reply, recipient, expected);
  check("a sealed reply bound to this key, space and instance is admitted with its credential",
    admitted?.actor === identity.id && admitted.alias === alias && admitted.lifecycleUid === lifecycleUid && admitted.expiresAt === expiresAt && admitted.creds === creds);
  check("the one-time key opens nothing after its first reply", readAdmission(replyFor(recipient.publicKey), recipient, expected) === undefined);

  const intended = new SealRecipient();
  const stranger = new SealRecipient();
  check("a reply sealed to another recipient does not open", readAdmission(replyFor(intended.publicKey), stranger, expected) === undefined);
  intended.clear();

  const earlier = new SealRecipient();
  const replayed = replyFor(earlier.publicKey);
  earlier.clear();
  check("a replayed reply sealed to an earlier one-time key does not open", readFresh(() => replayed) === undefined);
  check("a payload that binds an earlier sealTo refuses even when sealed to this key",
    readFresh((sealTo) => replyFor(sealTo, { ...payloadFor(sealTo), sealTo: new SealRecipient().publicKey })) === undefined);

  for (const [field, value] of [["alias", `chat_${"b".repeat(26)}`], ["actor", newIdentity().id], ["lifecycleUid", mintLifecycleUid()], ["expiresAt", expiresAt + 1]] as const)
    check(`an outer ${field} that differs from the sealed one refuses`, readFresh((sealTo) => ({ ...replyFor(sealTo), [field]: value })) === undefined);
  check("a tampered ciphertext byte refuses", readFresh((sealTo) => {
    const r = replyFor(sealTo);
    const sealed = r.sealed as string;
    return { ...r, sealed: sealed.slice(0, 40) + (sealed[40] === "A" ? "B" : "A") + sealed.slice(41) };
  }) === undefined);
  check("a payload for another space refuses", readFresh((sealTo) => replyFor(sealTo), { ...expected, space: "elsewhere" }) === undefined);
  check("a payload from another manager instance refuses", readFresh((sealTo) => replyFor(sealTo), { ...expected, managerInstanceId: "n".repeat(26) }) === undefined);
  check("an extra sealed key refuses", readFresh((sealTo) => replyFor(sealTo, { ...payloadFor(sealTo), role: "x" })) === undefined);
  check("a missing sealed credential refuses", readFresh((sealTo) => { const { creds: _c, ...rest } = payloadFor(sealTo); return replyFor(sealTo, rest); }) === undefined);
  check("another payload version refuses", readFresh((sealTo) => replyFor(sealTo, { ...payloadFor(sealTo), v: 2 })) === undefined);
  check("a sealed credential for another identity refuses", readFresh((sealTo) => replyFor(sealTo, { ...payloadFor(sealTo), creds: otherCreds })) === undefined);
  check("an outer reply that also carries the credential in the clear refuses", readFresh((sealTo) => ({ ...replyFor(sealTo), creds })) === undefined);
  check("an ordinary alias refuses", readFresh((sealTo) => ({ ...replyFor(sealTo, { ...payloadFor(sealTo), alias: "reviewer" }), alias: "reviewer" })) === undefined);
  check("a sealer that is not a curve key refuses", readFresh((sealTo) => ({ ...replyFor(sealTo), sealer: identity.id })) === undefined);
  check("a non-integer expiry refuses", readFresh((sealTo) => ({ ...replyFor(sealTo, { ...payloadFor(sealTo), expiresAt: 1.5 }), expiresAt: 1.5 })) === undefined);
  check("a malformed lifecycle uid refuses", readFresh((sealTo) => ({ ...replyFor(sealTo, { ...payloadFor(sealTo), lifecycleUid: "x" }), lifecycleUid: "x" })) === undefined);
}

console.log("2. a retire reply becomes an honest close report");
{
  // `retireReport` runs after the session's own endpoint stopped; NativeChatSession downgrades
  // `connectionClosed` when that stop failed. So every report here says `confirmed`, whatever the
  // retirement outcome, and every one names the leaf's broker validity.
  const iid = "i".repeat(26);
  const until = expiresAt;
  const validity = new Date(until).toISOString();
  const retired = retireReport({ ok: true, data: { outcome: "retired" } }, iid, until);
  check("retired reports retired", retired.retirement === "retired" && retired.credentialValidUntil === until, retired);
  check("retired never claims the leaf is revoked at the broker", retired.message.includes("marked revoked") && retired.message.includes(`until ${validity}`) && !/credential (is|was) revoked/.test(retired.message), retired);
  const already = retireReport({ ok: true, data: { outcome: "alreadyRetired" } }, iid, until);
  check("alreadyRetired reports retired", already.retirement === "retired", already);
  const pending = retireReport({ ok: true, data: { outcome: "failed", reason: "retirement pending: eviction not verified" } }, iid, until);
  check("failed reports requested and keeps the reason", pending.retirement === "requested" && pending.message.includes("retirement pending"), pending);
  const refused = retireReport({ ok: false, code: "failed-precondition", nativeOutcome: "not-executed", error: "belongs to manager instance j" }, iid, until);
  check("a refusal reports requested and says the session is not retired", refused.retirement === "requested" && refused.message.includes("not retired"), refused);
  const silent = retireReport({ ok: false, unanswered: true, error: "no responder" }, iid, until);
  check("an unanswered retire reports unknown", silent.retirement === "unknown", silent);
  const odd = retireReport({ ok: true, data: { outcome: "notStarted" } }, iid, until);
  check("an unrecognized outcome reports unknown", odd.retirement === "unknown", odd);
  const all = [retired, already, pending, refused, silent, odd];
  check("the retirement outcome never changes the observed connection close", all.every((r) => r.connectionClosed === "confirmed"), all.map((r) => r.connectionClosed));
  check("every report names the leaf's broker validity", all.every((r) => r.credentialValidUntil === until && r.message.includes(validity)));
  check("no close report carries the credential bytes",
    all.every((r) => !JSON.stringify(r).includes(creds) && !JSON.stringify(r).includes("NATS USER JWT")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
