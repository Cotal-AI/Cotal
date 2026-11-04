/** Preloaded into a foreground `up` by foreground-up-signals. The CLI sends itself SIGTERM while it
 *  writes its start receipt, the start's last step, so the signal lands before the start returns:
 *  a moment a sender outside the process reaches only by chance. */
import { stdout } from "node:process";

const write = stdout.write;
let sent = false;
stdout.write = function (this: typeof stdout, ...args: unknown[]): boolean {
  const written = Reflect.apply(write, this, args) as boolean;
  if (!sent && String(args[0]).includes("Controller stack started")) {
    sent = true;
    process.kill(process.pid, "SIGTERM");
  }
  return written;
} as typeof stdout.write;
