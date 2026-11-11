import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkForUpdate, newerUpdate, readUpdateCheck, readUpdateRecovery, readUpdateSettings, UPDATE_DAY_MS, UPDATE_HOUR_MS } from "@cotal-ai/workspace";

/** The detached worker holds no terminal and has a bounded registry read. */
export async function updateCheckWorker(): Promise<void> {
  try { await checkForUpdate(); } catch { /* Optional checks never change command success. */ }
}

export function installUpdateNotice(argv: readonly string[], current: string): void {
  if (process.env.COTAL_NO_UPDATE_CHECK === "1" || process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.BUILD_NUMBER || !process.stdout.isTTY || !process.stderr.isTTY || argv.some(arg => ["--json", "-j", "--plain"].includes(arg))) return;
  const word = argv.find(arg => !arg.startsWith("-"));
  if (word === "update" || word === "daemon" || word?.startsWith("__") || ["supervise", "deliver", "agent-bearer"].includes(word ?? "")) return;
  try {
    if (!readUpdateSettings().notify) return;
    const cached = readUpdateCheck();
    if (!cached || Date.now() - (cached.checkedAt ?? 0) >= UPDATE_DAY_MS && Date.now() - cached.attemptedAt >= UPDATE_HOUR_MS) {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./cotal.js", import.meta.url)), "__update-check"], { detached: true, stdio: "ignore", env: process.env, windowsHide: true });
      child.on("error", () => {});
      child.unref();
    }
    const recovery = readUpdateRecovery();
    const message = recovery ? `Cotal update needs repair (installed ${recovery.installed}, previous ${recovery.previous}); automatic updates paused. Run cotal update --self.` : cached?.latest && newerUpdate(cached.latest, current) ? `Cotal update available: ${current} -> ${cached.latest}. Run cotal update --self.` : undefined;
    if (message) process.once("exit", () => process.stderr.write(`${message}\n`));
  } catch { /* Optional notice state cannot make a working command fail. */ }
}
