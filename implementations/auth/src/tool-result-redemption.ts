/**
 * The identity plane's tool-result consent decision (SPEC 13.6): may this holder redeem this signed
 * consent right now? Shared by the exchange (before the bearer is signed) and the callout (again at
 * the permission mint), exactly like `session-redemption.ts` for sessions.
 *
 * The incarnation a consent may read is the target's CURRENT active lifecycle head, read fresh, never
 * the uid the artifact claims: a retiring, retired or successor head refuses, an alias re-grant
 * included. The artifact itself is re-verified against the host's registered `consents` anchors
 * (signature, scope ceiling, human-proof freshness, window), and its holder must be the redeeming
 * principal. Nothing here mints; the callout turns the returned consent into the exact rows of
 * `toolResultRedemptionRows`.
 */
import { assertDerivedOwnerToken, assertValidOwnerToken, EpEnvelopeError, verifyToolResultConsent, type AnchorResolver, type ToolResultConsent } from "@cotal-ai/core";

export interface ToolResultRedemptionReads {
  space: string;
  /** The host's registered `consents` anchors. Absent: this host does not redeem consents. */
  resolveAnchor: AnchorResolver | undefined;
  /** Leader-read of the target's lifecycle head. */
  readHead: (owner: string, actor: string) => Promise<{ lifecycleUid: string; state: string } | undefined>;
  now?: number;
}

export async function verifyToolResultRedemption(
  reads: ToolResultRedemptionReads,
  holder: { owner: string; actor: string },
  raw: unknown,
): Promise<ToolResultConsent> {
  if (reads.resolveAnchor === undefined)
    throw new EpEnvelopeError("unimplemented", "this host has no tool-result consent anchors configured");
  const target = (raw as { target?: { owner?: unknown; actor?: unknown } } | null)?.target;
  if (typeof target?.owner !== "string" || typeof target.actor !== "string")
    throw new EpEnvelopeError("contract-invalid", "a tool-result consent names no target agent");
  const owner = assertDerivedOwnerToken(target.owner);
  const actor = assertValidOwnerToken(target.actor);
  const head = await reads.readHead(owner, actor);
  if (head === undefined || head.state !== "active")
    throw new EpEnvelopeError("expired", "the consent's target agent has no active incarnation");
  const consent = await verifyToolResultConsent(raw, {
    space: reads.space,
    expect: { owner, actor, lifecycleUid: head.lifecycleUid },
    resolveAnchor: reads.resolveAnchor,
    ...(reads.now !== undefined ? { now: reads.now } : {}),
  });
  if (consent.holder.id !== `${holder.owner}.${holder.actor}`)
    throw new EpEnvelopeError("permission-denied", "only the holder a consent names can redeem it");
  return consent;
}
