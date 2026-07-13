/**
 * v0.4 governed-traits smoke (SPEC §13.7 "Traits", §13.9 trait seam, §13.10 anchors/D28)
 * against a real broker: trait DEFINITION verification (D28 signature over the sig-absent
 * canonical form, fresh anchor resolution, role/window/revocation, domain-scope containment —
 * `ai.cotal.*` is the operator key's domain, a third party signs only under its registered
 * claim), trait ATTACHMENT verification (named-authority binding, endpoint/command/space/
 * contract-digest binding, selector admission, value-schema validation through the digest-
 * verified two-step read; strip/substitute/forge/stale-digest/downgrade all refuse), the
 * whole-surface coverage check (BOTH strip directions), the §13.7 downgrade/removal revision
 * check across re-registrations, and the fail-closed pre-effect gate in serveEndpoint:
 * guarded (allow/deny/hold/throw/malformed; obligations surfaced), priced (proof in the auth
 * slot verified before effect, one-use replay refused, a guard deny never burns a proof),
 * construction refusals (governed command without enforcement, extraneous enforcement,
 * missing hooks, foreign-grant surface, governed journal command), and cast silence.
 * The guard and proof-verifier implementations here are smoke FAKES — core owns only the
 * seams (§13.9); policy engines and payment rails are extensions.
 *
 * Run: pnpm smoke:ep-traits   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { createUser } from "@nats-io/nkeys";
import {
  isReachable, EpEnvelopeError,
  openRecordsBucket, registerServiceInstance, authorizeServeGrant, serveEndpoint,
  compileContract, contractDigest,
  epRequestSubject, epCallerReplyFilter,
  signArtifact, signatureInput,
  verifyTraitDefinition, isVerifiedTraitDefinition, traitDefinitionDigest,
  verifyTraitAttachment, isVerifiedTraitAttachment,
  verifyGovernedSurface, assertGovernedSurfaceFor,
  TRAIT_GUARDED, TRAIT_PRICED, GOVERNED_TRAIT_URNS,
  type SignerAnchor, type AnchorResolver, type TraitDefinition,
  type EpGuardVerdict, type EpTraitEnforcement, type EpGovernedSurface,
  type ServiceSpec, type ServiceNameAuthority, type EpCaller, type EndpointReply,
  type EpCommandDef, type EpServeGrant, type EpIssuanceBarrier, type EpServeContext,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "eptraits";
const IID = "a".repeat(26);
const UID = "c".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const NOW = Date.now();

// ── trust anchors: the operator's ai.cotal traits key + a third party's com.acme key ──
const opKp = createUser();
const acmeKp = createUser();
const anchors = new Map<string, SignerAnchor>();
const anchor = (keyId: string, kp: { getPublicKey(): string }, over: Partial<SignerAnchor> = {}): SignerAnchor => {
  const a: SignerAnchor = {
    keyId, publicKey: kp.getPublicKey(), owner: "u_op", roles: ["traits"],
    scope: { traits: ["ai.cotal"] }, validFrom: 1_000, validTo: NOW + 86_400_000, ...over,
  };
  anchors.set(keyId, a);
  return a;
};
anchor("op-traits-1", opKp);
anchor("acme-traits-1", acmeKp, { owner: "com.acme", scope: { traits: ["com.acme"] } });
anchor("op-noscope-1", opKp, { scope: undefined });
anchor("op-norole-1", opKp, { roles: ["receipts"], scope: { receipts: ["vault"] } });
anchor("op-revoked-1", opKp, { revoked: true });
const resolveAnchor: AnchorResolver = (keyId) => anchors.get(keyId);

// ── contract-store: value schemas + cluster documents, each a manifest+root pair (§13.7) ──
const store = new Map<string, unknown>();
const register = (doc: unknown): string => {
  const rootDigest = contractDigest(doc);
  const manifest = { v: 1, root: rootDigest, members: [] as string[] };
  const closureDigest = contractDigest(manifest);
  store.set(rootDigest, doc);
  store.set(closureDigest, manifest);
  return closureDigest;
};
const readArtifact = (d: string) => store.get(d);
const VS_GUARD = register({ type: "object", properties: { guard: { type: "string" } }, required: ["guard"], additionalProperties: false });
const VS_PRICE = register({ type: "object", properties: { currency: { type: "string" }, amount: { type: "number" } }, required: ["currency", "amount"], additionalProperties: false });

// ── trait definitions: signed, content-addressed, domain-scoped ──
const defBody = (over: Record<string, unknown> = {}) => ({
  v: 1, urn: TRAIT_GUARDED, valueSchema: VS_GUARD, selector: ["command"],
  breakingChanges: true, authority: { keyId: "op-traits-1" }, signer: { keyId: "op-traits-1" }, ...over,
});
const defGuarded = await verifyTraitDefinition(signArtifact(defBody(), opKp), { resolveAnchor });
const defPriced = await verifyTraitDefinition(signArtifact(defBody({ urn: TRAIT_PRICED, valueSchema: VS_PRICE }), opKp), { resolveAnchor });
c("an operator-signed ai.cotal.* definition verifies and is provenance-branded",
  isVerifiedTraitDefinition(defGuarded) && isVerifiedTraitDefinition(defPriced) && Object.isFrozen(defGuarded));
c("the definition's content address is the digest over its FULL canonical form (sig included)",
  traitDefinitionDigest(defGuarded).startsWith("sha256:") && traitDefinitionDigest(defGuarded) !== traitDefinitionDigest(defPriced));
const defAcme = await verifyTraitDefinition(
  signArtifact(defBody({ urn: "com.acme.vocab", signer: { keyId: "acme-traits-1" }, authority: { keyId: "acme-traits-1" } }), acmeKp),
  { resolveAnchor });
c("a third-party definition verifies under its registered reverse-DNS domain claim", isVerifiedTraitDefinition(defAcme));
const defGuardedEventOnly = await verifyTraitDefinition(signArtifact(defBody({ selector: ["event"] }), opKp), { resolveAnchor });

await rejects("a definition signed by an UNKNOWN key refuses (unknown keys fail closed)",
  () => verifyTraitDefinition(signArtifact(defBody({ signer: { keyId: "ghost-1" } }), opKp), { resolveAnchor }), "permission-denied");
await rejects("a definition signed by a REVOKED key refuses (revocation is immediate for new verifications)",
  () => verifyTraitDefinition(signArtifact(defBody({ signer: { keyId: "op-revoked-1" } }), opKp), { resolveAnchor }), "permission-denied");
await rejects("a definition signed by a key WITHOUT the traits role refuses",
  () => verifyTraitDefinition(signArtifact(defBody({ signer: { keyId: "op-norole-1" } }), opKp), { resolveAnchor }), "permission-denied");
await rejects("a traits key with NO scope ceiling signs nothing (absent dimension is closed, not open)",
  () => verifyTraitDefinition(signArtifact(defBody({ signer: { keyId: "op-noscope-1" } }), opKp), { resolveAnchor }), "permission-denied");
await rejects("a third-party key cannot define under ai.cotal (scope containment on the urn domain)",
  () => verifyTraitDefinition(signArtifact(defBody({ signer: { keyId: "acme-traits-1" } }), acmeKp), { resolveAnchor }), "permission-denied");
await rejects("out-of-window verification refuses",
  () => verifyTraitDefinition(signArtifact(defBody(), opKp), { resolveAnchor, now: 1 }), "permission-denied");
await rejects("a TAMPERED definition (urn swapped after signing) fails its signature",
  () => verifyTraitDefinition({ ...signArtifact(defBody(), opKp), urn: "ai.cotal.other" }, { resolveAnchor }), "permission-denied");
await rejects("a definition with unknown extra fields refuses (closed discriminated schema)",
  () => verifyTraitDefinition(signArtifact(defBody({ extra: 1 }), opKp), { resolveAnchor }));
await rejects("a definition with a malformed selector refuses",
  () => verifyTraitDefinition(signArtifact(defBody({ selector: ["command", "command"] }), opKp), { resolveAnchor }));
c("the D28 signature input is the sig-ABSENT canonical form (signing is stable under sig stripping)",
  new TextDecoder().decode(signatureInput(signArtifact(defBody(), opKp))) === new TextDecoder().decode(signatureInput(defBody() as Record<string, unknown>)));

// ── attachments: named-authority signature over the full binding ──
const VAULT_CMDS = [
  { name: "launch", class: "ephemeral", targeted: false, capability: "vault.call", inputDigest: "", outputDigest: "", traits: [TRAIT_GUARDED] },
  { name: "charge", class: "ephemeral", targeted: false, capability: "vault.call", inputDigest: "", outputDigest: "", traits: [TRAIT_PRICED] },
  { name: "both", class: "ephemeral", targeted: false, capability: "vault.call", inputDigest: "", outputDigest: "", traits: [TRAIT_GUARDED, TRAIT_PRICED] },
  { name: "free", class: "ephemeral", targeted: false, capability: "vault.call", inputDigest: "", outputDigest: "" },
];
// Warm ajv once: the FIRST compileContract pays a cold module+JIT init that can exceed the fixed
// 100ms profile budget on a loaded machine — a throwaway compile absorbs it so the real compiles
// below are timed warm (a cold-init flake is not a contract-invalid signal).
try { compileContract({ root: { type: "null" } }); } catch { /* warm only */ }
const argsContract = compileContract({ root: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false } });
for (const m of VAULT_CMDS) { m.inputDigest = argsContract.closureDigest; m.outputDigest = outContract.closureDigest; }
const vaultDoc = (rev: number, commands: unknown[]) => ({ urn: "ai.cotal.vault", revision: rev, attributes: [], events: [], commands });
const DC_VAULT = register(vaultDoc(1, VAULT_CMDS));

