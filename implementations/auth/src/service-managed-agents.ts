/** The authority plane's managed-agent family: retained-agent validation, managed-agent enrollment and
 *  its verification, prepare-retirement, and the managed runtime check. */
import { CotalEndpoint, provisionAgentDurables, EpEnvelopeError, mintCreds, newIdentity, type readRunAdmission, mintLifecycleUid, type SpaceAuth, sameManagedGrantCustody } from "@cotal-ai/core";
import { authorizeRemoteRetainedAgentValidation } from "./retained-manager-validation.js";
import { authorizeRemoteManagedAgentEnrollment, resolveRemoteSpawner, authorizeRemoteManagedAgentPrepareRetirement, authorizeRemoteManagedAgentRuntimeCreate, authorizeRemoteManagedAgentRuntimeStatus } from "./managed-agent-enrollment.js";
import { resolveReadAcl } from "@cotal-ai/core";
import { assertWithinRunDelegation, assertWithinSpawnerGrant, findManagedActor, revokeManagedActorIf, withManagedGrantTransaction } from "./ledger.js";
import type { managerGateReads } from "./callout-authority.js";
import type { AuthorityClientOpts } from "./authority-client.js";
import type { managedRetirementAuthority } from "./service-managed-retirement.js";
import type { AuthAuthorityPlane } from "./service-plane-types.js";
import type { OpenAuthAuthorityPlaneOptions } from "./service.js";

/** What managedAgentAuthority reads from the authority-plane closure. Each is a closure constant
 *  or parameter bound once before the plane's operations are built, never reassigned. */
export interface ManagedAgentDeps {
  server: OpenAuthAuthorityPlaneOptions["server"];
  space: OpenAuthAuthorityPlaneOptions["space"];
  dataAccount: OpenAuthAuthorityPlaneOptions["dataAccount"];
  observeLegacyManagerGate: ReturnType<typeof managerGateReads>["observeLegacyManagerGate"];
  refuseIfFenced: () => void;
  issuerAuth: () => SpaceAuth;
  takeObservedSpawnRequest: (subject: string, enrollment: { actor: string; tokenHash: string }) => Promise<boolean>;
  readRunStarterAdmission: (runId: string) => Promise<Awaited<ReturnType<typeof readRunAdmission>>["admission"]>;
  deprovisionManagedFootprint: (owner: string, actor: string, lifecycleUid: string, memberChannels: string[]) => Promise<void>;
  managedRetirement: ReturnType<typeof managedRetirementAuthority>;
  serializedForAlias: <T>(dir: string, owner: string, actor: string, fn: () => Promise<T>) => Promise<T>;
  opts: OpenAuthAuthorityPlaneOptions;
  onConnection: AuthorityClientOpts["onConnection"] | undefined;
}

/** The plane's managed-agent operations (retained validation, enrollment and its verification,
 *  prepare-retirement verification and the runtime check), over the closure's deps. */
