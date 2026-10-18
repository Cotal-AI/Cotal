/**
 * Injected secret-store boundary smoke: with a store injected into `runDelivery`, the store is the
 * ONLY credential source. Locks the seam invariant the hosted composition relies on: local-source
 * flags (`--creds`, `--dev-mint`) are rejected AT THE BOUNDARY (before any ambient signer read —
 * including the `--dev-mint` space derivation), and an absent key is a hard error naming the key,
 * never a fall-through to a local mint. Every case throws before any connection, so this needs no
 * broker. The fake store also proves a hosted store is never written to by the read path.
 *
 * The uninjected `--dev-mint` cases then pin which account signs the dev cred: the real CLI runs in
 * a scratch root against a listener that reads the user JWT out of the CONNECT and refuses it, so
 * the signer is observed directly and no broker is needed there either.
 *
 * Run: pnpm smoke:delivery-store-boundary
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAccountAuth, createSpaceAuth, type ParsedArgs, type SecretStore } from "@cotal-ai/core";
import { authDir, saveSpaceAccountAuth, saveSpaceAuth } from "@cotal-ai/workspace";
import { DELIVERY_CREDS_KIND, deliveryCredsKey, runDelivery } from "../src/delivery.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
};
const rejects = async (name: string, fn: () => Promise<unknown>, msgPart: string) => {
  try {
    await fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    check(name, (e as Error).message.includes(msgPart), (e as Error).message);
  }
};

// A hosted-shaped fake: async get, and any write/delete from the daemon's READ path is a bug.
const emptyStore: SecretStore = {
  get: async () => undefined,
  put: async () => { throw new Error("BUG: the daemon read path must never put"); },
  create: async () => { throw new Error("BUG: the daemon read path must never create"); },
  delete: async () => { throw new Error("BUG: the daemon read path must never delete"); },
};
const args = (values: Record<string, string | boolean>): ParsedArgs => ({ values, positionals: [], raw: [] });

await rejects(
  "injected + --creds is rejected at the boundary",
  () => runDelivery(args({ space: "s", creds: "/mounted/delivery.creds" }), emptyStore),
  "cannot be combined with an injected secret store",
);
await rejects(
  "injected + --dev-mint is rejected at the boundary",
  () => runDelivery(args({ space: "s", "dev-mint": true }), emptyStore),
  "cannot be combined with an injected secret store",
);
// No --space: the rejection must fire BEFORE the dev-mint space derivation would read the signer.
await rejects(
  "injected + --dev-mint rejected before any ambient signer read (no --space)",
  () => runDelivery(args({ "dev-mint": true }), emptyStore),
  "cannot be combined with an injected secret store",
);
// The key it names must be the PER-SPACE one (P7). A hosted composition provisions from this
// message, so naming the bare kind would send it to put the cred at the pre-P7 flat key — a
// location this daemon never reads, and a failure whose only symptom is a cred that is simply
// never found. `{ injected: true }` is the hosted composition: it resolves the key without
// touching a filesystem the host does not have.
const hostedKey = deliveryCredsKey("s", { injected: true });
check("the hosted key is per-space, not the bare kind", hostedKey !== DELIVERY_CREDS_KIND && hostedKey.endsWith(`/${DELIVERY_CREDS_KIND}`), hostedKey);
await rejects(
  "injected + absent key is a hard error naming the key — never a local mint",
  () => runDelivery(args({ space: "s" }), emptyStore),
  `no cred in the injected secret store under key "${hostedKey}"`,
);
// Without --dev-mint there is no ambient space derivation either: --space stays required.
await rejects(
  "injected + no --space is the explicit --space error (no ambient derivation)",
  () => runDelivery(args({}), emptyStore),
  "--space is required",
);

// UNINJECTED --dev-mint SIGNS WITH THE SERVED SPACE'S ACCOUNT. `two` holds spaces a and b under one
// operator, `one` holds only a. The child presents its dev cred to the listener, which records the
// JWT's issuer account and refuses it; the child then stops at its own later startup refusal.
const scratch = mkdtempSync(join(tmpdir(), "delivery-dev-mint-"));
const jwts: string[] = [];
const listener = createServer((c) => {
  c.write(`INFO {"server_id":"dev-mint","version":"2.10.0","proto":1,"headers":true,"max_payload":1048576,"auth_required":true,"nonce":"ZGV2bWludA"}\r\n`);
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    const m = /CONNECT (\{.*?\})\r\n/.exec(buf);
    if (m) { jwts.push(JSON.parse(m[1]).jwt); c.end("-ERR 'Authorization Violation'\r\n"); }
  });
  c.on("error", () => undefined);
});
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const server = `nats://127.0.0.1:${(listener.address() as AddressInfo).port}`;
try {
  const seed = async (name: string, first: string, ...rest: string[]): Promise<Record<string, string>> => {
    const root = join(scratch, name);
    mkdirSync(join(root, ".cotal"), { recursive: true });
    const base = await createSpaceAuth(first);
    saveSpaceAuth(authDir(root), base);
    const accounts: Record<string, string> = { [first]: base.account.pub };
    for (const s of rest) {
      const extra = await createSpaceAccountAuth(base, s);
      saveSpaceAccountAuth(authDir(root), extra);
      accounts[s] = extra.account.pub;
    }
    return accounts;
  };
  const two = await seed("two", "a", "b");
  const one = await seed("one", "a");
  // A source checkout refuses to seed the connector store, so the child skips seeding like the other CLI smokes.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "xdg") };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  Object.assign(env, { COTAL_HOME: join(scratch, "cotal-home"), COTAL_SKIP_CONNECTOR_SEED: "1" });
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  // Async so the listener in this process can answer the child's dial.
  const deliver = (root: string, ...flags: string[]): Promise<{ out: string; signer?: string }> =>
    new Promise((done) => {
      jwts.length = 0;
      const child = spawn(join(repoRoot, "node_modules", ".bin", "tsx"), [join(repoRoot, "bin", "cotal.ts"), "deliver", ...flags, "--dev-mint", "--server", server], { cwd: join(scratch, root), env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", () => {
        const jwt = jwts.at(-1);
        done({ out, signer: jwt ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).nats?.issuer_account : undefined });
      });
    });

  const explicit = await deliver("two", "--space", "b");
  check("--space b --dev-mint on a two-space root signs with b's account", explicit.signer === two.b, explicit.out);
  const missing = await deliver("one", "--space", "b");
  check("--space b --dev-mint on a root without b refuses before any dial", missing.signer === undefined && missing.out.includes(`no .cotal/auth for space "b"`), missing.out);
  const matching = await deliver("one", "--space", "a");
  check("--space a --dev-mint on a's root signs with a's account", matching.signer === one.a, matching.out);
  const implicit = await deliver("one");
  check("bare --dev-mint on a single-space root signs with that space's account", implicit.signer === one.a, implicit.out);
  const ambiguous = await deliver("two");
  check("bare --dev-mint on a two-space root refuses to pick a space", ambiguous.signer === undefined && ambiguous.out.includes("refuses to pick one"), ambiguous.out);
} finally {
  listener.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nDELIVERY-STORE-BOUNDARY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
