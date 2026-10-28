/**
 * Client of the `/service-endpoint-host` route: one typed host request, without its granter, sent
 * with this machine's fresh login proof. The local arm posts to the running auth service's loopback
 * face with the operator exchange capability, so operator actions (a name binding) are reachable
 * there; the remote arm posts to the pinned public exchange, where only an owner's operations are
 * served. Redirects are refused: a 302 could walk the proof onto a host the registry never pinned.
 * The parsed answer comes back verbatim; the caller binds it to its own request.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, mkSecretDir, writeSecretFileCreateOnly, type EpCapability, type ServicePrincipal } from "@cotal-ai/core";
import { CommandFailure, findMesh, homeCotalDir, probeLiveness } from "@cotal-ai/workspace";
import { parseServiceHostResult, type ServiceCallerGrant, type ServiceHostInputs, type ServiceHostOperation, type ServiceHostResult } from "./service-host-contract.js";
import { SERVICE_ENDPOINT_HOST_PATH } from "./service-endpoint-authority.js";
import { fetchIdpJwt, requireIdpSession } from "./login.js";
import { loadAuthServiceInfo, loadPinnedIdp } from "./store.js";

/** A host request as the route takes it: the granter is the route's to derive. */
export type ServiceHostRouteRequest<K extends ServiceHostOperation = ServiceHostOperation> = { [O in K]: {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: O; input: ServiceHostInputs[O];
} }[K];

export const SERVICE_ENDPOINT_USAGE = "service-endpoint <approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint> --owner <u_…> --claim <ref> | callers <proposalId> | grant <proposalId> --to <owner.actor> --lifecycle <uid> --commands <a,b> | revoke <grantId> --to <owner.actor> --lifecycle <uid>>";

export type ServiceEndpointValues = { owner?: string; claim?: string; "caller-ceiling"?: string; "request-id"?: string;
  to?: string; lifecycle?: string; commands?: string; cursor?: string };

/** One `cotal service-endpoint` run: the subcommand, its subject, the id an effectful request went
 *  under, the host's answer, and why nothing was sent when the answer is a read that made the
 *  request unnecessary. */
export interface ServiceEndpointCall { request: string; subject: string; requestId?: string; answer: ServiceHostResult; note?: string }

/** An effectful host request as this root sent it, kept so a later run can send the same bytes
 *  under the same id. The host replays an identical request and answers `conflict` to a different
 *  one under a known id, and a decision rebuilt from a fresh proposal read is a different one once
 *  the first attempt moved the proposal. */
type RecordedHostRequest = ServiceHostRouteRequest<"decide" | "name-bind">;

const RECORDED_REQUESTS_DIR = "service-endpoint-requests";

/** Record `request` under the state dir before it is first sent. Create-only: an id is minted once. */
function recordHostRequest(dir: string, request: RecordedHostRequest): void {
  const requests = join(dir, RECORDED_REQUESTS_DIR);
  mkSecretDir(requests);
  writeSecretFileCreateOnly(join(requests, `${request.requestId}.json`), JSON.stringify({ ver: 1, request }));
}

/** The request this root recorded under `requestId`, or `undefined` when it never sent one. A file
 *  that is not a recorded request is refused, not read around. */
function recordedHostRequest(dir: string, requestId: string): RecordedHostRequest | undefined {
  const path = join(dir, RECORDED_REQUESTS_DIR, `${requestId}.json`);
  if (!existsSync(path)) return undefined;
  const malformed = () => new Error(`${path}: not a recorded service endpoint request; remove it to mint a new request instead`);
  let f: { ver?: unknown; request?: unknown };
  try { f = JSON.parse(readFileSync(path, "utf8")) as { ver?: unknown; request?: unknown }; } catch { throw malformed(); }
  const r = f?.request as Partial<RecordedHostRequest> | undefined;
  if (f?.ver !== 1 || typeof r !== "object" || r === null || r.v !== 1 || r.kind !== "service-endpoint-host" || r.requestId !== requestId
    || (r.operation !== "decide" && r.operation !== "name-bind") || typeof r.input !== "object" || r.input === null) throw malformed();
  return r as RecordedHostRequest;
}

/** The proposal fields a caller ceiling is built from. A closed proposal's tombstone has no commands. */
type ProposalCommands = { endpoint?: string; instanceId?: string; commands?: readonly { name: string; capability: string; targeted: boolean }[] };

/** `--caller-ceiling` names capabilities. Each becomes one ceiling entry per proposed command that
 *  declares it, pinned to the proposed instance, as the host admits them. A name no proposed command
 *  declares, or one a targeted command declares, is refused before anything is sent: a target mode
 *  is not derivable from a capability name. */
