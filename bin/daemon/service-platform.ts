import { systemdUserServiceRequirement } from "@cotal-ai/cli";
import { CommandFailure } from "@cotal-ai/workspace";

/** Native Linux installation needs systemd, independently of a session's user bus. */
export function daemonServiceRequirement(): CommandFailure | undefined {
  const requirement = systemdUserServiceRequirement();
  if (!requirement) return undefined;
  return new CommandFailure("refused", requirement.code, requirement.message, {
    remedy: "Run `cotal daemon serve` under your own supervisor (an OpenRC user service, runit or s6), and run `cotal update --self` by hand for updates",
  });
}
