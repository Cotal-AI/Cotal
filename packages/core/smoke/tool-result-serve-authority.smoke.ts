/**
 * User-mode tool-results serve issuance, participant half (no NATS) — run with:
 *   pnpm --dir packages/core exec tsx smoke/tool-result-serve-authority.smoke.ts
 *
 * Drives the shipped parseToolResultServeAuthorityRequest / toolResultServingFromMaterial /
 * writeToolResultServingFile / readToolResultServingFile / toolResultServingFileResolver: the request
 * is closed; the host's answer must echo the request and name this space, the tool-results endpoint,
 * this incarnation and (on renew) this epoch, carry a live JWT for the serve key, and well-formed
 * anchors; the serving file is 0600 and the resolver answers nothing once the file is gone, past
 * notAfter, or without anchors. The host half (ledger/enrollment/parent checks, registration,
 * mint) is not in this module and is not exercised here.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "@nats-io/nkeys";
import { newIdentity } from "../src/identity.js";
import { TOOL_RESULT_ENDPOINT } from "../src/tool-result-contract.js";
import {
  parseToolResultServeAuthorityRequest,
  readToolResultServingFile,
  toolResultServingFileResolver,
  toolResultServingFromMaterial,
  writeToolResultServingFile,
  type ToolResultServeAuthorityRequest,
} from "../src/tool-result-serve-authority.js";

let checks = 0;
const ok = (value: unknown, message: string): void => { assert.ok(value, message); checks++; };
const throws = (run: () => unknown, message: string): void => { assert.throws(run, message); checks++; };

const NOW = Date.now();
const SPACE = "team";
const OWNER = "u_" + "a".repeat(26);
const UID = "a".repeat(26);
const identity = newIdentity();
const host = createUser();
const request = (over: Partial<ToolResultServeAuthorityRequest> = {}): ToolResultServeAuthorityRequest => ({
  v: 1, kind: "tool-result-serve-authority", operation: "issue", space: SPACE, target: { actor: "seat", lifecycleUid: UID },
  managerInstanceId: "mgr-1", serve: { id: identity.id }, requestId: "r".repeat(24), ...over,
});
const jwt = (sub: string, exp: number) => `e30.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.sig`;
const anchor = { keyId: "host-1", publicKey: host.getPublicKey(), owner: "host.example", validFrom: NOW - 60_000, validTo: NOW + 3_600_000 };
const material = (req: ToolResultServeAuthorityRequest, over: Record<string, unknown> = {}, grant: Record<string, unknown> = {}) => ({
  v: 1, kind: "tool-result-serve-authority", operation: req.operation, space: req.space, owner: OWNER, target: req.target, requestId: req.requestId,
  grant: { space: SPACE, endpoint: TOOL_RESULT_ENDPOINT, instanceId: UID, epoch: 3, owner: OWNER, registrationRevision: 1, nameAuthorityRevision: 1, commands: ["tool-result"], surface: {}, ...grant },
  credential: { jwt: jwt(identity.id, Math.floor(NOW / 1000) + 600), exp: Math.floor(NOW / 1000) + 600 },
  consentAnchors: [anchor],
  ...over,
});

// ---- the request is closed ---------------------------------------------------------------------
ok(parseToolResultServeAuthorityRequest(request()).operation === "issue", "a well-formed issue request parses");
ok(parseToolResultServeAuthorityRequest(request({ operation: "renew", epoch: 3 })).epoch === 3, "a renew names the current epoch");
throws(() => parseToolResultServeAuthorityRequest(request({ operation: "renew" })), "a renew without an epoch is refused");
throws(() => parseToolResultServeAuthorityRequest(request({ epoch: 3 })), "an issue carrying an epoch is refused");
throws(() => parseToolResultServeAuthorityRequest({ ...request(), registry: "*" }), "an extra field (a registry-wide read) is refused");
throws(() => parseToolResultServeAuthorityRequest(request({ requestId: "short" })), "a short request id is refused");
throws(() => parseToolResultServeAuthorityRequest(request({ serve: { id: "A".repeat(56) } })), "a serve key that is not a user nkey is refused");

// ---- the host's answer must be this request's -------------------------------------------------
const issued = toolResultServingFromMaterial(material(request()), request(), identity);
ok(issued.creds.includes("BEGIN NATS USER JWT") && issued.grant.instanceId === UID && issued.consentAnchors?.length === 1, "the answer becomes creds, this incarnation's grant and the host's anchors");
ok(issued.notAfter === (Math.floor(NOW / 1000) + 600) * 1000, "notAfter is the credential's own expiry");
throws(() => toolResultServingFromMaterial(material(request(), { requestId: "x".repeat(24) }), request(), identity), "a replayed answer to another request is refused");
throws(() => toolResultServingFromMaterial(material(request(), { space: "neighbour" }), request(), identity), "an answer for a neighbouring space is refused");
throws(() => toolResultServingFromMaterial(material(request(), {}, { space: "neighbour" }), request(), identity), "a grant for a neighbouring space is refused");
throws(() => toolResultServingFromMaterial(material(request(), {}, { owner: "u_" + "b".repeat(26) }), request(), identity), "a grant for a neighbouring owner is refused");
throws(() => toolResultServingFromMaterial(material(request(), {}, { endpoint: "browser" }), request(), identity), "a grant for another endpoint is refused");
throws(() => toolResultServingFromMaterial(material(request(), {}, { instanceId: "b".repeat(26) }), request(), identity), "a grant for a stale or successor incarnation is refused");
throws(() => toolResultServingFromMaterial(material(request(), { target: { actor: "sibling", lifecycleUid: UID } }), request(), identity), "an answer naming a sibling agent is refused");
const renew = request({ operation: "renew", epoch: 2 });
throws(() => toolResultServingFromMaterial(material(renew), renew, identity), "a renewal whose grant moved to another epoch is refused");
throws(() => toolResultServingFromMaterial(material(request(), { credential: { jwt: jwt(createUser().getPublicKey(), Math.floor(NOW / 1000) + 600), exp: Math.floor(NOW / 1000) + 600 } }), request(), identity), "a JWT for another key is refused");
throws(() => toolResultServingFromMaterial(material(request(), { credential: { jwt: jwt(identity.id, Math.floor(NOW / 1000) - 1), exp: Math.floor(NOW / 1000) - 1 } }), request(), identity), "an already-expired credential is refused");
throws(() => toolResultServingFromMaterial(material(request(), { consentAnchors: [{ ...anchor, roles: ["sessions"] }] }), request(), identity), "anchors that try to configure role or scope are refused");

// ---- the serving file and its resolver ---------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "trsa-"));
const file = join(dir, "seat.tool-results.json");
let clock = NOW;
const resolve = toolResultServingFileResolver(file, () => clock);
try {
  ok(resolve("host-1") === undefined, "no serving file: no anchor resolves");
  writeToolResultServingFile(file, issued);
  ok(readToolResultServingFile(file).grant.epoch === 3, "the written file reads back");
  ok(resolve("host-1")?.publicKey === host.getPublicKey(), "the host's anchor resolves while the credential is current");
  ok(resolve("stranger") === undefined, "an unregistered signer does not resolve");
  clock = issued.notAfter + 1;
  ok(resolve("host-1") === undefined, "past notAfter the snapshot is not current and nothing resolves");
  clock = NOW;
  chmodSync(file, 0o644);
  throws(() => readToolResultServingFile(file), "a group/world-readable serving file is refused");
  ok(resolve("host-1") === undefined, "a group/world-readable serving file resolves nothing");
  const { consentAnchors: _anchors, ...bare } = issued;
  writeToolResultServingFile(file, bare);
  ok(resolve("host-1") === undefined, "a serve without host anchors resolves nothing");
  rmSync(file);
  ok(resolve("host-1") === undefined, "a removed file (failed renewal) resolves nothing");
  throws(() => writeToolResultServingFile("relative.json", issued), "a relative serving-file path is refused");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`tool-result-serve-authority smoke: ${checks} checks passed`);
