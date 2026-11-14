/**
 * The macOS adapter for `cotal daemon install`: a LaunchAgent in the signed-in user's GUI domain.
 *
 * The plist goes to `~/Library/LaunchAgents`, the per-user agents directory launchd loads at login,
 * and `launchctl bootstrap gui/<uid>` loads it now. `RunAtLoad` starts the daemon whenever the job
 * is loaded, at install and at each login, and `KeepAlive` starts it again whenever it exits, spaced
 * by launchd's default ten-second throttle. Its output goes to `daemon.log` in the daemon's own
 * state directory. It runs in the user's session, so it never needs root.
 *
 * Ownership is the receipt's. The plist is created at an absent name and its digest recorded before
 * launchd sees it, and a label launchd already has refuses the install. `uninstall` boots out the
 * label only while that exact plist is unchanged. `launchctl print` output is documented as not an
 * interface, so it is never parsed; only its exit status is read, where 113 means the domain has no
 * such service.
 *
 * A LaunchDaemon in the system domain is the separate headless profile and is not offered here.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirNoSymlink, realDirNoSymlink } from "@cotal-ai/core";
import { darwinLaunchdJob, type DarwinLaunchdLookup } from "@cotal-ai/seat";
import { CommandFailure } from "@cotal-ai/workspace";
import { assertSystemdSource, createSystemdSource } from "@cotal-ai/cli";
import type { NativePlan, NativeRun, NativeService, UnitReceipt } from "./install.js";

const LAUNCHCTL = "/bin/launchctl";
/** `launchctl print`'s exit status when the domain has no service with that label. */
const NOT_LOADED = 113;

/** `ai.cotal.daemon`, or `ai.cotal.daemon.<16 hex>` for an explicit daemon home, derived as its
 *  socket directory is. */
export function launchAgentLabel(daemonHome: string | undefined): string {
  if (daemonHome === undefined) return "ai.cotal.daemon";
  return `ai.cotal.daemon.${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}`;
}

import { xmlText } from "./install-xml.js";
export { xmlText } from "./install-xml.js";

export interface LaunchAgentInput {
  readonly label: string;
  readonly argv: readonly string[];
  readonly searchPath: string;
  readonly workingDirectory: string;
  readonly logPath: string;
}

