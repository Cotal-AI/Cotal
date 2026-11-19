/** The authority plane's managed lifecycle retirement: the loopback managed-retire door and the
 *  hosted retirement preparation that revokes a managed grant and releases its broker footprint.
 *  The plane passes its fence, retirement deps and in-flight retirement map, so a door call and a
 *  rail call for one lifecycle join one barrier operation. */
import {
  EpEnvelopeError, assertDerivedOwnerToken, assertLifecycleToken, assertValidOwnerToken, isConcreteChannel, managedRetirementOpId,
  retirementFrontierStreams,
} from "@cotal-ai/core";
import { joinOrStartRetirement, type RetirementFlights } from "./auth-admin.js";
import { findManagedActor, withManagedGrantTransaction } from "./ledger.js";
import { readLifecycleHeadForOperation, type LifecycleRegistry } from "./lifecycle-registry.js";
import { authorizeRemoteManagedAgentPrepareRetirement, type ObserveManagerGate } from "./managed-agent-enrollment.js";
import type { RetirementDeps } from "./retirement-barrier.js";
import type { AuthAuthorityPlane } from "./service.js";

/** What the managed retirement members read from the plane that composes them. */
export interface ManagedRetirementDeps {
  dir: string;
  space: string;
  dataAccount: { signingSeed: string };
  barrierReg: LifecycleRegistry;
  retirement: RetirementDeps;
  retirementFlights: RetirementFlights;
  observeLegacyManagerGate: ObserveManagerGate;
  refuseIfFenced: () => void;
  deprovisionManagedFootprint: (owner: string, actor: string, lifecycleUid: string, memberChannels: string[]) => Promise<void>;
  serializedForAlias: <T>(dir: string, owner: string, actor: string, fn: () => Promise<T>) => Promise<T>;
}

/** The plane's managed lifecycle retirement members, over the plane's own state. */
export function managedRetirementAuthority(deps: ManagedRetirementDeps): Pick<AuthAuthorityPlane, "retireManagedLifecycle" | "prepareManagedAgentRetirement"> {
  const { space, dataAccount, barrierReg, retirement, retirementFlights, observeLegacyManagerGate, refuseIfFenced, deprovisionManagedFootprint, serializedForAlias } = deps;
  const opts = { dir: deps.dir };
  return {
    retireManagedLifecycle: async (args) => {
      refuseIfFenced();
      const owner = assertDerivedOwnerToken(args.owner);
      const actor = assertValidOwnerToken(args.actor);
      const lifecycleUid = assertLifecycleToken(args.lifecycleUid);
      // The `prepareAgentRetirement` contract: the host revokes the managed grant FIRST. Only a
      // grant still live AT THIS uid blocks; a row at another uid is a successor the head decides.
      if (findManagedActor(opts.dir, owner, actor)?.lifecycleUid === lifecycleUid)
        throw new EpEnvelopeError("conflict", `managed actor "${owner}/${actor}" is still granted at lifecycle ${lifecycleUid}; revoke the grant before retiring it`);
      const head = await readLifecycleHeadForOperation(barrierReg, owner, actor);
      if (head === undefined)
        return { retired: false, lifecycleUid, notStarted: true };
      if (head.mapping.lifecycleUid !== lifecycleUid) {
        if (head.mapping.state === "retired")
          return { retired: false, lifecycleUid, notStarted: true };
        throw new EpEnvelopeError("conflict", `managed lifecycle retirement for "${owner}/${actor}" names ${lifecycleUid}, but the authority head is ${head.mapping.state} at ${head.mapping.lifecycleUid}`);
      }
      if (head.mapping.state === "retired")
        return { retired: true, lifecycleUid, alreadyRetired: true };
      // The rail's opId, not the interactive digest: a host door call and a late participant rail call
      // create or resume ONE barrier operation and join ONE in-process flight.
      const opId = managedRetirementOpId(lifecycleUid);
      const flight = joinOrStartRetirement(retirementFlights, barrierReg, {
        owner, actor, lifecycleUid, opId, frontierStreams: retirementFrontierStreams(space),
      }, retirement);
      if (flight === undefined)
        throw new EpEnvelopeError("conflict", `managed retirement operation ${opId} is already in flight for different coordinates`);
      await flight;
      return { retired: true, lifecycleUid };
    },
    prepareManagedAgentRetirement: async ({ owner, scope, request }) => {
      refuseIfFenced();
      const r = await authorizeRemoteManagedAgentPrepareRetirement({ owner, scope, proofSecret: dataAccount.signingSeed, space, request, observeManagerGate: observeLegacyManagerGate });
      const { actor, lifecycleUid } = r.target;
      await serializedForAlias(opts.dir, owner, actor, async () => {
        // Only a grant still at the target uid is this lifecycle's. A row at another uid belongs to a
        // successor, and an absent row means an earlier attempt already released both halves.
        const row = findManagedActor(opts.dir, owner, actor);
        if (row?.lifecycleUid === lifecycleUid) {
          // Footprint before grant: while the row stands, a retry still knows which channels to purge.
          // The footprint work is async, so it runs outside the grant lock.
          await deprovisionManagedFootprint(owner, actor, lifecycleUid, row.allowSubscribe.filter(isConcreteChannel));
          // The decision and the write are one transaction: the row removed is the one read above
          // only if it still names this uid and the custody it carried then. A row written before
          // custody existed is removed by uid alone, as before.
          withManagedGrantTransaction(opts.dir, (tx) => {
            if (row.custody !== undefined) tx.revokeManagedIf(owner, actor, { lifecycleUid, custody: row.custody });
            else tx.revokeManagedAt(owner, actor, lifecycleUid);
          });
        }
      });
      return {
        v: 1,
        kind: "manager-managed-agent-prepare-retirement",
        space,
        owner,
        actor: r.actor,
        instanceId: r.instanceId,
        managerLifecycleUid: r.managerLifecycleUid,
        requestId: r.requestId,
        target: r.target,
        opId: r.opId,
        prepared: true,
      };
    },
  };
}
