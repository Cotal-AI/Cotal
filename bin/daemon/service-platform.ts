import { existsSync } from "node:fs";
import { CommandFailure, resolveOnPath } from "@cotal-ai/workspace";

/** Native Linux installation needs systemd, independently of a session's user bus. */
export function daemonServiceRequirement(): CommandFailure | undefined {
  if (process.platform !== "linux" || (existsSync("/run/systemd/system") && resolveOnPath("systemctl"))) return undefined;
  return new CommandFailure("refused", "UNSUPPORTED", "the Linux daemon background service requires systemd, with /run/systemd/system present and systemctl on PATH; this environment does not provide it", {
    remedy: "run `cotal daemon serve` under your own supervisor (an OpenRC user service, runit or s6), and run `cotal update --self` by hand for updates",
  });
}
