/**
 * The decisions the auth callout runs for every connect: the connect authority, the native-key
 * issuance recorder and the permission hooks. The full auth service and a callout-only replica
 * compose the same hooks over their own connections, so a connect gets the same answer from
 * whichever process the broker's queue group picks.
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  acceptedReadGrant, actorLedgerSource, assertDerivedOwnerToken, assertLifecycleToken, canonicalJson, connectionAcceptedToken, EpEnvelopeError,
  importNativeSubjectPermissions, mintGeneration, parseServiceSpec, prepareListing, parseServiceStatus, readSvcRecordLeader, recordSpecKey, recordStatusKey,
  RECORD_KINDS, remoteManagerServePrincipal, serveIssuanceGateKv, SERVICE_ACCESS_TTL_SECONDS, writeAcceptedRow,
  type EpGateState, type HeldIssuerSession, type IssuedAuthorityRef,
} from "@cotal-ai/core";
import type { ManagerInstanceIdentity } from "@cotal-ai/workspace";
import { startAuthCallout, type AuthCalloutLimits, type CalloutAuth, type CalloutConnection } from "./callout.js";
import { chatAwareAclResolver, type ChatSessionAuthority } from "./chat-session-authority.js";
import { authorizeConnectCredential, type ConnectReader } from "./connect-reader.js";
import type { ConnectLimiter } from "./connect-limit.js";
import type { UserTokenIssuer } from "./issuer.js";
import { ledgerAclResolver, ledgerAuthorizeConnect } from "./ledger.js";
import type { LifecycleRegistry } from "./lifecycle-registry.js";
import { makeNativeIssuanceRecorder, type NativeIssuanceRecorder } from "./native-issuance.js";
import type { NativeServiceCalloutAuthority } from "./native-service-callout.js";
import { calloutPermissions, type EndpointCallerResolver, type ListingIssuer, type UserCallerIssuer } from "./permissions.js";
import { effectiveEndpointCaller } from "./service-caller-effective.js";
import { verifySessionRedemption } from "./session-redemption.js";
import type { UserTokenSession, ValidatedUserToken } from "./token.js";

export type ManagerGateVerdict = "candidate" | "unknown" | "not open" | "not this owner's" | "not registered";

/** Leader reads of one manager instance's issuance gate and its registered service records. */
export interface ManagerGateReads {
  observeManagerGate(instanceId: string): Promise<EpGateState | null>;
  /** The gate of a legacy manager. An environment-manager gate refuses. */
  observeLegacyManagerGate(instanceId: string): Promise<EpGateState | null>;
  /** Whether `owner` may call this manager instance now: an open gate this owner's manager serves,
   *  at the registered spec revision, with a status at the gate's process epoch. */
  managerGate(owner: string, instanceId: string): Promise<ManagerGateVerdict>;
}

export function managerGateReads(deps: {
  space: string;
  /** The auth store, read by a connection that may leader-read it. */
  authKv: KV;
  /** Leader reads of the records store. */
  recordsJsm: JetStreamManager;
  localManager: () => ManagerInstanceIdentity | undefined;
}): ManagerGateReads {
  const { space, authKv, recordsJsm } = deps;
  const observeManagerGate = async (instanceId: string) => serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId }).observe();
  const observeLegacyManagerGate = async (instanceId: string) => {
    const gate = await observeManagerGate(instanceId);
    if (gate?.authorityFamily === "environment-manager")
      throw new EpEnvelopeError("permission-denied", `manager instance ${instanceId} belongs to the environment-manager authority family`);
    return gate;
  };
  const managerGate = async (owner: string, instanceId: string): Promise<ManagerGateVerdict> => {
    const localManager = deps.localManager();
    const gate = await observeLegacyManagerGate(instanceId);
    if (!gate) return "unknown";
    if (gate.state !== "open") return "not open";
    const remotePrincipal = remoteManagerServePrincipal(owner, instanceId);
    const local = localManager?.instanceId === instanceId && gate.principal === `local.${localManager.serveIdentity.id}`;
    const remote = gate.principal === remotePrincipal;
    if (!local && !remote) return "not this owner's";
    const rec = await readSvcRecordLeader(recordsJsm, space, recordSpecKey(RECORD_KINDS.svc, ["manager", instanceId]));
    if (!rec || "deleted" in rec) return "not registered";
    const spec = parseServiceSpec(rec.value, { endpoint: "manager" });
    if (spec.owner !== (local ? "local" : owner) || rec.revision !== gate.registrationRevision) return "not registered";
    const statusRec = await readSvcRecordLeader(recordsJsm, space, recordStatusKey(RECORD_KINDS.svc, ["manager", instanceId]));
    if (!statusRec || "deleted" in statusRec) return "not registered";
    const status = parseServiceStatus(statusRec.value);
    if (status.observedSpecRevision < rec.revision || status.epoch !== gate.processEpoch) return "not registered";
    return "candidate";
  };
  return { observeManagerGate, observeLegacyManagerGate, managerGate };
}

