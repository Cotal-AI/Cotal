/**
 * Client of the `/service-endpoint-host` route: one typed host request, without its granter, sent
 * with this machine's fresh login proof. The local arm posts to the running auth service's loopback
 * face with the operator exchange capability, so operator actions (a name binding) are reachable
 * there; the remote arm posts to the pinned public exchange, where only an owner's operations are
 * served. Redirects are refused: a 302 could walk the proof onto a host the registry never pinned.
 * The parsed answer comes back verbatim; the caller binds it to its own request.
 */
import { findMesh, homeCotalDir, probeLiveness } from "@cotal-ai/workspace";
import { parseServiceHostResult, type ServiceHostInputs, type ServiceHostOperation, type ServiceHostResult } from "./service-host-contract.js";
import { SERVICE_ENDPOINT_HOST_PATH } from "./service-endpoint-authority.js";
import { fetchIdpJwt, requireIdpSession } from "./login.js";
import { loadAuthServiceInfo, loadPinnedIdp } from "./store.js";

/** A host request as the route takes it: the granter is the route's to derive. */
export type ServiceHostRouteRequest<K extends ServiceHostOperation = ServiceHostOperation> = { [O in K]: {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: O; input: ServiceHostInputs[O];
} }[K];

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
