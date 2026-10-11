import { epCallerGrantRows } from "./endpoint-grants.js";
import { environmentManagerGoalWriterGrants } from "./endpoint-binding.js";
import { remoteManagerActors } from "./remote-manager-authority.js";
import { assertDerivedOwnerToken, assertLifecycleToken, livenessReplyGrant, livenessServeFilter,
  managerBucket, MANAGER_LEASE_KEY, presenceBucket, principalKey } from "./subjects.js";
import { endpointToken } from "./endpoint-subjects.js";
import type { MintPrincipal } from "./provision.js";

export type EnvironmentManagerProfile = "environment-bootstrap" | "environment-manager-supervisor"
  | "environment-manager-executor" | "environment-manager-goal-writer";

/** Host-derived coordinates for fixed guest grants. The authority separately fences durable
 * admission and issuance; this permission builder grants no admission or signing right. */
export interface EnvironmentManagerGrantPin {
  owner: string;
  instanceId: string;
  lifecycleUid: string;
  authorityEndpoint: string;
  authorityInstanceId: string;
  /** Admission expiry in epoch seconds. Every minted credential also supplies an explicit expiry. */
  expiresAt: number;
}

export function isEnvironmentManagerProfile(profile: string): profile is EnvironmentManagerProfile {
  return profile === "environment-bootstrap" || profile === "environment-manager-supervisor"
    || profile === "environment-manager-executor" || profile === "environment-manager-goal-writer";
}

/** The temporary sixth actor shares the admitted UID, never a standing manager identity. */
export function environmentBootstrapActor(instanceId: string): string {
  return `manager_bootstrap_${assertLifecycleToken(instanceId, "instanceId")}`;
}

/** Fixed, default-deny profiles. No guest credential receives an auth-store read or write. */
export function environmentManagerPermissions(
  profile: EnvironmentManagerProfile,
  space: string,
  pr: MintPrincipal,
  pin: EnvironmentManagerGrantPin | undefined,
): Record<string, unknown> {
  if (!isEnvironmentManagerProfile(profile)) throw new Error(`permissionsFor: unknown environment profile ${profile}`);
  if (!pin) throw new Error(`permissionsFor: ${profile} requires opts.environmentManager`);
  assertDerivedOwnerToken(pin.owner);
  const iid = assertLifecycleToken(pin.instanceId, "instanceId");
  assertLifecycleToken(pin.lifecycleUid, "manager lifecycleUid");
  assertLifecycleToken(pin.authorityInstanceId, "authorityInstanceId");
  endpointToken(pin.authorityEndpoint);
  if (pin.owner !== pr.owner) throw new Error(`permissionsFor: ${profile} owner does not match admission`);
  if (pin.lifecycleUid !== pr.lifecycleUid) throw new Error(`permissionsFor: ${profile} lifecycle does not match admission`);
  if (!Number.isSafeInteger(pin.expiresAt) || pin.expiresAt <= Math.floor(Date.now() / 1000))
    throw new Error(`permissionsFor: ${profile} admission expiry must be finite and current`);
  const actors = remoteManagerActors(iid);
  const expectedActor = profile === "environment-bootstrap" ? environmentBootstrapActor(iid)
    : profile === "environment-manager-supervisor" ? actors.supervisor
      : profile === "environment-manager-executor" ? actors.executor : actors.goalWriter;
  if (pr.actor !== expectedActor) throw new Error(`permissionsFor: ${profile} actor must be ${expectedActor}`);
  const inbox = `_INBOX_${pr.connId}.>`;
  if (profile === "environment-manager-goal-writer") {
    const g = environmentManagerGoalWriterGrants(space, pr.connId);
    return { pub: { allow: g.publish }, sub: { allow: g.subscribe } };
  }
  if (profile === "environment-manager-supervisor") {
    const presence = `KV_${presenceBucket(space)}`;
    const manager = `KV_${managerBucket(space)}`;
    return {
      pub: { allow: [
        "$JS.API.INFO",
        `$JS.API.STREAM.INFO.${manager}`,
        `$JS.API.STREAM.MSG.GET.${manager}`,
        `$KV.${managerBucket(space)}.${MANAGER_LEASE_KEY}.${iid}`,
        `$KV.${presenceBucket(space)}.${principalKey(pr.owner, pr.actor).key}`,
        `$JS.API.STREAM.INFO.${presence}`,
        `$JS.API.CONSUMER.CREATE.${presence}.>`,
        `$JS.API.CONSUMER.INFO.${presence}.>`,
        "$JS.FC.>",
        livenessReplyGrant(space, "manager"),
      ] },
      sub: { allow: [inbox, livenessServeFilter(space, "manager")] },
    };
  }
  const commands = profile === "environment-bootstrap"
    ? ["describe", "bootstrap", "bootstrap-status"] : ["describe", "authority"];
  const g = epCallerGrantRows(space, commands.map(command => ({
    endpoint: pin.authorityEndpoint, instanceId: pin.authorityInstanceId, instanceOnly: true, command,
  })), { owner: pr.owner, actor: pr.actor, uid: pin.lifecycleUid });
  return { pub: { allow: g.pub }, sub: { allow: [...g.sub, inbox] } };
}