function callerCeilingFor(flag: string | undefined, proposal: ProposalCommands, proposalId: string): EpCapability[] {
  const names = [...new Set((flag ?? "").split(",").map((c) => c.trim()).filter(Boolean))];
  const commands = proposal.commands ?? [];
  const unknown = names.filter((name) => !commands.some((c) => c.capability === name));
  if (unknown.length) {
    const declared = [...new Set(commands.map((c) => c.capability))];
    throw new CommandFailure("refused", "USAGE_INVALID", `no command of proposal ${proposalId} declares ${unknown.join(", ")}; ${declared.length ? `its commands declare ${declared.join(", ")}` : "it declares no commands"}, and nothing was decided`);
  }
  const picked = commands.filter((c) => names.includes(c.capability));
  const targeted = picked.filter((c) => c.targeted).map((c) => c.name);
  if (targeted.length)
    throw new CommandFailure("refused", "UNSUPPORTED", `--caller-ceiling covers untargeted commands only, and ${targeted.join(", ")} of proposal ${proposalId} ${targeted.length === 1 ? "is" : "are"} targeted; nothing was decided`);
  return picked.map((c) => ({ endpoint: proposal.endpoint!, command: c.name, instanceId: proposal.instanceId!, instanceOnly: true }));
}

const describeRecorded = (r: RecordedHostRequest): string =>
  r.operation === "decide" ? `${r.input.decision} ${r.input.proposalId}` : `name-bind ${r.input.endpoint}`;

/** One host request for `cotal service-endpoint`, as the signed-in owner or, for `name-bind`, as
 *  the operator on the loopback face. A decision reads the proposal first, with the name binding
 *  that read carries, and decides at those revisions, so a proposal or name that moved in between
 *  is a conflict the host reports, never a decision on something else. A decision or a binding is
 *  recorded under its id before it is sent, and `--request-id` sends that recorded request again
 *  verbatim, never one rebuilt from a fresh read, so the host replays its answer; an id this root
 *  never recorded, or one recorded for another command, is refused with nothing sent. */
