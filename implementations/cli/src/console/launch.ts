import { spawn } from "node:child_process";
import { oneLine, type Envelope } from "@cotal-ai/workspace";
import { selfArgv } from "../lib/self-exec.js";
import type { ManagedLaunchResult } from "../commands/spawn.js";
import type { ControlCtx } from "./control.js";

export interface AgentLaunchInput {
  application: string;
  persona: string;
  model: string;
  name: string;
  prompt: string;
  events: boolean;
}

export type AgentLaunchReply =
  | { ok: true; name: string; managerInstanceId: string; model: string | null; warnings: string[] }
  | { ok: false; message: string; remedy?: string; canRetry: boolean };

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
    child.once("close", (code) => {
      let receipt: Envelope<ManagedLaunchResult>;
      try {
        if (bytes > 128 * 1024) throw new Error("oversized receipt");
        receipt = JSON.parse(output) as Envelope<ManagedLaunchResult>;
        if (receipt.schemaVersion !== 1 || receipt.command !== "spawn") throw new Error("invalid receipt");
      } catch {
        resolve({ ok: false, canRetry: false, message: "Launch outcome unconfirmed. Inspect the roster and cotal ps before starting another agent." });
        return;
      }
      const result = receipt.result;
      if (code === 0 && receipt.outcome === "ok" && result?.kind === "managed-launch" &&
          result.readiness === "joined" && typeof result.name === "string" && typeof result.managerInstanceId === "string") {
        resolve({ ok: true, name: result.name, managerInstanceId: result.managerInstanceId,
          model: result.requestedModel, warnings: receipt.warnings.map((warning) => oneLine(warning.message)) });
      } else {
        resolve({ ok: false, canRetry: receipt.outcome === "refused",
          message: oneLine(receipt.error?.message ?? "The CLI did not confirm that the agent joined."),
          remedy: receipt.error?.remedy ? oneLine(receipt.error.remedy) : undefined });
      }
    });
  });
}
