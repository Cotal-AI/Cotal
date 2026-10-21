import { spawn } from "node:child_process";
import { finishOwnedChild, observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";

/** Run only the new tree's CLI in its explicit private cwd/environment, without a shell. */
export async function foregroundCliProbe(
  entry: string, tsx: string, cwd: string, env: NodeJS.ProcessEnv, args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, ["--import", tsx, entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = observeOwnedChild(child);
  let out = "", err = "";
  child.stdout.on("data", (data: Buffer) => { out += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { err += data.toString(); });
  try {
    await waitForOwnedChild(() => state.exited || state.error !== undefined, 15_000, `public CLI ${args[0]} exit`);
    if (state.error) throw state.error;
    await waitForOwnedChild(() => state.closed, 3_000, `public CLI ${args[0]} streams`);
    return { code: state.code, out, err };
  } finally {
    await finishOwnedChild(child, state, () => {}, () => [], `public CLI ${args[0]}`);
  }
}
