import { FEEDBACK_URL, PUBLIC_FEEDBACK_URL } from "./config.js";

export interface FeedbackInput {
  origin: "human" | "agent";
  type: "bug" | "idea" | "friction" | "praise" | "other";
  summary: string;
  source: string;
  details?: string;
  severity?: "low" | "medium" | "high";
  area?: string;
  repro?: string;
  expected?: string;
  actual?: string;
  diagnostics?: string;
}

export interface FeedbackSubmitOptions {
  key?: string;
  url?: string;
  email?: string;
}

export interface FeedbackResult {
  text: string;
  isError?: boolean;
}

const ok = (text: string): FeedbackResult => ({ text });
const err = (text: string): FeedbackResult => ({ text, isError: true });

/** A stored submission: the documented 202 receipt, with a printable id and a boolean published. */
function receipt(status: number, value: unknown): { id: string; published: boolean } | undefined {
  if (status !== 202 || typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as { ok?: unknown; id?: unknown; published?: unknown };
  if (body.ok !== true || typeof body.id !== "string" || body.id.length === 0 || body.id.length > 200) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(body.id) || body.id.trim() !== body.id) return undefined;
  if (typeof body.published !== "boolean") return undefined;
  return { id: body.id, published: body.published };
}

/** Submit feedback through the same keyed or public intake used by `cotal_feedback`. */
export async function submitFeedback(
  input: FeedbackInput,
  options: FeedbackSubmitOptions = {},
): Promise<FeedbackResult> {
  const url = options.url ?? (options.key ? FEEDBACK_URL : PUBLIC_FEEDBACK_URL);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, unknown> = { ...input };
  if (options.key) {
    headers.authorization = `Bearer ${options.key}`;
  } else {
    if (!options.email)
      return err(
        "Keyless feedback goes to the public cotal.ai intake, which requires a traceable contact email — ask the user for one and retry with the email argument (or set COTAL_FEEDBACK_EMAIL).",
      );
    body.email = options.email;
  }
  let res: Response;
  let raw: string;
  try {
    // One POST, and only to the configured intake. A redirect is an unconfirmed outcome, not a second destination.
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error" });
    raw = await res.text();
  } catch (e) {
    return err(`Couldn't reach the feedback intake at ${url}: ${(e as Error).message} The submission was not retried.`);
  }
  let reply: unknown = undefined;
  if (raw)
    try {
      reply = JSON.parse(raw);
    } catch {
      reply = undefined;
    }
  const stored = receipt(res.status, reply);
  if (stored) {
    const note = stored.published === false ? " (stored, but the internal feedback channel publish failed)" : "";
    return ok(`Feedback sent (id ${stored.id})${note}. Thanks!`);
  }
  const errorText =
    typeof reply === "object" && reply !== null && typeof (reply as { error?: unknown }).error === "string"
      ? (reply as { error: string }).error
      : undefined;
  if (!res.ok) return err(`Feedback rejected (${res.status}${errorText ? `: ${errorText}` : ""}).`);
  return err(
    `Feedback acceptance is unconfirmed (${res.status}). The request may have reached the intake and was not retried.`,
  );
}
