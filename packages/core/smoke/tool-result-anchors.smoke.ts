/**
 * Registered tool-result consent anchors (no NATS) — run with:
 *   pnpm --dir packages/core exec tsx smoke/tool-result-anchors.smoke.ts
 *
 * Drives the shipped parseToolResultConsentAnchors / readToolResultConsentAnchorFile /
 * toolResultConsentAnchorFileResolver / consentSignerStillCurrent with the shipped
 * mintToolResultConsent / verifyToolResultConsent: a registered anchor verifies; an unknown,
 * withdrawn, rotated-out or unreadable signer does not; role and scope cannot be configured; another
 * space or target refuses; no anchor file refuses; a consent expires.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "@nats-io/nkeys";
import { EpEnvelopeError } from "../src/endpoint-envelope.js";
import { readLaunchMaterial } from "../src/launch-material.js";
import { consentSignerStillCurrent, parseToolResultConsentAnchors, readToolResultConsentAnchorFile, toolResultConsentAnchorFileResolver, type ToolResultConsentAnchorRecord } from "../src/tool-result-anchors.js";
import { mintToolResultConsent, verifyToolResultConsent } from "../src/tool-result-consent.js";

let checks = 0;
const NOW = Date.now();
const SPACE = "team";
const TARGET = { owner: "u_" + "a".repeat(26), actor: "seat", lifecycleUid: "a".repeat(26) };
const HOLDER = `${TARGET.owner}.web`;
const dir = mkdtempSync(join(tmpdir(), "trca-"));
const file = join(dir, "anchors.json");
const host = createUser();
const next = createUser();
const stranger = createUser();
const record = (over: Partial<ToolResultConsentAnchorRecord> = {}, key = host): ToolResultConsentAnchorRecord =>
  ({ keyId: "host-1", publicKey: key.getPublicKey(), owner: "host.example", validFrom: NOW - 60_000, validTo: NOW + 3_600_000, ...over });
const write = (records: unknown) => writeFileSync(file, JSON.stringify(records));
const resolve = toolResultConsentAnchorFileResolver(file);
const mint = (keyId = "host-1", key = host, over: Record<string, unknown> = {}) =>
  mintToolResultConsent({ space: SPACE, target: TARGET, holder: HOLDER, proofAt: NOW - 1000, ttlMs: 120_000, issuerKeyId: keyId, now: NOW, ...(over as object) }, key);
const verify = (c: unknown, over: Record<string, unknown> = {}) => verifyToolResultConsent(c, { space: SPACE, expect: TARGET, resolveAnchor: resolve, now: NOW + 10, ...(over as object) });
const refused = async (what: string, run: () => Promise<unknown>, code?: string) => {
  await assert.rejects(run, (e: unknown) => e instanceof EpEnvelopeError && (code === undefined || e.code === code), what); checks++;
};

try {
  // ---- a recognized anchor ---------------------------------------------------------------------
  write([record()]);
  const [a] = readToolResultConsentAnchorFile(file);
  assert.deepEqual([a!.roles, a!.scope], [["consents"], { consents: ["tool-results"] }], "role and scope are fixed"); checks++;
  const good = mint();
  assert.equal((await verify(good)).id, good.id, "a consent from a registered anchor verifies"); checks++;
  assert.equal(await consentSignerStillCurrent(resolve, good), true, "its signer is current"); checks++;

  // ---- refusals --------------------------------------------------------------------------------
  await refused("an unknown signer", () => verify(mint("stranger", stranger)), "permission-denied");
  await refused("another space (account)", () => verify(good, { space: "neighbour" }), "permission-denied");
  await refused("another owner's target", () => verify(good, { expect: { ...TARGET, owner: "u_" + "b".repeat(26) } }), "target-mismatch");
  await refused("a successor incarnation", () => verify(good, { expect: { ...TARGET, lifecycleUid: "b".repeat(26) } }), "expired");
  await refused("finite expiry", () => verify(good, { now: good.exp + 1 }), "expired");

  // ---- rotation and withdrawal, read fresh -----------------------------------------------------
  write([record({ validTo: NOW - 1 }), record({ keyId: "host-2" }, next)]);
  await refused("a consent signed after its key's window closed", () => verify(mint("host-1", host, { now: NOW })));
  assert.equal((await verify(mint("host-2", next))).issuer.keyId, "host-2", "the successor key verifies"); checks++;
  write([record({ revoked: true })]);
  await refused("a withdrawn anchor", () => verify(good));
  assert.equal(await consentSignerStillCurrent(resolve, good), false, "an applied consent's withdrawn signer is no longer current"); checks++;

  // ---- failed refresh and no registration ------------------------------------------------------
  writeFileSync(file, "{ not json");
  await refused("an unreadable anchor file (failed refresh)", () => verify(good));
  assert.equal(await consentSignerStillCurrent(resolve, good), false, "a failed refresh withdraws, never keeps the last snapshot"); checks++;
  rmSync(file);
  await refused("no anchor file", () => verify(good));

  // ---- configuration refusals -----------------------------------------------------------------
  for (const [what, raw] of [
    ["an empty list", []],
    ["a role field", [{ ...record(), roles: ["sessions"] }]],
    ["a scope field", [{ ...record(), scope: { consents: ["*"] } }]],
    ["a duplicate key id", [record(), record({}, next)]],
    ["one key under two ids", [record(), record({ keyId: "host-2" })]],
    ["a non-user key", [record({ publicKey: "A" + host.getPublicKey().slice(1) })]],
    ["a backward window", [record({ validFrom: NOW, validTo: NOW - 1 })]],
    ["a non-boolean withdrawal", [{ ...record(), revoked: "yes" }]],
  ] as const) {
    assert.throws(() => parseToolResultConsentAnchors(raw), Error, `${what} refuses`); checks++;
  }
  writeFileSync(join(dir, "material.json"), JSON.stringify({ creds: "/c", toolResults: { creds: "x", grant: { endpoint: "tool-results", instanceId: "a".repeat(26), epoch: 1 }, consentAnchors: "relative.json" } }), { mode: 0o600 });
  assert.throws(() => readLaunchMaterial(join(dir, "material.json")), /not an absolute path/, "launch material refuses a relative anchor path"); checks++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`tool-result-anchors smoke: ${checks} checks passed`);