export function managedAgentAuthority(deps: ManagedAgentDeps): Pick<AuthAuthorityPlane, "validateRetainedAgent" | "verifyManagedAgentEnrollment" | "verifyManagedAgentPrepareRetirement" | "enrollManagedAgent" | "prepareManagedAgentRetirement" | "verifyManagedAgentRuntime"> {
  const { server, space, dataAccount, observeLegacyManagerGate, refuseIfFenced, issuerAuth, takeObservedSpawnRequest, readRunStarterAdmission, deprovisionManagedFootprint, managedRetirement, serializedForAlias, opts, onConnection } = deps;
  return {
    validateRetainedAgent: async (holder) => {
      refuseIfFenced();
      return authorizeRemoteRetainedAgentValidation({
        ...holder,
        proofSecret: dataAccount.signingSeed,
        space,
        observeManagerGate: observeLegacyManagerGate,
      });
    },
    verifyManagedAgentEnrollment: async ({ owner, scope, request }) => {
      refuseIfFenced();
      const r = await authorizeRemoteManagedAgentEnrollment({
        owner,
        scope,
        proofSecret: dataAccount.signingSeed,
        space,
        request,
        observeManagerGate: observeLegacyManagerGate,
      });
      // The host platform writes the grant, so this door decides its parent and bounds it as the
      // enrollment below does: by the caller it observed asking, or the run's starter, through the
      // ledger walk, and for a run also by the grant its admission froze (SPEC 13.6). The read is
      // the set the enrollment provisions; any other list the target omits is measured as empty.
      const t = r.target;
      const spawner = await resolveRemoteSpawner({ request: r, owner, takeObserved: takeObservedSpawnRequest, readAdmission: readRunStarterAdmission });
      const helper = { owner, actor: t.actor, scope: t.capabilities ?? [], allowSubscribe: resolveReadAcl(t.subscribe ?? [], t.allowSubscribe), allowPublish: t.allowPublish ?? [], role: t.role };
      if (spawner.run !== undefined) assertWithinRunDelegation(spawner.run.runId, spawner.run.starter, spawner.run.delegation, helper);
      assertWithinSpawnerGrant(opts.dir, { ...helper, parent: spawner.parent }, "spawn");
      return { request: r, parent: spawner.parent };
    },
    verifyManagedAgentPrepareRetirement: async ({ owner, scope, request }) => {
      refuseIfFenced();
      return authorizeRemoteManagedAgentPrepareRetirement({
        owner,
        scope,
        proofSecret: dataAccount.signingSeed,
        space,
        request,
        observeManagerGate: observeLegacyManagerGate,
      });
    },
    enrollManagedAgent: async ({ owner, scope, request, sentinelCreds, agentBearerExchangeUrl }) => {
      refuseIfFenced();
      const r = await authorizeRemoteManagedAgentEnrollment({ owner, scope, proofSecret: dataAccount.signingSeed, space, request, observeManagerGate: observeLegacyManagerGate });
      const t = r.target;
      const subscribe = t.subscribe ?? [];
      // An omitted or empty read list reads the subscribe set, so the bound, the row and the
      // footprint all take the read set it resolves to.
      const allowSubscribe = resolveReadAcl(subscribe, t.allowSubscribe);
      const { lifecycleUid, row } = await serializedForAlias(opts.dir, owner, t.actor, async () => {
        // The custody this enrollment attests: the instance the authorized request names, checked
        // against its current registration above. Never a field of the participant's target.
        const custody = { kind: "remote-manager" as const, instanceId: r.instanceId };
        // The helper's parent is the caller this host observed asking for it, not the manager, so
        // the ledger bounds the helper by that caller's grant (SPEC 13.6). A retry of an enrollment
        // whose row stands answers from that row, whose parent was decided when it was written, so
        // it consumes no observation.
        const spawner = findManagedActor(opts.dir, owner, t.actor)?.tokenHash === t.tokenHash ? undefined : await resolveRemoteSpawner({
          request: r, owner, takeObserved: takeObservedSpawnRequest, readAdmission: readRunStarterAdmission,
        });
        // ONE synchronous transaction for the read, the decision and the write, so an
        // enrollment in another process (or a provider grant) cannot land between them.
        const decided = withManagedGrantTransaction(opts.dir, (tx) => {
          const current = tx.read(owner, t.actor);
          const held = current?.kind === "managed-agent" ? current : undefined;
          // The token digest names one enrollment. A held row with this request's digest is that
          // enrollment retried, so it answers the same uid; any other held row is a lifecycle that
          // still runs, and taking its grant would strand it.
          if (held !== undefined && held.tokenHash !== t.tokenHash)
            throw new EpEnvelopeError("conflict", `managed agent "${t.actor}" is enrolled at lifecycle ${held.lifecycleUid}; prepare that lifecycle's retirement before enrolling a successor`);
          // A retry is this enrollment only if the held row records this exact custody. A row with
          // none, or with another, is never upgraded or adopted here.
          if (held !== undefined && (held.custody === undefined || !sameManagedGrantCustody(held.custody, custody)))
            throw new EpEnvelopeError("conflict", `managed agent "${t.actor}" is held at lifecycle ${held.lifecycleUid} under another custody; it was not adopted by this enrollment`);
          // A retry provisions the read this request resolves to, so it is this enrollment only if
          // that read is the one its grant records. A grant an older host wrote for a target that
          // named only a subscribe set records no read.
          if (held !== undefined && !(new Set(held.allowSubscribe).size === new Set(allowSubscribe).size && held.allowSubscribe.every((ch) => allowSubscribe.includes(ch))))
            throw new EpEnvelopeError("conflict", `managed agent "${t.actor}" is enrolled at lifecycle ${held.lifecycleUid} to read [${held.allowSubscribe.join(", ")}], and this retry reads [${allowSubscribe.join(", ")}]; prepare that lifecycle's retirement and enroll it again`);
          // A retry walks the held grant again: its spawner chain may have narrowed since the
          // first answer, and provisioning would restore what it took away.
          if (held !== undefined) {
            assertWithinSpawnerGrant(opts.dir, held, "spawn");
            return { lifecycleUid: held.lifecycleUid!, row: held, wrote: false };
          }
          if (spawner === undefined)
            throw new EpEnvelopeError("conflict", `managed agent "${t.actor}" was enrolled for this token and is gone; enroll it again`);
          // A run's helper is also bounded by what the run's starter held at admission, beside the
          // walk over the starter's current row below.
          if (spawner.run !== undefined)
            assertWithinRunDelegation(spawner.run.runId, spawner.run.starter, spawner.run.delegation, {
              owner, actor: t.actor, scope: t.capabilities ?? [], allowSubscribe, allowPublish: t.allowPublish ?? [], role: t.role,
            });
          // A fresh uid is never one a retirement tombstoned, and only the host can make that
          // promise. The grant's envelope walk refuses an over-wide request before any durable exists.
          const lifecycleUid = mintLifecycleUid();
          const row = tx.grantManaged({
            owner,
            actor: t.actor,
            scope: t.capabilities ?? [],
            allowSubscribe,
            allowPublish: t.allowPublish ?? [],
            ...(t.eventPayloads === false || opts.eventPayloadsWithheld === true ? { eventPayloads: false as const } : {}),
            ...(t.role !== undefined ? { role: t.role } : {}),
            ...(t.label !== undefined ? { label: t.label } : {}),
            parent: spawner.parent,
            lifecycleUid,
            tokenHash: t.tokenHash,
            custody,
          });
          return { lifecycleUid, row, wrote: true };
        });
        const { lifecycleUid, row } = decided;
        try {
          const identity = newIdentity();
          const provisioner = new CotalEndpoint({
            space,
            servers: server,
            onConnection: (nc) => onConnection?.(nc, `cotal:provisioner:${space}`),
            channels: [],
            creds: await mintCreds(issuerAuth(), identity, "provisioner"),
            card: { id: identity.id, name: "provisioner", role: "provisioner", kind: "endpoint" },
            registerPresence: false,
            watchPresence: false,
            watchChannels: false,
            consume: false,
          });
          await provisioner.start();
          try {
            await provisionAgentDurables(provisioner, { owner, actor: t.actor, lifecycleUid }, { subscribe, allowSubscribe, role: row.role });
          } finally {
            await provisioner.stop();
          }
        } catch (e) {
          // A retried enrollment's first answer may already have reached the participant, so its
          // grant stays. A grant this call wrote gave the participant no uid, so it can never be
          // retired: it and any durable it got must go now. The revoke removes only the row this
          // call wrote: same uid AND same custody, read under the grant lock.
          if (decided.wrote) {
            revokeManagedActorIf(opts.dir, owner, t.actor, { lifecycleUid, custody });
            await deprovisionManagedFootprint(owner, t.actor, lifecycleUid, []).catch((err) =>
              opts.log(`auth-service: refused enrollment of ${owner}/${t.actor} left durables at ${lifecycleUid}: ${err instanceof Error ? err.message : String(err)}`));
          }
          throw e;
        }
        return { lifecycleUid, row };
      });
      return {
        v: 1,
        kind: "manager-managed-agent-enrollment",
        space,
        owner,
        actor: r.actor,
        instanceId: r.instanceId,
        managerLifecycleUid: r.managerLifecycleUid,
        requestId: r.requestId,
        registrationProof: r.registrationProof,
        serveEpoch: r.serveEpoch,
        material: {
          owner,
          actor: t.actor,
          lifecycleUid,
          sentinelCreds,
          subscribe,
          allowSubscribe,
          allowPublish: row.allowPublish,
          agentBearerExchangeUrl,
        },
      };
    },
    prepareManagedAgentRetirement: managedRetirement.prepareManagedAgentRetirement,
    verifyManagedAgentRuntime: async ({ owner, request }) => {
      refuseIfFenced();
      const args = {
        owner,
        dir: opts.dir,
        proofSecret: dataAccount.signingSeed,
        space,
        observeManagerGate: observeLegacyManagerGate,
      };
      return request.kind === "manager-managed-agent-runtime-status"
        ? authorizeRemoteManagedAgentRuntimeStatus({ ...args, request })
        : authorizeRemoteManagedAgentRuntimeCreate({ ...args, request });
    },
  };
}
