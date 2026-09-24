/**
 * Construction-time SecretStore identity: the #773 challenge names both stores and
 * never falls back between an fs root and an injected coordinate.
 */
import {
  divergentSecretStoreNotice,
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
const msg = divergentSecretStoreNotice(a, b);
ok("notice names the manager root", msg.includes("/mgr-root"));
ok("notice names the daemon root", msg.includes("/daemon-root"));
ok("fs label is the root itself", formatSecretStoreIdentity(a) === "/mgr-root");
ok("injected label is prefixed", formatSecretStoreIdentity({ kind: "injected", coordinate: "kms:x" }) === "injected:kms:x");

ok("parse fs", parseSecretStoreIdentity({ kind: "fs", root: "/r" }).kind === "fs");
ok("parse injected", parseSecretStoreIdentity({ kind: "injected", coordinate: "kms:x" }).kind === "injected");
throws("parse refuses mixed shape", () => parseSecretStoreIdentity({ kind: "fs", root: "/r", coordinate: "x" }), "admits only");
throws("parse refuses blank root", () => parseSecretStoreIdentity({ kind: "fs", root: "  " }), "non-blank root");
throws("parse refuses unknown kind", () => parseSecretStoreIdentity({ kind: "s3", root: "/r" }), "fs\" or \"injected");

// ---------- #1694: the answer to the store challenge names the process that answered ----------
// The delivery-admin rail is queue-grouped, so the store a manager compares against is the store of
// AN answerer unless the reply says whose it is. These cells grade the parser only. Whether a
// non-holder is refused is the caller's job, and the parser must not pre-empt it: an honest
// `false` has to survive parsing so the caller can act on it and say why.
const ANS = { identity: { kind: "fs" as const, root: "/r" }, responder: "dlv-1", holdsDeliveryLease: true };
ok("parse accepts a fully bound store answer",
  parseDaemonStoreAnswer(ANS).responder === "dlv-1" && parseDaemonStoreAnswer(ANS).identity.kind === "fs");
ok("a lease-less answer parses and reports the claim honestly (refusing is the caller's job, not the parser's)",
  parseDaemonStoreAnswer({ ...ANS, holdsDeliveryLease: false }).holdsDeliveryLease === false);
throws("parse refuses the bare identity shape that carried no binding",
  () => parseDaemonStoreAnswer({ kind: "fs", root: "/r" }), "admits only");
throws("parse refuses an answer with no responder identity",
  () => parseDaemonStoreAnswer({ identity: ANS.identity, holdsDeliveryLease: true }), "non-blank responder");
throws("parse refuses a blank responder identity",
  () => parseDaemonStoreAnswer({ ...ANS, responder: "   " }), "non-blank responder");
throws("parse refuses an ABSENT lease claim rather than defaulting it to false",
  () => parseDaemonStoreAnswer({ identity: ANS.identity, responder: "dlv-1" }), "an absent claim is not a false one");
throws("parse refuses a non-boolean lease claim",
  () => parseDaemonStoreAnswer({ ...ANS, holdsDeliveryLease: "yes" }), "as a boolean");
throws("parse refuses a non-object answer", () => parseDaemonStoreAnswer("x"), "must be an object");
throws("parse refuses an UNKNOWN top-level key rather than ignoring it (closed, like the identity parser)",
  () => parseDaemonStoreAnswer({ ...ANS, extra: 1 }), "admits only");
throws("...and the refusal NAMES the unknown key, so an operator sees which field was not understood",
  () => parseDaemonStoreAnswer({ ...ANS, extra: 1 }), "unknown: extra");
ok("CONTROL: the admitted three-field shape still parses after the extra-key refusal",
  parseDaemonStoreAnswer(ANS).holdsDeliveryLease === true);

console.log(`\nSECRET-STORE-IDENTITY SMOKE OK  (${pass} passed)`);
