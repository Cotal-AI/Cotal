/**
 * Broker-free remint-cap encoding: mint, resource/actor bind, key-possession, replay.
 *
 * PRODUCTION CALLER: packages/core/src/session-remint-cap.ts
 * mintSessionRemintCap / verifySessionRemintCap / parseSessionRemintCapShape.
 * Launch-material field: packages/core/src/launch-material.ts remintCap.
 * ctx.cap is not used. A loopback operator bearer is not a remint cap.
 *
 * Run: pnpm smoke:session-remint-cap
 */
import { fromSeed } from "@nats-io/nkeys";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EpEnvelopeError,
  mintSessionRemintCap,
  newArtifactSigner,
  newIdentity,
  parseSessionRemintCapShape,
  readLaunchMaterial,
  verifySessionRemintCap,
  writeLaunchMaterial,
  type ResourceKey,
  type SignerAnchor,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown> | unknown, code: string) => {
  try { await fn(); c(name, false, "no throw"); }
  catch (e) { c(name, e instanceof EpEnvelopeError && e.code === code, (e as Error).message); }
};

const NOW = 1_788_900_000_000;
const SPACE = "remintcap";
const resource: ResourceKey = {
  hostIdentity: "host-key-sha256:abc",
  provider: "com.cotal.opencode",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "native-session-17",
  resourceGeneration: "creation:2026-09-08T20:00:00Z",
};
const otherResource: ResourceKey = { ...resource, stableSessionId: "native-session-99" };
const identity = newIdentity();
const holder = { owner: "u_alice", actor: "native_session", lifecycleUid: "0123456789abcdefghijklmnop" };
const issuer = newArtifactSigner();
const issuerKeyId = "remint-1";
const anchor: SignerAnchor = {
  keyId: issuerKeyId,
  publicKey: issuer.publicKey,
  owner: "u_alice.owner",
  roles: ["sessions"],
  scope: { sessions: ["session-remint"] },
  validFrom: 0,
  validTo: NOW + 10_000_000_000,
};
const resolveAnchor = (keyId: string) => keyId === issuerKeyId ? anchor : undefined;
const cap = mintSessionRemintCap({
  space: SPACE,
  resourceKey: resource,
  holder,
  enrolledPublicId: identity.id,
  ttlMs: 60_000,
  issuerKeyId,
  now: NOW,
}, issuer);
const possession = fromSeed(new TextEncoder().encode(identity.seed)).sign(new TextEncoder().encode(cap.nonce));
const used = new Set<string>();
const nonceSeen = (nonce: string) => used.has(nonce);
const markNonce = (nonce: string) => { used.add(nonce); };
const verify = (raw: unknown, over: Partial<Parameters<typeof verifySessionRemintCap>[1]> = {}) =>
  verifySessionRemintCap(raw, {
    space: SPACE,
    resolveAnchor,
    now: NOW + 1_000,
    resourceKey: resource,
    holder,
    enrolledPublicId: identity.id,
    possession,
    nonceSeen,
    markNonce,
    ...over,
  });

c("minted cap family is session-remint", cap.family === "session-remint");
c("minted cap binds enrolled nkey", cap.enrolledPublicId === identity.id);
c("minted cap binds actor and lifecycle", cap.holder.owner === holder.owner && cap.holder.actor === holder.actor && cap.holder.lifecycleUid === holder.lifecycleUid);
c("shape parser accepts a minted cap", parseSessionRemintCapShape(cap).nonce === cap.nonce);

const first = await verify(cap);
c("PRODUCTION CALLER verifySessionRemintCap accepts matching possession", first.nonce === cap.nonce);

await rejects("wrong resource is refused", () => verify(cap, { resourceKey: otherResource, nonceSeen: () => false, markNonce: () => {} }), "permission-denied");
await rejects("wrong lifecycle is refused", () => verify(cap, {
  holder: { ...holder, lifecycleUid: "abcdefghijklmnopqrstuvwxyz" },
  nonceSeen: () => false,
  markNonce: () => {},
}), "permission-denied");
const otherId = newIdentity();
await rejects("wrong nkey possession is refused", () => verify(cap, {
  possession: fromSeed(new TextEncoder().encode(otherId.seed)).sign(new TextEncoder().encode(cap.nonce)),
  nonceSeen: () => false,
  markNonce: () => {},
}), "permission-denied");
await rejects("replay of a used nonce is refused", () => verify(cap), "permission-denied");

const path = writeLaunchMaterial({ remintCap: cap, servers: "nats://127.0.0.1:4222" });
const read = readLaunchMaterial(path);
c("launch material round-trips remintCap", read.remintCap?.id === cap.id && read.remintCap?.nonce === cap.nonce);
c("launch material remintCap is not a loopback operator bearer", read.remintCap?.family === "session-remint");

const badDir = mkdtempSync(join(tmpdir(), "cotal-remintcap-"));
const badPath = join(badDir, "material.json");
writeFileSync(badPath, JSON.stringify({ remintCap: { family: "session-remint" } }), { mode: 0o600 });
try {
  readLaunchMaterial(badPath);
  c("garbled remintCap in launch material is refused", false);
} catch (e) {
  c("garbled remintCap in launch material is refused", e instanceof Error && e.message.includes("remintCap"));
}
rmSync(badDir, { recursive: true, force: true });

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
