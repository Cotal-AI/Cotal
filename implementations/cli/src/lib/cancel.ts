import * as p from "./prompts.js";

/** Treat a clack cancel (Ctrl-C / Esc) as quitting the guided flow, cleanly, with `message` as its
 *  last line. clack traps SIGINT inside a prompt and returns its cancel symbol instead of exiting;
 *  route those here so Ctrl-C aborts rather than falling through to a default. */
export function abortIfCancel<T>(value: T, message = "Setup cancelled."): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}