export async function serviceEndpointHostCall(dir: string, space: string, positionals: readonly string[], values: ServiceEndpointValues): Promise<ServiceEndpointCall> {
  const [sub, subject, ...extra] = positionals;
  const usage = () => new CommandFailure("refused", "USAGE_INVALID", SERVICE_ENDPOINT_USAGE);
  if (!sub || !subject || extra.length) throw usage();
  const fresh = <K extends ServiceHostOperation>(operation: K, input: ServiceHostInputs[K]): ServiceHostRouteRequest<K> =>
    ({ v: 1, kind: "service-endpoint-host", requestId: randomBytes(16).toString("hex"), operation, input });
  // The host is resolved before a request is recorded, so a space with no host records nothing.
  let resolved: ServiceHostTarget | undefined;
  const host = () => resolved ??= serviceHostEndpoint(dir, space, `service-endpoint ${sub}`);
  const post = (r: ServiceHostRouteRequest) => postServiceEndpointHost(host(), r);
  const read = async (operation: "proposal-read" | "operation-read" | "name-read" | "caller-policy-list", input: ServiceHostInputs[typeof operation]): Promise<ServiceEndpointCall> =>
    ({ request: sub, subject, answer: await post(fresh(operation, input) as ServiceHostRouteRequest) });
  // A lost answer leaves the request recorded, so the failure names the id a resend goes under.
  const send = async (request: RecordedHostRequest): Promise<ServiceEndpointCall> => {
    const target = host();
    let answer: ServiceHostResult;
    try { answer = await postServiceEndpointHost(target, request); }
    catch (e) { throw new Error(`${e instanceof Error ? e.message : String(e)}; the request is recorded as ${request.requestId}: send it again with \`cotal service-endpoint ${sub} ${subject} --request-id ${request.requestId}\``); }
    return { request: sub, subject, requestId: request.requestId, answer };
  };
  const replayId = values["request-id"];
  if (replayId !== undefined) {
    if (!/^[0-9a-f]{32}$/.test(replayId)) throw new CommandFailure("refused", "USAGE_INVALID", "--request-id is the 32 lowercase hex characters an earlier run printed");
    if (sub !== "approve" && sub !== "refuse" && sub !== "name-bind") throw new CommandFailure("refused", "USAGE_INVALID", "--request-id sends an approve, refuse or name-bind again; a read is always a new request");
    if (values["caller-ceiling"] !== undefined || values.owner !== undefined || values.claim !== undefined)
      throw new CommandFailure("refused", "USAGE_INVALID", "--request-id sends the recorded request as it was; it takes no --caller-ceiling, --owner or --claim");
    const recorded = recordedHostRequest(dir, replayId);
    if (recorded === undefined)
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no request ${replayId} was sent from this root for space "${space}"; --request-id sends again only a request a run here recorded, and nothing was sent`);
    if (describeRecorded(recorded) !== `${sub} ${subject}`)
      throw new CommandFailure("refused", "USAGE_INVALID", `request ${replayId} was "${describeRecorded(recorded)}", not "${sub} ${subject}"; nothing was sent`);
    return send(recorded);
  }
  switch (sub) {
    case "approve": case "refuse": {
      const proposal = await post(fresh("proposal-read", { proposalId: subject })) as ServiceHostResult & { record?: { value: ProposalCommands & { nameBinding: { revision: number } | null }; revision: number } };
      if (proposal.state !== "present" || proposal.record === undefined)
        throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no proposal ${subject} is yours to decide on space "${space}"; nothing was decided`);
      const callerCeiling = callerCeilingFor(values["caller-ceiling"], proposal.record.value, subject);
      const request = fresh("decide", {
        proposalId: subject, expectedProposalRevision: proposal.record.revision,
        expectedNameRevision: proposal.record.value.nameBinding?.revision ?? 0,
        decision: sub, callerCeiling,
      });
      recordHostRequest(dir, request);
      return send(request);
    }
    case "proposal": return read("proposal-read", { proposalId: subject });
    case "operation": return read("operation-read", { operationId: subject });
    case "name": return read("name-read", { endpoint: subject });
    case "name-bind": {
      if (!values.owner || !values.claim) throw usage();
      const request = fresh("name-bind", { endpoint: subject, owner: values.owner, expectedRevision: 0, claimReference: values.claim });
      host();
      recordHostRequest(dir, request);
      return send(request);
    }
    case "callers": {
      const { endpoint, instanceId } = await proposed(subject);
      return read("caller-policy-list", { owner: null, cursor: values.cursor ?? null, limit: 50, service: { endpoint, instanceId } });
    }
    case "grant": {
      const commands = [...new Set((values.commands ?? "").split(",").map((c) => c.trim()).filter(Boolean))];
      if (!commands.length) throw new CommandFailure("refused", "USAGE_INVALID", "grant needs --commands <a,b>: the commands the grantee may invoke; nothing was sent");
      const grantee = granteeOf();
      const proposal = await proposed(subject);
      if (proposal.state !== "approved" || proposal.approvalDigest === null)
        throw new CommandFailure("refused", "CONFLICT", `proposal ${subject} is ${proposal.state}; a caller is granted on an approved registration, and nothing was sent`);
      const service = { endpoint: proposal.endpoint, instanceId: proposal.instanceId, approvalDigest: proposal.approvalDigest };
      const capabilities: EpCapability[] = commands.map((command) => ({ endpoint: service.endpoint, command, instanceId: service.instanceId, instanceOnly: true }));
      const policy = await post(fresh("caller-policy-read", { grantee, service: { endpoint: service.endpoint, instanceId: service.instanceId } }));
      const record = policy.state === "present" && policy.operation === "caller-policy-read" ? policy.record : undefined;
      // A grant already covering these commands at this approval is the answer: a second run of the
      // same grant, or a retry whose first send landed, adds nothing.
      const held = record?.value.grants.find((g: ServiceCallerGrant) => g.status.state === "active" && g.endpoint === service.endpoint
        && g.instanceId === service.instanceId && g.serviceApprovalDigest === service.approvalDigest
        && commands.every((command) => g.capabilities.some((c) => c.command === command && c.target === undefined)));
      if (held) return { request: sub, subject, answer: policy, note: `${grantee.owner}.${grantee.actor} already holds grant ${held.grantId} for these commands; nothing was sent` };
      return derived(fresh("caller-grant", { grantee, service, capabilities, expectedPolicyRevision: record?.revision ?? 0 }));
    }
    case "revoke": {
      const grantee = granteeOf();
      const policy = await post(fresh("caller-policy-read", { grantee, service: null }));
      const record = policy.state === "present" && policy.operation === "caller-policy-read" ? policy.record : undefined;
      if (!record?.value.grants.some((g: ServiceCallerGrant) => g.grantId === subject))
        throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${grantee.owner}.${grantee.actor} holds no grant ${subject} you can read on space "${space}"; nothing was sent`);
      return derived(fresh("caller-revoke", { grantee, grantId: subject, expectedPolicyRevision: record.revision }));
    }
    default: throw usage();
  }

  /** The proposal a caller request names: its endpoint, instance and, once approved, the approval
   *  digest. A decided proposal reads back as its tombstone, which still names all three. */
  async function proposed(proposalId: string): Promise<{ endpoint: string; instanceId: string; state: string; approvalDigest: string | null }> {
    const r = await post(fresh("proposal-read", { proposalId }));
    if (r.state !== "present" || r.operation !== "proposal-read")
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no proposal ${proposalId} is yours on space "${space}"; nothing was sent`);
    const v = r.record.value;
    return { endpoint: v.endpoint, instanceId: v.instanceId, state: v.state, approvalDigest: "approvalDigest" in v ? v.approvalDigest : null };
  }

  function granteeOf(): ServicePrincipal {
    const to = values.to ?? "", dot = to.indexOf("."), lifecycleUid = values.lifecycle;
    if (dot <= 0 || dot === to.length - 1 || !lifecycleUid)
      throw new CommandFailure("refused", "USAGE_INVALID", `${sub} needs --to <owner.actor> and --lifecycle <uid>: a caller grant names one exact lifecycle; nothing was sent`);
    return { owner: to.slice(0, dot), actor: to.slice(dot + 1), lifecycleUid };
  }

  /** Send a caller change under an id derived from the space and the request's own input. The input
   *  carries the policy revision it was read at, so a retry after a lost answer is the same request
   *  and the host replays its answer, while a run after the change landed reads a new revision. */
  async function derived(request: ServiceHostRouteRequest<"caller-grant" | "caller-revoke">): Promise<ServiceEndpointCall> {
    const requestId = createHash("sha256").update(`cotal/service-endpoint/${request.operation}/v1\n${space}\n${canonicalJson(request.input)}`).digest("hex").slice(0, 32);
    return { request: sub!, subject: subject!, requestId, answer: await post({ ...request, requestId }) };
  }
}

