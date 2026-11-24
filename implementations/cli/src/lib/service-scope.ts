import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveOnPath } from "@cotal-ai/workspace";

type Launch = { program: string; args: readonly string[]; cwd: string };

/** `launch` started in a systemd user scope of its own, when a systemd user manager answers.
 *  Linux apps such as T3 Code run each agent in a scope and stop that scope when its session
 *  ends, which ends every process in it, even one that started a session of its own. A service
 *  an agent started outside such a scope then outlives it.
 *
 *  With --scope, systemd-run execs the command once the scope holds it, so the process keeps its
 *  PID, start time, stdio and environment; systemd only adds INVOCATION_ID. If the scope cannot
 *  be made, systemd-run exits with its error and the launch fails; it is not retried unscoped.
 *
 *  Off Linux, or with no XDG_RUNTIME_DIR, no systemd-run or no user bus, there is no user manager,
 *  and so no scope of the caller to leave: `launch` is returned as it is. */
export function inOwnScope(launch: Launch, env: NodeJS.ProcessEnv, unit: { space: string; instanceId: string; launchRequestId: string }): Launch {
  const runner = userScopeRunner(env);
  if (!runner) return launch;
  // One unit per launch, so a relaunch never meets an earlier launch's scope that a descendant still holds.
  const name = `cotal-${createHash("sha256").update(unit.space).digest("hex").slice(0, 12)}-${unit.instanceId}-${unit.launchRequestId}.scope`;
  return { ...launch, program: runner, args: ["--user", "--scope", "--quiet", "--collect", `--unit=${name}`, "--", launch.program, ...launch.args] };
}

/** The systemd-run to start a scope with, once the user manager answers on `env`'s runtime directory. */
function userScopeRunner(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "linux" || !env.XDG_RUNTIME_DIR) return undefined;
  const runner = resolveOnPath("systemd-run", env), systemctl = resolveOnPath("systemctl", env);
  if (!runner || !systemctl) return undefined;
  const answer = spawnSync(systemctl, ["--user", "show", "--property=Version", "--value"], { env, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 5000 });
  return answer.status === 0 && answer.stdout.trim() ? runner : undefined;
}
