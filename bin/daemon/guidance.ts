import { existsSync, readdirSync } from "node:fs";
import { authDir, codeSpan, CommandFailure, findPreparedSpace, hasUserAuthState, homeCotalDir, isMeshRegistryError, meshFile, meshesDir, MeshRegistryError, oneLine, preparedSpacesDir, readMeshRegistry, resolveOnPath, shellPath, windowsShellWord, type MeshEntry, type PreparedSpace } from "@cotal-ai/workspace";
import type { AccountComputerStatus } from "./account-state.js";

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

function shellArg(value: string): string {
  return process.platform === "win32"
    ? windowsShellWord(value) ?? `'${value.replaceAll("'", "''")}'`
    : shellPath(value);
}

/** A copyable command for this daemon. Tuples keep option values distinct from boolean flags;
 *  leading-hyphen values need `=` even when shell-quoted. */
export function daemonCommandCopy(op: string, home?: string, args: readonly (string | readonly [string, string])[] = []): string {
  const words: (string | readonly [string, string])[] = ["cotal", "daemon", op, ...args];
  if (home !== undefined && home !== homeCotalDir()) words.push(["--daemon-home", home]);
  return words.map(word => typeof word === "string" ? shellArg(word)
    : `${word[0]}${word[1].startsWith("-") ? "=" : " "}${shellArg(word[1])}`).join(" ");
}

function cotalCommandCopy(op: string, args: readonly (string | readonly [string, string])[] = []): string {
  const words: (string | readonly [string, string])[] = ["cotal", op, ...args];
  return words.map(word => typeof word === "string" ? shellArg(word)
    : `${word[0]}${word[1].startsWith("-") ? "=" : " "}${shellArg(word[1])}`).join(" ");
}

type UnreadableRecordSource = "mesh-dir" | "mesh-record" | "prepared";

function unreadableSpaceRecordRefusal(space: string, error: MeshRegistryError, source: UnreadableRecordSource): CommandFailure {
  const file = oneLine(error.file);
  const forgetCommand = codeSpan(cotalCommandCopy("space", ["forget", ...(space.startsWith("-") ? ["--", space] : [space])]));
  const summary = error.summary
    ? `${oneLine(error.summary).replace(/^mesh registry file /, "Space registration file ")}.`
    : undefined;
  const message = summary
    ?? (source === "mesh-dir"
      ? `The space registrations folder ${file} could not be read.`
      : source === "prepared" && error.file === preparedSpacesDir()
        ? `The prepared spaces folder ${file} could not be read.`
        : source === "prepared"
          ? `Prepared space record ${file} cannot be read as a valid record.`
          : `Space registration file ${file} cannot be read as a valid record.`);
  const remedy = error.remedy ?? (source === "mesh-dir" || (source === "prepared" && error.file === preparedSpacesDir())
    ? `Restore read access to ${shellArg(error.file)}, then try again.`
    : `Restore ${shellArg(error.file)} from backup, or remove it with ${forgetCommand}.`);
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", message, {
    target: { space, file: error.file },
    remedy,
    native: { code: "UNAVAILABLE" },
    cause: error,
  });
}

/** The daemon also reads the shared registrations folder while assembling status. */
export function unreadableStatusRegistrations(space: string): CommandFailure | undefined {
  const dir = meshesDir();
  try {
    readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return unreadableSpaceRecordRefusal(space, new MeshRegistryError(dir, "Space registrations could not be read", {
        cause: error,
        ...(code === "ENOTDIR" ? { remedy: `Restore the space registrations folder at ${shellArg(dir)}, then try again.` } : {}),
      }), "mesh-dir");
    }
  }
  return undefined;
}

function accountDesiredRefusal(space: string, summary: string, account: AccountComputerStatus | undefined, idpUrl: string | undefined, home?: string): CommandFailure | undefined {
  const accounts = account?.accounts?.length ? account.accounts : (account ? [account] : []);
  const desired = account?.spaces.find(row => row.space === space && row.desired);
  if (!desired) return undefined;
  const holding = accounts.find(entry => entry.spaces.some(row => row.space === space && row.desired))
    ?? (accounts.length === 1 ? accounts[0] : undefined);
  const provider = holding?.idpUrl ?? idpUrl;
  const statusCommand = codeSpan(daemonCommandCopy("status", home));
  if (desired.observed === "removed on this computer") {
    return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Space ${space} was disconnected on this computer, so the background service is not hosting its Manager. ${summary}`, {
      target: { space },
      remedy: `Run ${codeSpan(daemonCommandCopy("setup", home, [["--space", space], ...(accounts.length > 1 && provider ? [["--idp", provider] as const] : [])]))} to reconnect it here.`,
      native: { code: "ACCOUNT_DESIRED" },
    });
  }
  if (holding?.mode === "sign-in-required") {
    return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Space ${space} is enabled on this account computer, and its account requires sign-in before the background service can host its Manager. ${summary}`, {
      target: { space },
      remedy: provider ? `Run ${codeSpan(daemonCommandCopy("login", home, [["--idp", provider]]))} to restore sign-in.` : `Inspect ${statusCommand} for the account's sign-in state.`,
      native: { code: "ACCOUNT_DESIRED" },
    });
  }
  if (desired.lastRefusal) {
    const setupArgs = accounts.length > 1 && provider ? [["--idp", provider] as const] : [];
    const remedy = desired.lastRefusal === "no available application"
      ? `Install an agent application, then run ${codeSpan(daemonCommandCopy("setup", home, setupArgs))} in a terminal that finds it.`
      : (desired.lastRefusal === "not-signed-in" || desired.lastRefusal === "credential-expired") && provider
        ? `Run ${codeSpan(daemonCommandCopy("login", home, [["--idp", provider]]))} to restore sign-in.`
        : desired.custodyRecovery
          ? "Open the Cotal app and choose Use signed-in account to confirm moving this connection."
          : `Inspect ${statusCommand} for the account computer status. The background service retries automatically.`;
    return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Space ${space} is enabled on this account computer, but its Manager could not start. Reason: ${oneLine(desired.lastRefusal).replace(/\.$/, "")}. ${summary}`, {
      target: { space },
      remedy,
      native: { code: "ACCOUNT_DESIRED" },
    });
  }
  if (holding?.message) {
    return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Space ${space} is enabled on this account computer, but the background service could not update the account connection. Reason: ${oneLine(holding.message).replace(/\.$/, "")}. ${summary}`, {
      target: { space },
      remedy: `Inspect ${statusCommand} for the account computer status. The background service retries automatically.`,
      native: { code: "ACCOUNT_DESIRED" },
    });
  }
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `Space ${space} is enabled on this account computer, and the background service has not started its Manager yet. ${summary}`, {
    target: { space },
    remedy: `Nothing needs to be run. Check ${statusCommand} again shortly.`,
    native: { code: "ACCOUNT_DESIRED" },
  });
}