/** The plist this install writes. launchd execs `ProgramArguments` directly, with no shell. */
export function renderLaunchAgent(input: LaunchAgentInput): { text: string; sha256: string } {
  if ([input.argv[0] ?? "", input.workingDirectory, input.logPath].some((path) => !isAbsolute(path))) throw new CommandFailure("refused", "USAGE_INVALID", "the LaunchAgent needs absolute executable, working and log paths");
  const str = (value: string) => `<string>${xmlText(value)}</string>`;
  input.argv.forEach(xmlText);
  const daemon = input.argv.indexOf("daemon");
  const cli = input.argv[daemon - 1];
  if (daemon < 2 || input.argv[daemon + 1] !== "serve" || !cli || !isAbsolute(cli)
    || !input.argv.slice(1, daemon - 1).every((flag) => /^--[A-Za-z][A-Za-z0-9-]*(?:=[^\s"]*)?$/.test(flag))) {
    throw new CommandFailure("refused", "UNSUPPORTED", "the LaunchAgent needs the durable Node daemon serve entry; no launcher was substituted");
  }
  // launchd's job dictionary omits WorkingDirectory. Carry it in the exact argument vector instead;
  // this entry changes directory before importing the CLI, including any cwd-sensitive setup.
  // Resolve our entry from this module, not argv's CLI symlink (a global install may live in bin/).
  const bootstrap = fileURLToPath(new URL("../daemon-cwd.js", import.meta.url));
  const argv = [...input.argv.slice(0, daemon - 1), bootstrap, input.workingDirectory, ...input.argv.slice(daemon)];
  const entry = (key: string, value: string) => `<key>${key}</key>${str(value)}`;
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    entry("Label", input.label),
    `<key>ProgramArguments</key><array>${argv.map(str).join("")}</array>`,
    `<key>EnvironmentVariables</key><dict>${entry("PATH", input.searchPath)}${entry("COTAL_DAEMON_NATIVE_SERVICE", "1")}</dict>`,
    entry("StandardOutPath", input.logPath),
    entry("StandardErrorPath", input.logPath),
    "<key>RunAtLoad</key><true/>",
    "<key>ExitTimeOut</key><integer>90</integer>",
    "<key>KeepAlive</key><true/>",
    "</dict></plist>",
    "",
  ].join("\n");
  if (Buffer.byteLength(text) > 64 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "the LaunchAgent exceeds its bounded source size");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

/** A boolean key's value in the bytes that will be written, so a receipt never states a policy the
 *  plist does not carry. */
function plistFlag(text: string, key: string): string {
  const value = new RegExp(`<key>${key}</key><(true|false)/>`).exec(text)?.[1];
  return value === undefined ? "absent" : `${key}=${value}`;
}

function uid(): number {
  const id = process.getuid?.();
  if (id === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this platform has no user id for a launchd GUI domain");
  if (id === 0) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "a LaunchAgent runs in the signed-in user's GUI domain, and this is root; nothing was written", { remedy: "run \`cotal daemon install\` as the desktop user who will run the daemon, without sudo" });
  return id;
}

/** The user's real home, owned by them, with its real `Library`. */
function libraryOf(id: number): string {
  const home = homedir();
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(home); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the macOS account home could not be inspected; no LaunchAgent location was adopted"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== id) throw new CommandFailure("refused", "CONFLICT", "the macOS account home is not a real directory owned by this user; no LaunchAgent location was adopted");
  let library: string | null;
  try { library = realDirNoSymlink(home, "Library"); }
  catch { library = null; }
  if (!library) throw new CommandFailure("refused", "CONFLICT", "the macOS account has no real Library directory; no LaunchAgent location was adopted");
  return library;
}

export function launchAgentService(run: NativeRun, lookup: (label: string) => DarwinLaunchdLookup = darwinLaunchdJob): NativeService {
  const loaded = (id: number, label: string): boolean => {
    const read = run(LAUNCHCTL, ["print", `gui/${id}/${label}`]);
    if (read.status === 0) return true;
    if (read.status === NOT_LOADED) return false;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `launchd's GUI domain gui/${id} did not answer for ${label} (${read.detail}); nothing was changed`, { remedy: "run this from a logged-in macOS desktop session of the user who will run the daemon" });
  };
  const step = (args: readonly string[]): void => {
    const result = run(LAUNCHCTL, args);
    if (result.status !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `launchctl ${args.join(" ")} did not confirm completion (${result.detail}); it was not retried`, { remedy: "inspect it with launchctl print, then remove the recorded plist with \`cotal daemon uninstall\`" });
  };
  /** Whether the recorded job is loaded, refused unless it is this daemon's label and unchanged plist. */
  const owned = (receipt: UnitReceipt): boolean => {
    // A receipt names only the label and plist this daemon home derives, so it can never steer a
    // bootout at another job.
    const label = launchAgentLabel(receipt.daemonHome);
    if (receipt.unit !== label || receipt.unitPath !== join(libraryOf(uid()), "LaunchAgents", `${label}.plist`)) throw new CommandFailure("refused", "CONFLICT", `the recorded job ${receipt.unit} is not this daemon's LaunchAgent; nothing was removed`);
    try { assertSystemdSource(receipt.unitPath, receipt.unitSha256); }
    catch { throw new CommandFailure("refused", "CONFLICT", `${receipt.unitPath} is not the plist this daemon installed; nothing was removed`); }
    const isLoaded = loaded(uid(), label);
    if (isLoaded) {
      const observed = lookup(label);
      if (observed.state !== "loaded") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the loaded LaunchAgent definition could not be verified; nothing was changed");
      const source = readFileSync(receipt.unitPath, "utf8");
      const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
      const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(source)?.[1];
      const expected = array === undefined ? undefined : [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => decode(match[1]!));
      const working = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(source)?.[1];
      const job = observed.job;
      const daemon = expected?.indexOf("daemon") ?? -1;
      const bootstrap = expected?.[daemon - 2];
      const directory = expected?.[daemon - 1];
      const cwdInArguments = daemon >= 3 && expected?.[daemon + 1] === "serve"
        && bootstrap !== undefined && isAbsolute(bootstrap) && basename(bootstrap) === "daemon-cwd.js"
        && directory !== undefined && isAbsolute(directory)
        && expected!.slice(1, daemon - 2).every((flag) => /^--[A-Za-z][A-Za-z0-9-]*(?:=[^\s"]*)?$/.test(flag));
      // Legacy plists keep their original proof requirement. An absent native field never clears
      // one of those receipts, and an unrecognised directory-free launcher is not adopted.
      const workingMatches = working !== undefined ? job.workingDirectory === decode(working)
        : !source.includes("<key>WorkingDirectory</key>") && cwdInArguments;
      if (!expected?.length || !workingMatches || job.label !== label || job.program !== expected[0] || JSON.stringify(job.programArguments) !== JSON.stringify(expected)) {
        throw new CommandFailure("refused", "CONFLICT", "the loaded LaunchAgent does not prove the recorded program, arguments and working directory; nothing was changed");
      }
    }
    return isLoaded;
  };
  return {
    mechanism: "launchd-agent",
    plan(paths, daemonHome, argv, searchPath): NativePlan {
      const id = uid();
      const library = libraryOf(id);
      const label = launchAgentLabel(daemonHome);
      const unitPath = join(library, "LaunchAgents", `${label}.plist`);
      let agents: string | null;
      try { agents = realDirNoSymlink(library, "LaunchAgents"); }
      catch { throw new CommandFailure("refused", "CONFLICT", "~/Library/LaunchAgents is not a real directory; no plist path was adopted"); }
      let present = false;
      if (agents) {
        try { lstatSync(unitPath); present = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `${unitPath} could not be inspected; no absent plist was inferred`); }
      }
      if (present) throw new CommandFailure("refused", "CONFLICT", `${unitPath} already exists and no install of this daemon recorded it; it was not written over`);
      if (loaded(id, label)) throw new CommandFailure("refused", "CONFLICT", `launchd already has a job labelled ${label} in gui/${id} that no install of this daemon recorded; nothing was written`);
      const { text, sha256 } = renderLaunchAgent({ label, argv, searchPath: searchPath(), workingDirectory: homedir(), logPath: join(paths.state, "daemon.log") });
      return { mechanism: "launchd-agent", unit: label, unitPath, bytes: Buffer.from(text), sha256, user: userInfo().username, restart: plistFlag(text, "KeepAlive"), wantedBy: `login to gui/${id} (${plistFlag(text, "RunAtLoad")})` };
    },
    publish(plan) {
      // ~/Library is the user's own; only the LaunchAgents directory under it is created, 0700.
      ensureDirNoSymlink(libraryOf(uid()), "LaunchAgents");
      createSystemdSource(plan.unitPath, plan.bytes.toString("utf8"), plan.sha256);
    },
    register(plan) {
      const id = uid();
      // `enable` clears a disabled override a previous `launchctl disable` left for this label.
      step(["enable", `gui/${id}/${plan.unit}`]);
      step(["bootstrap", `gui/${id}`, plan.unitPath]);
    },
    check(receipt: UnitReceipt) {
      owned(receipt);
    },
    start(receipt: UnitReceipt) {
      const id = uid();
      if (owned(receipt)) step(["kickstart", `gui/${id}/${receipt.unit}`]);
      else step(["bootstrap", `gui/${id}`, receipt.unitPath]);
    },
    restart(receipt: UnitReceipt, reload = false) {
      const id = uid();
      const isLoaded = owned(receipt);
      if (reload) {
        if (isLoaded) {
          step(["bootout", `gui/${id}/${receipt.unit}`]);
          const deadline = Date.now() + 10_000;
          const pause = new Int32Array(new SharedArrayBuffer(4));
          while (loaded(id, receipt.unit)) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the LaunchAgent ${receipt.unit} did not unload within 10s; no bootstrap was submitted`, { remedy: "run the same setup command again to start the recorded service" });
            Atomics.wait(pause, 0, 0, Math.min(100, remaining));
          }
        }
        step(["bootstrap", `gui/${id}`, receipt.unitPath]);
      } else if (isLoaded) step(["kickstart", "-k", `gui/${id}/${receipt.unit}`]);
      else step(["bootstrap", `gui/${id}`, receipt.unitPath]);
    },
    remove(receipt: UnitReceipt, preserveSource = false) {
      const id = uid();
      if (owned(receipt)) step(["bootout", `gui/${id}/${receipt.unit}`]);
      if (!preserveSource) rmSync(receipt.unitPath, { force: true });
    },
  };
}
