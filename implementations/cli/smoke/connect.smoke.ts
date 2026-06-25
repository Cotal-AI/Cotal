/**
 * The preflight decision tree — `classifyPreflightFailure` (lib/connect.ts). This is the riskiest
 * new logic in the command migration: a wrong branch PRUNES A LIVE registry entry. Pure + offline,
 * so every (source × reason × has-auth) combination is exercised here without a broker. The
 * load-bearing invariant: a NON-registry source (flag-server / local-space, or a raw `--creds`
 * connection) is never pruned — only the registry owns its entries. Run: pnpm smoke:connect
 */
import { strict as assert } from "node:assert";
import { classifyPreflightFailure } from "../src/lib/connect.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const REGISTRY = ["registry", "current", "flag-space", "local-recorded"] as const;
const NON_REGISTRY = ["flag-server", "local-space"] as const;

// unreachable: a registry-owned target prunes (broker gone); a non-registry one never does.
for (const s of REGISTRY)
  check(
    `unreachable + ${s} → prune + 'unreachable'`,
    (() => {
      const r = classifyPreflightFailure(s, "unreachable", true);
      return r.prune === true && r.kind === "unreachable";
    })(),
  );
for (const s of NON_REGISTRY)
  check(
    `unreachable + ${s} → NO prune + 'unreachable'`,
    (() => {
      const r = classifyPreflightFailure(s, "unreachable", false);
      return r.prune === false && r.kind === "unreachable";
    })(),
  );

// auth-required, registry-owned WITH auth: minted creds rejected → stale entry, prune.
check("auth-required + registry + has-auth → prune + 'registry-creds-rejected'", (() => {
  const r = classifyPreflightFailure("flag-space", "auth-required", true);
  return r.prune === true && r.kind === "registry-creds-rejected";
})());
// auth-required, registry-owned OPEN: probed credless, broker now wants auth → stale, prune.
check("auth-required + registry + open → prune + 'registry-open-now-auth'", (() => {
  const r = classifyPreflightFailure("registry", "auth-required", false);
  return r.prune === true && r.kind === "registry-open-now-auth";
})());
// auth-required, NON-registry WITH auth: caller's creds rejected → user owns it, NO prune.
check("auth-required + local + has-auth → NO prune + 'creds-rejected'", (() => {
  const r = classifyPreflightFailure("local-space", "auth-required", true);
  return r.prune === false && r.kind === "creds-rejected";
})());
// auth-required, NON-registry open: broker wants auth, we hold none → NO prune.
check("auth-required + local + open → NO prune + 'open-wants-auth'", (() => {
  const r = classifyPreflightFailure("flag-server", "auth-required", false);
  return r.prune === false && r.kind === "open-wants-auth";
})());

// The invariant, exhaustively: a non-registry source is NEVER pruned — whatever the reason/auth.
// (This is the guard behind the escape hatch: a bad `--creds` can't delete a good registry entry.)
for (const s of NON_REGISTRY)
  for (const reason of ["unreachable", "auth-required"] as const)
    for (const hasAuth of [true, false])
      check(
        `non-registry ${s} / ${reason} / auth=${hasAuth} never prunes`,
        classifyPreflightFailure(s, reason, hasAuth).prune === false,
      );

console.log(`\nconnect (preflight classifier) smoke: ${pass} checks passed`);
process.exit(0);