/** The callout's hooks, as `startAuthCallout` and `calloutPermissions` take them. */
export interface CalloutAuthority {
  authorizeConnect: (t: ValidatedUserToken) => Promise<void>;
  /** The callout's required native-key issuance recorder (SPEC 13.1 `natkey.`): create-only, then
   *  the same connect authority re-read before the minted JWT may leave. */
  recordIssuance: NativeIssuanceRecorder;
  authorizeManagerCaller: (owner: string, instanceId: string) => Promise<void>;
  /** The callout's issuance of an interactive user's `manager-caller` view (SPEC 13.15): on the
   *  process's held issuer session, it stages and releases evidence bound to the actor-ledger row
   *  and writes the connection's accepted row, or renews the generation that row already names. */
  issueUserCaller: UserCallerIssuer;
  /** The callout's listing issuance (SPEC 13.15, "Listing issuance") for an agent connection or an
   *  unissued manager-caller view, on the same held issuer session: a fresh listing generation
   *  bound to the actor-ledger row, or the one the connection's listing token already names when
   *  the ceiling is identical. Any other row leaves the connection without the listing rows. */
  issueListing: ListingIssuer;
  /** Fresh generic endpoint caller rights for the authenticated exact actor lifecycle. */
  resolveEndpointCaller: EndpointCallerResolver;
  /** #2312: may this principal hold this one session? Leader-reads the redeemed `session.<id>` row
   *  and the serving manager gate; returns the session claim (expiry from the row) or throws. */
  verifySession: (
    principal: { owner: string; actor: string; lifecycleUid?: string },
    claim: { endpoint: string; sessionId: string; epoch: number; grantSig?: string },
  ) => Promise<UserTokenSession>;
}

export interface CalloutAuthorityDeps {
  space: string;
  /** The issuer session this process holds for user-caller issuance. Its owner closes it. */
  issuer: HeldIssuerSession;
  /** The provider state dir holding the actor ledger. */
  dir: string;
  dataAccount: { pub: string; signingSeed: string };
  /** The registry the issuance rows are written on and endpoint caller rights are read from. */
  registry: LifecycleRegistry;
  /** The proved connect-credential reader. Throws while it is not bound. */
  reader: () => ConnectReader;
  chat: Pick<ChatSessionAuthority, "isChatPrincipal" | "authorizeConnect">;
  gate: ManagerGateReads;
  /** Leader reads of the sessions store, for session redemption. */
  recordsJsm: JetStreamManager;
  /** Present only when the service host bootstrapped its caller payload. */
  checkCallerPayload?: () => Promise<void>;
  /** Throws once this process must authorize nothing more: a fenced plane, a stopping replica. */
  refuse: () => void;
}

