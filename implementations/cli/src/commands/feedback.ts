import { execFileSync } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { resolve } from "node:path";
import type { FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, jsonFlag, plainFlag, presentationOf, protectedCredentialReference,
  readLocalRecordSource, writeResult, type OutputWarning, type RefusalCode,
} from "@cotal-ai/workspace";

type FeedbackType = "bug" | "idea" | "friction" | "praise" | "other";
type FeedbackSeverity = "low" | "medium" | "high";
const TYPES = new Set<FeedbackType>(["bug", "idea", "friction", "praise", "other"]);
const SEVERITIES = new Set<FeedbackSeverity>(["low", "medium", "high"]);
const FEEDBACK_URL = "https://broker.cotal.ai/v1/feedback";
const PUBLIC_FEEDBACK_URL = "https://cotal.ai/v1/feedback";

export const feedbackFlags = [
  { name: "type", type: "string", value: "<type>", description: "bug, idea, friction, praise or other" },
  { name: "details", type: "string", value: "<text>", description: "free-form details; do not include credentials or private logs" },
  { name: "severity", type: "string", value: "<severity>", description: "low, medium or high" },
  { name: "area", type: "string", value: "<area>", description: "the part of Cotal this concerns" },
  { name: "email", type: "string", value: "<email>", description: "public intake contact; otherwise the configured contact or local git email" },
  { name: "name", type: "string", value: "<name>", description: "optional contact name" },
  { name: "url", type: "string", value: "<https-url>", description: "explicit intake override; HTTPS except literal loopback development hosts" },
  { name: "key-file", type: "string", value: "<private-file>", description: "protected intake key file; contents never appear in argv or output" },
  { name: "key", type: "string", value: "<deprecated>", description: "migration refusal; use a protected --key-file instead of a key on argv" },
  jsonFlag, plainFlag,
] as const satisfies readonly FlagSpec[];
type Values = FlagValues<typeof feedbackFlags>;

export function validateFeedbackArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const values = args.values as Values;
  if (values.key !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "intake credentials must not be supplied on argv; no request was made and the value was not echoed", { remedy: "use a protected --key-file <path>, or the public intake with --email <contact>" });
  if (args.positionals.length !== 1 || !args.positionals[0]?.trim() || args.positionals[0].length > 300) throw new CommandFailure("refused", "USAGE_INVALID", "feedback needs one quoted summary of 1 to 300 characters");
  if (!TYPES.has((values.type ?? "other") as FeedbackType) || values.severity !== undefined && !SEVERITIES.has(values.severity as FeedbackSeverity)) throw new CommandFailure("refused", "USAGE_INVALID", "use a declared feedback type and low, medium or high severity");
  for (const [field, limit] of [["details", 10000], ["area", 120], ["name", 200], ["email", 320]] as const) if (values[field] !== undefined && values[field].length > limit) throw new CommandFailure("refused", "USAGE_INVALID", `--${field} exceeds its ${limit}-character limit; the value was not echoed`);
  if (values["key-file"] !== undefined && (!values["key-file"].trim() || /[\u0000-\u001f\u007f]/u.test(values["key-file"]))) throw new CommandFailure("refused", "USAGE_INVALID", "--key-file requires one path without terminal controls");
  if (values.url !== undefined) intakeUrl(values.url);
}

function intakeUrl(text: string): URL {
  let url: URL;
  try { url = new URL(text); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "the intake URL is invalid; its contents were not printed"); }
  if (url.username || url.password || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new CommandFailure("refused", "USAGE_INVALID", "feedback requires HTTPS, or HTTP on a literal loopback development host, without URL credentials or a fragment");
  return url;
}

type KeySource = "private-file" | "configured" | "public";

function feedbackKey(values: Values): { key?: string; source: KeySource } {
  if (values["key-file"] !== undefined) {
    const path = resolve(values["key-file"]);
    protectedCredentialReference(path);
    const bytes = readLocalRecordSource(path, 16 * 1024, true);
    if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the protected feedback key file disappeared; no other key was substituted");
    let key: string;
    try { key = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, ""); }
    catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the private key file is not valid UTF-8; no key content was printed"); }
    if (!key || /\s|[\u0000-\u001f\u007f]/u.test(key)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the private key file must hold one opaque bearer token and at most one final newline");
    return { key, source: "private-file" };
  }
  const key = process.env.COTAL_FEEDBACK_KEY?.trim();
  if (key && (Buffer.byteLength(key, "utf8") > 16 * 1024 || /\s|[\u0000-\u001f\u007f]/u.test(key))) throw new CommandFailure("refused", "AUTH_REQUIRED", "the configured intake key is malformed; no credential was printed and no public fallback was tried");
  return key ? { key, source: "configured" } : { source: "public" };
}

