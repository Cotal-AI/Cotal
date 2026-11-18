import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeSecretFile } from "@cotal-ai/core";
import { cmdSpawnSpec, win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock } from "@cotal-ai/workspace";
import type { SetupCommand } from "./machine-setup-command.js";

let cancelled = false;
let exitConfirmed = true;
process.once("disconnect", () => { cancelled = true; });
const input = await new Promise<SetupCommand | undefined>((resolve) => {
  process.once("message", resolve);
  process.once("disconnect", () => resolve(undefined));
});
process.on("message", (message: { cancel?: unknown }) => { if (message.cancel === true) cancelled = true; });
if (input === undefined) process.exit(0);

async function run({ file, args, cwd, maxBuffer, timeoutMs }: SetupCommand) {
  const spec = cmdSpawnSpec(file, args);
  const native = win32ProcessBinding();
  const dir = mkdtempSync(join(tmpdir(), "cotal-setup-"));
  const log = join(dir, "command.log");
  try {
    writeSecretFile(log, "");
    if (cancelled) return { status: null, output: "native setup cancelled" };
    const commandLine = spec.windowsVerbatimArguments ? `${windowsCommandLine(spec.file, [])} ${spec.args[0]}` : windowsCommandLine(spec.file, spec.args);
    const environment = windowsEnvironmentBlock(process.env);
    exitConfirmed = false;
    native.launch({ application: spec.file, commandLine, cwd, environment, log });
    let status: number | undefined;
    let failure: string | undefined;
    try {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        if (cancelled) failure = "native setup cancelled";
        else if (performance.now() >= deadline) failure = `native setup command timed out after ${timeoutMs} ms`;
        else if (statSync(log).size > maxBuffer) failure = "native setup command exceeded its output limit";
        else {
          status = native.rootExit();
          if (status === undefined || native.accounting().active > 0) { await delay(20); continue; }
        }
        break;
      }
    } finally {
      // Even an output read failure must retire the job before the parent sees a result.
      const deadline = performance.now() + 10_000;
      while (native.drain(0) !== "drained") {
        if (performance.now() >= deadline) throw new Error("native setup job drain is unconfirmed");
        await delay(20);
      }
      exitConfirmed = true;
    }
    if (failure) return { status: null, output: failure };
    if (statSync(log).size > maxBuffer) return { status: null, output: "native setup command exceeded its output limit" };
    return { status: status ?? null, output: readFileSync(log, "utf8").trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const result = await run(input).catch((error: unknown) => {
  // No result without proof: the Manager must not infer a drain from the helper's exit.
  if (!exitConfirmed) throw error;
  return { status: null, output: error instanceof Error ? error.message : String(error) };
});
if (process.connected) await new Promise<void>((resolve) => process.send?.(result, () => resolve()));
process.exit(0);
