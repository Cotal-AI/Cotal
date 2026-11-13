import { spawn } from "node:child_process";
import { oneLine, type Envelope } from "@cotal-ai/workspace";
import { selfArgv } from "../lib/self-exec.js";
import type { ManagedLaunchResult } from "@cotal-ai/workspace/launch";
import type { ControlCtx } from "@cotal-ai/workspace/control";

export interface AgentLaunchInput {
  application: string;
  persona: string;
  model: string;
  name: string;
  prompt: string;
  events: boolean;
}

export type AgentLaunchReply =
  | { ok: true; name: string; id?: string; managerInstanceId: string; model: string | null; warnings: string[] }
  | { ok: false; message: string; remedy?: string; canRetry: boolean };

/** The name the joined notice shows. A missing or whitespace-only name is the agent's id. */
export function shownJoinedName(name: string, id: string | undefined): string {
  if (name.trim()) return name;
  if (id !== undefined && id.trim()) return id;
  return "(unnamed)";
}

/** The palette reply for one spawn receipt. A joined receipt keeps its id so a blank name can be shown as that id. */
export function replyFromSpawnOutput(code: number | null, output: string, bytes: number): AgentLaunchReply {
  let receipt: Envelope<ManagedLaunchResult>;
  try {
    if (bytes > 128 * 1024) throw new Error("oversized receipt");
    receipt = JSON.parse(output) as Envelope<ManagedLaunchResult>;
    if (receipt.schemaVersion !== 1 || receipt.command !== "spawn") throw new Error("invalid receipt");
  } catch {
    return { ok: false, canRetry: false, message: "Launch outcome unconfirmed. Inspect the roster and `cotal ps` before starting another agent." };
  }
  const result = receipt.result;
  if (code === 0 && receipt.outcome === "ok" && result?.kind === "managed-launch" &&
      result.readiness === "joined" && typeof result.name === "string" && typeof result.managerInstanceId === "string") {
    return {
      ok: true, name: result.name, ...(typeof result.id === "string" ? { id: result.id } : {}),
      managerInstanceId: result.managerInstanceId,
      model: result.requestedModel, warnings: receipt.warnings.map((warning) => oneLine(warning.message)),
    };
  }
  return {
    ok: false, canRetry: receipt.outcome === "refused",
    message: oneLine(receipt.error?.message ?? "The CLI did not confirm that the agent joined."),
    remedy: receipt.error?.remedy ? oneLine(receipt.error.remedy) : undefined,
  };
}

/** Execute the real CLI launch with argv, never a shell. Its structured receipt owns validation,
 * persona precedence, caller authority, readiness and uncertain outcomes for both interfaces. */
export async function launchAgent(ctx: ControlCtx, input: AgentLaunchInput): Promise<AgentLaunchReply> {
  const [command, ...prefix] = selfArgv();
  const args = [...prefix, "spawn", input.persona, "--detach", "--json", "--no-color"];
  for (const [flag, value] of [
    ["space", ctx.space], ["server", ctx.server], ["creds", ctx.creds],
    ["harness", input.application], ["model", input.model],
    ["name", input.name], ["prompt", input.prompt],
  ]) if (value) args.push(`--${flag}=${value}`);
  args.push(input.events ? "--events" : "--no-events");
  return new Promise((resolve) => {
    const child = spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 128 * 1024) output += chunk.toString("utf8");
    });
    // Diagnostics stay off Ink's terminal; only the CLI's structured, public receipt is rendered.
    child.stderr.resume();
    child.once("error", () => resolve({ ok: false, canRetry: true, message: "The launch command could not start. Check the Cotal executable." }));
    child.once("close", (code) => resolve(replyFromSpawnOutput(code, output, bytes)));
  });
}
