/**
 * Host half of user-mode tool-results serving: the fences, the anchor snapshot, the route (no NATS)
 * — run with:
 *   pnpm --dir implementations/auth exec tsx smoke/tool-result-serving.smoke.ts
 *
 * Drives the shipped authorizeToolResultServe over a REAL ledger directory (grantActor,
 * grantManagedActor), the REAL host-keyed registration proof (remoteManagerCurrentRegistrationProof)
 * and the gate/head reads the plane injects; currentToolResultConsentAnchors over a resolver; and
 * stock dispatchManagerAuthorityRequest's routing. One POSITIVE control and one refusal per fence:
 * another space, no `supervise`, no or frozen manager gate, a neighbour owner's gate, a stale serve
 * epoch, a forged proof, an absent row, a successor or stale lifecycle, a child of another actor,
 * a retiring or successor head (an absent, not-yet-activated head is the positive fresh-spawn
 * case), a malformed request. The effect (registration, mint, renew at the same epoch,
 * deregistration) needs a live broker and is NOT exercised here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "@nats-io/nkeys";
import {
  EpEnvelopeError, mintLifecycleUid, REMOTE_MANAGER_IDENTITY_NAMES, remoteManagerActors,
  type AnchorResolver, type SignerAnchor, type ToolResultServeAuthorityRequest,
} from "@cotal-ai/core";
import { grantActor, grantManagedActor, remoteManagerCurrentRegistrationProof } from "../src/index.js";
import { dispatchManagerAuthorityRequest } from "../src/service.js";
import { authorizeToolResultServe, currentToolResultConsentAnchors, type AuthorizeToolResultServeArgs } from "../src/tool-result-serving.js";

let checks = 0;
const SPACE = "team";
const OWNER = "u_" + "a".repeat(26);
const NEIGHBOUR = "u_" + "b".repeat(26);
const SECRET = "host-proof-secret";
const dir = mkdtempSync(join(tmpdir(), "trsh-"));
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const childUid = mintLifecycleUid();
const identities = Object.fromEntries(REMOTE_MANAGER_IDENTITY_NAMES.map((n) => [n, { id: createUser().getPublicKey() }])) as ToolResultServeAuthorityRequest["identities"];
const gate = { state: "open" as const, principal: `${OWNER}.${remoteManagerActors(instanceId).serve}`, processEpoch: 4, registrationRevision: 9 };

try {
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["supervise", "spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  grantActor(dir, { owner: OWNER, actor: "other", scope: ["supervise", "spawn"], allowSubscribe: [">"], allowPublish: [">"] });
  const tokenHash = createHash("sha256").update("actor-token").digest("hex");
  grantManagedActor(dir, { owner: OWNER, actor: "seat", scope: [], allowSubscribe: [], allowPublish: [], parent: `${OWNER}.cli`, lifecycleUid: childUid, tokenHash });
  grantManagedActor(dir, { owner: OWNER, actor: "stray", scope: [], allowSubscribe: [], allowPublish: [], parent: `${OWNER}.other`, lifecycleUid: mintLifecycleUid(), tokenHash });

  const envelope = { space: SPACE, actor: "cli", instanceId, managerLifecycleUid, identities };
  const request = (over: Partial<ToolResultServeAuthorityRequest> = {}): ToolResultServeAuthorityRequest => ({
    v: 1, kind: "tool-result-serve-authority", operation: "issue", ...envelope,
    requestId: `toolresult${mintLifecycleUid()}`,
    registrationProof: remoteManagerCurrentRegistrationProof(SECRET, OWNER, envelope, gate),
    serveEpoch: gate.processEpoch,
    target: { actor: "seat", lifecycleUid: childUid },
    serve: { id: createUser().getPublicKey() },
    ...over,
  });
  const args = (over: Partial<AuthorizeToolResultServeArgs> = {}): AuthorizeToolResultServeArgs => ({
    request: request(), space: SPACE, owner: OWNER, scope: ["supervise"], dir, proofSecret: SECRET,
    observeManagerGate: async (id) => (id === instanceId ? gate : null),
    readHead: async (_o, actor) => (actor === "seat" ? { lifecycleUid: childUid, state: "active" } : undefined),
    ...over,
  });
  const refused = async (what: string, a: AuthorizeToolResultServeArgs, code: string) => {
    await assert.rejects(authorizeToolResultServe(a), (e: unknown) => e instanceof EpEnvelopeError && e.code === code, what); checks++;
  };

  const ok = await authorizeToolResultServe(args());
  assert.equal(ok.target.lifecycleUid, childUid); assert.equal(ok.actor, "cli"); checks += 2;
  const renew = await authorizeToolResultServe(args({ request: request({ operation: "renew", epoch: 2 }) }));
  assert.equal(renew.epoch, 2); checks++;
  const fresh = await authorizeToolResultServe(args({ readHead: async () => undefined }));
  assert.equal(fresh.target.lifecycleUid, childUid, "a fresh enrollment whose head activates at first connect is authorized by its live row"); checks++;

  await refused("another space", args({ space: "neighbour" }), "permission-denied");
  await refused("an authorizing actor without supervise", args({ scope: ["spawn", "admin"] }), "permission-denied");
  await refused("no manager gate", args({ observeManagerGate: async () => null }), "failed-precondition");
  await refused("a frozen manager gate", args({ observeManagerGate: async () => ({ ...gate, state: "frozen" as never }) }), "failed-precondition");
  await refused("a neighbour owner's manager gate", args({ owner: NEIGHBOUR }), "permission-denied");
  await refused("a stale serve epoch", args({ request: request({ serveEpoch: 3 }) }), "conflict");
  await refused("a forged registration proof", args({ request: request({ registrationProof: `sha256:${"0".repeat(64)}` }) }), "permission-denied");
  await refused("a proof for another authorizing actor", args({ request: request({ actor: "other" }) }), "permission-denied");
  await refused("no managed row for the target", args({ request: request({ target: { actor: "ghost", lifecycleUid: childUid } }) }), "expired");
  await refused("a successor or stale lifecycle", args({ request: request({ target: { actor: "seat", lifecycleUid: mintLifecycleUid() } }) }), "expired");
  await refused("a retiring head", args({ readHead: async () => ({ lifecycleUid: childUid, state: "retiring" }) }), "expired");
  await refused("a head at a successor", args({ readHead: async () => ({ lifecycleUid: mintLifecycleUid(), state: "active" }) }), "expired");
  await refused("a malformed request", args({ request: { ...request(), extra: true } }), "contract-invalid");
  await refused("the manager's own actor as target", args({ request: request({ target: { actor: "cli", lifecycleUid: childUid } }) }), "contract-invalid");
  {
    // `stray` is a live managed row under ANOTHER authorizing actor: the proof is valid for `cli`,
    // but the child is not cli's.
    const strayUid = (await import("../src/ledger.js")).findManagedActor(dir, OWNER, "stray")!.lifecycleUid!;
    await refused("a child enrolled under another actor", args({
      request: request({ target: { actor: "stray", lifecycleUid: strayUid } }),
      readHead: async () => ({ lifecycleUid: strayUid, state: "active" }),
    }), "permission-denied");
  }

  // ---- the public anchor snapshot ------------------------------------------------------------
  const NOW = Date.now();
  const key = createUser();
  const anchor = (over: Partial<SignerAnchor> = {}): SignerAnchor => ({ keyId: "host-1", publicKey: key.getPublicKey(), owner: "host.example", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: NOW - 1000, validTo: NOW + 60_000, ...over });
  const resolver = (a: SignerAnchor | undefined): AnchorResolver => (id) => (a && id === a.keyId ? a : undefined);
  const snap = await currentToolResultConsentAnchors({ keyId: "host-1", resolveAnchor: resolver(anchor()) }, NOW);
  assert.deepEqual(snap, [{ keyId: "host-1", publicKey: key.getPublicKey(), owner: "host.example", validFrom: NOW - 1000, validTo: NOW + 60_000 }]); checks++;
  assert.equal(await currentToolResultConsentAnchors(undefined, NOW), undefined); checks++;
  assert.equal(await currentToolResultConsentAnchors({ keyId: "host-1", resolveAnchor: resolver(anchor({ revoked: true })) }, NOW), undefined); checks++;
  assert.equal(await currentToolResultConsentAnchors({ keyId: "host-1", resolveAnchor: resolver(anchor({ roles: ["sessions"], scope: { sessions: ["manager"] } })) }, NOW), undefined); checks++;
  assert.equal(await currentToolResultConsentAnchors({ keyId: "host-1", resolveAnchor: resolver(anchor({ validTo: NOW - 1 })) }, NOW), undefined); checks++;
  assert.equal(await currentToolResultConsentAnchors({ keyId: "host-1", resolveAnchor: resolver(undefined) }, NOW), undefined); checks++;

  // ---- the stock route ------------------------------------------------------------------------
  const seen: { owner: string; scope: string[] }[] = [];
  const ctx = { dir, issueToolResultServe: async (a: { owner: string; scope: string[]; request: unknown }) => { seen.push({ owner: a.owner, scope: a.scope }); return { routed: true }; } };
  const routed = await dispatchManagerAuthorityRequest(ctx as never, OWNER, { request: request() });
  assert.deepEqual(routed, { routed: true }); checks++;
  assert.deepEqual(seen, [{ owner: OWNER, scope: ["supervise", "spawn"] }], "the route reads the AUTHORIZING actor's row scope, not the target's"); checks++;
  await assert.rejects(dispatchManagerAuthorityRequest({ dir } as never, OWNER, { request: request() }), (e: unknown) => e instanceof EpEnvelopeError && e.code === "unimplemented"); checks++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`tool-result-serving smoke: ${checks} checks passed`);
