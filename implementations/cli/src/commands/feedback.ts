import { execFileSync } from "node:child_process";
import { type ParsedArgs } from "@cotal-ai/core";
import { c } from "../ui.js";

type FeedbackType = "bug" | "idea" | "friction" | "praise" | "other";
type FeedbackSeverity = "low" | "medium" | "high";

const TYPES = new Set<FeedbackType>(["bug", "idea", "friction", "praise", "other"]);
const SEVERITIES = new Set<FeedbackSeverity>(["low", "medium", "high"]);

/** Keyed beta intake (with a feedback key) / public hosted intake (without). Mirrors
 *  connector-core's constants — the CLI can't import extensions (tier rule). */
const FEEDBACK_URL = "https://broker.cotal.ai/v1/feedback";
const PUBLIC_FEEDBACK_URL = "https://cotal.ai/v1/feedback";

export async function feedback(args: ParsedArgs): Promise<void> {
  const { positionals } = args;
  const values = args.values as {
    type?: string;
    details?: string;
    severity?: string;
    area?: string;
    email?: string;
    name?: string;
    url?: string;
    key?: string;
  };

  const summary = positionals[0];
  if (!summary) {
    console.error(
      c.red(
        'usage: cotal feedback "<summary>" [--type bug|idea|friction|praise|other] [--details …] [--severity low|medium|high] [--area …] [--email …] [--name …] [--url …] [--key …]',
      ),
    );
    process.exit(1);
  }
  const type = (values.type ?? "other") as FeedbackType;
  if (!TYPES.has(type)) {
    console.error(c.red(`--type must be one of ${[...TYPES].join(", ")}`));
    process.exit(1);
  }
  if (values.severity && !SEVERITIES.has(values.severity as FeedbackSeverity)) {
    console.error(c.red(`--severity must be one of ${[...SEVERITIES].join(", ")}`));
    process.exit(1);
  }

  const key = values.key ?? process.env.COTAL_FEEDBACK_KEY?.trim() ?? undefined;
  const url = values.url ?? process.env.COTAL_FEEDBACK_URL?.trim() ?? (key ? FEEDBACK_URL : PUBLIC_FEEDBACK_URL);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, unknown> = {
    origin: "human",
    type,
    summary,
    details: values.details,
    severity: values.severity,
    area: values.area,
    name: values.name,
    source: "cli",
  };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  } else {
    const email = values.email ?? process.env.COTAL_FEEDBACK_EMAIL?.trim() ?? gitEmail();
    if (!email) {
      console.error(
        c.red(
          "The public feedback intake needs a traceable contact email — pass --email or set COTAL_FEEDBACK_EMAIL.",
        ),
      );
      process.exit(1);
    }
    body.email = email;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    console.error(c.red(`Couldn't reach the feedback intake at ${url}: ${(e as Error).message}`));
    process.exit(1);
  }
  const reply = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) {
    console.error(c.red(`Feedback rejected (${res.status}${reply.error ? `: ${reply.error}` : ""}).`));
    process.exit(1);
  }
  console.log(`Feedback sent${reply.id ? ` — id ${c.cyan(reply.id)}` : ""}. Thanks!`);
}

function gitEmail(): string | undefined {
  try {
    return execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}
