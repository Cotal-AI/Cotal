/** Exact current ledger ancestry for endpoint caller policy. Every managed link needs concrete
 * active grant ids, never an alias-only parent, admin exemption or a child's asserted lineage. */
import { EpEnvelopeError, canonicalJson, endpointCapabilitiesWithin, parsePrincipalKey, type EpCapability, type ServicePrincipal } from "@cotal-ai/core";
import { findActorUnified } from "./ledger.js";
import type { NativeServiceCallerPolicy } from "./service-caller-policy.js";
import type { ServiceParentRef } from "./service-host-contract.js";

export async function callerParentRefs(args: {
  space: string; ledgerDir: string; grantee: ServicePrincipal; capabilities: EpCapability[];
  service: { endpoint: string; instanceId: string; approvalDigest: string };
  expectedRefs?: ServiceParentRef[];
  readPolicy: (principal: ServicePrincipal) => Promise<NativeServiceCallerPolicy | undefined>;
}): Promise<ServiceParentRef[]> {
  const fail = (): never => { throw new EpEnvelopeError("permission-denied", "endpoint caller ancestry has no current exact-lifecycle covering grants"); };
  const seen = new Set<string>();
  const caller = (p: ServicePrincipal) => ({ owner: p.owner, actor: p.actor, uid: p.lifecycleUid });
  const walk = async (principal: ServicePrincipal): Promise<ServiceParentRef[]> => {
    if (seen.size >= 32 || seen.has(principal.lifecycleUid)) return fail();
    seen.add(principal.lifecycleUid);
    const row = findActorUnified(args.ledgerDir, principal.owner, principal.actor);
    if (!row || row.lifecycleUid !== principal.lifecycleUid) return fail();
    if (!row.parent) {
      if (row.kind !== "interactive") return fail();
      return [];
    }
    if (row.kind !== "managed-agent") return fail();
    const parent = parsePrincipalKey(row.parent);
    if (!parent || parent.owner !== principal.owner) return fail();
    const parentRow = findActorUnified(args.ledgerDir, parent.owner, parent.actor);
    if (!parentRow?.lifecycleUid) return fail();
    const p = { owner: parent.owner, actor: parent.actor, lifecycleUid: parentRow.lifecycleUid };
    const policy = await args.readPolicy(p);
    if (!policy || canonicalJson(policy.grantee) !== canonicalJson(p)) return fail();
    const covering = policy.grants.filter(g => g.status.state === "active" && g.endpoint === args.service.endpoint
      && g.instanceId === args.service.instanceId && g.serviceApprovalDigest === args.service.approvalDigest
      && g.source.kind === "service-owner" && g.source.approvalDigest === args.service.approvalDigest);
    const expected = args.expectedRefs?.find(ref => ref.principal.lifecycleUid === p.lifecycleUid);
    if (args.expectedRefs && (!expected || canonicalJson(expected.principal) !== canonicalJson(p))) return fail();
    const wantedIds = expected && new Set(expected.grants.map(ref => ref.grantId));
    const usable = covering.filter(g => !wantedIds || wantedIds.has(g.grantId));
    if (expected && usable.length !== expected.grants.length) return fail();
    const ancestors = await walk(p);
    if (usable.some(g => canonicalJson(g.parentRefs) !== canonicalJson(ancestors))) return fail();
    if (!usable.length || !endpointCapabilitiesWithin({ space: args.space,
      child: { caller: caller(args.grantee), capabilities: args.capabilities },
      parent: { caller: caller(p), capabilities: usable.flatMap(g => g.capabilities) } })) return fail();
    return [...ancestors, { principal: p, grants: usable.map(g => ({ granteeUid: p.lifecycleUid, grantId: g.grantId })).sort((a, b) => a.grantId < b.grantId ? -1 : 1) }]
      .sort((a, b) => a.principal.lifecycleUid < b.principal.lifecycleUid ? -1 : 1);
  };
  const expectedRefs = await walk(args.grantee);
  return expectedRefs.map(p => ({ ...p, grants: [...p.grants].sort((a, b) => a.grantId < b.grantId ? -1 : 1) }));
}
