/** CI acceptance for an installed replacement waiting on seats, then activating after stop. */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-generation-live: Linux only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// All copies stay under this suite's private TMPDIR. The invoking lane owns cleanup once no
// process can enter them. Never merge artifact assembly into an existing install.
const root = mkdtempSync(join(tmpdir(), "daemon-generation-ci-"));
const fixture = join(root, "packages");
async function run(args: string[], env = process.env): Promise<void> {
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: "inherit" });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`generation acceptance subprocess exited ${code}`);
}
await run([join(repo, "bin/smoke/build-daemon-upgrade-fixture.mjs"), fixture, "--workspace-source"]);
const args = process.argv.slice(2);
await run([join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "bin/smoke/daemon-service-connect.smoke.ts"), "--hosting-only", "--upgrade-repro", ...(args.length ? args : ["--upgrade-active-repro", "--watcher-seat-repro"])], { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), COTAL_DAEMON_UPGRADE_FIXTURE: fixture });
console.log("daemon-generation-live: copied-install generation acceptance passed");
