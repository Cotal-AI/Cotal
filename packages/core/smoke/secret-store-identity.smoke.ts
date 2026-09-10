/**
 * Construction-time SecretStore identity: the #773 challenge names both stores and
 * never falls back between an fs root and an injected coordinate.
 */
import {
  divergentSecretStoreRefusal,
  formatSecretStoreIdentity,
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
ok("fs label is the root itself", formatSecretStoreIdentity(a) === "/mgr-root");
ok("injected label is prefixed", formatSecretStoreIdentity({ kind: "injected", coordinate: "kms:x" }) === "injected:kms:x");

ok("parse fs", parseSecretStoreIdentity({ kind: "fs", root: "/r" }).kind === "fs");
ok("parse injected", parseSecretStoreIdentity({ kind: "injected", coordinate: "kms:x" }).kind === "injected");
throws("parse refuses mixed shape", () => parseSecretStoreIdentity({ kind: "fs", root: "/r", coordinate: "x" }), "admits only");
throws("parse refuses blank root", () => parseSecretStoreIdentity({ kind: "fs", root: "  " }), "non-blank root");
throws("parse refuses unknown kind", () => parseSecretStoreIdentity({ kind: "s3", root: "/r" }), "fs\" or \"injected");

console.log(`\nSECRET-STORE-IDENTITY SMOKE OK  (${pass} passed)`);