function unregisteredSpaceRemedy(space: string, account: AccountComputerStatus | undefined, home?: string): string {
  const accounts = account?.accounts?.length ? account.accounts : (account ? [account] : []);
  const signedIn = accounts.filter(entry => entry.idpUrl && (entry.mode === "account" || entry.mode === "per-space"));
  if (signedIn.length > 0) {
    return `Run ${codeSpan(daemonCommandCopy("setup", home, [["--space", space]]))} to discover this space from your signed-in account and host its Manager here.`;
  }
  if (account?.mode === "sign-in-required" && account.idpUrl) {
    return `Run ${codeSpan(daemonCommandCopy("setup", home, [["--space", space], ["--idp", account.idpUrl]]))} to sign in and host its Manager here.`;
  }
  return "Run `cotal space` to list the spaces registered on this computer.";
}

/** Refuse `daemon status --space` when the daemon does not host a Manager for `space`. */
export function unhostedManagerStatusRefusal(space: string, hostedSpaces: readonly string[], home?: string, account?: AccountComputerStatus): CommandFailure {
  const hosted = [...new Set(hostedSpaces)].sort();
  const hostedList = hosted.length ? `Spaces hosted by the background service: ${hosted.join(", ")}.` : undefined;
  let entry: MeshEntry | undefined;
  let prepared: PreparedSpace | undefined;
  let readingPrepared = false;
  try {
    const { entries, unusable } = readMeshRegistry();
    const ownUnusable = unusable.find(error => error.file === meshFile(space));
    if (ownUnusable) return unreadableSpaceRecordRefusal(space, ownUnusable, "mesh-record");
    entry = entries.find(item => item.space === space);
    if (!entry) {
      readingPrepared = true;
      const found = findPreparedSpace(space);
      if (found) {
        try {
          if (!hasUserAuthState(found.root, space, { readOnly: true })) prepared = found;
        } catch (authError) {
          const authFile = (authError as NodeJS.ErrnoException).path ?? authDir(found.root);
          return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `User-auth state in ${oneLine(authFile)} could not be read.`, {
            target: { space, file: authFile },
            remedy: `Restore read access to ${shellArg(authFile)}, then try again.`,
            native: { code: "UNAVAILABLE" },
            cause: authError,
          });
        }
      }
    }
  } catch (error) {
    if (!isMeshRegistryError(error)) throw error;
    const source: UnreadableRecordSource = readingPrepared ? "prepared" : error.file === meshesDir() ? "mesh-dir" : "mesh-record";
    return unreadableSpaceRecordRefusal(space, error, source);
  }
  const desiredSummary = hostedList ?? "It is not hosting any spaces yet.";
  const desired = accountDesiredRefusal(space, desiredSummary, account, entry?.userAuth?.idp.url, home);
  if (desired) return desired;
  if (!entry && !prepared) {
    const summary = hostedList ?? "The background service is not hosting any spaces.";
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `Space ${space} is not registered on this computer. ${summary}`, {
      target: { requested: space },
      remedy: unregisteredSpaceRemedy(space, account, home),
      native: { code: "NOT_REGISTERED" },
    });
  }
  const summary = hostedList ?? "It is not hosting any spaces.";
  if (entry?.origin !== "up" && entry?.mode === "user" && entry.userAuth?.remote === true) {
    const setupCommand = codeSpan(daemonCommandCopy("setup", home, [["--space", space]]));
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `The background service does not host a Manager for ${space}. ${summary}`, {
      target: { space },
      remedy: `Run ${setupCommand} to host its Manager here.`,
      native: { code: "NOT_REQUESTED" },
    });
  }
  const localRoot = entry?.root ?? prepared!.root;
  const statusCommand = codeSpan(cotalCommandCopy("status", [["--space", space]]));
  return new CommandFailure("refused", "TARGET_NOT_FOUND", `The background service does not run local spaces, so it does not host a Manager for ${space} (${oneLine(localRoot)}). ${summary}`, {
    target: { space },
    remedy: entry
      ? `Run ${statusCommand} to inspect its local stack in ${oneLine(localRoot)}.`
      : `Run \`cotal up\` in ${oneLine(localRoot)} to start its local stack.`,
    native: { code: "NOT_REQUESTED" },
  });
}