export function calloutAuthority(deps: CalloutAuthorityDeps): CalloutAuthority {
  const { space, issuer, dir, dataAccount, registry, chat, gate, refuse } = deps;
  const fileArm = ledgerAuthorizeConnect(dir);
  // A chat principal (its alias is in the chat row space) is checked by the chat arm: its active
  // row, its parent pin and its holder index. Every other principal by the grant-file arm.
  const connectArm = async (t: ValidatedUserToken): Promise<void> => {
    if (chat.isChatPrincipal(t.owner, t.act.actor)) await chat.authorizeConnect(t);
    else fileArm(t);
  };
  // The callout's issuance evidence: create-only natkey row, then the connect authority re-read
  // in the same stream before the minted JWT may leave. For a chat session this re-read is the
  // post-sign fence: its own head and root credential, its parent pin and its holder index.
  const recordIssuance = makeNativeIssuanceRecorder(registry, async (t) => {
    refuse();
    await connectArm(t);
    await authorizeConnectCredential(deps.reader(), t, Date.now);
  });
  return {
    resolveEndpointCaller: async (t) => {
      refuse();
      const grantee = { owner: t.owner, actor: t.act.actor, lifecycleUid: assertLifecycleToken(t.act.lifecycleUid ?? "", "caller lifecycleUid") };
      const effective = await effectiveEndpointCaller(registry, dataAccount.pub, dir, grantee);
      const checkCallerPayload = deps.checkCallerPayload;
      if (effective.capabilities.length && !checkCallerPayload)
        throw new EpEnvelopeError("failed-precondition", "endpoint caller rights require actual host payload bootstrap");
      if (effective.capabilities.length) await checkCallerPayload!();
      const image = canonicalJson(effective);
      return { ...effective, ...(effective.expiresAt === undefined ? {} : { expiresAt: Math.min(effective.expiresAt, Math.floor(Date.now() / 1000) + SERVICE_ACCESS_TTL_SECONDS) }), recheck: async () => {
        refuse();
        if (effective.capabilities.length) await checkCallerPayload!();
        refuse();
        const current = await effectiveEndpointCaller(registry, dataAccount.pub, dir, grantee);
        if (canonicalJson(current) !== image) throw new EpEnvelopeError("permission-denied", "endpoint caller authority changed before release");
      } };
    },
    authorizeConnect: async (t) => {
      refuse();
      await connectArm(t);
      await authorizeConnectCredential(deps.reader(), t, Date.now);
    },
    recordIssuance: (i) => {
      refuse();
      return recordIssuance(i);
    },
    authorizeManagerCaller: async (owner, instanceId) => {
      refuse();
      const verdict = await gate.managerGate(owner, assertLifecycleToken(instanceId, "managerInstanceId"));
      if (verdict !== "candidate") throw new Error(`manager instance ${instanceId} is ${verdict} at the permission mint`);
    },
    issueUserCaller: async ({ t, connId, mint }) => {
      refuse();
      const owner = assertDerivedOwnerToken(t.owner);
      const actor = t.act.actor;
      const uid = assertLifecycleToken(t.act.lifecycleUid ?? "", "lifecycleUid");
      const acceptedToken = connectionAcceptedToken(connId);
      return issuer.run(async (session) => {
        // The row this connection's nonce names, read the way the client reads it.
        const existing = await session.nc.request(acceptedReadGrant(space, acceptedToken), new Uint8Array(0), { timeout: 3000 });
        const code = existing.headers?.code ?? 0;
        const status = existing.headers?.get("Status") ?? "";
        const missing = code === 404 || status.startsWith("404");
        if (!missing && (code >= 400 || status !== ""))
          throw new Error(`callout permissions: the accepted-row read for this connection failed (${code || status})`);
        if (missing) {
          // The generation ends with this bearer, which is already its resolution bound.
          const generation = mintGeneration(t.exp);
          const perms = mint({ generation, acceptedToken, listing: true });
          const ref = { space, owner, actor, uid, generation };
          const prepared = await session.store.stage({
            version: 1, ref, sources: [actorLedgerSource(space, owner, actor, uid)], permissions: importNativeSubjectPermissions(perms), expiresAt: t.exp,
          });
          await session.store.release(prepared, async () => {});
          await writeAcceptedRow(session.accepted, acceptedToken, ref);
          return perms;
        }
        const row = JSON.parse(new TextDecoder().decode(existing.data)) as { version?: unknown; ref?: IssuedAuthorityRef };
        const ref = row.ref;
        if (row.version !== 1 || ref === undefined || ref.space !== space || ref.owner !== owner || ref.actor !== actor || ref.uid !== uid)
          throw new Error("callout permissions: this connection's accepted row names another issued reference; reconnect under a new nonce");
        // A generation issued before the listing row existed renews its recorded ceiling, without it.
        const listed = mint({ generation: ref.generation, acceptedToken, listing: true });
        try {
          await session.store.confirm(ref, importNativeSubjectPermissions(listed));
          return listed;
        } catch (e) {
          if (!(e instanceof EpEnvelopeError && e.code === "failed-precondition")) throw e;
        }
        const perms = mint({ generation: ref.generation, acceptedToken });
        await session.store.confirm(ref, importNativeSubjectPermissions(perms));
        return perms;
      });
    },
    issueListing: async ({ t, connId, mint }) => {
      refuse();
      const owner = assertDerivedOwnerToken(t.owner);
      const actor = t.act.actor;
      const uid = assertLifecycleToken(t.act.lifecycleUid ?? "", "lifecycleUid");
      return issuer.run(async (session) => {
        // The horizon is the bearer's expiry, which bounds every connection minted on it.
        const prepared = await prepareListing(session, {
          space, owner, actor, uid, connId, horizon: t.exp, sources: [actorLedgerSource(space, owner, actor, uid)], expiresAt: t.exp,
        }, mint);
        await prepared.commit();
        return prepared.permissions;
      });
    },
    verifySession: async (principal, claim) => {
      refuse();
      return verifySessionRedemption({
        jsm: deps.recordsJsm,
        space,
        managerGate: async (owner, instanceId) => {
          const verdict = await gate.managerGate(owner, assertLifecycleToken(instanceId, "serving.instanceId"));
          const observed = await gate.observeLegacyManagerGate(instanceId);
          return { verdict, ...(observed ? { processEpoch: observed.processEpoch } : {}) };
        },
      }, principal, claim);
    },
  };
}

