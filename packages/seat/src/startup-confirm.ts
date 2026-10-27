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

export interface StartupReply { prompt: string; key: "Down" | "Enter"; optional?: boolean }
/** A native startup screen the watch never answers; see core's StartupBlocker. */
export interface StartupBlocker { prompt: string; reason: string }

/** Mirrors core's screen-based startup sequence without introducing a seat-to-core dependency. */
export class StartupConfirmSequence {
  readonly #final: string;
  readonly #before: { prompt: string; key: "Down" | "Enter"; optional: boolean }[];
  readonly #ready: string[];
  readonly #blockers: { prompt: string; reason: string }[];
  #blocked: string | undefined;
  #step = 0;
  #seen: number | undefined;
  #readySeen = false;
  #done = false;
  constructor(prompt: string, before: readonly StartupReply[] = [], ready: readonly string[] = [], blockers: readonly StartupBlocker[] = []) {
    this.#final = normalizeConfirmText(prompt);
    if (!this.#final) throw new Error("startup confirmation prompt is empty after ANSI and whitespace normalization");
    if (!Array.isArray(before) || before.length > 8) throw new Error("invalid startup choices");
    this.#before = before.map((reply) => {
      if (!reply || typeof reply.prompt !== "string" || reply.prompt.length > 1024 || !["Down", "Enter"].includes(reply.key)
        || (reply.optional !== undefined && typeof reply.optional !== "boolean")) throw new Error("invalid startup choice");
      const normalized = reply.prompt.split(/\r?\n/).map(normalizeConfirmText).filter(Boolean).join("\n");
      if (!normalized) throw new Error("startup choice prompt is empty after normalization");
      return { prompt: normalized, key: reply.key, optional: reply.optional === true };
    });
    if (!Array.isArray(ready) || ready.length > 8) throw new Error("invalid startup ready texts");
    this.#ready = ready.map((text) => {
      const normalized = typeof text === "string" && text.length <= 1024 ? normalizeConfirmText(text) : "";
      if (!normalized) throw new Error("invalid startup ready text");
      return normalized;
    });
    if (!Array.isArray(blockers) || blockers.length > 8) throw new Error("invalid startup blockers");
    this.#blockers = blockers.map((blocker) => {
      if (!blocker || typeof blocker.prompt !== "string" || blocker.prompt.length > 1024
        || typeof blocker.reason !== "string" || !blocker.reason.trim() || blocker.reason.length > 1024) throw new Error("invalid startup blocker");
      const normalized = blocker.prompt.split(/\r?\n/).map(normalizeConfirmText).filter(Boolean).join("\n");
      if (!normalized) throw new Error("startup blocker prompt is empty after normalization");
      return { prompt: normalized, reason: blocker.reason };
    });
  }
  /** The reason of the declared blocker on the last screen read, if one was there. */
  get blocked(): string | undefined {
    return this.#blocked;
  }
  /** The key to press, if any; `done` ends the watch. */
  observe(screen: string): { key?: "Down" | "Enter"; done: boolean } | undefined {
    if (this.#done) return undefined;
    const lines = screen.split(/\r?\n/).map(normalizeConfirmText).filter(Boolean);
    const matches = (prompt: string): boolean => {
      const expected = prompt.split("\n");
      return lines.some((_, start) => expected.every((line, offset) => lines[start + offset] === line));
    };
    this.#blocked = this.#blockers.find((blocker) => matches(blocker.prompt))?.reason;
    if (this.#blocked !== undefined) { this.#seen = undefined; this.#readySeen = false; return undefined; }
    let index = this.#step;
    while (this.#before[index]?.optional && !matches(this.#before[index].prompt)) index++;
    const step = this.#before[index];
    if (!step || !matches(step.prompt)) {
      this.#seen = undefined;
      const final = this.#before.length ? matches(this.#final) : normalizeConfirmText(screen).includes(this.#final);
      if (final) { this.#done = true; return { key: "Enter", done: true }; }
      // A harness may skip the confirmation and open its input screen. Seeing a ready text within
      // one visible line, on two consecutive snapshots, ends the watch without a key. A declared
      // dialog still on screen is not that input screen, even when its displayed path has the text.
      const ready = lines.some((line) => this.#ready.some((text) => line.includes(text)))
        && !this.#before.some((reply) => matches(reply.prompt));
      if (!ready) { this.#readySeen = false; return undefined; }
      if (!this.#readySeen) { this.#readySeen = true; return undefined; }
      this.#done = true;
      return { done: true };
    }
    this.#readySeen = false;
    if (this.#seen !== index) { this.#seen = index; return undefined; }
    this.#step = index + 1;
    this.#seen = undefined;
    return { key: step.key, done: false };
  }
}

export function unmatchedConfirmMessage(prompt: string, timeoutMs: number, blocked?: string): string {
  return blocked === undefined
    ? `Cotal startup confirmation failed: prompt ${JSON.stringify(prompt)} did not appear within ${timeoutMs}ms.`
    : `Cotal startup confirmation failed: ${blocked}`;
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
  private active = true;
  private readonly matcher: StartupConfirmMatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sequence: StartupConfirmSequence | undefined;

  /** Throws for a prompt that can never match, so a runtime refuses it before it starts a child.
   * Choices and ready texts are read from the screen; a bare prompt is matched in the output. */
  constructor(prompt: string, before: readonly StartupReply[] = [], ready: readonly string[] = [], blockers: readonly StartupBlocker[] = []) {
    this.matcher = new StartupConfirmMatcher(prompt);
    const sequence = new StartupConfirmSequence(prompt, before, ready, blockers);
    this.sequence = before.length || ready.length || blockers.length ? sequence : undefined;
  }

  /** The failure becomes the exit's diagnostic, because a TUI may never show it where an operator looks. */
  arm(diagnostic: ConnectorDiagnosticReader, failure: StartupConfirmFailure, pane?: {
    read(): string | undefined; key(key: "Down" | "Enter"): void;
  }): void {
    if (!this.active) return;
    const fail = (message: string): void => {
      this.disarm();
      diagnostic.recordStop(message);
      failure.report(message);
      failure.stop();
    };
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    this.timer = setTimeout(() => fail(unmatchedConfirmMessage(this.matcher.prompt, CONFIRM_TIMEOUT_MS, this.sequence?.blocked)), CONFIRM_TIMEOUT_MS);
    if (this.sequence) {
      if (!pane) { fail("Cotal startup confirmation failed: this runtime has no screen-based startup choices."); return; }
      const poll = (): void => {
        if (!this.active || Date.now() >= deadline) return;
        try {
          const screen = pane.read();
          if (screen === undefined) { this.disarm(); return; }
          if (!this.active || Date.now() >= deadline) return;
          const action = this.sequence!.observe(screen);
          if (action?.key) pane.key(action.key);
          if (action?.done) { this.disarm(); return; }
          this.pollTimer = setTimeout(poll, 250);
        } catch (error) { fail(`Cotal startup confirmation failed: ${(error as Error).message}`); }
      };
      this.pollTimer = setTimeout(poll, 250);
    }
  }

  /** True once, for the chunk that completes the prompt; the runtime answers it with Enter. */
  push(chunk: string): boolean {
    if (!this.active || this.sequence || !this.matcher.push(chunk)) return false;
    this.disarm();
    return true;
  }

  /** End confirmation authority before stopping the child or processing further output. */
  disarm(): void {
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.pollTimer);
    this.timer = undefined;
    this.pollTimer = undefined;
  }
}
