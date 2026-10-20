import {
  SERVICE_AUTHORITY_MAX_BYTES, SERVICE_DESCRIBE_QUERY_BUDGET_MS, ServiceAuthorityTransportError,
  parseServiceAuthorityEnvelope, parseServiceAuthorityInfo, parseServiceAuthorityResult,
  type ServiceAuthorityEnvelope, type ServiceAuthorityInfo, type ServiceAuthorityResult, type ServiceAuthorityRequest,
} from "@cotal-ai/core";
import { assertPinnedFetchUrl } from "@cotal-ai/workspace";

export interface ServiceAuthorityCallOptions { timeoutMs?: number; signal?: AbortSignal }
interface ServiceAuthorityBudget { signal: AbortSignal; check(): void; remainingMs(): number }
const isMutation = (operation: ServiceAuthorityRequest["operation"]) => operation !== "status" && operation !== "describe-view";

/** One original local deadline covers preparation, fetch, body and response validation. */
export async function withServiceAuthorityBudget<T>(operation: ServiceAuthorityRequest["operation"], options: ServiceAuthorityCallOptions,
  work: (budget: ServiceAuthorityBudget) => Promise<T>, startedAt = performance.now()): Promise<T> {
  const signal = options.signal;
  const cap = operation === "describe-view" ? SERVICE_DESCRIBE_QUERY_BUDGET_MS : 30_000;
  const requested = options.timeoutMs ?? cap;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0)
    throw new Error("service authority budget must be a positive finite duration");
  const deadline = startedAt + Math.min(cap, requested), controller = new AbortController();
  const failure = () => new ServiceAuthorityTransportError("service authority deadline expired or request was cancelled", isMutation(operation) ? "unknown" : "not-executed");
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(1, Math.ceil(deadline - performance.now()))); timer.unref();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let rejectOnAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(failure());
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (controller.signal.aborted) rejectOnAbort();
  });
  const budget: ServiceAuthorityBudget = { signal: controller.signal,
    remainingMs: () => Math.max(0, deadline - performance.now()),
    check: () => { if (controller.signal.aborted || performance.now() >= deadline) throw failure(); },
  };
  try {
    return await Promise.race([Promise.resolve().then(async () => { budget.check(); const result = await work(budget); budget.check(); return result; }), aborted]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

export function assertServiceViewFreshness(result: ServiceAuthorityResult, startedAt: number): void {
  if (result.state === "view" && result.validForMs <= performance.now() - startedAt)
    throw new ServiceAuthorityTransportError("service Describe view expired during the full query roundtrip", "not-executed");
}

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
    response = await fetch(url, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });
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

export async function postRemoteServiceAuthority(base: string, raw: ServiceAuthorityEnvelope, options: ServiceAuthorityCallOptions = {}): Promise<ServiceAuthorityResult> {
  const startedAt = performance.now();
  const envelope = parseServiceAuthorityEnvelope(raw);
  const url = serviceAuthorityUrl(base);
  return withServiceAuthorityBudget(envelope.request.operation, options, async (budget) => {
    const mutation = isMutation(envelope.request.operation);
    const response = await send(url, {
      method: "POST", headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(envelope), signal: budget.signal,
    }, mutation);
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceAuthorityTransportError("service authority HTTP failure leaves the request unconfirmed; retain the existing request identity", mutation ? "unknown" : "not-executed", response.status);
    }
    if (envelope.request.operation === "describe-view" && !(response.headers.get("cache-control") ?? "").split(",").some((p) => p.trim().toLowerCase() === "no-store")) {
      await response.body?.cancel().catch(() => {});
      throw new ServiceAuthorityTransportError("service Describe response must forbid storage", "not-executed", response.status);
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
    budget.check();
    assertServiceViewFreshness(result, startedAt);
    return result;
  }, startedAt);
}
