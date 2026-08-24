import { HarnessError } from "@1jehuang/jcode-sdk";

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

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

type ProviderBody = { code?: unknown; message?: unknown };

function providerBody(message: string): ProviderBody | undefined {
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
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

function rejectedParameter(message: string): { parameter: "model" | "reasoning effort"; value: string } | undefined {
  const match = /\b(model(?:[ _-]?(?:id|parameter))?|reasoning[ _-]?effort|effort(?:[ _-]?tier)?)\s*(?:=|:|is|was)?\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})/i.exec(message);
  if (!match || !SAFE_VALUE.test(match[2]!)) return undefined;
  return { parameter: /^model/i.test(match[1]!) ? "model" : "reasoning effort", value: match[2]! };
}

/**
 * Classify only the Jcode SDK's invalid-request response and only when both fields are safely
 * extractable. Everything else retains the existing scrubbed startup diagnostic.
 */
export function classifyReadinessProviderRefusal(error: unknown): JcodeReadinessProviderRefusal | undefined {
  if (!(error instanceof HarnessError) || error.code !== "invalid_request") return undefined;
  const body = providerBody(error.message);
  const code = providerCode(error.message, body);
  const parameter = rejectedParameter(typeof body?.message === "string" ? body.message : error.message);
  return code && parameter ? new JcodeReadinessProviderRefusal(code, parameter.parameter, parameter.value) : undefined;
}
