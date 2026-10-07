import type { LaunchSpec } from "./connector.js";

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC = /\x1b(?:.|$)/g;
const POLL_MS = 250;

/** How long a runtime waits for a {@link LaunchSpec.confirm} prompt before it ends the seat. */
const CONFIRM_TIMEOUT_MS = 15_000;

/** Normalize terminal text according to {@link LaunchSpec.confirm}: ignore ANSI control sequences and whitespace. */
function normalizeConfirmText(value: string): string {
  return value.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(/\s+/g, "");
}

/** A seat's pane, as a {@link confirmWatch} watch drives it from a timer. */
export interface ConfirmPane {
  /** The text the pane shows now, or undefined once the seat has exited. Must be bounded: it runs
   *  on the event loop, and the watch cannot end the seat while a read is still blocked. */
  read(): string | undefined;
  /** Press Enter in the pane. */
  enter(): void;
  /** End the seat and report `message`. Must not throw: nothing above the timer can catch it. */
  fail(message: string): void;
}

/**
 * Honor {@link LaunchSpec.confirm} for a runtime that reads its pane instead of owning the child's
 * output: the returned watch presses Enter once when the declared text is on screen, and ends the
 * seat with the pty runtime's message when it is not there within {@link CONFIRM_TIMEOUT_MS}. An
 * Enter sent without looking answers whatever dialog the harness shows first with that dialog's
 * default. The prompt is checked here so a runtime refuses it before it opens the pane.
 */
export function confirmWatch(prompt: string): (pane: ConfirmPane) => void {
  const needle = normalizeConfirmText(prompt);
  if (!needle) throw new Error("startup confirmation prompt is empty after ANSI and whitespace normalization");
  return (pane) => {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    const poll = (): void => {
      let failure: string;
      try {
        const screen = pane.read();
        if (screen === undefined) return;
        if (Date.now() < deadline) {
          if (normalizeConfirmText(screen).includes(needle)) return pane.enter();
          setTimeout(poll, POLL_MS);
          return;
        }
        failure = `Cotal startup confirmation failed: prompt ${JSON.stringify(prompt)} did not appear within ${CONFIRM_TIMEOUT_MS}ms.`;
      } catch (err) {
        failure = `Cotal startup confirmation failed: ${(err as Error).message}`;
      }
      pane.fail(failure);
    };
    setTimeout(poll, POLL_MS);
  };
}
