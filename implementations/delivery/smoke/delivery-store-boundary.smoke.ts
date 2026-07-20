/**
 * Injected secret-store boundary smoke: with a store injected into `runDelivery`, the store is the
 * ONLY credential source. Locks the seam invariant the hosted composition relies on: local-source
 * flags (`--creds`, `--dev-mint`) are rejected AT THE BOUNDARY (before any ambient signer read —
 * including the `--dev-mint` space derivation), and an absent key is a hard error naming the key,
 * never a fall-through to a local mint. Every case throws before any connection, so this needs no
 * broker. The fake store also proves a hosted store is never written to by the read path.
 *
 * Run: pnpm smoke:delivery-store-boundary
 */
import type { ParsedArgs, SecretStore } from "@cotal-ai/core";
import { DELIVERY_CREDS_KEY, runDelivery } from "../src/delivery.js";

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
await rejects(
  "injected + absent key is a hard error naming the key — never a local mint",
  () => runDelivery(args({ space: "s" }), emptyStore),
  `no cred in the injected secret store under key "${DELIVERY_CREDS_KEY}"`,
);
// Without --dev-mint there is no ambient space derivation either: --space stays required.
await rejects(
  "injected + no --space is the explicit --space error (no ambient derivation)",
  () => runDelivery(args({}), emptyStore),
  "--space is required",
);

console.log(`\nDELIVERY-STORE-BOUNDARY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