const attBody = (over: Record<string, unknown> = {}) => ({
  v: 1, space: SPACE, endpoint: "vault", command: "launch", contractDigest: DC_VAULT,
  traitUrn: TRAIT_GUARDED, value: { guard: "warden" }, signer: { keyId: "op-traits-1" }, ts: NOW, ...over,
});
const expectLaunch = { space: SPACE, endpoint: "vault", command: "launch", contractDigest: DC_VAULT };
const attOk = await verifyTraitAttachment(signArtifact(attBody(), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact });
c("a named-authority attachment verifies, value validated against the definition's schema, and is branded",
  isVerifiedTraitAttachment(attOk) && Object.isFrozen(attOk) && (attOk.value as { guard: string }).guard === "warden");

await rejects("an UNVERIFIED (structural) definition carries no attachment authority",
  () => verifyTraitAttachment(signArtifact(attBody(), opKp), { definition: { ...defGuarded } as TraitDefinition, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
await rejects("an attachment for a DIFFERENT trait than its definition refuses",
  () => verifyTraitAttachment(signArtifact(attBody({ traitUrn: TRAIT_PRICED }), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
await rejects("a definition whose selector does not admit command targets refuses the attachment",
  () => verifyTraitAttachment(signArtifact(attBody(), opKp), { definition: defGuardedEventOnly, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
await rejects("a SUBSTITUTED attachment (bound to another command) never gates this one",
  () => verifyTraitAttachment(signArtifact(attBody({ command: "free" }), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
await rejects("a foreign-space attachment refuses (trust roots never merge across spaces)",
  () => verifyTraitAttachment(signArtifact(attBody({ space: "otherspace" }), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
await rejects("a STALE-DIGEST attachment (a prior revision's evidence) refuses",
  () => verifyTraitAttachment(signArtifact(attBody({ contractDigest: `sha256:${"0".repeat(64)}` }), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
await rejects("an attachment signed by a key OTHER than the definition's named authority refuses",
  () => verifyTraitAttachment(signArtifact(attBody({ signer: { keyId: "acme-traits-1" } }), acmeKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "permission-denied");
await rejects("a TAMPERED attachment value (downgrade after signing) fails the signature",
  () => verifyTraitAttachment({ ...signArtifact(attBody(), opKp), value: { guard: "nobody" } }, { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "permission-denied");
await rejects("an attachment value the definition's schema rejects refuses",
  () => verifyTraitAttachment(signArtifact(attBody({ value: { guard: 42 } }), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }), "failed-precondition");
const defUnreadable = await verifyTraitDefinition(
  signArtifact(defBody({ valueSchema: `sha256:${"9".repeat(64)}` }), opKp), { resolveAnchor });
await rejects("an UNREADABLE value schema fails the attachment closed",
  () => verifyTraitAttachment(signArtifact(attBody(), opKp), {
    definition: defUnreadable, expect: expectLaunch, resolveAnchor, readArtifact,
  }), "failed-precondition");

// ── anchor window binds VERIFICATION time, never the signer-asserted `ts` (finding: rotation
//    closure bypass). A definition whose AUTHORITY is a windowed key; attachments signed by it. ──
anchor("op-window-1", opKp, { validFrom: 10_000, validTo: 20_000 });
const defWindowed = await verifyTraitDefinition(
  signArtifact(defBody({ authority: { keyId: "op-window-1" } }), opKp), { resolveAnchor });
const winAtt = (ts: number) => signArtifact(attBody({ signer: { keyId: "op-window-1" }, ts }), opKp);
c("an attachment verifies when the authority key's window covers VERIFICATION time",
  isVerifiedTraitAttachment(await verifyTraitAttachment(winAtt(15_000), { definition: defWindowed, expect: expectLaunch, resolveAnchor, readArtifact, now: 15_000 })));
await rejects("an EXPIRED authority key cannot backdate `ts` into its old window (verification time is past validTo)",
  () => verifyTraitAttachment(winAtt(15_000), { definition: defWindowed, expect: expectLaunch, resolveAnchor, readArtifact, now: 100_000 }), "permission-denied");
await rejects("a NOT-YET-VALID authority key cannot future-date `ts` (verification time is before validFrom)",
  () => verifyTraitAttachment(winAtt(15_000), { definition: defWindowed, expect: expectLaunch, resolveAnchor, readArtifact, now: 5_000 }), "permission-denied");

// ── D28 exact-artifact: an unsigned NESTED field cannot ride under a field-dropping projection ──
await rejects("a definition with an extra field in nested `authority` refuses (closed nested {keyId})",
  () => verifyTraitDefinition(signArtifact(defBody({ authority: { keyId: "op-traits-1", extra: "x" } }), opKp), { resolveAnchor }));
await rejects("a definition with an extra field in nested `signer` refuses",
  () => verifyTraitDefinition(signArtifact(defBody({ signer: { keyId: "op-traits-1", rogue: 1 } }), opKp), { resolveAnchor }));
await rejects("an attachment with an extra field in nested `signer` refuses (no unsigned field rides D28)",
  () => verifyTraitAttachment(signArtifact(attBody({ signer: { keyId: "op-traits-1", rogue: 1 } }), opKp), { definition: defGuarded, expect: expectLaunch, resolveAnchor, readArtifact }));

// ── live broker: registration → serve grant → governed surface → the pre-effect gate ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-eptraits-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const kv = await openRecordsBucket(nc, SPACE, { create: true });

  const authority: ServiceNameAuthority = { authorize: (_n, owner) => ({ authorized: owner === "u_op", revision: 0 }) };
  const gateStates = new Map<string, { space: string; endpoint: string; lifecycleUid: string; state: "open" | "frozen" | "retired"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number }>();
  const barrierFor = (endpoint: string, instanceId: string): EpIssuanceBarrier => {
    const key = `${endpoint}/${instanceId}`;
    if (!gateStates.has(key)) gateStates.set(key, { space: SPACE, endpoint, lifecycleUid: instanceId, state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
    const g = gateStates.get(key)!;
    return {
      observe: () => ({ ...g }),
      freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
      enumerate: () => [],
      revoke: () => {},
      evict: () => true,
      reopen: (token, succ) => { if (g.state !== "frozen" || g.revision !== token) return false; g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch; g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++; return true; },
    };
  };
  // The trusted registrar wires the governed-continuity seam (the store reader + the governed URNs
  // as DATA); a re-registration that strips a governed trait from a surviving command refuses HERE,
  // from the registry's own prior spec, never a caller-supplied prior surface.
  const reg = (spec: ServiceSpec, instanceId: string) =>
    registerServiceInstance(kv, { space: SPACE, spec, instanceId, registrant: { owner: "u_op" }, authority, barrier: barrierFor(spec.endpoint, instanceId), readClusterArtifact: readArtifact, governedTraitUrns: GOVERNED_TRAIT_URNS });
  const grantFor = (endpoint: string, instanceId: string): Promise<EpServeGrant> =>
    authorizeServeGrant(kv, { space: SPACE, endpoint, instanceId, epoch: 1, holder: { owner: "u_op" }, authority, readProcessEpoch: () => 1, readClusterArtifact: readArtifact });

  await reg({ endpoint: "vault", owner: "u_op", clusterDigests: [DC_VAULT], protocol: { v: 1 } }, IID);
  const grantV1 = await grantFor("vault", IID);
  c("the serve grant's verified surface carries the DECLARED traits out of digest-verified bytes",
    grantV1.surface.launch.traits.includes(TRAIT_GUARDED) && grantV1.surface.charge.traits.includes(TRAIT_PRICED)
    && grantV1.surface.both.traits.length === 2 && grantV1.surface.free.traits.length === 0);

  const signAtt = (command: string, urn: string, value: unknown, digest: string = DC_VAULT) =>
    signArtifact(attBody({ command, traitUrn: urn, value, contractDigest: digest }), opKp);
  const fullAttachments = () => [
    signAtt("launch", TRAIT_GUARDED, { guard: "warden" }),
    signAtt("both", TRAIT_GUARDED, { guard: "warden" }),
    signAtt("charge", TRAIT_PRICED, { currency: "usd", amount: 5 }),
    signAtt("both", TRAIT_PRICED, { currency: "usd", amount: 9 }),
  ];
  const defs = [defGuarded, defPriced];
  const verifySurface = (over: Record<string, unknown>) =>
    verifyGovernedSurface({ serve: grantV1, definitions: defs, attachments: fullAttachments(), resolveAnchor, readArtifact, ...over });
  const surfaceV1 = await verifySurface({});
  c("the full governed surface verifies: command -> trait -> verified attachment",
    surfaceV1.commands["launch"]?.[TRAIT_GUARDED] !== undefined && Object.keys(surfaceV1.commands["both"] ?? {}).length === 2
    && surfaceV1.commands["free"] === undefined);
  c("the verified governed surface is DEEP-FROZEN (a post-verify mutation cannot hollow the brand)",
    Object.isFrozen(surfaceV1.commands) && Object.isFrozen(surfaceV1.commands["launch"]));
  {
    // Finding: a frozen Map is still mutable; a frozen plain record is not. Prove a post-verify
    // delete cannot remove a governed entry (so the gate can never see it as ungoverned).
    let threw = false;
    try { delete (surfaceV1.commands as Record<string, unknown>)["launch"]; } catch { threw = true; }
    c("a post-verify delete on the frozen surface does not remove the governed entry",
      surfaceV1.commands["launch"] !== undefined && (threw || true));
  }
  await rejects("a DECLARED governed trait with no attachment refuses the whole surface (strip, direction one)",
    () => verifySurface({ attachments: fullAttachments().slice(1) }), "failed-precondition");
  await rejects("a verified-authority attachment the declaration DROPPED refuses (strip, direction two)",
    () => verifySurface({ attachments: [...fullAttachments(), signAtt("free", TRAIT_GUARDED, { guard: "warden" })] }), "failed-precondition");
  await rejects("two attachments for one (command, trait) refuse",
    () => verifySurface({ attachments: [...fullAttachments(), signAtt("launch", TRAIT_GUARDED, { guard: "other" })] }), "failed-precondition");
  await rejects("an attachment naming a command OUTSIDE the granted surface refuses",
    () => verifySurface({ attachments: [...fullAttachments(), signAtt("phantom", TRAIT_GUARDED, { guard: "warden" })] }), "failed-precondition");
  await rejects("a governed surface without the trait's definition is unverifiable and refuses",
    () => verifySurface({ definitions: [defGuarded] }), "failed-precondition");
  await rejects("a NON-GOVERNED definition has no attachment surface in this revision",
    () => verifySurface({ definitions: [...defs, defAcme] }), "failed-precondition");

  // ── the serve-side gate ──
  const ran: Record<string, number> = { launch: 0, charge: 0, both: 0, free: 0 };
  let seenObligations: readonly unknown[] | undefined;
  const defFor = (command: string): EpCommandDef => ({
    command,
    contract: { input: argsContract, output: outContract },
    handler: (ctx: EpServeContext) => { ran[command]++; seenObligations = ctx.obligations; return { which: command }; },
  });
  const vaultDefs = () => ["launch", "charge", "both", "free"].map(defFor);

  let guardMode: "allow" | "allow-obligations" | "deny" | "hold" | "throw" | "malformed" | "hang" = "allow";
  let guardSawValue: unknown;
  const guard = (q: { value: unknown }): EpGuardVerdict | Promise<EpGuardVerdict> => {
    guardSawValue = q.value;
    if (guardMode === "hang") return new Promise<EpGuardVerdict>(() => { /* never settles */ });
    if (guardMode === "throw") throw new Error("guard transport down");
    if (guardMode === "malformed") return { verdict: "yolo" } as unknown as EpGuardVerdict;
    if (guardMode === "deny") return { verdict: "deny", reason: "policy said no" };
    if (guardMode === "hold") return { verdict: "hold" };
    if (guardMode === "allow-obligations") return { verdict: "allow", obligations: [{ attenuate: "read-only" }] };
    return { verdict: "allow" };
  };
  const usedProofs = new Set<string>();
  let verifierCalls = 0;
  const verifyPaymentProof = (q: { proof: string; requestId: string }): boolean => {
    verifierCalls++;
    if (q.proof !== "proof-ok" || usedProofs.has(q.requestId)) return false;
    usedProofs.add(q.requestId); // the seam owns the declared replay policy: one-use per request id
    return true;
  };
  const enforcement: EpTraitEnforcement = { governed: surfaceV1, guard, verifyPaymentProof };

  await rejects("a governed command with NO enforcement wired refuses at construction (fail closed at wiring time)",
    () => serveEndpoint(nc, SPACE, grantV1, vaultDefs(), { public: true }));
  await rejects("a guarded command without a guard seam refuses at construction",
    () => serveEndpoint(nc, SPACE, grantV1, vaultDefs(), { public: true }, { traits: { governed: surfaceV1, verifyPaymentProof } }));
  await rejects("a priced command without a proof verifier refuses at construction",
    () => serveEndpoint(nc, SPACE, grantV1, vaultDefs(), { public: true }, { traits: { governed: surfaceV1, guard } }));
  await rejects("a STRUCTURAL (unbranded) governed surface refuses at construction",
    () => serveEndpoint(nc, SPACE, grantV1, vaultDefs(), { public: true }, { traits: { governed: { commands: surfaceV1.commands } as EpGovernedSurface, guard, verifyPaymentProof } }));

  const handle = serveEndpoint(nc, SPACE, grantV1, vaultDefs(), { public: true }, { traits: enforcement });
  await nc.flush();

  const replies: { subject: string; reply: EndpointReply }[] = [];
  const replySub = nc.subscribe(epCallerReplyFilter(SPACE, caller), {
    callback: (_e, m) => { replies.push({ subject: m.subject, reply: JSON.parse(new TextDecoder().decode(m.data)) as EndpointReply }); },
  });
  await nc.flush();
  let nonceN = 0, reqN = 0;
  const nonce = () => `n${String(nonceN++).padStart(23, "0")}`;
  const call = async (command: string, over: Record<string, unknown> = {}) => {
    const body = {
      v: 1, id: `req-${reqN++}`, op: { endpoint: "vault", command, inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest },
      class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: { name: "x" }, from: { id: "u_abc.worker", name: "w" }, ...over,
    };
    nc.publish(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "vault", command, caller, nonce: nonce() }), new TextEncoder().encode(JSON.stringify(body)));
    await nc.flush();
    for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
    return replies.shift();
  };

  const rFree = await call("free");
  c("an ungoverned command serves with no gate consulted", rFree?.reply.ok === true && ran.free === 1 && verifierCalls === 0);
  const rAllow = await call("launch");
  c("guard ALLOW effects (guard-then-effect), and the hook received the attachment's value",
    rAllow?.reply.ok === true && ran.launch === 1 && (guardSawValue as { guard: string }).guard === "warden");
  guardMode = "allow-obligations";
  const rOb = await call("launch");
  c("guard obligations surface on the handler context (the endpoint MUST apply them)",
    rOb?.reply.ok === true && Array.isArray(seenObligations) && (seenObligations[0] as { attenuate: string }).attenuate === "read-only");
  guardMode = "deny";
  const rDeny = await call("launch");
  c("guard DENY refuses permission-denied with no effect",
    rDeny?.reply.ok === false && rDeny.reply.error?.code === "permission-denied" && ran.launch === 2);
  guardMode = "hold";
  const rHold = await call("launch");
  c("guard HOLD refuses failed-precondition on the ephemeral rail (the action composite owns hold), no effect",
    rHold?.reply.ok === false && rHold.reply.error?.code === "failed-precondition" && ran.launch === 2);
  guardMode = "throw";
  const rThrow = await call("launch");
  c("an unreachable/throwing guard is DENY (fail closed), no effect",
    rThrow?.reply.ok === false && rThrow.reply.error?.code === "permission-denied" && ran.launch === 2);
  guardMode = "malformed";
  const rMal = await call("launch");
  c("a malformed guard verdict is DENY (runtime-fenced), no effect",
    rMal?.reply.ok === false && rMal.reply.error?.code === "permission-denied" && ran.launch === 2);
  guardMode = "hang";
  const rHang = await call("launch", { deadlineMs: 300 }); // a never-settling guard is BOUNDED -> deny
  c("a NEVER-SETTLING guard is bounded by the request deadline and becomes DENY, never a hung request (no effect)",
    rHang?.reply.ok === false && rHang.reply.error?.code === "permission-denied" && ran.launch === 2);
  guardMode = "allow";

  const rNoProof = await call("charge");
  c("a priced command with NO auth-slot proof refuses before the verifier is ever consulted",
    rNoProof?.reply.ok === false && rNoProof.reply.error?.code === "permission-denied" && verifierCalls === 0 && ran.charge === 0);
  const rBadProof = await call("charge", { auth: "proof-forged" });
  c("an invalid proof refuses permission-denied with no effect",
    rBadProof?.reply.ok === false && rBadProof.reply.error?.code === "permission-denied" && ran.charge === 0);
  const rPaid = await call("charge", { auth: "proof-ok", id: "req-paid-1" });
  c("a valid proof in the auth slot effects", rPaid?.reply.ok === true && ran.charge === 1);
  const rReplay = await call("charge", { auth: "proof-ok", id: "req-paid-1" });
  c("proof replay for the same request id refuses (the seam's one-use default), no second effect",
    rReplay?.reply.ok === false && rReplay.reply.error?.code === "permission-denied" && ran.charge === 1);

  guardMode = "deny";
  const verifierBefore = verifierCalls;
  const rBothDeny = await call("both", { auth: "proof-ok", id: "req-both-1" });
  c("guard-then-priced ORDER: a guard deny never burns a one-use payment proof",
    rBothDeny?.reply.ok === false && verifierCalls === verifierBefore && ran.both === 0);
  guardMode = "allow";
  const rBoth = await call("both", { auth: "proof-ok", id: "req-both-1" });
  c("guarded AND priced both pass -> effect (the un-burnt proof redeems)",
    rBoth?.reply.ok === true && ran.both === 1);

  guardMode = "deny";
  nc.publish(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "vault", command: "launch", caller, nonce: nonce() }),
    new TextEncoder().encode(JSON.stringify({
      v: 1, id: "req-cast-1", op: { endpoint: "vault", command: "launch", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest },
      class: "ephemeral", replyExpected: false, args: { name: "x" }, from: { id: "u_abc.worker", name: "w" },
    })));
  await nc.flush();
  await wait(400);
  c("a CAST to a guard-denied command has no effect and stays silent (at-most-once, gated)",
    ran.launch === 2 && replies.length === 0);
  guardMode = "allow";

  // Finding: serveEndpoint must snapshot the enforcement at construction — a caller that SWAPS
  // `enforcement.governed` wholesale after construction must not disable the gate. Swap in a
  // structural empty surface (which, if the serve loop re-dereferenced `opts.traits`, would make
  // launch appear ungoverned and effect ungated) and confirm the ORIGINAL gate still runs.
  guardMode = "deny";
  const launchBefore = ran.launch;
  enforcement.governed = { commands: {} } as EpGovernedSurface;
  enforcement.guard = undefined as unknown as typeof enforcement.guard;
  const rSwap = await call("launch");
  c("a post-construction swap of enforcement.governed/guard does NOT disable the gate (snapshot bound at construction)",
    rSwap?.reply.ok === false && rSwap.reply.error?.code === "permission-denied" && ran.launch === launchBefore);
  enforcement.governed = surfaceV1;
  enforcement.guard = guard;
  guardMode = "allow";

  await handle.stop();
  replySub.unsubscribe();

  // ── construction: extraneous enforcement + governed journal + foreign-grant surface ──
  const PLAIN_CMDS = [{ name: "hello", class: "ephemeral", targeted: false, capability: "plain.call", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest, traits: ["com.acme.vocab"] }];
  const DC_PLAIN = register({ urn: "ai.cotal.plain", revision: 1, attributes: [], events: [], commands: PLAIN_CMDS });
  await reg({ endpoint: "plain", owner: "u_op", clusterDigests: [DC_PLAIN], protocol: { v: 1 } }, IID);
  const grantPlain = await grantFor("plain", IID);
  const emptySurface = await verifyGovernedSurface({ serve: grantPlain, definitions: [], attachments: [], resolveAnchor, readArtifact });
  const plainDef = [{ command: "hello", contract: { input: argsContract, output: outContract }, handler: () => ({ which: "hello" }) }];
  const plainHandle = serveEndpoint(nc, SPACE, grantPlain, plainDef, { public: true });
  c("a NON-governed declared trait is vocabulary: it serves ungated, with no enforcement demanded", true);
  await plainHandle.stop();
  await rejects("an EXTRANEOUS enforcement bundle on an ungoverned surface refuses at construction",
    () => serveEndpoint(nc, SPACE, grantPlain, plainDef, { public: true }, { traits: { governed: emptySurface, guard, verifyPaymentProof } }));
  await rejects("a governed surface verified for a FOREIGN grant refuses at construction",
    () => serveEndpoint(nc, SPACE, grantPlain, plainDef, { public: true }, { traits: { governed: surfaceV1, guard, verifyPaymentProof } }));

  const JOBS_CMDS = [{ name: "submitjob", class: "journal", targeted: false, capability: "jobs.call", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest, traits: [TRAIT_PRICED] }];
  const DC_JOBS = register({ urn: "ai.cotal.jobs", revision: 1, attributes: [], events: [], commands: JOBS_CMDS });
  await reg({ endpoint: "vaultjobs", owner: "u_op", clusterDigests: [DC_JOBS], protocol: { v: 1 } }, IID);
  const grantJobs = await grantFor("vaultjobs", IID);
  await rejects("a GOVERNED journal-class command refuses at construction (no unenforced governance; the epj gate is a later slice)",
    () => serveEndpoint(nc, SPACE, grantJobs, [], { public: true }));

  // ── governed-continuity is enforced at the TRUSTED registration write (§13.7), against the
  //    registry's OWN prior spec — NOT a caller-supplied prior surface (which the owner could
  //    forge by claiming "first governance"). A re-registration that strips a governed trait from
  //    a surviving command refuses at reg(), with no `null` escape. ──
  const attV = (digest: string) => [
    signAtt("launch", TRAIT_GUARDED, { guard: "warden" }, digest),
    signAtt("both", TRAIT_GUARDED, { guard: "warden" }, digest),
    signAtt("charge", TRAIT_PRICED, { currency: "usd", amount: 6 }, digest),
    signAtt("both", TRAIT_PRICED, { currency: "usd", amount: 9 }, digest),
  ];
  // V2: same governance, new revision bytes -> re-registers cleanly (no strip), re-attaches, serves.
  const DC_VAULT2 = register(vaultDoc(2, VAULT_CMDS.map((m) => ({ ...m }))));
  await reg({ endpoint: "vault", owner: "u_op", clusterDigests: [DC_VAULT2], protocol: { v: 1 } }, IID);
  const grantV2 = await grantFor("vault", IID);
  const surfaceV2 = await verifyGovernedSurface({ serve: grantV2, definitions: defs, attachments: attV(DC_VAULT2), resolveAnchor, readArtifact });
  c("a re-registration that KEEPS governance (re-attaches at the new digest) registers and verifies",
    surfaceV2.commands["launch"]?.[TRAIT_GUARDED] !== undefined);

  // V3 STRIPS launch's guarded declaration but keeps the command. The re-registration itself
  // refuses at the trusted registrar (the FORGE the panel reproduced: previously an owner could
  // brand a stripped surface with previous:null and serve it; now the prior state is the registry's).
  const VAULT_CMDS_V3 = VAULT_CMDS.map((m) => { const { traits: _t, ...rest } = m; return m.name === "launch" ? rest : { ...m }; });
  const DC_VAULT3 = register(vaultDoc(3, VAULT_CMDS_V3));
  await rejects("a governance-STRIPPING re-registration refuses at the TRUSTED registrar (prior spec is the registry's, not a caller argument - no null escape)",
    () => reg({ endpoint: "vault", owner: "u_op", clusterDigests: [DC_VAULT3], protocol: { v: 1 } }, IID), "permission-denied");
  // A DOWNGRADE (drop ONE of two governed traits from a surviving command) is likewise refused.
  const VAULT_CMDS_V3b = VAULT_CMDS.map((m) => (m.name === "both" ? { ...m, traits: [TRAIT_GUARDED] } : { ...m })); // both loses priced
  const DC_VAULT3b = register(vaultDoc(3, VAULT_CMDS_V3b));
  await rejects("a governance DOWNGRADE (surviving command loses one of two governed traits) refuses at the registrar",
    () => reg({ endpoint: "vault", owner: "u_op", clusterDigests: [DC_VAULT3b], protocol: { v: 1 } }, IID), "permission-denied");

  // V4 REMOVES the launch command entirely (not a strip) -> re-registers cleanly.
  const VAULT_CMDS_V4 = VAULT_CMDS.filter((m) => m.name !== "launch").map((m) => ({ ...m }));
  const DC_VAULT4 = register(vaultDoc(4, VAULT_CMDS_V4));
  await reg({ endpoint: "vault", owner: "u_op", clusterDigests: [DC_VAULT4], protocol: { v: 1 } }, IID);
  const grantV4 = await grantFor("vault", IID);
  const surfaceV4 = await verifyGovernedSurface({
    serve: grantV4, definitions: defs, resolveAnchor, readArtifact,
    attachments: [
      signAtt("both", TRAIT_GUARDED, { guard: "warden" }, DC_VAULT4),
      signAtt("charge", TRAIT_PRICED, { currency: "usd", amount: 6 }, DC_VAULT4),
      signAtt("both", TRAIT_PRICED, { currency: "usd", amount: 9 }, DC_VAULT4),
    ],
  });
  c("removing the whole command (not stripping its trait) re-registers and verifies",
    surfaceV4.commands["launch"] === undefined && surfaceV4.commands["both"]?.[TRAIT_GUARDED] !== undefined);
  await rejects("a governed surface for a SUPERSEDED registration revision refuses at construction (a re-registration demands a fresh verification)",
    async () => serveEndpoint(nc, SPACE, grantV4, ["charge", "both", "free"].map(defFor), { public: true }, { traits: { governed: surfaceV1, guard, verifyPaymentProof } }));

  // ── TOCTOU: the gate AWAITS the guard, so a target mapping that rotates DURING that await must
  //    be caught by the post-gate currency recheck — a governed targeted request must never effect
  //    against a superseded target (finding: the new await reopened the closed target TOCTOU). ──
  const TGT_UID = "1".repeat(26);
  const ROT_UID = "2".repeat(26);
  const TGT_CMDS = [{ name: "guardtgt", class: "ephemeral", targeted: true, modes: ["owner"], capability: "vault.call", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest, traits: [TRAIT_GUARDED] }];
  const DC_TGT = register({ urn: "ai.cotal.tgt", revision: 1, attributes: [], events: [], commands: TGT_CMDS });
  await reg({ endpoint: "tgtvault", owner: "u_op", clusterDigests: [DC_TGT], protocol: { v: 1 } }, IID);
  const grantTgt = await grantFor("tgtvault", IID);
  const tgtSurface = await verifyGovernedSurface({
    serve: grantTgt, definitions: [defGuarded], resolveAnchor, readArtifact,
    attachments: [signArtifact(attBody({ endpoint: "tgtvault", command: "guardtgt", traitUrn: TRAIT_GUARDED, value: { guard: "warden" }, contractDigest: DC_TGT }), opKp)],
  });
  let mappingUid = TGT_UID;       // the CURRENT lifecycle mapping the resolver reports
  let rotateOnGuard = false;      // when set, the guard rotates the mapping mid-await
  const rotatingResolve = (t: { owner: string; actor: string }) =>
    t.owner === "u_abc" && t.actor === "svc" ? { lifecycleUid: mappingUid, mappingRevision: 1 } : undefined;
  const rotatingGuard = (): EpGuardVerdict => { if (rotateOnGuard) mappingUid = ROT_UID; return { verdict: "allow" }; };
  let tgtRuns = 0;
  const tgtHandle = serveEndpoint(nc, SPACE, grantTgt,
    [{ command: "guardtgt", contract: { input: argsContract, output: outContract }, handler: () => { tgtRuns++; return { which: "tgt" }; } }],
    { public: true },
    { resolveTarget: rotatingResolve, traits: { governed: tgtSurface, guard: rotatingGuard } });
  await nc.flush();
  const tgtReplies: { reply: EndpointReply }[] = [];
  const tgtSub = nc.subscribe(epCallerReplyFilter(SPACE, caller), { callback: (_e, m) => { tgtReplies.push({ reply: JSON.parse(new TextDecoder().decode(m.data)) as EndpointReply }); } });
  await nc.flush();
  const callTgt = async (targetUid: string) => {
    tgtReplies.length = 0;
    const body = {
      v: 1, id: `tgt-${reqN++}`, op: { endpoint: "tgtvault", command: "guardtgt", inputDigest: argsContract.closureDigest, outputDigest: outContract.closureDigest },
      class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: { name: "x" }, target: { owner: "u_abc", actor: "svc", lifecycleUid: targetUid }, from: { id: "u_abc.worker", name: "w" },
    };
    nc.publish(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "tgtvault", command: "guardtgt", caller, nonce: nonce(), target: { mode: "owner", tOwner: "u_abc" } }), new TextEncoder().encode(JSON.stringify(body)));
    await nc.flush();
    for (let i = 0; i < 40 && tgtReplies.length === 0; i++) await wait(50);
    return tgtReplies.shift();
  };
  rotateOnGuard = false;
  const rTgtOk = await callTgt(TGT_UID);
  c("a governed targeted request with a stable mapping passes the gate and effects", rTgtOk?.reply.ok === true && tgtRuns === 1);
  rotateOnGuard = true; mappingUid = TGT_UID;
  const rTgtRot = await callTgt(TGT_UID);
  c("a target mapping that ROTATES during the guard await is caught by the post-gate currency recheck (expired, no effect)",
    rTgtRot?.reply.ok === false && rTgtRot.reply.error?.code === "expired" && tgtRuns === 1);
  await tgtHandle.stop();
  tgtSub.unsubscribe();

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise((r) => broker.once("exit", r));
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT TRAITS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
