import { CompactSign } from "jose";
import { fromPublic } from "@nats-io/nkeys";
import type { KV } from "@nats-io/kv";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import {
  acquireEndpointPolicyHold, assertEndpointInstanceAuthority, canonicalJson, contractDigest, rawDigest,
  createRowByteIdempotent, mintLifecycleUid, mintGeneration, mintAcceptedToken, permissionsFor,
  importNativeSubjectPermissions, issuedPermitsSubject, writeAcceptedRow, parseEpSubject,
  parseEndpointRequest, checkRequestSubjectAgreement, provisionEndpointGateOpen, endpointRegistrationBarrier,
  registerServiceInstance, authorizeServeGrant, mintPublicUserJwt, serveIssuanceGateKv, epgateKey,
  parseEndpointGate, principalKey, endpointToken, assertLifecycleToken, epAuthBucket,
  verifyClusterManifest, verifyClusterRoot, compileContract, ENDPOINT_AUTHORITY_INPUT_SCHEMA,
  ENDPOINT_AUTHORITY_OUTPUT_SCHEMA, EpEnvelopeError,
  type EndpointAccountPin, type EndpointDelegatedBinding, type EndpointServingAuthorityRef,
  type EndpointServeAttestation, type EpCaller, type EpCapability, type IssuedStore,
  type IssuedSourceRef, type IssuedAuthorityRef, type EpCommandDef, type SpaceAuth,
  connectionAcceptedToken, epRequestSubject, issuedBucket, type EndpointInstanceAuthorityRequest, type EndpointInstanceAuthorityDecision,
  parseEndpointCallerSelection, endpointControlProof, type EndpointDeploymentTrust, type EndpointCallerSelection,
} from "@cotal-ai/core";
import type { SigningKey } from "./issuer.js";
import type { ValidatedUserToken } from "./token.js";

const enc = new TextEncoder(), dec = new TextDecoder();
function refuse(message: string): never { throw new EpEnvelopeError("permission-denied", message, undefined, "not-executed"); }
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) refuse("unsupported endpoint authority request shape");
  return raw as Record<string, unknown>;
}
export interface EndpointNamespacePolicy {
  account: EndpointAccountPin; endpoint: string; governor: string; namespaceRevision: number;
  policyRevision: number; clusterDigests: readonly string[];
}
export interface EndpointAuthorityPolicy {
  namespace(endpoint: string): Promise<EndpointNamespacePolicy>;
  serving(principal: EpCaller, allocated: { endpoint: string; instanceId: string; publicKey: string }): Promise<EndpointDelegatedBinding>;
  authorizeInstance(request: EndpointInstanceAuthorityRequest): Promise<EndpointInstanceAuthorityDecision>;
  caller(principal: EpCaller, request: { endpoint: string; instanceId: string; commands: readonly string[] }): Promise<{ capabilities: EpCapability[]; expiresAt: number }>;
  actorIsCurrent(principal: EpCaller): Promise<boolean>;
}
export interface Reservation { v: 2; endpoint: string; instanceId: string; operationId: string; binding: EndpointDelegatedBinding; clusterDigests: string[]; state: "prepared" | "active" | "retired" }
export interface ActivationContent { action: "activate"; registrationRevision: 0; processEpoch: 0; contractArtifacts: { digest: string; value: Record<string, unknown> | boolean }[] }
export interface Challenge { v: 2; kind: "cotal.endpoint-holder"; operationId: string; challengeId: string; nonce: string; endpoint: string; instanceId: string; binding: EndpointDelegatedBinding; operationDigest: string; issuedAt: number; expiresAt: number }
export interface Active { reservation: Reservation; serveJwt: string; attestation: string; credentialDigest: string; registrationRevision: number; processEpoch: number; operationDigest: string }
export interface Drain { v: 2; operationId: string; admissionId: string; instanceId: string; holder: EpCaller & { generation: string }; caller: IssuedAuthorityRef; requestSubjectDigest: string; envelopeDigest: string; state: "held" | "terminal" | "uncertain"; outcome?: "executed" | "not-executed" | "unknown" }
export interface EndpointAuthorityHostInput {
  account: EndpointAccountPin; auth: SpaceAuth; authKv: KV; recordsKv: KV; sourceKv: KV; acceptedKv: KV;
  issued: IssuedStore; nc: NatsConnection; signing?: SigningKey; signAttestation?: (payload: EndpointServeAttestation) => Promise<string>; issuer: string; policy: EndpointAuthorityPolicy;
  publishArtifact(artifact: { digest: string; value: Record<string, unknown> | boolean }): Promise<void>;
  readArtifact(digest: string): Promise<unknown>;
  deploymentTrust?: Readonly<EndpointDeploymentTrust>;
  assertCurrent?(): Promise<void>;
}
/** Trusted-host authority. Signing and writer handles stay in this process. All participant
 * paths receive bounded JWT/JWS material only and run direct native application calls. */
