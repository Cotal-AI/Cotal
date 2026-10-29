import { strict as assert } from "node:assert";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherSource } from "@cotal-ai/core";
import { visibilityDetail, waitUntilVisible } from "./probe.js";
import { privateLauncher } from "./src/runtime.js";

let checks = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

let time = 0;
const seen = await waitUntilVisible(() => 1, {
  deadlineMs: 0,
  intervalMs: 1,
  now: () => time,
  sleep: async (ms) => { time += ms; },
});
check("visible payload is observed on the first sample", seen.kind === "seen" && seen.tries === 1);
check("seen detail names the observed count", visibilityDetail(seen).startsWith("1 seen"));

const absent = await waitUntilVisible(() => 0, {
  deadlineMs: 0,
  intervalMs: 1,
  now: () => time,
  sleep: async (ms) => { time += ms; },
});
check("absent payload is a deadline, never success", absent.kind === "deadline" && absent.lastCount === 0);

const runtimeSource = readFileSync(fileURLToPath(new URL("./src/runtime.ts", import.meta.url)), "utf8");
check("herdr runtime delegates launcher generation to core", !runtimeSource.includes("function launcherSource") && !runtimeSource.includes("process.chdir(launch.cwd)"));

if (process.platform !== "win32") {
  const secret = "herdr-package-test-secret";
  const payload = { cwd: process.cwd(), command: process.execPath, args: ["-e", ""], env: { TOKEN: secret } };
  const launcher = privateLauncher({ command: payload.command, args: payload.args, env: payload.env }, payload.cwd);
  try {
    const scriptText = readFileSync(launcher.script, "utf8");
    check("launcher argv does not expose secret env", launcher.argv[0] === process.execPath && launcher.argv[1] === launcher.script && !launcher.argv.join(" ").includes(secret));
    check("launcher script is owner-only", (statSync(launcher.script).mode & 0o777) === 0o600);
    check("launcher directory is owner-only", (statSync(dirname(launcher.script)).mode & 0o777) === 0o700);
    check("secret is confined to the private launcher", scriptText.includes(secret));
    check("privateLauncher writes the exact core launcherSource output", scriptText === launcherSource("[cotal-herdr-launch]", payload));
  } finally {
    rmSync(launcher.dir, { recursive: true, force: true });
  }
}

console.log(`HERDR PACKAGE TESTS: ${checks} tests executed`);
