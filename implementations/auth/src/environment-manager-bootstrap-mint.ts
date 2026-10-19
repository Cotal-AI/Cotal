import {
  assertLifecycleToken, contractDigest, environmentBootstrapActor, EpEnvelopeError, epgateKey,
  isCasLoss, isUserNkey, mintPublicUserJwt, parseEndpointGate, remoteManagerServePrincipal,
} from "@cotal-ai/core";
import type { EnvironmentManagerAdmissionCoordinates } from "./environment-manager-admission.js";
import { finalizeAgentMint, markLedgerRowRevoked, stageAgentMint } from "./credential-ledger.js";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";

/** Host-only signing inputs. The public nkey and credential ID are recorded before this call;
 * neither a guest request nor this helper chooses a new admission or permission profile. */
interface BootstrapMintInput {
  publicId: string;
  credentialId: string;
  expiresAt: number;
  account: { pub: string; signingSeed: string };
}

/** Internal one-shot mint after native admission staging. A reserved or ambiguous attempt stays
 * held on replay; external cleanup must retire its recorded lifecycle, never mint a replacement.
 * Full provider/policy admission and private file delivery are not implemented by this helper. */
export async function mintEnvironmentManagerBootstrap(
  reg: LifecycleRegistry,
  input: EnvironmentManagerAdmissionCoordinates,
  mint: BootstrapMintInput,
): Promise<{ jwt: string; exp: number; credentialId: string; gateRevision: number }> {
  const pin = structuredClone(input);
  const args = structuredClone(mint);
  const now = Math.floor(Date.now() / 1000);
  const fields = ["owner", "instanceId", "lifecycleUid", "authorityEndpoint", "authorityInstanceId",
    "expiresAt", "environmentId", "admissionRevision", "operationId"];
  if (Object.keys(pin).length !== fields.length || Object.keys(pin).some(key => !fields.includes(key)) ||
    Object.keys(args).sort().join(",") !== "account,credentialId,expiresAt,publicId" ||
    !isUserNkey(args.publicId) || !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now ||
    args.expiresAt > now + 300 || args.expiresAt > pin.expiresAt)
    throw new EpEnvelopeError("failed-precondition", "environment bootstrap mint inputs or expiry are invalid");
  assertLifecycleToken(pin.operationId, "operationId");
  assertLifecycleToken(pin.instanceId, "instanceId");
  assertLifecycleToken(pin.lifecycleUid, "lifecycleUid");
  assertLifecycleToken(args.credentialId, "credentialId");
  const { space, authKv } = registryStores(reg);
  const admission = await authKv.get(`stage.${pin.operationId}.environment-manager`);
  if (!admission || admission.operation !== "PUT")
    throw new EpEnvelopeError("permission-denied", "environment bootstrap has no native admission staging");
  let staged: unknown;
  try { staged = admission.json(); }
  catch { throw new EpEnvelopeError("failed-precondition", "environment bootstrap admission staging is not JSON"); }
  const expected = { v: 1, kind: "environment-manager-admission", space, ...pin };
  if (contractDigest(staged) !== contractDigest(expected))
    throw new EpEnvelopeError("permission-denied", "environment bootstrap does not match the staged admission");
  const birth = await authKv.get(`stage.${pin.operationId}.environment-manager-gate`);
  if (!birth || birth.operation !== "PUT")
    throw new EpEnvelopeError("permission-denied", "environment bootstrap has no native initial-gate stamp");
  let initial: { instanceId?: unknown; principal?: unknown; openRevision?: unknown };
  try { initial = birth.json(); }
  catch { throw new EpEnvelopeError("failed-precondition", "environment bootstrap initial-gate stamp is not JSON"); }
  if (!initial || typeof initial !== "object" || Object.keys(initial).length !== 3 || initial.instanceId !== pin.instanceId ||
    initial.principal !== remoteManagerServePrincipal(pin.owner, pin.instanceId) ||
    !Number.isSafeInteger(initial.openRevision) || Number(initial.openRevision) < 1)
    throw new EpEnvelopeError("permission-denied", "environment bootstrap initial-gate stamp has foreign coordinates");
  const key = epgateKey("manager", pin.instanceId);
  const entry = await authKv.get(key);
  if (!entry || entry.operation !== "PUT")
    throw new EpEnvelopeError("permission-denied", "environment bootstrap has no native registration gate");
  const gate = parseEndpointGate(entry.value, key);
  if (gate.authorityFamily !== "environment-manager" ||
    gate.principal !== remoteManagerServePrincipal(pin.owner, pin.instanceId) ||
    gate.state !== "frozen" || gate.op.kind !== "registration" || gate.op.opId !== pin.operationId ||
    gate.registrationRevision !== 0)
    throw new EpEnvelopeError("permission-denied", "environment bootstrap requires its original frozen registration");
  const reservationKey = `stage.${pin.operationId}.environment-bootstrap-mint`;
  const reservation = JSON.stringify({ v: 1, admissionDigest: contractDigest(expected), publicId: args.publicId,
    credentialId: args.credentialId, expiresAt: args.expiresAt });
  try { await authKv.put(reservationKey, reservation, { previousSeq: 0 }); }
  catch (error) {
    if (isCasLoss(error))
      throw new EpEnvelopeError("conflict", "environment bootstrap mint is already reserved; its outcome stays held");
    throw new EpEnvelopeError("unavailable", "environment bootstrap mint reservation outcome is unknown");
  }
  const signed = await mintPublicUserJwt({ space, account: args.account }, args.publicId, "environment-bootstrap", {
    principal: { owner: pin.owner, actor: environmentBootstrapActor(pin.instanceId) }, lifecycleUid: pin.lifecycleUid,
    environmentManager: pin, expiresAt: args.expiresAt,
  });
  const ledger = await stageAgentMint(reg, { lifecycleUid: pin.lifecycleUid, credentialId: args.credentialId,
    holderPrincipal: `${pin.owner}.${environmentBootstrapActor(pin.instanceId)}`, sourceChain: ["root"], exp: signed.exp });
  let gateRevision: number;
  try {
    // This touch precedes preparation, never a token-pinned registration continuation. The native
    // lifecycle finalize remains separate; terminal cleanup freezes that lifecycle before abort.
    gateRevision = await authKv.update(key, entry.value, entry.revision);
    await finalizeAgentMint(reg, ledger);
  } catch (error) {
    await markLedgerRowRevoked(authKv, ledger.rowKey);
    if (isCasLoss(error))
      throw new EpEnvelopeError("permission-denied", "environment bootstrap lost its native registration fence");
    throw error;
  }
  return { ...signed, credentialId: args.credentialId, gateRevision };
}
