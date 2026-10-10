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

export interface StartupReply { prompt: string; key: "Down" | "Enter" }

/** Mirrors core's screen-based startup sequence without introducing a seat-to-core dependency. */
export class StartupConfirmSequence {
  readonly #final: string;
  readonly #before: { prompt: string; key: "Down" | "Enter" }[];
  #step = 0;
  #stable = false;
  #done = false;
  constructor(prompt: string, before: readonly StartupReply[] = []) {
    this.#final = normalizeConfirmText(prompt);
    if (!this.#final) throw new Error("startup confirmation prompt is empty after ANSI and whitespace normalization");
    if (!Array.isArray(before) || before.length > 8) throw new Error("invalid startup choices");
    this.#before = before.map((reply) => {
      if (!reply || typeof reply.prompt !== "string" || reply.prompt.length > 1024 || !["Down", "Enter"].includes(reply.key)) throw new Error("invalid startup choice");
      const normalized = reply.prompt.split(/\r?\n/).map(normalizeConfirmText).filter(Boolean).join("\n");
      if (!normalized) throw new Error("startup choice prompt is empty after normalization");
      return { prompt: normalized, key: reply.key };
    });
  }
  observe(screen: string): { key: "Down" | "Enter"; done: boolean } | undefined {
    if (this.#done) return undefined;
    const lines = screen.split(/\r?\n/).map(normalizeConfirmText).filter(Boolean);
    const matches = (prompt: string): boolean => {
      const expected = prompt.split("\n");
      return lines.some((_, start) => expected.every((line, offset) => lines[start + offset] === line));
    };
    const step = this.#before[this.#step];
    if (!step || !matches(step.prompt)) {
      this.#stable = false;
      const final = this.#before.length ? matches(this.#final) : normalizeConfirmText(screen).includes(this.#final);
      if (!final) return undefined;
      this.#done = true;
      return { key: "Enter", done: true };
    }
    if (!this.#stable) { this.#stable = true; return undefined; }
    this.#step++;
    this.#stable = false;
    return { key: step.key, done: false };
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
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sequence: StartupConfirmSequence | undefined;

  /** Throws for a prompt that can never match, so a runtime refuses it before it starts a child. */
  constructor(prompt: string, before: readonly StartupReply[] = []) {
    this.matcher = new StartupConfirmMatcher(prompt);
    const sequence = new StartupConfirmSequence(prompt, before);
    this.sequence = before.length ? sequence : undefined;
  }

  /** The failure becomes the exit's diagnostic, because a TUI may never show it where an operator looks. */
  arm(diagnostic: ConnectorDiagnosticReader, failure: StartupConfirmFailure, pane?: {
    read(): string | undefined; key(key: "Down" | "Enter"): void;
  }): void {
    const fail = (message: string): void => {
      this.disarm();
      diagnostic.recordStop(message);
      failure.report(message);
      failure.stop();
    };
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    this.timer = setTimeout(() => fail(unmatchedConfirmMessage(this.matcher.prompt, CONFIRM_TIMEOUT_MS)), CONFIRM_TIMEOUT_MS);
    if (this.sequence) {
      if (!pane) { fail("Cotal startup confirmation failed: this runtime has no screen-based startup choices."); return; }
      const poll = (): void => {
        if (Date.now() >= deadline) return;
        try {
          const screen = pane.read();
          if (screen === undefined) { this.disarm(); return; }
          if (Date.now() >= deadline) return;
          const action = this.sequence!.observe(screen);
          if (action) pane.key(action.key);
          if (action?.done) { this.disarm(); return; }
          this.pollTimer = setTimeout(poll, 250);
        } catch (error) { fail(`Cotal startup confirmation failed: ${(error as Error).message}`); }
      };
      this.pollTimer = setTimeout(poll, 250);
    }
  }

  /** True once, for the chunk that completes the prompt; the runtime answers it with Enter. */
  push(chunk: string): boolean {
    if (this.sequence || !this.matcher.push(chunk)) return false;
    this.disarm();
    return true;
  }

  /** A child that has exited can no longer fail its gate. */
  disarm(): void {
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
    this.timer = undefined;
    this.pollTimer = undefined;
  }
}
