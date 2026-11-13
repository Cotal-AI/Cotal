/** launchd owns this one-shot process until the existing updater has exited. */
import { spawn } from "node:child_process";
import { closeSync, ftruncateSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPrivateAppend, writeSecretFileAtomic } from "@cotal-ai/core";
import { homeCotalDir, readUpdateSettings, UPDATE_HOUR_MS } from "@cotal-ai/workspace";
import { admitLaunchUpdate, launchUpdateResultPath, readLaunchUpdateResult } from "./update-launchd.js";

admitLaunchUpdate(process.argv[2] ?? "");
const attemptPath = join(homeCotalDir(), "update-attempt.json");
try {
  if (!readUpdateSettings().auto || process.env.COTAL_NO_UPDATE_CHECK === "1") {
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, result: "automatic updates disabled before launchd handoff", next: Date.now() + UPDATE_HOUR_MS })}\n`);
  } else {
    const log = openPrivateAppend(join(homeCotalDir(), "update-attempt.log"));
    let code: number | null;
    try {
      ftruncateSync(log, 0);
      code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../cotal.js", import.meta.url)), "update", "--self"], {
          env: { ...process.env, COTAL_AUTO_UPDATE: "1", COTAL_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", log, log],
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally { closeSync(log); }
    if (code !== 0) throw new Error(`updater exited with ${code ?? "a signal"}; inspect update-attempt.log`);
  }
} catch (error) {
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
  writeSecretFileAtomic(attemptPath, `${JSON.stringify({ ...attempt, result: `launchd automatic update refused: ${error instanceof Error ? error.message : String(error)}. Run \`cotal update --self\``, next: Date.now() + UPDATE_HOUR_MS })}\n`);
  process.exitCode = 1;
} finally {
  const result = readLaunchUpdateResult();
  if (!result || result.pid !== process.pid) throw new Error("automatic update runner lost its result receipt");
  writeSecretFileAtomic(launchUpdateResultPath(), `${JSON.stringify({ ...result, done: true })}\n`);
}