async function responseId(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return typeof body?.id === "string" && body.id.length > 0 && body.id.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(body.id) ? body.id : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

/** One explicit submission, no redirects or automatic retry, followed by a public-only receipt. */
export async function feedback(args: ParsedArgs): Promise<void> {
  validateFeedbackArguments(args);
  const values = args.values as Values;
  const credential = feedbackKey(values);
  const url = intakeUrl(values.url ?? (process.env.COTAL_FEEDBACK_URL?.trim() || (credential.key ? FEEDBACK_URL : PUBLIC_FEEDBACK_URL)));
  const target = { intakeOrigin: url.origin };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, unknown> = { origin: "human", type: values.type ?? "other", summary: args.positionals[0], details: values.details, severity: values.severity, area: values.area, name: values.name, source: "cli" };
  if (credential.key) headers.authorization = `Bearer ${credential.key}`;
  else {
    const email = values.email ?? process.env.COTAL_FEEDBACK_EMAIL?.trim() ?? gitEmail();
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new CommandFailure("refused", "USAGE_INVALID", "the public intake needs a traceable contact email; none was sent", { remedy: "pass --email <contact>; no environment setup is required" });
    body.email = email;
  }
  // Node's fetch reports a connection that never opened on this channel, with the same error it
  // gives as the failure's cause. No request byte was written on such a connection.
  const unopened = new WeakSet<object>();
  const onConnectError = (message: unknown) => { const { error } = message as { error?: unknown }; if (typeof error === "object" && error !== null) unopened.add(error); };
  subscribe("undici:client:connectError", onConnectError);
  let response: Response;
  try { response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20_000) }); }
  catch (error) {
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (typeof cause === "object" && cause !== null && unopened.has(cause)) {
      const code = (cause as { code?: unknown }).code;
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no connection to the intake opened, so the report was not sent", { target, remedy: `check that ${url.origin} is reachable and serves ${url.protocol === "https:" ? "HTTPS" : "HTTP"}, then submit again`, ...(typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? { native: { code } } : {}) });
    }
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "feedback acceptance is unconfirmed; the request may have reached the intake and was not retried", { target, remedy: "check the original intake before submitting again; network, URL, response-body and credential details were not printed" });
  }
  finally { unsubscribe("undici:client:connectError", onConnectError); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const codes: Record<number, RefusalCode> = { 400: "SCHEMA_INVALID", 401: "AUTH_REQUIRED", 403: "PERMISSION_DENIED", 404: "TARGET_NOT_FOUND", 413: "SCHEMA_INVALID", 422: "SCHEMA_INVALID", 429: "TARGET_UNAVAILABLE" };
    const code = codes[response.status];
    if (!code) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the intake returned a non-success response without a confirmed acceptance outcome; no request was retried", { target, native: { code: `HTTP_${response.status}` } });
    const { message, remedy } = rejection(response, credential.source, url);
    throw new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}), native: { code: `HTTP_${response.status}` } });
  }
  const id = await responseId(response);
  const warnings: OutputWarning[] = id === null ? [{ code: "FEEDBACK_ID_UNAVAILABLE", target, message: "The intake returned HTTP success, but no bounded record ID was established. Do not resend merely to obtain an ID." }] : [];
  const result = { kind: "feedback-receipt", intakeOrigin: url.origin, httpStatus: response.status, intakeAccepted: true, recordId: id, authentication: credential.source, contactIncluded: body.email !== undefined, developerRead: "not-confirmed", actionTaken: "not-confirmed", bodyEchoed: false, secretOnStdout: false, retried: false };
  writeResult(presentationOf(values), { command: "feedback", target, result, warnings }, (data) => ({ sections: [{ title: "Feedback intake accepted the request", blocks: [
    { kind: "fields", rows: [["Intake", data.intakeOrigin], ["HTTP status", String(data.httpStatus)], ["Record", data.recordId ?? "not provided or not established"], ["Authentication", data.authentication], ["Contact", data.contactIncluded ? "included; not printed" : "not included on keyed intake"], ["Read or action by developers", "not confirmed"]] },
    { kind: "lines", lines: [{ text: "HTTP acceptance is not proof that someone read the report or took action. Summary, details, contact values, key contents and intake response bodies are not printed. No redirect, alternate credential or automatic retry was used.", tone: "hint" }] },
  ] }] }));
}

/** The cause and next step for an intake refusal. The response body is never echoed. */
function rejection(response: Response, source: KeySource, url: URL): { message: string; remedy?: string } {
  if (response.status === 401 && source === "public") return { message: "the intake requires a feedback key, and the report was not accepted", remedy: "pass --key-file <private-file> holding a key this intake issued" };
  if (response.status === 401) return { message: "the intake refused the feedback key, and the report was not accepted", remedy: `check that the key in ${source === "private-file" ? "--key-file" : "COTAL_FEEDBACK_KEY"} is one this intake issued, then submit again` };
  if (response.status === 404) return { message: "the intake has no feedback endpoint at this URL, and the report was not accepted", remedy: url.pathname === "/v1/feedback" ? `check that ${url.origin} runs a Cotal feedback intake` : `set --url to ${url.origin}/v1/feedback, the path a Cotal intake serves` };
  if (response.status === 429) {
    // Retry-After is either delay seconds or an HTTP date; anything else is treated as absent.
    const header = response.headers.get("retry-after")?.trim() ?? "";
    const at = /^\d{1,9}$/.test(header) ? Date.now() + Number(header) * 1000
      : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header) ? Date.parse(header) : Number.NaN;
    if (!Number.isFinite(at)) return { message: "the intake is rate limiting submissions and did not say for how long, and the report was not accepted", remedy: "wait, then submit again" };
    const when = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
    return { message: `the intake is rate limiting submissions until ${when}, and the report was not accepted`, remedy: `submit again after ${when}` };
  }
  return { message: "the intake rejected the request; its response body was not echoed and no alternate intake or key was tried" };
}

function gitEmail(): string | undefined {
  try { return execFileSync("git", ["config", "user.email"], { encoding: "utf8", timeout: 2_000 }).trim() || undefined; }
  catch { return undefined; }
}
