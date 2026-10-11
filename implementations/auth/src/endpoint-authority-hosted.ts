import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { fromSeed } from "@nats-io/nkeys";
import {
  epAuthBucket, recordsBucket, issuedBucket, acceptedBucket, epcStreamName, spacePrefix, token, epRequestObserveFilter,
  openIssuedStore, contractStoreContext, publishContractArtifact, contractArtifactCanonicalBytes,
  fetchContractArtifact, contractRefToHex, canonicalJson, rawDigest, assertLifecycleToken,
  parseEndpointDeploymentAssignment, parseEndpointDeploymentTrust, parseEndpointNativeAuthorityPin,
  parseEndpointAccountPin, parseEndpointCallerSelection, parseEndpointGate, epgateKey,
  type EndpointAuthorityDeployment, type EndpointDeploymentTrust, type EndpointCallerAuthorityReceipt,
  type EpCommandDef,
} from "@cotal-ai/core";
import { openAuthorityClient } from "./authority-client.js";
import { createEndpointAuthority, type EndpointAuthorityPolicy } from "./endpoint-authority.js";
import type { UserTokenIssuer } from "./issuer.js";
import type { ValidatedUserToken } from "./token.js";

export interface HostedEndpointAuthority {
  authority: ReturnType<typeof createEndpointAuthority>;
  trust(): Promise<Readonly<EndpointDeploymentTrust>>;
  service(token: ValidatedUserToken, request: Record<string, unknown>): Promise<unknown>;
  caller(token: ValidatedUserToken, request: Record<string, unknown>, credentialId: string): Promise<{ v: 2; token: string; receipt: string }>;
  issueCallerConnection(token: ValidatedUserToken, connId: string): Promise<Record<string, unknown>>;
  commandDefs(): EpCommandDef[];
  close(): Promise<void>;
}
function closed(request: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(request).length !== fields.length || fields.some(key => !Object.hasOwn(request, key)) || Object.keys(request).some(key => !fields.includes(key))) throw new Error("closed endpoint authority intention required");
}
/** Trusted auth-service composition. Broker writer/observer handles and signing remain here. */
export async function openHostedEndpointAuthority(args: {
  server: string; space: string; dataAccount: { pub: string; signingSeed: string };
  deployment: EndpointAuthorityDeployment; issuer: UserTokenIssuer; policy: EndpointAuthorityPolicy;
  authInstanceId: string; authEpoch: number;
  onConnection?: import("./authority-client.js").AuthorityClientOpts["onConnection"];
  log(line: string): void;
}): Promise<HostedEndpointAuthority> {
  const { space } = args, assignment = parseEndpointDeploymentAssignment(args.deployment.assignment);
  if (assignment.account.space !== space || assignment.account.accountPublicKey !== args.dataAccount.pub || typeof args.deployment.withCurrentAssignment !== "function") throw new Error("endpoint deployment does not match authenticated host account");
  const trust = parseEndpointDeploymentTrust({ account: assignment.account, assignmentLifecycleUid: assignment.lifecycleUid, assignmentExpiresAt: assignment.expiresAt, issuer: args.issuer.issuer, keys: args.issuer.jwks().keys, accountSigningKey: fromSeed(new TextEncoder().encode(args.dataAccount.signingSeed)).getPublicKey(), authority: { endpoint: "auth", instanceId: args.authInstanceId, epoch: args.authEpoch } });
  const buckets = [epAuthBucket(space), recordsBucket(space), issuedBucket(space), acceptedBucket(space)];
  const host = await openAuthorityClient({ server: args.server, space, dataAccount: args.dataAccount, label: `cotal:endpoint-authority:${space}`, onConnection: args.onConnection, log: args.log,
    grants: id => ({ publish: ["$JS.API.INFO", ...buckets.flatMap(bucket => [`$KV.${bucket}.>`, `$JS.API.STREAM.INFO.KV_${bucket}`, `$JS.API.STREAM.MSG.GET.KV_${bucket}`, `$JS.API.CONSUMER.CREATE.KV_${bucket}.>`, `$JS.API.CONSUMER.INFO.KV_${bucket}.>`, `$JS.API.CONSUMER.DELETE.KV_${bucket}.>`, `$JS.API.DIRECT.GET.KV_${bucket}.>`]), `${spacePrefix(space)}.epc.*`, `$JS.API.DIRECT.GET.${epcStreamName(space)}.${spacePrefix(space)}.epc.>`, "$JS.FC.>"], subscribe: [`_INBOX_${id}.>`, epRequestObserveFilter(token(space), { kind: "issued-instances" })] }) });
  try {
    const kvm = new Kvm(host.nc), authKv = await kvm.open(epAuthBucket(space)), recordsKv = await kvm.open(recordsBucket(space)), sourceKv = await kvm.open(issuedBucket(space)), acceptedKv = await kvm.open(acceptedBucket(space));
    const jsm = await jetstreamManager(host.nc), issued = openIssuedStore(sourceKv, jsm, space), store = await contractStoreContext(host.nc, space);
    async function assertCurrent() {
      parseEndpointDeploymentAssignment(assignment);
      if (canonicalJson(args.issuer.jwks().keys) !== canonicalJson(trust.keys)) throw new Error("endpoint issuer keys changed; authenticated deployment projection must be replaced");
      const key = epgateKey("auth", args.authInstanceId), entry = await authKv.get(key);
      if (!entry || entry.operation !== "PUT") throw new Error("native auth instance gate is absent");
      const gate = parseEndpointGate(entry.value, key);
      if (gate.state !== "open" || gate.processEpoch !== args.authEpoch) throw new Error("native auth instance currency changed");
      parseEndpointDeploymentAssignment(assignment); // Clock can expire while the broker read awaits.
    }
    async function current<T>(operation: () => Promise<T>, beforeReturn?: (value: T) => void): Promise<T> {
      return args.deployment.withCurrentAssignment(assignment, async () => {
        await assertCurrent();
        const value = await operation();
        await assertCurrent();
        beforeReturn?.(value);
        return value;
      });
    }
    const authority = createEndpointAuthority({ account: assignment.account, auth: { space, account: args.dataAccount } as import("@cotal-ai/core").SpaceAuth, authKv, recordsKv, sourceKv, acceptedKv, issued, nc: host.nc, issuer: args.issuer.issuer, signAttestation: payload => args.issuer.signEndpointServingAttestation(payload), policy: args.policy, deploymentTrust: trust, assertCurrent,
      publishArtifact: async artifact => { await publishContractArtifact(store, contractArtifactCanonicalBytes(artifact.value)); },
      readArtifact: async digest => { const bytes = await fetchContractArtifact(store, contractRefToHex(digest)); return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; } });
    function pins(request: Record<string, unknown>) {
      if (request.v !== 2 || canonicalJson(parseEndpointAccountPin(request.account)) !== canonicalJson(trust.account) || request.assignmentLifecycleUid !== trust.assignmentLifecycleUid || canonicalJson(parseEndpointNativeAuthorityPin(request.authority)) !== canonicalJson(trust.authority)) throw new Error("endpoint request account/assignment/native authority pins changed");
    }
    async function caller(token: ValidatedUserToken, request: Record<string, unknown>, credentialId: string, control = false): Promise<{ v: 2; token: string; receipt: string }> {
      let releasedExpiry = 0;
      return current(async () => {
        pins(request);
        const fields = ["v", "requestId", "account", "assignmentLifecycleUid", "authority", "endpoint", "instanceId", "commands"];
        closed(request, control ? [...fields, "operation", "credentialDigest", "signature"] : fields);
        const requestId = assertLifecycleToken(String(request.requestId)), selection = parseEndpointCallerSelection({ endpoint: request.endpoint, instanceId: request.instanceId, commands: request.commands });
        const grant = await authority.authorizeCallerBearer(token, { endpoint: selection.endpoint, instanceId: selection.instanceId, commands: [...selection.commands], ...(control ? { control: { requestId, credentialDigest: String(request.credentialDigest), signature: String(request.signature) } } : {}) });
        const issuedAt = Math.floor(Date.now() / 1000), expiresAt = Math.min(grant.expiresAt, token.exp, assignment.expiresAt, issuedAt + 120);
        if (expiresAt <= issuedAt) throw new Error("endpoint caller expired before bearer signing");
        const bearer = await args.issuer.issue({ owner: token.owner, actor: token.act.actor, space, lifecycleUid: token.act.lifecycleUid, credentialId, scope: token.act.scope ?? [], view: "endpoint-caller", endpointGrant: { grantId: grant.grantId, grantRevision: grant.grantRevision, policyRevision: grant.policyRevision }, ttlSec: expiresAt - issuedAt });
        const common = { iss: trust.issuer, aud: space, iat: issuedAt, exp: expiresAt, jti: requestId, v: 3 as const, account: trust.account, assignmentLifecycleUid: trust.assignmentLifecycleUid, authority: trust.authority, principal: grant.principal, selection: grant.selection, servingAuthority: grant.servingAuthority, registrationRevision: grant.registrationRevision, processEpoch: grant.processEpoch, clusterDigests: grant.clusterDigests, bearerDigest: rawDigest(bearer) };
        const receipt: EndpointCallerAuthorityReceipt = control
          ? { ...common, kind: "cotal.endpoint-control" }
          : { ...common, kind: "cotal.endpoint-caller", privateClusterDigests: grant.privateClusterDigests };
        const signed = await args.issuer.signEndpointCallerReceipt(receipt);
        releasedExpiry = expiresAt;
        await assertCurrent();
        if (token.exp <= Math.floor(Date.now() / 1000) || expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("endpoint caller expired at final HTTP release");
        return { v: 2, token: bearer, receipt: signed };
      }, () => {
        if (token.exp <= Math.floor(Date.now() / 1000) || releasedExpiry <= Math.floor(Date.now() / 1000)) throw new Error("endpoint caller expired after final authority await");
      });
    }
    return {
      authority,
      trust: () => current(async () => trust),
      async service(token, request) {
        if (request.operation === "control") {
          if (typeof request.credentialId !== "string") throw new Error("host credential binding is absent");
          const { credentialId, ...body } = request;
          return caller(token, body, credentialId, true);
        }
        return current(async () => {
          pins(request);
          const base = ["v", "operation", "account", "assignmentLifecycleUid", "authority"];
          if (request.operation === "prepare") { closed(request, [...base, "operationId", "endpoint", "holderPublicKey"]); return authority.prepare(token, request as unknown as Parameters<typeof authority.prepare>[1]); }
          if (request.operation === "challenge") { closed(request, [...base, "operationId", "instanceId", "content"]); return authority.challenge(token, request as unknown as Parameters<typeof authority.challenge>[1]); }
          if (request.operation === "activate") { closed(request, [...base, "operationId", "instanceId", "content", "signature"]); return authority.activate(token, request as unknown as Parameters<typeof authority.activate>[1]); }
          throw new Error("unsupported endpoint lifecycle operation");
        });
      },
      caller: (token, request, credentialId) => caller(token, request, credentialId),
      issueCallerConnection: (token, connId) => current(() => authority.issueCallerConnection(token, connId)),
      commandDefs: () => authority.commandDefs().map(def => ({ ...def, handler: ctx => current(() => Promise.resolve(def.handler(ctx))) })),
      async close() { await authority.close(); await host.close(); },
    };
  } catch (error) { await host.close(); throw error; }
}
