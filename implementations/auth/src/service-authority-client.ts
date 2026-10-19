import {
  SERVICE_AUTHORITY_MAX_BYTES, ServiceAuthorityTransportError,
  parseServiceAuthorityEnvelope, parseServiceAuthorityInfo, parseServiceAuthorityResult,
  type ServiceAuthorityEnvelope, type ServiceAuthorityInfo, type ServiceAuthorityResult,
} from "@cotal-ai/core";
import { assertPinnedFetchUrl } from "@cotal-ai/workspace";

/** Derive the protocol's fixed sibling from the protected exchange base. */
export function serviceAuthorityUrl(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("service authority requires a valid pinned exchange URL"); }
  if (url.username || url.password) throw new Error("service authority URL must not carry user credentials");
  const refusal = assertPinnedFetchUrl(url, "service authority");
  if (refusal) throw new Error(refusal);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/service-endpoint-authority`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty authority response");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > SERVICE_AUTHORITY_MAX_BYTES) throw new Error("authority response exceeds its byte limit");
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function send(url: string, init: RequestInit, mutation: boolean): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ServiceAuthorityTransportError("service authority did not return a response; retain the existing request identity", mutation ? "unknown" : "not-executed");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ServiceAuthorityTransportError("service authority redirects are refused", mutation ? "unknown" : "not-executed", response.status);
  }
  return response;
}

export async function readRemoteServiceAuthorityInfo(base: string, space: string): Promise<ServiceAuthorityInfo> {
  const response = await send(serviceAuthorityUrl(base), { method: "GET", headers: { "cache-control": "no-store" } }, false);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ServiceAuthorityTransportError("service authority account metadata request failed", "not-executed", response.status);
  }
  try { return parseServiceAuthorityInfo(await readBoundedJson(response), space); }
  catch { throw new ServiceAuthorityTransportError("service authority returned invalid account metadata", "not-executed", response.status); }
}

export async function postRemoteServiceAuthority(base: string, raw: ServiceAuthorityEnvelope): Promise<ServiceAuthorityResult> {
  const envelope = parseServiceAuthorityEnvelope(raw);
  const url = serviceAuthorityUrl(base);
  const mutation = envelope.request.operation !== "status";
  const response = await send(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
  }, mutation);
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw new ServiceAuthorityTransportError("service authority HTTP failure leaves the request unconfirmed; retain the existing request identity", mutation ? "unknown" : "not-executed", response.status);
  }
  let result: ServiceAuthorityResult;
  try { result = parseServiceAuthorityResult(await readBoundedJson(response), envelope.request); }
  catch {
    throw new ServiceAuthorityTransportError("service authority returned an unconfirmed response; retain the existing request identity", mutation ? "unknown" : "not-executed", response.status);
  }
  if (!response.ok && result.state !== "denied")
    throw new ServiceAuthorityTransportError("service authority HTTP status disagrees with its result", mutation ? "unknown" : "not-executed", response.status);
  if (result.state === "approval-required" && result.approvalUrl !== undefined && new URL(result.approvalUrl).origin !== new URL(url).origin)
    throw new ServiceAuthorityTransportError("service approval URL leaves the pinned authority origin", mutation ? "unknown" : "not-executed", response.status);
  return result;
}
