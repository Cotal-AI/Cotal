import { spawn } from "node:child_process";
import { EpEnvelopeError, type EpServeContext } from "@cotal-ai/core";
import { executablePin, type ExecEndpointInput } from "./definition.js";

interface Invocation { stop(): void; done: Promise<void> }
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Trusted local programs, not a sandbox. Neither the issuer environment nor handler stderr is forwarded. */
export class ExecEndpointHandlers {
  private readonly active = new Set<Invocation>();
  private closing = false;

  constructor(private readonly input: ExecEndpointInput, private readonly onCleanupUnknown: () => void) {}

  async invoke(context: EpServeContext): Promise<unknown> {
    if (this.closing) throw new EpEnvelopeError("unavailable", "the executable service is stopping", undefined, "not-executed");
    if (this.active.size >= 32) throw new EpEnvelopeError("resource-exhausted", "the executable service already has 32 unfinished handlers", undefined, "not-executed");
    const deadline = context.request.deadlineMs;
    if (!Number.isSafeInteger(deadline) || deadline === undefined || deadline <= 0) throw new EpEnvelopeError("bad-request", "executable calls and casts require an explicit native deadline", undefined, "not-executed");
    try {
      if (executablePin(this.input.handler) !== this.input.handlerPin) throw new Error();
    } catch { throw new EpEnvelopeError("failed-precondition", "the configured executable changed or lost its protection; inspect the original service before restarting", undefined, "not-executed"); }
    const bytes = Buffer.from(JSON.stringify({ command: context.subject.command, args: context.request.args ?? null }) + "\n", "utf8");
    if (bytes.length > MAX_INPUT_BYTES) throw new EpEnvelopeError("resource-exhausted", "the handler input exceeds 64 KiB; no payload was printed", undefined, "not-executed");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.input.handler, this.input.handlerArgs, { cwd: this.input.cwd, env: {}, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch { throw new EpEnvelopeError("unavailable", "the configured executable could not be spawned; no payload or native error text was printed", undefined, "not-executed"); }
    return await new Promise<unknown>((resolve, reject) => {
      let closed = false, exited = false, settled = false, failure: EpEnvelopeError | undefined;
      let outputBytes = 0, stderrBytes = 0;
      const output: Buffer[] = [];
      let killTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let finish: () => void;
      const done = new Promise<void>((accept) => { finish = accept; });
      const fail = (code: "internal" | "unavailable" | "deadline-exceeded" | "resource-exhausted", message: string) => {
        failure ??= new EpEnvelopeError(code, message, undefined, "unknown");
      };
      const signal = (value: NodeJS.Signals) => {
        // This group was created for this direct child. Never signal a group after its leader's exit.
        if (closed || exited || child.pid === undefined) return;
        try { process.kill(-child.pid, value); }
        catch { fail("unavailable", "handler termination was not confirmed; its effects must not be replayed"); }
      };
      const terminate = () => {
        if (closed || killTimer !== undefined) return;
        signal("SIGTERM");
        killTimer = setTimeout(() => signal("SIGKILL"), 250);
        cleanupTimer = setTimeout(() => {
          if (closed) return;
          fail("unavailable", "the original handler or its inherited pipes did not close after termination; cleanup is unknown and the service is stopping");
          this.closing = true;
          this.onCleanupUnknown();
          if (!settled) { settled = true; reject(failure); }
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        }, 1000);
      };
      const run: Invocation = { done, stop: () => { fail("unavailable", "the service stopped the original handler; its effects were not retried"); terminate(); } };
      this.active.add(run);
      const budget = Math.min(deadline, 120_000);
      const timer = setTimeout(() => { fail("deadline-exceeded", "the original handler exceeded its native call budget; termination was requested and no effect was retried"); terminate(); }, Math.max(1, budget - Math.min(250, Math.floor(budget / 10))));
      child.on("error", () => {
        failure ??= new EpEnvelopeError("unavailable", "the configured handler did not start or complete; native error text and payloads were not printed", undefined, child.pid === undefined ? "not-executed" : "unknown");
        terminate();
      });
      child.once("exit", () => { exited = true; });
      child.stdout?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { fail("resource-exhausted", "the original handler exceeded the 256 KiB output bound; no output was printed and no effect was retried"); terminate(); }
        else if (!failure) output.push(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) { fail("resource-exhausted", "the original handler exceeded the 64 KiB stderr bound; stderr was not forwarded and no effect was retried"); terminate(); }
      });
      child.stdout?.on("error", () => { fail("unavailable", "the original handler output pipe failed; its effects were not retried"); terminate(); });
      child.stderr?.on("error", () => { fail("unavailable", "the original handler error pipe failed; its effects were not retried"); terminate(); });
      child.stdin?.on("error", () => { fail("unavailable", "the original handler did not accept its complete JSON input; its effects were not retried"); terminate(); });
      child.once("close", (code, stoppedBy) => {
        closed = true;
        clearTimeout(timer); clearTimeout(killTimer); clearTimeout(cleanupTimer);
        this.active.delete(run); finish!();
        if (settled) return;
        settled = true;
        if (!failure && (code !== 0 || stoppedBy !== null)) fail("internal", "the original handler exited unsuccessfully; stderr and payloads were not printed and no effect was retried");
        if (failure) { reject(failure); return; }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output));
          resolve(JSON.parse(text));
        } catch { reject(new EpEnvelopeError("internal", "the original handler did not return one UTF-8 JSON value; output was not printed and no effect was retried", undefined, "unknown")); }
      });
      child.stdin?.end(bytes);
    });
  }

  async stop(): Promise<void> {
    this.closing = true;
    const runs = [...this.active];
    for (const run of runs) run.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(runs.map((run) => run.done)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("handler cleanup unconfirmed")), 1500); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