/** Subscribe the auth callout on `nc` with these hooks. The full service and a replica both start
 *  their callout here, so they answer with the same options and the same limits. */
export function serveCallout(nc: CalloutConnection, args: {
  space: string;
  /** The provider state dir holding the actor ledger. */
  dir: string;
  callout: Pick<CalloutAuth, "xkey" | "account">;
  dataAccount: { pub: string; signingSeed: string };
  issuer: UserTokenIssuer;
  hooks: CalloutAuthority;
  serviceAuthority?: NativeServiceCalloutAuthority;
  limits?: AuthCalloutLimits;
  /** The connect limits, shared with the exchange in the full service. Absent: the callout keeps
   *  its own at the defaults, as a replica does. */
  connectLimiter?: ConnectLimiter;
}): { done: Promise<void> } {
  const { space, dir, callout, issuer, hooks } = args;
  return startAuthCallout(nc, {
    ...(args.serviceAuthority !== undefined ? { serviceAuthority: args.serviceAuthority } : {}),
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: args.dataAccount,
    space,
    token: { key: issuer.localKeySet(), issuer: issuer.issuer },
    authorizeActor: hooks.authorizeConnect,
    recordIssuance: hooks.recordIssuance,
    // A chat principal resolves from its closed row (the agent leaf, no role); every other
    // principal from the grant ledger.
    permissionsFor: calloutPermissions(chatAwareAclResolver(dir, ledgerAclResolver(dir)), hooks.authorizeManagerCaller, hooks.verifySession, hooks.issueUserCaller, hooks.resolveEndpointCaller, hooks.issueListing),
    log: (l) => console.error(l),
    ...(args.limits !== undefined ? { limits: args.limits } : {}),
    ...(args.connectLimiter !== undefined ? { connectLimiter: args.connectLimiter } : {}),
  });
}
