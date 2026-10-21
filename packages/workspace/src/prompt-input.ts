import type { Readable } from "node:stream";

/**
 * Ask one clack prompt that ends when its input does. Ctrl-D on an empty line closes clack's own
 * readline without settling the prompt, and so does a closed stdin; the process then drains and
 * exits 13 with Node's unsettled top-level await warning. Both are answered here as the cancel
 * Ctrl-C gives, so the caller's own cancelled branch reports and exits.
 *
 * A Ctrl-D is acted on only after every keypress listener ran and only when it left the input
 * paused, which is what a closed readline does. Mid-line it deletes, as readline has it.
 */
export async function untilInputEnds<T>(ask: (signal: AbortSignal) => Promise<T | symbol>, input: Readable = process.stdin): Promise<T | symbol> {
  const ended = new AbortController();
  let settled = false;
  const end = () => { if (!settled) ended.abort(); };
  const key = (_text: unknown, pressed?: { ctrl?: boolean; name?: string }) => {
    if (pressed?.ctrl && pressed.name === "d") setImmediate(() => { if (input.isPaused()) end(); });
  };
  if (input.readableEnded || input.destroyed) end();
  input.once("end", end);
  input.once("close", end);
  input.on("keypress", key);
  try {
    return await ask(ended.signal);
  } finally {
    settled = true;
    input.off("end", end);
    input.off("close", end);
    input.off("keypress", key);
  }
}
