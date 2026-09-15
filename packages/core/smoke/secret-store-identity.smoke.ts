/**
 * Construction-time SecretStore identity: the #773 challenge names both stores and
 * never falls back between an fs root and an injected coordinate.
 */
import {
  divergentSecretStoreRefusal,
  foreignRenewalOwnerNote,
  formatSecretStoreIdentity,
  parseDaemonStoreAnswer,
  parseSecretStoreIdentity,
  sameSecretStoreIdentity,
} from "../src/secret-store.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn();
  } catch (e) {
    ok(name, String((e as Error).message).includes(needle), (e as Error).message);
    return;
  }
  throw new Error(`FAIL: ${name} - expected a loud throw`);
};

ok("same fs roots agree", sameSecretStoreIdentity({ kind: "fs", root: "/a/mesh" }, { kind: "fs", root: "/a/mesh" }));
ok("trailing slash does not split one root", sameSecretStoreIdentity({ kind: "fs", root: "/a/mesh/" }, { kind: "fs", root: "/a/mesh" }));
ok("two roots disagree", !sameSecretStoreIdentity({ kind: "fs", root: "/a" }, { kind: "fs", root: "/b" }));
ok("same injected coordinates agree", sameSecretStoreIdentity({ kind: "injected", coordinate: "vault:prod" }, { kind: "injected", coordinate: "vault:prod" }));
ok("injected coordinates disagree", !sameSecretStoreIdentity({ kind: "injected", coordinate: "vault:a" }, { kind: "injected", coordinate: "vault:b" }));
ok("fs never equals injected", !sameSecretStoreIdentity({ kind: "fs", root: "/a" }, { kind: "injected", coordinate: "/a" }));

const a = { kind: "fs" as const, root: "/mgr-root" };
const b = { kind: "fs" as const, root: "/daemon-root" };
const msg = divergentSecretStoreRefusal(a, b);
ok("refusal names the manager root", msg.includes("/mgr-root"));
ok("refusal names the daemon root", msg.includes("/daemon-root"));
const note = foreignRenewalOwnerNote(a, b);
ok("owner-elsewhere note names this manager's store", note.includes("/mgr-root"));
ok("owner-elsewhere note names the daemon's store", note.includes("/daemon-root"));
ok("owner-elsewhere note says this manager serves seats and does not remint", note.includes("serves seats") && note.includes("does not remint"));
ok("fs label is the root itself", formatSecretStoreIdentity(a) === "/mgr-root");
ok("injected label is prefixed", formatSecretStoreIdentity({ kind: "injected", coordinate: "kms:x" }) === "injected:kms:x");

ok("parse fs", parseSecretStoreIdentity({ kind: "fs", root: "/r" }).kind === "fs");
ok("parse injected", parseSecretStoreIdentity({ kind: "injected", coordinate: "kms:x" }).kind === "injected");
throws("parse refuses mixed shape", () => parseSecretStoreIdentity({ kind: "fs", root: "/r", coordinate: "x" }), "admits only");
throws("parse refuses blank root", () => parseSecretStoreIdentity({ kind: "fs", root: "  " }), "non-blank root");
throws("parse refuses unknown kind", () => parseSecretStoreIdentity({ kind: "s3", root: "/r" }), "fs\" or \"injected");

// The daemon's store answer carries its BINDING, because the delivery-admin rail is queue-grouped:
// any bound responder can answer, and only the delivery lease holder actually reloads the standing
// credentials. A field the parser accepted as absent would be a claim the caller could not check,
// so each one is required rather than defaulted.
const answer = parseDaemonStoreAnswer({ identity: { kind: "fs", root: "/daemon-root" }, responder: "local.UABC", holdsDeliveryLease: true });
ok("parse accepts a fully bound store answer", answer.identity.kind === "fs" && answer.responder === "local.UABC" && answer.holdsDeliveryLease);
ok("a lease-less answer parses and reports the claim honestly (refusing is the caller's job, not the parser's)",
  parseDaemonStoreAnswer({ identity: { kind: "fs", root: "/r" }, responder: "local.UX", holdsDeliveryLease: false }).holdsDeliveryLease === false);
throws("parse refuses an answer with no responder identity", () => parseDaemonStoreAnswer({ identity: { kind: "fs", root: "/r" }, holdsDeliveryLease: true }), "non-blank responder");
throws("parse refuses a blank responder identity", () => parseDaemonStoreAnswer({ identity: { kind: "fs", root: "/r" }, responder: "  ", holdsDeliveryLease: true }), "non-blank responder");
// An ABSENT lease claim must not read as false: false is a statement, absent is a missing field,
// and silently defaulting would let an old responder's reply be graded as an honest non-holder.
throws("parse refuses an ABSENT lease claim rather than defaulting it to false", () => parseDaemonStoreAnswer({ identity: { kind: "fs", root: "/r" }, responder: "local.UX" }), "holdsDeliveryLease");
throws("parse refuses a non-boolean lease claim", () => parseDaemonStoreAnswer({ identity: { kind: "fs", root: "/r" }, responder: "local.UX", holdsDeliveryLease: "true" }), "holdsDeliveryLease");
// The BARE pre-binding shape is refused: that is the wire form whose first-reply-wins reading let a
// second responder's store stand in for the reloading process's.
throws("parse refuses the bare identity shape that carried no binding", () => parseDaemonStoreAnswer({ kind: "fs", root: "/r" }), "non-blank responder");
throws("parse refuses a non-object answer", () => parseDaemonStoreAnswer("no responders"), "must be an object");

console.log(`\nSECRET-STORE-IDENTITY SMOKE OK  (${pass} passed)`);
