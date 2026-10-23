import * as p from "./prompts.js";

/** Treat a clack cancel (Ctrl-C / Esc) as quitting setup, cleanly. clack traps SIGINT
 *  inside a prompt and returns its cancel symbol instead of exiting; route those here so
 *  Ctrl-C aborts setup rather than falling through to a default. `message` is the closing line,
 *  for a flow that is not setup. */
export function abortIfCancel<T>(value: T, message = "Setup cancelled."): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}
