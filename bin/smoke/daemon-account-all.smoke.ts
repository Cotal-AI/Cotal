/** Account computer acceptance: real daemon HTTP, process crash, and real broker reconciliation. */
import { spawn } from "node:child_process";
for (const [file, ...args] of [
  ["bin/smoke/daemon-account.smoke.ts"],
  ["bin/smoke/daemon-account-crash.smoke.ts"],
  ["bin/smoke/daemon-service-connect.smoke.ts", "--hosting-only", "--account-only"],
  ["bin/smoke/daemon-service-connect.smoke.ts", "--hosting-only", "--account-only", "--account-hosted"],
  ["bin/smoke/daemon-service-connect.smoke.ts", "--hosting-only", "--signin-parity"],
]) {
  const child = spawn(process.execPath, ["--import", "tsx", file!, ...args], { stdio: "inherit", env: process.env });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`account computer suite failed: ${file} (${code})`);
}
console.log("account computer acceptance suite passed");
