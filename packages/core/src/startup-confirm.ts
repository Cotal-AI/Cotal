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
}

/** The seat package repeats this small matcher because it has no core dependency. Both operate on
 * current screen snapshots, never scrollback accumulated from an earlier dialog. */
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
    // Workspace paths can contain the warning text. Prefer a real menu over that text and match
    // whole visible lines, rather than a substring in the displayed path.
    if (!step || !matches(step.prompt)) {
      this.#stable = false;
      const final = this.#before.length ? matches(this.#final) : normalizeConfirmText(screen).includes(this.#final);
      if (!final) return undefined;
      this.#done = true;
      return { key: "Enter", done: true };
    }
    // A partial first paint is not an interactive menu yet. Require the same choice on two
    // consecutive snapshots; a changed screen clears the observation instead of receiving a key.
    if (!this.#stable) { this.#stable = true; return undefined; }
    this.#step++;
    this.#stable = false;
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

/** Honor {@link LaunchSpec.confirm} and its optional preceding choices within one startup bound.
 * No key is sent for an unrelated dialog, after exit, or after the final confirmation. */
export function confirmWatch(prompt: string, before: readonly StartupReply[] = []): (pane: ConfirmPane) => void {
  // Validate before a runtime starts a child, but allocate mutable state per watch.
  new StartupConfirmSequence(prompt, before);
  return (pane) => {
    const sequence = new StartupConfirmSequence(prompt, before);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    const poll = (): void => {
      let failure = `Cotal startup confirmation failed: prompt ${JSON.stringify(prompt)} did not appear within ${CONFIRM_TIMEOUT_MS}ms.`;
      try {
        if (Date.now() < deadline) {
          const screen = pane.read();
          if (screen === undefined) return;
          if (Date.now() < deadline) {
            const action = sequence.observe(screen);
            if (action?.key === "Down") {
              if (!pane.down) throw new Error("this runtime cannot answer a Down startup choice");
              pane.down();
            } else if (action) pane.enter();
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