export function createEndpointAuthority(input: EndpointAuthorityHostInput) {
  const { authKv, recordsKv, sourceKv, account, policy } = input;
  const observed = new Map<string, { digest: string; id: string; expires: number }>();
  const subscriptions: Subscription[] = [];
  const inFlight = new Set<string>();
  const reservationKey = (id: string) => `endpoint-reservation.${assertLifecycleToken(id)}`;
  async function read<T>(kv: KV, key: string): Promise<{ row: T; revision: number }> {
    const entry = await kv.get(key);
    if (!entry || entry.operation !== "PUT") refuse(`endpoint authority record ${key} is absent/deleted`);
    return { row: JSON.parse(dec.decode(entry.value)) as T, revision: entry.revision };
  }
  async function identity(token: ValidatedUserToken): Promise<EpCaller> {
    await input.assertCurrent?.();
    if (token.exp <= Math.floor(Date.now() / 1000)) refuse("endpoint user bearer expired");
    if (token.space !== account.space || !token.act.lifecycleUid) refuse("endpoint authority token belongs to another account/lifecycle");
    const principal = { owner: token.owner, actor: token.act.actor, uid: token.act.lifecycleUid };
    if (!(await policy.actorIsCurrent(principal))) refuse("endpoint actor lifecycle is no longer current");
    return principal;
  }
  async function currentReservation(id: string): Promise<Reservation> {
    const { row } = await read<Reservation>(authKv, reservationKey(id));
    if (row.v !== 2 || row.instanceId !== id || row.state === "retired") refuse("endpoint reservation is retired or corrupt");
    const verdict = await assertEndpointInstanceAuthority({ account, endpoint: row.endpoint, instanceId: id, holder: row.binding.holder, clusterDigests: row.clusterDigests, expected: row.binding.authority, ceiling: row.binding.ceiling }, policy);
    if (!verdict.authorized || !(await policy.actorIsCurrent({ owner: row.binding.holder.owner, actor: row.binding.holder.actor, uid: row.binding.holder.lifecycleUid }))) refuse("endpoint serving holder is no longer current");
    return row;
  }
  function sameHolder(row: Reservation, principal: EpCaller): void {
    if (row.binding.holder.owner !== principal.owner || row.binding.holder.actor !== principal.actor || row.binding.holder.lifecycleUid !== principal.uid) refuse("endpoint lifecycle belongs to another holder");
  }
  function observe(row: Reservation): void {
    const filter = `cotal.${account.space}.ep.v1.inst.${endpointToken(row.endpoint)}.${row.instanceId}.*.>`;
    subscriptions.push(input.nc.subscribe(filter, { callback(error, message) {
      if (error) return;
      const parsed = parseEpSubject(message.subject);
      if (!parsed || parsed.plane !== "request" || parsed.rail !== "v1") return;
      try {
        const request = parseEndpointRequest(JSON.parse(dec.decode(message.data))); checkRequestSubjectAgreement(request, parsed);
        const now = Date.now();
        for (const [key, value] of observed) if (value.expires <= now) observed.delete(key);
        if (observed.size >= 4096) return;
        observed.set(message.subject, { digest: contractDigest(request), id: request.id, expires: now + 10000 });
      } catch { /* malformed requests never establish observed authority */ }
    } }));
  }
  async function sourceIsLive(source: IssuedSourceRef): Promise<boolean> {
    await input.assertCurrent?.();
    if (source.space !== account.space || source.bucket !== issuedBucket(account.space)) refuse("foreign endpoint issued source");
    const match = /^endpoint-grant\.([a-z0-9]{26,32})\.([1-9][0-9]*)$/.exec(source.key);
    if (!match || match[2] !== "1") refuse("unknown endpoint source revision");
    const { row } = await read<{ reservation: string; principal: EpCaller; expiresAt: number; policyRevision: number; commands: string[]; capabilities: EpCapability[]; currency?: unknown; control?: boolean; credentialDigest?: string }>(sourceKv, source.key);
    if (row.expiresAt <= Math.floor(Date.now() / 1000) || !(await policy.actorIsCurrent(row.principal))) return false;
    const reservation = await currentReservation(row.reservation);
    if (reservation.binding.authority.policyRevision !== row.policyRevision || reservation.state !== "active") return false;
    const active = (await read<Active>(authKv, `endpoint-active.${reservation.instanceId}`)).row;
    const gateKey = epgateKey(reservation.endpoint, reservation.instanceId), gateEntry = await authKv.get(gateKey);
    if (!gateEntry || gateEntry.operation !== "PUT") return false;
    const gate = parseEndpointGate(gateEntry.value, gateKey);
    if (gate.state !== "open" || gate.processEpoch !== active.processEpoch || gate.registrationRevision !== active.registrationRevision || canonicalJson(gate.delegated) !== canonicalJson(reservation.binding)) return false;
    const namespace = await policy.namespace(reservation.endpoint);
    if (namespace.policyRevision !== row.policyRevision || namespace.namespaceRevision !== reservation.binding.authority.namespaceRevision) return false;
    if (input.deploymentTrust && canonicalJson(row.currency) !== canonicalJson(input.deploymentTrust)) return false;
    if (row.control) {
      const active = await activeForServing(row.principal, row.reservation);
      return active.credentialDigest === row.credentialDigest;
    }
    const grant = await policy.caller(row.principal, { endpoint: reservation.endpoint, instanceId: reservation.instanceId, commands: row.commands });
    return grant.expiresAt >= row.expiresAt && canonicalJson(grant.capabilities) === canonicalJson(row.capabilities);
  }
  async function activeForServing(principal: EpCaller, instanceId: string): Promise<Active> {
    const row = await currentReservation(instanceId); sameHolder(row, principal);
    if (row.state !== "active") refuse("endpoint is not active");
    const active = (await read<Active>(authKv, `endpoint-active.${instanceId}`)).row;
    const gateEntry = await authKv.get(epgateKey(row.endpoint, row.instanceId));
    if (!gateEntry || gateEntry.operation !== "PUT") refuse("endpoint gate is absent");
    const gate = parseEndpointGate(gateEntry.value, epgateKey(row.endpoint, row.instanceId));
    if (gate.state !== "open" || gate.processEpoch !== active.processEpoch || gate.registrationRevision !== active.registrationRevision || canonicalJson(gate.delegated) !== canonicalJson(row.binding)) refuse("endpoint serving gate is stale or frozen");
    return active;
  }
  return {
    async prepare(token: ValidatedUserToken, request: { operationId: string; endpoint: string; holderPublicKey: string }): Promise<Reservation> {
      const principal = await identity(token); const operationId = assertLifecycleToken(request.operationId);
      fromPublic(request.holderPublicKey);
      const operationKey = `endpoint-prepare.${operationId}`;
      const existing = await authKv.get(operationKey);
      if (existing) {
        if (existing.operation !== "PUT") refuse("prepare operation was deleted");
        const row = JSON.parse(dec.decode(existing.value)) as Reservation;
        sameHolder(row, principal);
        if (row.endpoint !== request.endpoint || row.binding.holder.publicKey !== request.holderPublicKey) refuse("prepare operation content changed");
        return currentReservation(row.instanceId);
      }
      const namespace = await policy.namespace(request.endpoint);
      if (canonicalJson(namespace.account) !== canonicalJson(account)) refuse("namespace belongs to another account");
      const hold = await acquireEndpointPolicyHold(authKv, { endpoint: request.endpoint, policyRevision: namespace.policyRevision, operationId, content: { kind: "prepare", principal, request } });
      const instanceId = mintLifecycleUid();
      const binding = await policy.serving(principal, { endpoint: request.endpoint, instanceId, publicKey: request.holderPublicKey });
      if (binding.holder.owner !== principal.owner || binding.holder.actor !== principal.actor || binding.holder.lifecycleUid !== principal.uid || binding.holder.publicKey !== request.holderPublicKey || canonicalJson(binding.account) !== canonicalJson(account)) refuse("serving policy substituted holder or account");
      await assertEndpointInstanceAuthority({ account, endpoint: request.endpoint, instanceId, holder: binding.holder, clusterDigests: namespace.clusterDigests, expected: binding.authority, ceiling: binding.ceiling }, policy);
      const row: Reservation = { v: 2, endpoint: request.endpoint, instanceId, operationId, binding, clusterDigests: [...namespace.clusterDigests], state: "prepared" };
      await createRowByteIdempotent(authKv, reservationKey(instanceId), row);
      await createRowByteIdempotent(authKv, operationKey, row);
      await provisionEndpointGateOpen(authKv, { endpoint: row.endpoint, instanceId, principal: principalKey(principal.owner, principal.actor).key, delegated: binding });
      await hold.release();
      return row;
    },
    async challenge(token: ValidatedUserToken, request: { operationId: string; instanceId: string; content: ActivationContent }): Promise<Challenge> {
      const principal = await identity(token), row = await currentReservation(request.instanceId); sameHolder(row, principal);
      if (request.content.action !== "activate" || request.content.registrationRevision !== 0 || request.content.processEpoch !== 0) refuse("unsupported lifecycle action/currency");
      const operationId = assertLifecycleToken(request.operationId);
      const content = { kind: "activation", account, endpoint: row.endpoint, instanceId: row.instanceId, binding: row.binding, operationId, content: request.content };
      const operationDigest = contractDigest(content), key = `endpoint-challenge.${operationId}`;
      const existing = await authKv.get(key);
      if (existing) {
        const stored = JSON.parse(dec.decode(existing.value)) as Challenge;
        if (stored.operationDigest !== operationDigest || stored.expiresAt <= Math.floor(Date.now() / 1000)) refuse("challenge operation changed or expired");
        return stored;
      }
      const now = Math.floor(Date.now() / 1000);
      const challenge: Challenge = { v: 2, kind: "cotal.endpoint-holder", operationId, challengeId: mintLifecycleUid(), nonce: mintGeneration() + mintGeneration(), endpoint: row.endpoint, instanceId: row.instanceId, binding: row.binding, operationDigest, issuedAt: now, expiresAt: Math.min(now + 60, row.binding.ceiling.expiresAt) };
      await createRowByteIdempotent(authKv, key, challenge);
      return challenge;
    },
    async activate(token: ValidatedUserToken, request: { operationId: string; instanceId: string; content: ActivationContent; signature: string }): Promise<Active> {
      const principal = await identity(token), row = await currentReservation(request.instanceId); sameHolder(row, principal);
      const challenge = (await read<Challenge>(authKv, `endpoint-challenge.${assertLifecycleToken(request.operationId)}`)).row;
      const digest = contractDigest({ kind: "activation", account, endpoint: row.endpoint, instanceId: row.instanceId, binding: row.binding, operationId: request.operationId, content: request.content });
      if (challenge.instanceId !== row.instanceId || challenge.operationDigest !== digest || challenge.expiresAt <= Math.floor(Date.now() / 1000) || !fromPublic(row.binding.holder.publicKey).verify(enc.encode(canonicalJson(challenge)), Buffer.from(request.signature, "base64url"))) refuse("activation holder proof/content/currency failed");
      if (inFlight.has(row.endpoint)) refuse("another endpoint release is in flight");
      inFlight.add(row.endpoint);
      try {
        const hold = await acquireEndpointPolicyHold(authKv, { endpoint: row.endpoint, policyRevision: row.binding.authority.policyRevision, operationId: request.operationId, content: { kind: "activate", digest } });
        const prior = await authKv.get(`endpoint-active.${row.instanceId}`);
        if (prior) {
          const active = await activeForServing(principal, row.instanceId);
          if (active.operationDigest !== digest) refuse("activation operation content changed");
          await hold.release();
          return active;
        }
        const artifacts = new Map<string, unknown>(); let total = 0;
        for (const artifact of request.content.contractArtifacts) {
          if (!artifact || (typeof artifact.value !== "object" && typeof artifact.value !== "boolean") || artifact.value === null || contractDigest(artifact.value) !== artifact.digest || artifacts.has(artifact.digest)) refuse("invalid activation artifact");
          const bytes = Buffer.byteLength(canonicalJson(artifact.value)); total += bytes;
          if (bytes > 262144 || total > 1048576 || artifacts.size >= 64) refuse("activation artifact bound exceeded");
          artifacts.set(artifact.digest, artifact.value);
        }
        for (const closure of row.clusterDigests) {
          const { root } = verifyClusterManifest(closure, artifacts.get(closure));
          const doc = verifyClusterRoot(root, artifacts.get(root));
          if (doc.attributes.length || doc.events.length || doc.commands.some(c => c.class !== "ephemeral" || c.action || c.effect === undefined)) refuse("unsupported delegated surface");
        }
        for (const artifact of request.content.contractArtifacts) await input.publishArtifact(artifact);
        const authority = { authorize: () => ({ authorized: false, revision: 0 }), authorizeInstance: policy.authorizeInstance.bind(policy) };
        const delegated = { account, holder: row.binding.holder, ceiling: row.binding.ceiling };
        const registered = await registerServiceInstance(recordsKv, { space: account.space, instanceId: row.instanceId, spec: { endpoint: row.endpoint, owner: principal.owner, clusterDigests: row.clusterDigests, protocol: { v: 3 }, servingAuthority: row.binding.authority, serveRoutes: row.binding.ceiling.routes, resources: row.binding.ceiling.resources }, registrant: { owner: principal.owner }, authority, delegated, policyHold: hold, barrier: endpointRegistrationBarrier(authKv, account.space, { endpoint: row.endpoint, instanceId: row.instanceId, opId: request.operationId, policyHold: hold }), readClusterArtifact: digest => input.readArtifact(digest) });
        const grant = await authorizeServeGrant(recordsKv, { space: account.space, endpoint: row.endpoint, instanceId: row.instanceId, epoch: registered.processEpoch, holder: { owner: principal.owner }, authority, delegated, readProcessEpoch: async () => parseEndpointGate((await authKv.get(epgateKey(row.endpoint, row.instanceId)))!.value, epgateKey(row.endpoint, row.instanceId)).processEpoch, readClusterArtifact: input.readArtifact });
        const minted = await mintPublicUserJwt(input.auth, row.binding.holder.publicKey, "endpoint-serve", { principal: { owner: principal.owner, actor: principal.actor }, endpointServe: grant, serveIssuance: serveIssuanceGateKv(authKv, account.space, { endpoint: row.endpoint, instanceId: row.instanceId, policyHold: hold }), expiresInSeconds: row.binding.ceiling.expiresAt - Math.floor(Date.now() / 1000) });
        const credentialDigest = rawDigest(minted.jwt), now = Math.floor(Date.now() / 1000);
        const attested: EndpointServeAttestation = { v: 2, kind: "cotal.endpoint-serve", issuer: input.issuer, endpoint: row.endpoint, instanceId: row.instanceId, registrationRevision: registered.registrationRevision, processEpoch: registered.processEpoch, operationId: request.operationId, account, holder: row.binding.holder, authority: row.binding.authority, protocol: { v: 3 }, ceiling: row.binding.ceiling, clusterDigests: row.clusterDigests, credentialId: credentialDigest.replace("sha256:", "sha256-"), credentialDigest, issuedAt: now, expiresAt: minted.exp };
        const attestation = input.signAttestation ? await input.signAttestation(attested)
          : input.signing ? await new CompactSign(enc.encode(canonicalJson(attested))).setProtectedHeader({ alg: "EdDSA", kid: input.signing.kid }).sign(input.signing.privateKey)
          : refuse("endpoint serving attestation signer is absent");
        const active: Active = { reservation: { ...row, state: "active" }, serveJwt: minted.jwt, attestation, credentialDigest, ...registered, operationDigest: digest };
        await createRowByteIdempotent(authKv, `endpoint-active.${row.instanceId}`, active);
        const reservation = await read<Reservation>(authKv, reservationKey(row.instanceId));
        await authKv.update(reservationKey(row.instanceId), enc.encode(canonicalJson(active.reservation)), reservation.revision);
        observe(active.reservation); await input.nc.flush();
        await hold.release();
        return active;
      } finally { inFlight.delete(row.endpoint); }
    },
    async caller(token: ValidatedUserToken, request: { endpoint: string; instanceId: string; commands: string[]; publicKey: string }): Promise<{ jwt: string; caller: IssuedAuthorityRef; acceptedToken: string }> {
      const principal = await identity(token), row = await currentReservation(request.instanceId);
      if (row.endpoint !== request.endpoint || row.state !== "active") refuse("caller endpoint is not active");
      const operationId = mintLifecycleUid(), hold = await acquireEndpointPolicyHold(authKv, { endpoint: row.endpoint, policyRevision: row.binding.authority.policyRevision, operationId, content: { kind: "caller", principal, request } });
      let materialWriteStarted = false;
      try {
      const allowed = await policy.caller(principal, request);
      const expiresAt = Math.min(allowed.expiresAt, row.binding.ceiling.expiresAt);
      if (expiresAt <= Math.floor(Date.now() / 1000)) refuse("caller grant expired");
      const generation = mintGeneration(), acceptedToken = mintAcceptedToken(), ref = { ...principal, space: account.space, generation };
      const grantId = mintLifecycleUid(), source: IssuedSourceRef = { space: account.space, bucket: issuedBucket(account.space), key: `endpoint-grant.${grantId}.1` };
      materialWriteStarted = true;
      await createRowByteIdempotent(sourceKv, source.key, { reservation: row.instanceId, principal, expiresAt, policyRevision: row.binding.authority.policyRevision, commands: request.commands, capabilities: allowed.capabilities });
      const opts = { principal: { owner: principal.owner, actor: principal.actor }, lifecycleUid: principal.uid, endpointCaller: { endpoint: row.endpoint, instanceId: row.instanceId, capabilities: allowed.capabilities }, issued: { generation, acceptedToken }, expiresInSeconds: expiresAt - Math.floor(Date.now() / 1000) };
      const permissions = permissionsFor("endpoint-caller", account.space, { ...principal, lifecycleUid: principal.uid, connId: request.publicKey }, opts);
      const staged = await input.issued.stage({ version: 1, ref, sources: [source], permissions: importNativeSubjectPermissions(permissions), expiresAt });
      await input.issued.release(staged, async () => { if (!(await sourceIsLive(source))) refuse("caller policy source no longer active"); });
      await writeAcceptedRow(input.acceptedKv, acceptedToken, ref);
      const minted = await mintPublicUserJwt(input.auth, request.publicKey, "endpoint-caller", opts);
      await hold.release();
      return { jwt: minted.jwt, caller: ref, acceptedToken };
      } catch (error) {
        if (!materialWriteStarted) await hold.release();
        throw error;
      }
    },
    async authorizeCallerBearer(token: ValidatedUserToken, request: { endpoint: string; instanceId: string; commands: string[]; control?: { requestId: string; credentialDigest: string; signature: string } }) {
      const principal = await identity(token), reservation = await currentReservation(request.instanceId);
      if (reservation.endpoint !== request.endpoint || reservation.state !== "active") refuse("caller selection is not active");
      const selection = parseEndpointCallerSelection({ endpoint: request.endpoint, instanceId: request.instanceId, commands: request.commands });
      const active = (await read<Active>(authKv, `endpoint-active.${reservation.instanceId}`)).row;
      const operationId = mintLifecycleUid(), hold = await acquireEndpointPolicyHold(authKv, { endpoint: reservation.endpoint, policyRevision: reservation.binding.authority.policyRevision, operationId, content: { kind: "caller-bearer", principal, request } });
      let materialWriteStarted = false;
      try {
        let capabilities: EpCapability[], allowedExpiry: number;
        const privateClusterDigests: string[] = [];
        if (request.control) {
          if (!input.deploymentTrust) refuse("public serving control deployment is unsupported");
          const serving = await activeForServing(principal, request.instanceId);
          const controlCommands = ["describe", "ep-admit", "ep-check", "ep-release"];
          if (canonicalJson([...selection.commands].sort()) !== canonicalJson(controlCommands) || serving.credentialDigest !== request.control.credentialDigest || !fromPublic(reservation.binding.holder.publicKey).verify(endpointControlProof({ requestId: request.control.requestId, trust: input.deploymentTrust, selection, credentialDigest: serving.credentialDigest }), Buffer.from(request.control.signature, "base64url"))) refuse("serving control holder proof or commands mismatch");
          capabilities = controlCommands.map(command => ({ endpoint: "auth", command }));
          allowedExpiry = reservation.binding.ceiling.expiresAt;
        } else {
          const operations = selection.commands.filter(command => command !== "describe");
          const decision = await policy.caller(principal, { endpoint: selection.endpoint, instanceId: selection.instanceId, commands: operations });
          const allowed = [...new Set(decision.capabilities.map(cap => cap.command))].sort();
          if (canonicalJson(allowed) !== canonicalJson([...operations].sort()) || decision.capabilities.some(cap => cap.endpoint !== reservation.endpoint || cap.target !== undefined || cap.journal || (cap.instanceId !== undefined && cap.instanceId !== reservation.instanceId) || (cap.routes?.length ?? 0) > 0)) refuse("caller policy must authorize the exact untargeted selection without widening or partial attenuation");
          const visible = new Map<string, { class: string; targeted: boolean }>();
          for (const closure of reservation.clusterDigests) {
            const { root } = verifyClusterManifest(closure, await input.readArtifact(closure));
            const document = verifyClusterRoot(root, await input.readArtifact(root));
            for (const command of document.commands) {
              if (visible.has(command.name)) refuse("registered endpoint commands are ambiguous");
              visible.set(command.name, command);
            }
            if (document.commands.some(command => operations.includes(command.name))) privateClusterDigests.push(closure);
          }
          if (operations.some(command => visible.get(command)?.class !== "ephemeral" || visible.get(command)?.targeted !== false)) refuse("caller selection is not an untargeted ephemeral command");
          capabilities = [...decision.capabilities];
          allowedExpiry = decision.expiresAt;
        }
        const expiresAt = Math.min(token.exp, allowedExpiry, reservation.binding.ceiling.expiresAt, input.deploymentTrust?.assignmentExpiresAt ?? Infinity, Math.floor(Date.now() / 1000) + 120), grantId = mintLifecycleUid();
        if (expiresAt <= Math.floor(Date.now() / 1000)) refuse("endpoint caller authorization expired");
        await identity(token);
        materialWriteStarted = true;
        await createRowByteIdempotent(sourceKv, `endpoint-grant.${grantId}.1`, { reservation: reservation.instanceId, principal, commands: selection.commands.filter(command => command !== "describe"), capabilities, expiresAt, policyRevision: reservation.binding.authority.policyRevision, ...(input.deploymentTrust ? { currency: input.deploymentTrust } : {}), ...(request.control ? { control: true, credentialDigest: request.control.credentialDigest } : {}) });
        await identity(token);
        if (expiresAt <= Math.floor(Date.now() / 1000)) refuse("endpoint caller authorization expired at final release");
        await hold.release();
        return { grantId, grantRevision: 1, policyRevision: reservation.binding.authority.policyRevision, expiresAt, principal, selection, servingAuthority: reservation.binding.authority, registrationRevision: active.registrationRevision, processEpoch: active.processEpoch, clusterDigests: reservation.clusterDigests, privateClusterDigests };
      } catch (error) {
        if (!materialWriteStarted) await hold.release();
        throw error;
      }
    },
    async issueCallerConnection(token: ValidatedUserToken, connId: string): Promise<Record<string, unknown>> {
      const principal = await identity(token), claim = token.act.endpointGrant;
      if (token.act.view !== "endpoint-caller" || !claim || claim.grantRevision !== 1) refuse("unsupported endpoint caller bearer");
      const source: IssuedSourceRef = { space: account.space, bucket: issuedBucket(account.space), key: `endpoint-grant.${claim.grantId}.${claim.grantRevision}` };
      const saved = (await read<{ reservation: string; principal: EpCaller; commands: string[]; capabilities: EpCapability[]; expiresAt: number; policyRevision: number; control?: boolean }>(sourceKv, source.key)).row;
      if (canonicalJson(saved.principal) !== canonicalJson(principal) || saved.policyRevision !== claim.policyRevision || !(await sourceIsLive(source))) refuse("endpoint caller grant no longer current");
      const reservation = await currentReservation(saved.reservation), operationId = mintLifecycleUid();
      const hold = await acquireEndpointPolicyHold(authKv, { endpoint: reservation.endpoint, policyRevision: saved.policyRevision, operationId, content: { kind: "caller-connect", principal, connId, claim } });
      let materialWriteStarted = false;
      try {
      const acceptedToken = connectionAcceptedToken(connId);
      const old = await input.acceptedKv.get(acceptedToken);
      const generation = old ? (JSON.parse(dec.decode(old.value)) as { ref: IssuedAuthorityRef }).ref.generation : mintGeneration();
      const ref = { ...principal, space: account.space, generation };
      const target = saved.control && input.deploymentTrust ? { endpoint: "auth", instanceId: input.deploymentTrust.authority.instanceId } : { endpoint: reservation.endpoint, instanceId: reservation.instanceId };
      const perms = permissionsFor("endpoint-caller", account.space, { ...principal, lifecycleUid: principal.uid, connId }, { endpointCaller: { ...target, capabilities: saved.capabilities.length ? saved.capabilities : [{ endpoint: target.endpoint, command: "describe" }] }, issued: { generation, acceptedToken } });
      if (old) {
        const recorded = JSON.parse(dec.decode(old.value)) as { ref: IssuedAuthorityRef };
        if (canonicalJson(recorded.ref) !== canonicalJson(ref)) refuse("accepted endpoint caller identity changed");
        await input.issued.resolve(ref, sourceIsLive);
        await input.issued.confirm(ref, importNativeSubjectPermissions(perms));
      } else {
        materialWriteStarted = true;
        const staged = await input.issued.stage({ version: 1, ref, sources: [source], permissions: importNativeSubjectPermissions(perms), expiresAt: Math.min(saved.expiresAt, token.exp) });
        await input.issued.release(staged, async () => { if (!(await sourceIsLive(source))) refuse("endpoint caller source changed at release"); });
        await writeAcceptedRow(input.acceptedKv, acceptedToken, ref);
      }
      await identity(token);
      if (!(await sourceIsLive(source))) refuse("endpoint source changed at final connection release");
      await hold.release();
      return perms;
      } catch (error) {
        if (!materialWriteStarted) await hold.release();
        throw error;
      }
    },
    commandDefs(): EpCommandDef[] {
      const contract = { input: compileContract({ root: ENDPOINT_AUTHORITY_INPUT_SCHEMA }), output: compileContract({ root: ENDPOINT_AUTHORITY_OUTPUT_SCHEMA }) };
      return ["ep-check", "ep-admit", "ep-release"].map(command => ({ command, contract, handler: async ctx => {
        const body = object(ctx.request.args, command === "ep-check" ? ["v", "endpoint", "instanceId", "credentialDigest", "nonce", "signature"] : command === "ep-admit" ? ["v", "operation", "operationId", "serving", "requestSubject", "request"] : ["v", "operation", "operationId", "admissionId", "serving", "outcome"]);
        if (body.v !== 2) refuse("unsupported endpoint authority version");
        const principal = ctx.subject.caller;
        if (ctx.subject.rail !== "v1" || !("generation" in principal)) refuse("endpoint authority requires an issued serving control connection");
        if (command === "ep-check") {
          const instanceId = String(body.instanceId), active = await activeForServing(principal, instanceId);
          const proof = { kind: "cotal.endpoint-adopt", nonce: body.nonce, credentialDigest: active.credentialDigest, binding: active.reservation.binding, endpoint: active.reservation.endpoint, instanceId, processEpoch: active.processEpoch, registrationRevision: active.registrationRevision };
          if (body.endpoint !== active.reservation.endpoint || body.credentialDigest !== active.credentialDigest || !fromPublic(active.reservation.binding.holder.publicKey).verify(enc.encode(canonicalJson(proof)), Buffer.from(String(body.signature), "base64url"))) refuse("endpoint adoption proof failed");
          return { current: true, credentialDigest: active.credentialDigest };
        }
        if (body.operation !== (command === "ep-admit" ? "admit" : "release")) refuse("authority operation disagrees with native command");
        const serving = object(body.serving, ["account", "endpoint", "instanceId", "epoch", "authority"]);
        if (canonicalJson(serving.account) !== canonicalJson(account)) refuse("serving admission account mismatch");
        const instanceId = String(serving.instanceId), operationId = assertLifecycleToken(String(body.operationId));
        if (command === "ep-release") {
          const key = `endpoint-drain.${assertLifecycleToken(String(body.admissionId))}`, saved = await read<Drain>(authKv, key), row = saved.row;
          if (row.instanceId !== instanceId || row.operationId !== operationId || row.holder.owner !== principal.owner || row.holder.actor !== principal.actor || row.holder.uid !== principal.uid || row.holder.generation !== principal.generation || !["executed", "not-executed", "unknown"].includes(String(body.outcome))) refuse("terminal release holder/outcome mismatch");
          if (row.state !== "held" && row.outcome !== body.outcome) refuse("conflicting terminal outcome needs authenticated reconciliation");
          if (row.state === "held") await authKv.update(key, enc.encode(canonicalJson({ ...row, state: body.outcome === "unknown" ? "uncertain" : "terminal", outcome: body.outcome })), saved.revision);
          return { v: 2, operation: "release", released: true, admissionId: row.admissionId, outcome: body.outcome };
        }
        const active = await activeForServing(principal, instanceId), reservation = active.reservation;
        if (serving.endpoint !== reservation.endpoint || serving.epoch !== active.processEpoch || canonicalJson(serving.authority) !== canonicalJson(reservation.binding.authority)) refuse("admission serving currency changed");
        const hold = await acquireEndpointPolicyHold(authKv, { endpoint: reservation.endpoint, policyRevision: reservation.binding.authority.policyRevision, operationId, content: { kind: "admit", holder: principal, body } });
        let drainWriteStarted = false;
        try {
        const requestPin = object(body.request, ["id", "envelopeDigest"]);
        const subject = String(body.requestSubject), parsed = parseEpSubject(subject);
        if (!parsed || parsed.plane !== "request" || parsed.rail !== "v1" || parsed.route !== "inst" || parsed.instanceId !== instanceId || parsed.endpoint !== reservation.endpoint || !("generation" in parsed.caller)) refuse("admission requires exact issued application subject");
        await input.nc.flush();
        const witnessed = observed.get(subject); observed.delete(subject);
        if (!witnessed || witnessed.expires <= Date.now() || witnessed.id !== requestPin.id || witnessed.digest !== requestPin.envelopeDigest) refuse("application request was not independently broker-observed");
        const caller: IssuedAuthorityRef = { space: account.space, ...parsed.caller } as IssuedAuthorityRef;
        const current = await input.issued.resolve(caller, sourceIsLive);
        if (!issuedPermitsSubject(current.evidence.permissions.publish, subject)) refuse("issued caller ceiling does not admit this exact request");
        const commands: string[] = [];
        for (const digest of reservation.clusterDigests) {
          const { root } = verifyClusterManifest(digest, await input.readArtifact(digest));
          const document = verifyClusterRoot(root, await input.readArtifact(root));
          for (const command of document.commands) {
            if (command.targeted) continue;
            const candidate = epRequestSubject(account.space, { route: { mode: "inst", instanceId }, endpoint: reservation.endpoint, command: command.name, caller, nonce: "a".repeat(32) });
            if (issuedPermitsSubject(current.evidence.permissions.publish, candidate)) commands.push(command.name);
          }
        }
        const admissionId = mintLifecycleUid(), row: Drain = { v: 2, operationId, admissionId, instanceId, holder: { owner: principal.owner, actor: principal.actor, uid: principal.uid, generation: String(principal.generation) }, caller, requestSubjectDigest: rawDigest(subject), envelopeDigest: String(requestPin.envelopeDigest), state: "held" };
        drainWriteStarted = true;
        await createRowByteIdempotent(authKv, `endpoint-drain.${admissionId}`, row);
        await hold.release();
        return { v: 2, operation: "admit", operationId, admissionId, serving, caller, commands, requestSubjectDigest: row.requestSubjectDigest, envelopeDigest: row.envelopeDigest };
        } catch (error) {
          // A validation-only refusal created no admission/material. An uncertain drain write
          // retains the gate for reconciliation rather than guessing no admission exists.
          if (!drainWriteStarted) await hold.release();
          throw error;
        }
      } }));
    },
    async close() { for (const subscription of subscriptions) await subscription.drain(); },
    sourceIsLive,
  };
}
