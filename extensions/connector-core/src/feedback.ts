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
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const raw = await res.text();
    let reply: { id?: string; error?: string; published?: boolean } = {};
    if (raw)
      try {
        reply = JSON.parse(raw);
      } catch {
        reply = { error: raw };
      }
    if (!res.ok)
      return err(`Feedback rejected (${res.status}${reply.error ? `: ${reply.error}` : ""}).`);
    const note = reply.published === false ? " (stored, but the internal feedback channel publish failed)" : "";
    return ok(`Feedback sent${reply.id ? ` (id ${reply.id})` : ""}${note}. Thanks!`);
  } catch (e) {
    return err(`Couldn't reach the feedback intake at ${url}: ${(e as Error).message}`);
  }
}
