/** CI acceptance for copied-install generation changes and guarded manual update admission. */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
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
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
if (args.includes("--retired-app-runtime")) {
  const app = join(root, "Cotal.app", "Contents");
  const runtime = join(app, "Resources", "runtime");
  mkdirSync(dirname(runtime), { recursive: true });
  mkdirSync(join(app, "MacOS"));
  renameSync(join(fixture, "hoisted-fix2-0.151.2"), runtime);
  copyFileSync(process.execPath, join(app, "MacOS", "cotal-node"));
  writeFileSync(join(runtime, "desktop-runtime.json"), "{}\n");
  await run([join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "bin/smoke/daemon-service-connect.smoke.ts"), "--hosting-only"], { ...env, COTAL_DAEMON_RETIRED_APP_RUNTIME: runtime });
  console.log("daemon-generation-live: retired app runtime acceptance passed");
  process.exit(0);
}
const cases = args.includes("--manual-admission-repros")
  ? [["--update-repro", "--manual-admission-race-repro"], ["--update-repro", "--manual-admission-empty-repro"]]
  : [args.length ? args : ["--upgrade-active-repro", "--watcher-seat-repro"]];
for (const flags of cases) {
  await run([join(repo, "node_modules/tsx/dist/cli.mjs"), join(repo, "bin/smoke/daemon-service-connect.smoke.ts"), "--hosting-only", ...(flags.includes("--update-repro") ? [] : ["--upgrade-repro"]), ...flags], { ...env, COTAL_DAEMON_UPGRADE_FIXTURE: fixture });
}
console.log("daemon-generation-live: copied-install generation acceptance passed");