export type ServiceHostTarget = { endpoint: string; idpUrl: string; authorization?: string };

/** The refusal for a space this root knows no service endpoint host for. Only the auth service of a
 *  user-auth space started with `--service-endpoints` hosts one, so a static or open space is told
 *  that, as grants are; a remote user-auth registration without one is re-registered. */
function noServiceHost(space: string, mode: "auth" | "open" | "user" | undefined, remote: boolean): CommandFailure {
  const target = { space };
  if (remote) return new CommandFailure("refused", "UNSUPPORTED", `space "${space}" has no pinned service endpoint host; nothing was sent`, { target, remedy: `re-register it with \`cotal meshes add ${space} --from <url>\`` });
  if (mode === "auth" || mode === "open")
    return new CommandFailure("refused", "UNSUPPORTED", `space "${space}" is ${mode === "auth" ? "a static-credential" : "an open"} space and has no service endpoint host; nothing was sent`, { target, remedy: "service endpoints are hosted by the auth service of a space started with `cotal up --user-auth --service-endpoints`" });
  return new CommandFailure("refused", "UNSUPPORTED", "this root does not hold the space's user-auth service; nothing was sent", { target, remedy: "run it on the root that started the space with `cotal up --user-auth --service-endpoints`; a space started without `--user-auth` has no service endpoint host" });
}

function serviceHostEndpoint(dir: string, space: string, what: string): ServiceHostTarget {
  const idp = loadPinnedIdp(dir);
  if (idp) {
    const info = loadAuthServiceInfo(dir);
    if (!info || probeLiveness(info.pid) !== "alive")
      throw new Error(`the user-auth service for space "${space}" is not running - restart it with \`cotal up\` before ${what}`);
    return { endpoint: `${info.url}${SERVICE_ENDPOINT_HOST_PATH}`, idpUrl: idp.url, authorization: `Bearer ${info.cap}` };
  }
  const entry = findMesh(space);
  const ua = entry?.mode === "user" ? entry.userAuth : undefined;
  if (ua?.remote !== true || typeof ua.endpoints?.url !== "string") throw noServiceHost(space, entry?.mode, ua?.remote === true);
  const url = new URL(ua.endpoints.url);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${SERVICE_ENDPOINT_HOST_PATH}`;
  url.search = ""; url.hash = "";
  return { endpoint: url.toString(), idpUrl: ua.idp.url };
}

/** POST one host request to the resolved host with a fresh IdP proof and return the engine's parsed answer. */
export async function postServiceEndpointHost(target: ServiceHostTarget, request: ServiceHostRouteRequest): Promise<ServiceHostResult> {
  const idpToken = await fetchIdpJwt(target.idpUrl, requireIdpSession(homeCotalDir(), target.idpUrl).token);
  const res = await fetch(target.endpoint, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", ...(target.authorization !== undefined ? { authorization: target.authorization } : {}) },
    body: JSON.stringify({ idpToken, request }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`the service endpoint host answered ${res.status} with a redirect - redirects are refused`);
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) throw new Error(`the service endpoint host refused: ${typeof body.error === "string" ? body.error : `HTTP ${res.status}`}`);
  return parseServiceHostResult(body);
}
