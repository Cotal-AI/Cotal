/**
 * A signing key must not expire unattended.
 *
 * The manager minted its session signing key once, at boot, with a flat 24h window:
 *
 *   validTo: Date.now() + SESSION_GRANT_MAX_TTL_MS
 *
 * and handed back that same frozen anchor forever. Past 24h of uptime every attach failed closed:
 *
 *   signing key mgr-sessions-UCZ2XFX524KR is outside its validity window at 1787489502074
 *   (window 1787365061492..1787451521492)
 *
 * Decoded: a 24.02h window, and the failure landed 10.55h AFTER expiry. Restarting the client does
 * nothing, because the dead window lives in the manager's anchor; the only recovery found was
 * restarting the manager, which kills every live session. It happened three times in one day.
 *
 * Failing closed on an expired key is correct (SPEC 13.10) and is NOT what this suite questions.
 * What it grades is that the key is renewed before it can expire, and that the old key stays
 * verifiable long enough that an artifact signed a moment before a swap is not orphaned by it.
 */
import assert from "node:assert/strict";
import {
  OVERLAP_MS,
  RENEW_AT_FRACTION,
  RotatingSigner,
  generationAnchor,
  needsRenewal,
  renewalDueAt,
} from "../src/signing-key-rotation.js";

let pass = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  const detail = `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`;
  failures.push(detail);
  console.log(`  ✗ ${detail}`);
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_787_365_061_492; // the real mint time from the incident

const mint = (seq: number, now: number) => ({
  keyId: `mgr-sessions-gen${seq}`,
  keyPair: { sign: () => new Uint8Array([seq]) },
  anchor: generationAnchor({
    keyId: `mgr-sessions-gen${seq}`,
    publicKey: `pub-${seq}`,
    owner: "ai.cotal.manager",
    roles: ["sessions"],
    scope: { sessions: ["ai.cotal.manager"] },
    now,
    ttlMs: DAY,
  }),
});

console.log("\n1. THE INCIDENT: a manager past its window still signs");
{
  const s = new RotatingSigner(mint, T0);
  const first = s.current().keyId;
  // The exact failure time from the operator's paste: 34.5h after mint.
  const atFailure = 1_787_489_502_074;
  s.maybeRenew(atFailure);
  const active = s.current().anchor;
  check("the signing key is still inside its window at the moment that used to fail", atFailure <= active.validTo, {
    at: atFailure,
    validTo: active.validTo,
  });
  check("because it rotated rather than expiring", s.current().keyId !== first, { first, now: s.current().keyId });
}

console.log("\n2. renewal happens EARLY, with the window mostly unspent");
{
  const a = generationAnchor({ keyId: "k", publicKey: "p", owner: "o", roles: ["sessions"], scope: {}, now: T0, ttlMs: DAY });
  const due = renewalDueAt(a);
  check("renewal is due before the window is half gone", due < a.validFrom + (a.validTo - a.validFrom) / 2);
  check("and not immediately at mint (that would rotate on every check)", due > a.validFrom);
  check("the margin left after the renewal point is the majority of the window", a.validTo - due > (a.validTo - a.validFrom) / 2);
  check("not yet due at mint", !needsRenewal(a, T0));
  check("due once the fraction has elapsed", needsRenewal(a, a.validFrom + Math.ceil((a.validTo - a.validFrom) * RENEW_AT_FRACTION)));
}

console.log("\n3. the OLD key stays verifiable across the swap");
{
  const s = new RotatingSigner(mint, T0);
  const old = s.current().keyId;
  const swapAt = T0 + Math.ceil(DAY * RENEW_AT_FRACTION) + 1;
  s.maybeRenew(swapAt);
  check("a new generation is active", s.current().keyId !== old);
  check("the OLD keyId still resolves right after the swap", s.resolve(old) !== undefined);
  check("an artifact signed under the old key can still be verified", (s.resolve(old)?.validTo ?? 0) >= swapAt);
}

console.log("\n4. and it is eventually dropped, so retention is not a leak");
{
  const s = new RotatingSigner(mint, T0);
  const old = s.current().keyId;
  s.maybeRenew(T0 + Math.ceil(DAY * RENEW_AT_FRACTION) + 1);
  const oldExpiry = s.resolve(old)!.validTo;
  s.maybeRenew(oldExpiry + OVERLAP_MS + 1);
  check("the superseded key is gone once its overlap has passed", s.resolve(old) === undefined);
  check("retention stays bounded across many rotations", (() => {
    const r = new RotatingSigner(mint, T0);
    for (let i = 1; i <= 50; i++) r.maybeRenew(T0 + i * DAY);
    return r.generations().length <= 3;
  })());
}

console.log("\n5. the newest key is NEVER dropped, whatever the clock does");
{
  const s = new RotatingSigner(mint, T0);
  // A clock jump far past every window: dropping everything would leave the plane unable to sign
  // at all, which is worse than serving with a key a verifier will reject.
  s.maybeRenew(T0 + 400 * DAY);
  check("a generation still exists after an absurd clock jump", s.generations().length >= 1);
  check("and it is signable", typeof s.current().keyPair.sign === "function");
}

console.log("\n6. renewal is idempotent - safe to call before every signature");
{
  const s = new RotatingSigner(mint, T0);
  const before = s.current().keyId;
  for (let i = 0; i < 100; i++) s.maybeRenew(T0 + 60_000);
  check("100 checks inside the window rotate nothing", s.current().keyId === before);
  check("and do not accumulate generations", s.generations().length === 1, { n: s.generations().length });
}

console.log("\n7. an unknown keyId still resolves to nothing (fail-closed is preserved)");
{
  const s = new RotatingSigner(mint, T0);
  check("a key that was never minted does not resolve", s.resolve("mgr-sessions-forged") === undefined);
}

console.log(`\nsigning key rotation: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`signing key rotation: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
