import { existsSync } from "node:fs";
import { codeSpan, CommandFailure, findPreparedSpace, hasUserAuthState, homeCotalDir, isMeshRegistryError, meshFile, readMeshRegistry, resolveOnPath, shellPath, windowsShellWord } from "@cotal-ai/workspace";

/** An unavailable systemd installation is different from an unreachable systemd user manager. */
export function daemonServiceRequirement(home?: string): CommandFailure | undefined {
  if (process.platform !== "linux" || (existsSync("/run/systemd/system") && resolveOnPath("systemctl"))) return undefined;
  return new CommandFailure("refused", "UNSUPPORTED", "The Linux background service requires systemd. This environment does not provide both a running systemd and systemctl on PATH.", {
    remedy: `Manage an existing systemd service from an environment with systemd and systemctl on PATH as the same user. If no daemon is installed or running, run ${codeSpan(daemonCommandCopy("serve", home))} under your own supervisor. Use \`cotal update --self\` for manual updates.`,
  });
}

export const NON_USER_AUTH_MESSAGE = "this space does not use user sign-in. The machine service hosts Managers only for user-auth participant spaces";
export const NON_USER_AUTH_REMEDY = "run `cotal up` in the folder that hosts the local space. Its stack runs the Manager";

export function foreignDaemonUpdateReport(entry: string): string {
  return `machine daemon: the background service belongs to another Cotal installation (${entry}). This update did not start or stop it.`;
}

export const windowsDaemonHomeAccess = "its owner must be you, SYSTEM or Administrators, and its Windows ACL may grant access only to those accounts";

/** Name PowerShell when its quoting is needed to copy the daemon home unchanged. */
export function windowsDaemonRemedy(op: "install" | "serve" | "start", home?: string): string {
  const shell = home !== undefined && home !== homeCotalDir() && windowsShellWord(home) === undefined ? " in PowerShell" : "";
  return `${codeSpan(daemonCommandCopy(op, home))}${shell}`;
}

export function windowsDaemonFirstStart(home?: string): string {
  return `install a scheduled task with ${windowsDaemonRemedy("install", home)}, or run the daemon in the foreground with ${windowsDaemonRemedy("serve", home)}`;
}

/** A copyable command for this daemon. Tuples keep option values distinct from boolean flags;
 *  leading-hyphen values need `=` even when shell-quoted. */
export function daemonCommandCopy(op: string, home?: string, args: readonly (string | readonly [string, string])[] = []): string {
  const quote = process.platform === "win32"
    ? (value: string) => windowsShellWord(value) ?? `'${value.replaceAll("'", "''")}'`
    : shellPath;
  const words: (string | readonly [string, string])[] = ["cotal", "daemon", op, ...args];
  if (home !== undefined && home !== homeCotalDir()) words.push(["--daemon-home", home]);
  return words.map(word => typeof word === "string" ? quote(word)
    : `${word[0]}${word[1].startsWith("-") ? "=" : " "}${quote(word[1])}`).join(" ");
}

/** Refuse `daemon status --space` when the daemon does not host a Manager for `space`. */
export function unhostedManagerStatusRefusal(space: string, hostedSpaces: readonly string[], home?: string): CommandFailure {
  const hosted = [...new Set(hostedSpaces)].sort();
  const setupCommand = codeSpan(daemonCommandCopy("setup", home, [["--space", space]]));
  let entry;
  let localPrepared = false;
  try {
    const { entries, unusable } = readMeshRegistry();
    if (unusable.some(error => error.file === meshFile(space))) {
      return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "The mesh registry could not be read for this space.", {
        remedy: `Run ${codeSpan(daemonCommandCopy("spaces", home))} to identify unreadable records, then restore the mesh registry.`,
        native: { code: "UNAVAILABLE" },
      });
    }
    entry = entries.find(item => item.space === space);
    if (!entry) {
      const prepared = findPreparedSpace(space);
      localPrepared = Boolean(prepared && !hasUserAuthState(prepared.root, space, { readOnly: true }));
    }
  } catch (error) {
    if (!isMeshRegistryError(error)) throw error;
    return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "The mesh registry could not be read for this space.", {
      remedy: `Run ${codeSpan(daemonCommandCopy("spaces", home))} to identify unreadable records, then restore the mesh registry.`,
      native: { code: "UNAVAILABLE" },
    });
  }
  if (!entry && !localPrepared) {
    const summary = hosted.length
      ? `Hosted spaces on this computer: ${hosted.join(", ")}.`
      : "This computer is not hosting any spaces.";
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `Space ${space} is not registered on this computer. ${summary}`, {
      target: { requested: space },
      remedy: `Check the name with \`cotal space\`, or run ${setupCommand} to add this space and host it here.`,
      native: { code: "NOT_REGISTERED" },
    });
  }
  const summary = hosted.length
    ? `Hosted spaces on this computer: ${hosted.join(", ")}.`
    : "It is not hosting any spaces.";
  const remedy = entry?.mode === "user"
    ? `Run ${setupCommand} to host its Manager here.`
    : "Run `cotal up` in the folder that hosts the local space. Its stack runs the Manager.";
  return new CommandFailure("refused", "TARGET_NOT_FOUND", `This computer is not hosting a Manager for ${space}. ${summary}`, {
    target: { space },
    remedy,
    native: { code: "NOT_REQUESTED" },
  });
}
