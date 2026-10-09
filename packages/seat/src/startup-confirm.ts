import type { ConnectorDiagnosticReader } from "./diagnostic.js";
import { CONFIRM_TIMEOUT_MS } from "./protocol.js";

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC = /\x1b(?:.|$)/g;

/** Normalize terminal text according to LaunchSpec.confirm: ignore ANSI control sequences and whitespace.
 *  Repeated in core's startup-confirm, which the runtimes that read their panes use, because this
 *  package depends on nothing else in the repo; the two must normalize alike. */
export function normalizeConfirmText(value: string): string {
  return value.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(/\s+/g, "");
}

/**
 * Matches a connector-declared startup confirmation prompt across arbitrary PTY chunks.
 * The retained text is bounded because startup TUIs can repaint indefinitely before showing a gate.
 */
export class StartupConfirmMatcher {
  private readonly needle: string;
  private raw = "";
  private matched = false;

  constructor(readonly prompt: string, private readonly maxChars = 64 * 1024) {
    this.needle = normalizeConfirmText(prompt);
    if (!this.needle) throw new Error("startup confirmation prompt is empty after ANSI and whitespace normalization");
  }

  push(chunk: string): boolean {
    if (this.matched) return false;
    this.raw += chunk;
    const text = normalizeConfirmText(this.raw);
    if (text.includes(this.needle)) {
      this.matched = true;
      return true;
    }
    if (this.raw.length > this.maxChars) this.raw = this.raw.slice(-this.maxChars);
    return false;
  }
}

export function unmatchedConfirmMessage(prompt: string, timeoutMs: number): string {
  return `Cotal startup confirmation failed: prompt ${JSON.stringify(prompt)} did not appear within ${timeoutMs}ms.`;
}

/** What a runtime does for a {@link StartupConfirmGate} whose prompt never appeared. */
export interface StartupConfirmFailure {
  /** Show `message` to whoever reads the seat's output. */
  report(message: string): void;
  /** Stop the child the runtime's graceful way, which kills a child that ignores SIGTERM. */
  stop(): void;
}

/**
 * Honors LaunchSpec.confirm for a runtime that owns the child's output. Both pty runtimes use it, so
 * a gate that fails ends the seat the same way whichever one owns the child.
 */
export class StartupConfirmGate {
  private readonly matcher: StartupConfirmMatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Throws for a prompt that can never match, so a runtime refuses it before it starts a child. */
  constructor(prompt: string) {
    this.matcher = new StartupConfirmMatcher(prompt);
  }

  /** The failure becomes the exit's diagnostic, because a TUI may never show it where an operator looks. */
  arm(diagnostic: ConnectorDiagnosticReader, failure: StartupConfirmFailure): void {
    this.timer = setTimeout(() => {
      const message = unmatchedConfirmMessage(this.matcher.prompt, CONFIRM_TIMEOUT_MS);
      diagnostic.recordStop(message);
      failure.report(message);
      failure.stop();
    }, CONFIRM_TIMEOUT_MS);
  }

  /** True once, for the chunk that completes the prompt; the runtime answers it with Enter. */
  push(chunk: string): boolean {
    if (!this.matcher.push(chunk)) return false;
    this.disarm();
    return true;
  }

  /** A child that has exited can no longer fail its gate. */
  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
