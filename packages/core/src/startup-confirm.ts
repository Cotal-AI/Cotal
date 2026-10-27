import type { LaunchSpec } from "./connector.js";

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC = /\x1b(?:.|$)/g;
const POLL_MS = 250;
const CONFIRM_TIMEOUT_MS = 15_000;

function normalizeConfirmText(value: string): string {
  return value.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(/\s+/g, "");
}

/** Optional startup choices before the required final confirmation. Keys are a closed vocabulary,
 * not arbitrary terminal input. Each choice is answered at most once and in order. */
export interface StartupReply {
  prompt: string;
  key: "Down" | "Enter";
  /** The choice may never appear, for example one of two layouts a harness draws a dialog in. While
   * it is not on screen, the next choice can be answered instead, which skips this one for good. */
  optional?: boolean;
}

/** A native startup screen the watch never answers, such as a harness's first-run setup or a safety
 * warning only its user may accept. No key is sent while one is on screen. When the startup bound
 * ends with one on screen, the failure names its `reason` instead of the prompt that did not appear. */
export interface StartupBlocker {
  prompt: string;
  reason: string;
}

/** The seat package repeats this small matcher because it has no core dependency. Both operate on
 * current screen snapshots, never scrollback accumulated from an earlier dialog. */
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
    // A blocker is left for the startup bound to end, so a person at the pane can still answer it.
    this.#blocked = this.#blockers.find((blocker) => matches(blocker.prompt))?.reason;
    if (this.#blocked !== undefined) { this.#seen = undefined; this.#readySeen = false; return undefined; }
    // An optional choice that is not on screen does not block the choice after it. Answering a
    // later choice passes over the optional ones before it for good.
    let index = this.#step;
    while (this.#before[index]?.optional && !matches(this.#before[index].prompt)) index++;
    const step = this.#before[index];
    // Workspace paths can contain the warning text. Prefer a real menu over that text and match
    // whole visible lines, rather than a substring in the displayed path.
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
    // A partial first paint is not an interactive menu yet. Require the same choice on two
    // consecutive snapshots; a changed screen clears the observation instead of receiving a key.
    if (this.#seen !== index) { this.#seen = index; return undefined; }
    this.#step = index + 1;
    this.#seen = undefined;
    return { key: step.key, done: false };
  }
}

/** A seat's current pane. All operations must be bounded. */
export interface ConfirmPane {
  /** Return only the current screen, not scrollback. Undefined means the child exited.
   * A blocked read prevents the watch from stopping the child, so it must be bounded. */
  read(): string | undefined;
  /** Press Enter in the pane. */
  enter(): void;
  /** Required when the connector declares a Down choice. */
  down?(): void;
  /** Stop the child and report the failure. Must not throw from the watch's timer. */
  fail(message: string): void;
}

/** Honor {@link LaunchSpec.confirm}, its optional preceding choices, its ready texts and its blockers
 * within one startup bound. No key is sent for an unrelated dialog, after exit, or once the watch is done. */
export function confirmWatch(prompt: string, before: readonly StartupReply[] = [], ready: readonly string[] = [], blockers: readonly StartupBlocker[] = []): (pane: ConfirmPane) => void {
  // Validate before a runtime starts a child, but allocate mutable state per watch.
  new StartupConfirmSequence(prompt, before, ready, blockers);
  return (pane) => {
    const sequence = new StartupConfirmSequence(prompt, before, ready, blockers);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    const poll = (): void => {
      const blocked = sequence.blocked;
      let failure = blocked === undefined
        ? `Cotal startup confirmation failed: prompt ${JSON.stringify(prompt)} did not appear within ${CONFIRM_TIMEOUT_MS}ms.`
        : `Cotal startup confirmation failed: ${blocked}`;
      try {
        if (Date.now() < deadline) {
          const screen = pane.read();
          if (screen === undefined) return;
          if (Date.now() < deadline) {
            const action = sequence.observe(screen);
            if (action?.key === "Down") {
              if (!pane.down) throw new Error("this runtime cannot answer a Down startup choice");
              pane.down();
            } else if (action?.key === "Enter") pane.enter();
            if (action?.done) return;
            setTimeout(poll, POLL_MS);
            return;
          }
        }
      } catch (err) {
        failure = `Cotal startup confirmation failed: ${(err as Error).message}`;
      }
      pane.fail(failure);
    };
    setTimeout(poll, POLL_MS);
  };
}
