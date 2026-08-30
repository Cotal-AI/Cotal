import { HarnessError } from "@1jehuang/jcode-sdk";
import { constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { hardenPrivate } from "@cotal-ai/core";

export type JcodeConnectorFailureCode = "model_prefix_rejected" | "model_refused" | "model_mismatch";

/** A bounded connector-owned startup refusal. Only its allow-listed code is rendered publicly. */
export class JcodeConnectorError extends Error {
  constructor(readonly code: JcodeConnectorFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

let diagnosticLogFd: number | undefined;

/** Start the per-seat connector diagnostic log before any private Jcode process is launched. */
export function installJcodeDiagnosticLog(home: string): string {
  const logs = join(home, "logs");
  try {
    const stats = lstatSync(logs);
    if (stats.isSymbolicLink()) throw new Error(`refusing symlinked Jcode connector log directory: ${logs}`);
    if (!stats.isDirectory()) throw new Error(`Jcode connector log path is not a directory: ${logs}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(logs, { mode: 0o700 });
  }
  hardenPrivate(logs, "dir");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(logs, `connector-${timestamp}-${process.pid}.log`);
  diagnosticLogFd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  hardenPrivate(path, "file");
  return path;
}

/** Write one connector-owned diagnostic to the terminal and the seat's private connector log. */
export function writeJcodeDiagnostic(message: string): void {
  process.stderr.write(message);
  if (diagnosticLogFd !== undefined) writeSync(diagnosticLogFd, message);
}

/** A bounded, connector-owned account of a provider refusal during the mandatory readiness turn.
 * It deliberately contains only a provider error code and a model/effort value the connector could
 * classify; the original Harness API message may include private configuration or child output. */
export class JcodeReadinessProviderRefusal extends Error {
  constructor(
    readonly providerCode: string,
    readonly parameter: "model" | "reasoning effort",
    readonly value: string,
  ) {
    super(`provider refused ${parameter} ${JSON.stringify(value)} (${providerCode})`);
  }
}

/** A Jcode reasoning-effort refusal with only fields safe for an external observer/UI.
 * The underlying HarnessError can include arbitrary provider response text and must never escape
 * through the host's startup diagnostic. */
export class JcodeEffortRefusal extends Error {
  readonly providerCode = "invalid_request";

  constructor(
    readonly requestedTier: string,
    readonly effectiveModel: string,
    readonly acceptedLadder: readonly string[],
  ) {
    super("Jcode reasoning effort was refused");
  }
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_EFFORT_TIERS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none"]);
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

type ProviderBody = { code?: unknown; message?: unknown };

function providerBody(message: string): ProviderBody | undefined {
  // HarnessError prefixes the wire message with its stable SDK code (`invalid_request: ...`),
  // so a provider's JSON body can begin after that prefix rather than at byte zero.
  const json = message.slice(message.indexOf("{"));
  try {
    const parsed = JSON.parse(json) as { error?: unknown };
    const body = parsed.error ?? parsed;
    if (!body || typeof body !== "object") return undefined;
    return body as ProviderBody;
  } catch {
    return undefined;
  }
}

function providerCode(message: string, body: ProviderBody | undefined): string | undefined {
  if (typeof body?.code === "string" && SAFE_CODE.test(body.code)) return body.code;
  const prefix = /^\s*([a-z][a-z0-9_]{0,63}):/.exec(message)?.[1];
  return prefix && SAFE_CODE.test(prefix) ? prefix : undefined;
}

function classifiedCode(message: string, body: ProviderBody | undefined): string {
  // The SDK error is `invalid_request`; a provider may put its own code in JSON or as a textual
  // prefix. Prefer the provider's code when safely present, otherwise name the SDK's stable code.
  return providerCode(message, body) ?? "invalid_request";
}

function rejectedParameter(message: string): { parameter: "model" | "reasoning effort"; value: string } | undefined {
  const match = /\b(model(?:[ _-]?(?:id|parameter))?|reasoning[ _-]?effort|effort(?:[ _-]?tier)?)\s*(?:=|:|is|was)?\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})/i.exec(message);
  if (!match || !SAFE_VALUE.test(match[2]!)) return undefined;
  return { parameter: /^model/i.test(match[1]!) ? "model" : "reasoning effort", value: match[2]! };
}

/** A display-only parser, never validation. It accepts only the documented generic effort names,
 * stops before prose delimiters, and cannot reproduce arbitrary downstream text. */
function acceptedEffortLadder(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  const listed = /\b(?:accepted\s+(?:tiers?|efforts?)|available)\s*:\s*([^;\r\n]{1,256})/i.exec(error.message)?.[1];
  if (!listed) return [];
  return [...new Set(
    listed
      .split(",")
      .map((part) => part.trim().replace(/^["'`(\[]+|["'`\])\s]+$/g, "").toLowerCase())
      .filter((tier) => SAFE_EFFORT_TIERS.has(tier)),
  )];
}

/** Compose a bounded effort-refusal diagnostic. `invalid_request` is intentionally fixed: Jcode
 * rejected this API operation, while provider-supplied codes and text are untrusted. */
export function jcodeEffortRefusal(error: unknown, requestedTier: string, effectiveModel: string): JcodeEffortRefusal {
  return new JcodeEffortRefusal(requestedTier, effectiveModel, acceptedEffortLadder(error));
}

/**
 * Classify only the Jcode SDK's invalid-request response and only when both fields are safely
 * extractable. Everything else retains the existing scrubbed startup diagnostic.
 */
export function classifyReadinessProviderRefusal(error: unknown): JcodeReadinessProviderRefusal | undefined {
  if (!(error instanceof HarnessError) || error.code !== "invalid_request") return undefined;
  const body = providerBody(error.message);
  const code = classifiedCode(error.message, body);
  const parameter = rejectedParameter(typeof body?.message === "string" ? body.message : error.message);
  return parameter ? new JcodeReadinessProviderRefusal(code, parameter.parameter, parameter.value) : undefined;
}
