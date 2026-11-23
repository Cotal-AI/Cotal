/** Act at the foreground `up` receipt boundary, before the startup callback returns. */
import { renameSync } from "node:fs";
import { stdout } from "node:process";

const write = stdout.write;
let sent = false;
stdout.write = function (this: typeof stdout, ...args: unknown[]): boolean {
  const written = Reflect.apply(write, this, args) as boolean;
  if (!sent && String(args[0]).includes("Controller stack started")) {
    sent = true;
    const moved = process.env.COTAL_SMOKE_RENAME_AT_RECEIPT;
    if (moved) renameSync(process.cwd(), moved);
    else process.kill(process.pid, "SIGTERM");
  }
  return written;
} as typeof stdout.write;
