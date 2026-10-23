/**
 * Client of the `/service-endpoint-host` route: one typed host request, without its granter, sent
 * with this machine's fresh login proof. The local arm posts to the running auth service's loopback
 * face with the operator exchange capability, so operator actions (a name binding) are reachable
 * there; the remote arm posts to the pinned public exchange, where only an owner's operations are
 * served. Redirects are refused: a 302 could walk the proof onto a host the registry never pinned.
 * The parsed answer comes back verbatim; the caller binds it to its own request.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileCreateOnly, type EpCapability } from "@cotal-ai/core";
import { CommandFailure, findMesh, homeCotalDir, probeLiveness } from "@cotal-ai/workspace";
import { parseServiceHostResult, type ServiceHostInputs, type ServiceHostOperation, type ServiceHostResult } from "./service-host-contract.js";
import { SERVICE_ENDPOINT_HOST_PATH } from "./service-endpoint-authority.js";
import { fetchIdpJwt, requireIdpSession } from "./login.js";
import { loadAuthServiceInfo, loadPinnedIdp } from "./store.js";

/** A host request as the route takes it: the granter is the route's to derive. */
export type ServiceHostRouteRequest<K extends ServiceHostOperation = ServiceHostOperation> = { [O in K]: {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: O; input: ServiceHostInputs[O];
} }[K];

export const SERVICE_ENDPOINT_USAGE = "service-endpoint <approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint> --owner <u_…> --claim <ref>>";

export type ServiceEndpointValues = { owner?: string; claim?: string; "caller-ceiling"?: string; "request-id"?: string };

/** One `cotal service-endpoint` run: the subcommand, its subject, the id an effectful request went
 *  under, and the host's answer. */
export interface ServiceEndpointCall { request: string; subject: string; requestId?: string; answer: ServiceHostResult }

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
  const post = (r: ServiceHostRouteRequest) => postServiceEndpointHost(dir, space, r, `service-endpoint ${sub}`);
  const read = async (operation: "proposal-read" | "operation-read" | "name-read", input: ServiceHostInputs[typeof operation]): Promise<ServiceEndpointCall> =>
    ({ request: sub, subject, answer: await post(fresh(operation, input) as ServiceHostRouteRequest) });
  // A lost answer leaves the request recorded, so the failure names the id a resend goes under.
  const send = async (request: RecordedHostRequest): Promise<ServiceEndpointCall> => {
    let answer: ServiceHostResult;
    try { answer = await post(request); }
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
      const proposal = await post(fresh("proposal-read", { proposalId: subject })) as ServiceHostResult & { record?: { value: { nameBinding: { revision: number } | null }; revision: number } };
      if (proposal.state !== "present" || proposal.record === undefined)
        throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no proposal ${subject} is yours to decide on space "${space}"; nothing was decided`);
      const callerCeiling = (values["caller-ceiling"] ?? "").split(",").map((c) => c.trim()).filter(Boolean) as unknown as EpCapability[];
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
      recordHostRequest(dir, request);
      return send(request);
    }
    default: throw usage();
  }
}

function serviceHostEndpoint(dir: string, space: string, what: string): { endpoint: string; idpUrl: string; authorization?: string } {
  const idp = loadPinnedIdp(dir);
  if (idp) {
    const info = loadAuthServiceInfo(dir);
    if (!info || probeLiveness(info.pid) !== "alive")
      throw new Error(`the user-auth service for space "${space}" is not running - restart it with \`cotal up\` before ${what}`);
    return { endpoint: `${info.url}${SERVICE_ENDPOINT_HOST_PATH}`, idpUrl: idp.url, authorization: `Bearer ${info.cap}` };
  }
  const entry = findMesh(space);
  const ua = entry?.mode === "user" ? entry.userAuth : undefined;
  if (ua?.remote !== true || typeof ua.endpoints?.url !== "string")
    throw new Error(`space "${space}" has no pinned service endpoint host - re-register it with \`cotal meshes add ${space} --from <url>\``);
  const url = new URL(ua.endpoints.url);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${SERVICE_ENDPOINT_HOST_PATH}`;
  url.search = ""; url.hash = "";
  return { endpoint: url.toString(), idpUrl: ua.idp.url };
}

/** POST one host request with a fresh IdP proof and return the engine's parsed answer. */
export async function postServiceEndpointHost(dir: string, space: string, request: ServiceHostRouteRequest, what: string): Promise<ServiceHostResult> {
  const target = serviceHostEndpoint(dir, space, what);
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
