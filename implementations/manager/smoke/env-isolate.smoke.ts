/**
 * Runtime environment boundary: a connector-declared launch spec is the full child environment for
 * pty and tmux. Ordinary parent values are withheld; explicit launch values are preserved.
 *
 * Run: pnpm smoke:env-isolate
 */
import { execFileSync } from "node:child_process";
import { createRuntime } from "../src/index.js";
import "@cotal-ai/cmux";
import "@cotal-ai/tmux";
import { launchEnv } from "@cotal-ai/connector-core";
import type { LaunchSpec } from "@cotal-ai/core";

let failures = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  console.log(`${pass ? "✓" : "✗"} ${name}${pass ? "" : `: ${String(detail ?? "")}`}`);
  if (!pass) failures++;
};
const secret = "P3_OPERATOR_SECRET";
const explicit = "P3_EXPLICIT_CAPABILITY";
process.env[secret] = "withhold-me";
process.env[explicit] = "opt-in-value";
const cwd = process.cwd();

async function childEnv(
  spawnFn: (spec: LaunchSpec) => { attach: () => unknown; stop: (opts?: { graceful?: boolean }) => void },
): Promise<string> {
  const spec: LaunchSpec = {
    command: process.execPath,
    args: ["-e", "for (const [k,v] of Object.entries(process.env)) console.log(`${k}=${v}`)"],
    env: launchEnv({ envAllow: [explicit] }),
  };
  const handle = spawnFn(spec);
  const session = handle.attach() as { onData: (fn: (data: Buffer) => void) => () => void; onExit: (fn: () => void) => () => void };
  let output = "";
  session.onData((data) => { output += data.toString("utf8"); });
  await new Promise<void>((resolve) => session.onExit(resolve));
  handle.stop({ graceful: false });
  return output;
}

function assertBoundary(label: string, output: string): void {
  console.log(`${label}:`);
  check("ordinary operator value is withheld", !output.includes(`${secret}=withhold-me`), output);
  check("explicit value reaches child", output.includes(`${explicit}=opt-in-value`), output);
  check("PATH reaches child", /(^|\n)PATH=/i.test(output), output);
  const home = process.platform === "win32" ? "USERPROFILE" : "HOME";
  check(`${home} reaches child`, new RegExp(`(^|\\n)${home}=`).test(output), output);
}

{
  const runtime = createRuntime("pty", "cotal-p3");
  const raw = await childEnv((spec) => runtime.spawn("p3-pty", spec, cwd));
  assertBoundary("pty runtime", raw.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
}

let tmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); tmux = true; } catch { /* optional runtime */ }
if (tmux) {
  const runtime = createRuntime("tmux", "cotal-p3-smoke");
  const spec: LaunchSpec = { command: "sh", args: ["-c", "printenv; sleep 5"], env: launchEnv({ envAllow: [explicit] }) };
  const handle = runtime.spawn("p3-tmux", spec, cwd);
  await new Promise((resolve) => setTimeout(resolve, 900));
  let output = "";
  try { output = execFileSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", "cotal-p3-smoke:p3-tmux"], { encoding: "utf8" }); } catch { /* window closed */ }
  assertBoundary("tmux runtime", output);
  handle.stop({ graceful: false });
  try { execFileSync("tmux", ["kill-session", "-t", "cotal-p3-smoke"], { stdio: "ignore" }); } catch { /* stopped */ }
} else {
  console.log("• tmux runtime skipped (tmux not installed)");
}

delete process.env[secret];
delete process.env[explicit];
process.exit(failures === 0 ? 0 : 1);
