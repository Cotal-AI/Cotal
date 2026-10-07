/**
 * Hosted auth-service lifetime, native: two real data accounts on one broker, each with its own
 * callout account and injected store, started in ONE process through `startAuthService`.
 * Locks store-identity and account refusals, independent readiness, a context-local failed start
 * (duplicate plane claim) that leaves the sibling ready, no process signal/exit/cwd footprint,
 * and close of one context releasing only its own plane claim.
 *
 * Run: pnpm smoke:hosted-auth-lifetime   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { epAuthBucket, mintCreds, newIdentity, setupSpaceStreams, type SecretStore } from "@cotal-ai/core";
import { Kvm } from "@nats-io/kv";
import { openAuthorityClient, authorityBarrierGrants } from "../src/authority-client.js";
import { planeClaimRefusal, startAuthService, type AuthServiceHandle } from "../src/index.js";
import { parsePlaneClaimRow, PLANE_CLAIM_KEY } from "../src/plane-claim.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("hosted-auth");
const handles: AuthServiceHandle[] = [];
let count = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); count++; };
const refuses = async (p: Promise<unknown>, re: RegExp, name: string) => { await assert.rejects(p, re, name); count++; };
const health = async (h: AuthServiceHandle) => {
  try { const r = await fetch(`${h.url}/health`); return r.ok ? ((await r.json()) as { issuer: string }).issuer : undefined; }
  catch { return undefined; }
};
try {
  const [a, b] = fx.accounts;
  // Each fixture account is a provisioned space (as a hosted platform provisions it before starting
  // auth, and as hosted-bootstrap-order does): the per-space streams the auth plane publishes into.
  for (const acct of fx.accounts)
    await setupSpaceStreams({ servers: fx.servers, space: acct.space, creds: await mintCreds(acct.auth, newIdentity(), "provisioner") });
  const inputs = fx.accounts.map((acct, i) => ({
    context: { accountPublicKey: acct.accountPublicKey, lifecycleUid: `life-${i}` },
    space: acct.space, servers: fx.servers, store: acct.store, storeIdentity: acct.store.identity, stateDir: acct.stateDir,
  }));
  const signals = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
  const exit = process.exit;
  // Before/after footprint of the cwd AND of any pre-existing cwd .cotal folder (a real worktree may
  // already carry one): hosted contexts must neither create nor write into a cwd-selected root.
  const cwdCotal = join(process.cwd(), ".cotal");
  const footprint = () => JSON.stringify([readdirSync(process.cwd()).sort(), existsSync(cwdCotal) ? readdirSync(cwdCotal, { recursive: true }).map(String).sort() : null]);
  const cwdBefore = footprint();
  const anonymous: SecretStore = { get: (k) => a.store.get(k), put: (k, v) => a.store.put(k, v), delete: (k) => a.store.delete(k) };
  await refuses(startAuthService({ ...inputs[0], store: anonymous }), /must declare a stable identity/, "identity-less store refuses");
  await refuses(startAuthService({ ...inputs[0], storeIdentity: b.store.identity }), /identity does not match/, "wrong store identity refuses");
  await refuses(startAuthService({ ...inputs[0], context: inputs[1].context }), /data account does not match/, "wrong assigned account refuses");
  await refuses(startAuthService({ ...inputs[0], stateDir: "" }), /needs an account/, "missing stateDir refuses");

  const [first, second] = await Promise.all(inputs.map((input) => startAuthService(input)));
  handles.push(first, second);
  ok(JSON.stringify(await first.readiness()) === JSON.stringify({ state: "ready", context: inputs[0].context }), "A ready with its assigned context");
  ok(JSON.stringify(await second.readiness()) === JSON.stringify({ state: "ready", context: inputs[1].context }), "B ready with its assigned context");
  const [issA, issB] = [await health(first), await health(second)];
  ok(issA !== undefined && issB !== undefined && issA !== issB, "each context serves its own issuer on its own listener");

  await refuses(startAuthService(inputs[0]), /plane|claim|held/i, "a duplicate context for A refuses locally at the plane claim");
  ok(process.exit === exit, "no process.exit replaced or called by a failed start");
  ok(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT") === signals, "hosted contexts install no process signal listeners");
  ok(footprint() === cwdBefore, "no cwd-selected root was created or written");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B remains ready and serving after A's failed duplicate");
  ok((await first.readiness()).state === "ready" && (await health(first)) === issA, "A remains ready after its own refused duplicate");

  await first.drain();
  ok((await first.readiness()).state === "draining", "A reports draining after drain");
  ok((await health(first)) === undefined, "A's listener is closed after drain");
  ok((await second.readiness()).state === "ready" && (await health(second)) === issB, "B remains ready after A closes");

  const restarted = await startAuthService(inputs[0]);
  handles.push(restarted);
  ok((await restarted.readiness()).state === "ready" && (await health(restarted)) === issA, "A restarts over its released plane claim");
  ok((await health(second)) === issB, "B remains serving after A restarts");
  await restarted.close();
  await first.close();
  await second.close();
  await second.close();
  ok((await health(second)) === undefined, "B closes idempotently");
  const retry = await startAuthService(inputs[0]);
  handles.push(retry);
  await fx.stopBroker();
  let closeFailure: unknown;
  try { await retry.close(); } catch (e) { closeFailure = e; }
  ok(planeClaimRefusal(closeFailure) === "release-unreachable", "hosted close exposes a typed retryable release refusal");
  ok((await retry.readiness()).state !== "ready", "failed close does not report hosted context ready");
  await fx.restartBroker();
  const verifier = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! }, label: `cotal:auth-barrier:${a.space}`, grants: (id) => authorityBarrierGrants(a.space, id), log: () => {} });
  try {
    const kv = await new Kvm(verifier.nc).open(epAuthBucket(a.space));
    ok(parsePlaneClaimRow((await kv.get(PLANE_CLAIM_KEY))!.value)?.state === "held", "hosted failed close leaves the row held");
    // The independent verifier can connect before the existing barrier has reconnected.
    await new Promise((r) => setTimeout(r, 1000));
    let retryFailure: unknown;
    try { await retry.close(); } catch (e) { retryFailure = e; }
    ok(retryFailure === undefined && parsePlaneClaimRow((await kv.get(PLANE_CLAIM_KEY))!.value)?.state === "released",
      "hosted close retries the release after the broker returns");
  } finally { await verifier.close(); }
  console.log(`hosted auth lifetime: ${count} two-account assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  for (const h of handles) await h.close().catch(() => {});
  await fx.close();
}

// The public embedder lifetime cells share this already fragment-registered CI entrypoint.
await import("./auth-public-closure.smoke.js");
await import("./plane-claim-public.smoke.js");
await import("./account-liveness-public.smoke.js");
