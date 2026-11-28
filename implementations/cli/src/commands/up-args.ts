import { isIP } from "node:net";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SERVICE_AUTHORITY_MAX_BYTES, SERVICE_CALLER_PAYLOAD_FLOOR, type ParsedArgs } from "@cotal-ai/core";
import {
  parseSeatCapFlag,
  CommandFailure,
  codeSpan,
  assertSingleSpaceBroker,
  authDir,
  soleSpaceOf,
  listSpaceAccounts,
  canonicalRoot,
  rootPathProblem,
  rootControlProblem,
  findMesh,
  findPreparedSpace,
  homeCotalDir,
  getCurrent,
  preparedSpaceAt,
  projectRootProblem,
  projectRootProblemText,
  localMeshesForRoot,
  presentationOf,
  parsePositiveIntegerFlag,
  meshesForRoot,
  userAuthSpacesOnDisk,
  readMaintenanceJournal,
  readBrokerPolicy,
  rootNamesNoSpace,
  SPACE_NAME_MAX,
  spaceNameTooLong,
} from "@cotal-ai/workspace";
import { localDiagnostic } from "../telemetry.js";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { resolveSpace } from "../lib/status.js";
import { cotalRoot, homeHoldsStack, linkedCotalRefusal, upRootWriteProblem } from "../lib/paths.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { displayCmd } from "../lib/self-exec.js";
import { managerRecordState } from "../lib/manager-proc.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { liveMeshProcesses } from "./clean.js";
import { checkSpaceFlagValue, checkSpaceName } from "./meshes-add.js";
import { checkLocalSpace } from "./space-registration.js";
import { checkPublicExchangePort, preparedUpRoot } from "./up-target.js";
import { retainedOpenSpace } from "../lib/legacy-start.js";
import { bindReaches, controllerStackApplies, requestsTls } from "./stack-up.js";
import { readStackJournal, refuseControllerCut } from "../lib/stack-journal.js";
import { serviceInstances } from "../lib/service-instances.js";
import { serviceSupervisorStore } from "../lib/service-supervision.js";
import { serviceInstallIntents } from "../lib/service-install-intent.js";
import { serviceUninstallIntents } from "../lib/service-uninstall-intent.js";
import { serviceUnitActionStore } from "../lib/service-unit-action.js";
import { assertStoreDirArgument, startupStoreProblem } from "../lib/store-dir.js";
import { parseMaxFileStore, parseAuthTimeout, parseMaxPayload, assertManagerPayload, parseAccountResolver, tlsAddress } from "./up-transport.js";
import { tlsDialName, WILDCARD_HOSTS } from "./up-host.js";

/** `--recreate-issued-stores <backup-dir>` names a directory the step creates, so it must not exist
 *  and its parent must. Checked before anything starts; the step checks again when it creates it. */
function assertIssuedBackupDirArgument(raw: string): void {
  const dir = resolve(raw);
  const problem = !raw.trim() ? "is empty" : existsSync(dir) ? `${dir} already exists` : !existsSync(dirname(dir)) ? `${dirname(dir)} does not exist` : undefined;
  if (problem) throw new CommandFailure("refused", "USAGE_INVALID", `--recreate-issued-stores names a new backup directory, and ${problem}; nothing was started`, { target: { backupDir: dir }, remedy: "name a directory that does not exist yet, inside one that does" });
}

/** Launch intent is checked by the kernel before seed or effect preparation. A recovery
 *  re-entry supplies its recorded mode explicitly rather than inheriting the new public default. */
export function validateUpArguments(args: ParsedArgs, beforeRestore = false): void {
  const presentation = presentationOf(args.values);
  if (typeof args.values.file === "string" && !args.values.file.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "--file is empty, so it names no manifest; nothing was started or written", { remedy: "name a manifest with --file <cotal.yaml>, or omit --file to start the folder's stack" });
  if (args.values.restore === "")
    throw new CommandFailure("refused", "USAGE_INVALID", "--restore is empty, so it names no backup folder; nothing was started or written", { remedy: "pass the backup folder as --restore <dir>, or omit --restore to start without restoring", selfContained: true });
  // A `.cotal` that is a link, or leads nowhere, is refused before anything reads through it.
  const linked = args.values.root === undefined ? linkedCotalRefusal("up") : undefined;
  if (linked) throw linked;
  if (args.values["user-auth"] === true && args.values.open === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--user-auth and --open contradict - a user-auth space cannot run unauthenticated", { remedy: "drop --open for user auth, or drop --user-auth for an open space" });
  if (args.values.open === true) {
    publicExchangeArgs(args.values, false);
    serviceEndpointsArgs(args.values, false);
  } else {
    if (typeof args.values["exchange-public-port"] === "string") checkPublicExchangePort(args.values["exchange-public-port"]);
    const url = args.values["exchange-public-url"];
    if (typeof url === "string" && !url.startsWith("https://"))
      throw new CommandFailure("refused", "USAGE_INVALID", "--exchange-public-url must be an https:// URL (TLS terminates at the reverse proxy); nothing was started or written");
  }
  if (args.values.idp !== undefined && args.values["user-auth"] !== true && !args.values.file)
    throw new CommandFailure("refused", "USAGE_INVALID", '--idp is for user-auth spaces; pair it with --user-auth, or set broker.auth: "user" in a manifest', { remedy: "use --user-auth --idp <auth base URL>, without --open" });
  if (args.values.restore !== undefined && args.values["no-manager"] === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--no-manager cannot be combined with --restore: the restore needs a manager to commit its state; nothing was restored", { remedy: "rerun the restore without --no-manager" });
  if (args.values["no-manager"] === true && args.values.runtime !== undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", "--no-manager cannot be combined with --runtime because no manager starts", { remedy: "drop --runtime, or drop --no-manager to select a manager runtime" });
  // Only an omitted --runtime selects the default runtime. An empty one, as an unset variable gives,
  // is a value that names no runtime (#7114).
  if (typeof args.values.runtime === "string" && !args.values.runtime.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "--runtime is empty, so it names no runtime; nothing was started or written", { remedy: "name a runtime, such as `--runtime pty`, or omit --runtime to use the default" });
  if (args.values["no-manager"] === true && args.values["max-sessions"] !== undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", "--no-manager cannot be combined with --max-sessions because no manager starts", { remedy: "drop --max-sessions, or drop --no-manager to set the manager session ceiling" });
  if (args.values.foreground === true && args.values.detach === true) throw new CommandFailure("refused", "USAGE_INVALID", "choose --foreground or --detach, not both");
  // Only a manifest launch has a plan to print; without -f every route would start the stack.
  if (args.values["dry-run"] === true && !args.values.file && args.values.foreground === true) {
    const cli = presentation === "json" ? "cotal" : displayCmd();
    const boot = `${cli} team boot cotal.yaml --foreground --dry-run${presentation === "rich" ? "" : ` --${presentation}`}`;
    throw new CommandFailure("refused", "USAGE_INVALID", "up cannot preview a terminal-bound launch. Nothing was started or written.", { remedy: `preview the manifest with ${codeSpan(boot)}` });
  }
  if (args.values["dry-run"] === true && !args.values.file)
    throw new CommandFailure("refused", "USAGE_INVALID", "--dry-run previews a manifest launch and needs -f <cotal.yaml>; nothing was started or written", { remedy: `pass -f <cotal.yaml>${presentation === "rich" ? "" : ` and omit --${presentation}`} to print that manifest's plan; \`cotal status\` shows what this folder records` });
  // The stack passes its space to its own children as `--space <name>`, which a leading - breaks.
  const named = typeof args.values.space === "string" ? checkSpaceFlagValue(args.values.space) : undefined;
  if (named && !named.ok) throw new CommandFailure("refused", "USAGE_INVALID", `${named.message.replace(/^✗ /, "")}; nothing was started or written`, { remedy: named.remedy });
  // A manifest boot checks its own `--server` override against `broker.servers`.
  const server = args.values.server as string | undefined;
  const tlsRoot = typeof args.values.root === "string" ? resolve(args.values.root) : freshFolderRoot(args.values) ?? cotalRoot();
  const serverProblem = server !== undefined && !args.values.file ? upServerProblem(server, args.values["tls-cert"] !== undefined || Boolean(tlsDialName(server) && readBrokerPolicy(tlsRoot)?.transport.kind === "tls-required")) : undefined;
  if (serverProblem) throw new FlagValueRefusal(`${serverProblem}; nothing was started or written`, `pass the IP address the local broker listens on, for example ${serverExample(String(args.values.server), args.values.host as string | undefined)}`);
  // A --host that is no bind host, or a bind that does not serve --server's address, refuses here,
  // before the controller stack writes its journal or trust.
  const hostProblem = !args.values.file ? upHostProblem(args.values.host as string | undefined, args.values.server as string | undefined) : undefined;
  if (hostProblem) throw new CommandFailure("refused", "USAGE_INVALID", `${hostProblem.problem}; nothing was started or written`, { remedy: hostProblem.remedy });
  const spaceTooLong = typeof args.values.space === "string" ? spaceNameTooLong(args.values.space) : undefined;
  if (spaceTooLong) throw new CommandFailure("refused", "USAGE_INVALID", `${spaceTooLong}; nothing was started or written`, { remedy: `choose a space name of at most ${SPACE_NAME_MAX} characters` });
  // A prepared or controller-owned root has no route that serves TLS, so any TLS input refuses here,
  // once and naming the route that does, before the checks below send it from one TLS form to another.
  if (!args.values.file && requestsTls(args.values) && !readMaintenanceJournal(tlsRoot)) controllerStackApplies(tlsRoot, (args.values.space as string | undefined) ?? folderSpace(), args.values);
  // A --tls-cert broker serves TLS only, and its address says so, so every client dials tls:// and
  // checks the certificate against the address it names.
  if (!args.values.file && args.values["tls-cert"] !== undefined && typeof args.values.server === "string" && /^nats:\/\//i.test(args.values.server))
    throw new CommandFailure("refused", "USAGE_INVALID", "--tls-cert serves the broker over TLS, so --server must be a tls:// address; nothing was started or written", { remedy: `pass --server ${tlsAddress(args.values.server)}`, selfContained: true });
  if (typeof args.values.file === "string" && args.values.foreground === true)
    throw foregroundManifestRefusal(args.values.file, presentation, args.values["dry-run"] === true, args.values.server !== undefined);
  if (args.values.foreground === true && (args.values.json === true || args.values.plain === true)) throw new CommandFailure("refused", "USAGE_INVALID", "foreground up keeps native terminal custody and cannot produce a finite JSON or plain receipt", { remedy: `omit ${args.values.json ? "--json" : "--plain"} to keep the stack in this terminal, or omit --foreground for a finite receipt from a controller-owned stack` });
  // Flag values and combinations are usage, so they refuse here, before any effect. The run keeps
  // its own checks for maintenance re-entries, which do not pass through this validation.
  parsePositiveIntegerFlag("--max-sessions", args.values["max-sessions"] as string | undefined);
  parseSeatCapFlag("--seat-cap", args.values["seat-cap"] as string | undefined);
  parseMaxFileStore(args.values["max-file-store"] as string | undefined);
  const logFile = args.values["log-file"] as string | undefined;
  if (logFile !== undefined && (!logFile.trim() || /[\u0000-\u001f\u007f]/u.test(logFile)))
    throw new CommandFailure("refused", "USAGE_INVALID", "--log-file must be a non-empty file path without control characters");
  const logfileSizeLimit = parsePositiveIntegerFlag("--logfile-size-limit", args.values["logfile-size-limit"] as string | undefined);
  const logfileMaxNum = parsePositiveIntegerFlag("--logfile-max-num", args.values["logfile-max-num"] as string | undefined);
  // A controller restart can use its saved path. A restore still needs an explicit path.
  if (!args.values.file && logFile === undefined && (logfileSizeLimit !== undefined || logfileMaxNum !== undefined)
    && (args.values.restore !== undefined || readStackJournal(tlsRoot)?.journal.broker?.logFile === undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "--logfile-size-limit and --logfile-max-num require --log-file");
  // The timeout belongs to the auth callout, which only a user-auth space has. A manifest or a
  // restore starts the broker its own record describes, so neither takes it.
  if (parseAuthTimeout(args.values["auth-timeout"] as string | undefined) !== undefined) {
    if (args.values.open === true) throw new CommandFailure("refused", "USAGE_INVALID", "--auth-timeout sets the auth callout's timeout, and an open space has no auth callout; nothing was started", { remedy: "drop --auth-timeout, or start a user-auth space with --user-auth" });
    if (args.values.file !== undefined || args.values.restore !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", `--auth-timeout cannot be combined with ${args.values.file !== undefined ? "--file/-f" : "--restore"}, which starts the broker its own record describes; nothing was started`, { remedy: "start it without --auth-timeout; a recorded timeout is rendered again" });
  }
  // Both broker modes render the payload limit. A manifest or a restore starts the broker its own
  // record describes, so neither takes the flag.
  const requestedPayload = parseMaxPayload(args.values["max-payload"] as string | undefined);
  if (requestedPayload !== undefined) {
    if (args.values.file !== undefined || args.values.restore !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", `--max-payload cannot be combined with ${args.values.file !== undefined ? "--file/-f" : "--restore"}, which starts the broker its own record describes; nothing was started`, { remedy: "start it without --max-payload; a recorded limit is rendered again" });
    // A space that admits service endpoints is a space whose auth host asserts the caller payload
    // precondition at startup, and that assertion REFUSES below the floor, so the auth context does
    // not open at all. Refusing the pair here is the difference between a usage error before
    // anything starts and a broker that comes up without its auth plane.
    if (args.values["service-endpoints"] === true && requestedPayload < SERVICE_CALLER_PAYLOAD_FLOOR)
      throw new CommandFailure("refused", "USAGE_INVALID", `--max-payload ${requestedPayload} is below ${SERVICE_CALLER_PAYLOAD_FLOOR} bytes, the least a space with --service-endpoints starts on: a caller policy row may grow to ${SERVICE_AUTHORITY_MAX_BYTES} bytes and its write needs ${SERVICE_CALLER_PAYLOAD_FLOOR - SERVICE_AUTHORITY_MAX_BYTES} more, so the auth host refuses to open; nothing was started`, { remedy: `pass --max-payload ${SERVICE_CALLER_PAYLOAD_FLOOR} or more, or drop --service-endpoints` });
    if (args.values["no-manager"] !== true) assertManagerPayload(requestedPayload);
  }
  // The account resolver belongs to the auth-mode broker configuration as well: the open broker has
  // no operator and so no accounts to resolve, and a manifest or a restore starts the broker its own
  // record describes.
  if (parseAccountResolver(args.values["account-resolver"] as string | undefined) !== undefined) {
    if (args.values.open === true) throw new CommandFailure("refused", "USAGE_INVALID", "--account-resolver sets how the broker resolves space accounts, and the open broker configuration has none; nothing was started", { remedy: "drop --account-resolver, or start an auth space without --open" });
    if (args.values.file !== undefined || args.values.restore !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", `--account-resolver cannot be combined with ${args.values.file !== undefined ? "--file/-f" : "--restore"}, which starts the broker its own record describes; nothing was started`, { remedy: "start it without --account-resolver; a recorded resolver is rendered again" });
  }
  if (typeof args.values["store-dir"] === "string") assertStoreDirArgument(args.values["store-dir"], typeof args.values.root === "string" ? resolve(args.values.root) : freshFolderRoot(args.values) ?? cotalRoot(), args.values.restore ? "restore" : "start");
  const restoreOnly = args.values["restore-only"];
  if (restoreOnly !== undefined && restoreOnly !== "registry") throw new CommandFailure("refused", "USAGE_INVALID", `--restore-only takes registry (got ${JSON.stringify(restoreOnly)})`);
  if (!args.values.restore && (restoreOnly !== undefined || args.values["accept-missing-source"] === true)) throw new CommandFailure("refused", "USAGE_INVALID", "--restore-only and --accept-missing-source require --restore <dir>");
  if (args.values.file !== undefined && args.values["accept-stale-checkpoint"] === true) throw new FlagValueRefusal("--accept-stale-checkpoint cannot be combined with --file/-f: a manifest starts a fresh mesh, not a preserved stack", "drop --accept-stale-checkpoint for a fresh start, or omit --file/-f to resume a preserved stack");
  if (args.values.restore && (args.values.file !== undefined || args.values.channels !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--restore cannot be combined with --file/-f or --channels");
  if (args.values.restore && args.values["rotate-sys"] === true) throw new CommandFailure("refused", "USAGE_INVALID", "--restore cannot be combined with --rotate-sys", { remedy: "restore the space and verify it first, then rotate: `cotal down`, then `cotal up --rotate-sys`" });
  if (args.values["recreate-issued-stores"] !== undefined) {
    if (args.values.file !== undefined || args.values.restore !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", `--recreate-issued-stores cannot be combined with ${args.values.file !== undefined ? "--file/-f" : "--restore"}; nothing was started`, { remedy: "run `cotal up --space <space> --recreate-issued-stores <backup-dir>` on its own first" });
    assertIssuedBackupDirArgument(String(args.values["recreate-issued-stores"]));
  }
  if (args.values["recreate-membership-store"] === true && (args.values.file !== undefined || args.values.restore !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", `--recreate-membership-store cannot be combined with ${args.values.file !== undefined ? "--file/-f" : "--restore"}; nothing was started`, { remedy: "run `cotal up --space <space> --recreate-membership-store` on its own first" });
  if (args.values.root !== undefined) preparedUpRoot(String(args.values.root));
  else if (!(args.values.file && args.values["dry-run"] === true)) {
    const inheritedRoot = inheritedMachineHomeRoot();
    if (inheritedRoot) {
      if (!freshFolderRoot(args.values)) {
        const retry = args.values.file ? `repeat your manifest command from this folder${presentation === "rich" ? "" : `, but omit --${presentation}`}` : "run `cotal up` again from this folder";
        throw new CommandFailure("refused", "CONFLICT", "this folder inherits the machine's home .cotal; up did not start a stack in that home root", { target: { root: process.cwd(), inheritedRoot }, remedy: `prepare this folder with \`cotal space create <space> --root .\`, then ${retry}` });
      }
    } else {
      const home = machineHomeRoot();
      if (home && !homeHoldsStack(home))
        throw new CommandFailure("refused", "CONFLICT", `${home} is your home folder, whose .cotal holds this machine's own records, so up started no stack there`, { target: { root: home }, remedy: "prepare a project folder with `cotal space create <space> --root <dir>`, then run `cotal up` there, or pass --root <dir> from here" });
    }
  }
  if (args.values.restore !== undefined) refuseControllerCut(args.values.root !== undefined ? preparedUpRoot(String(args.values.root)) : cotalRoot(), "up --restore");
  if (!(args.values.file && args.values["dry-run"] === true)) {
    const root = args.values.root !== undefined ? preparedUpRoot(String(args.values.root)) : freshFolderRoot(args.values) ?? cotalRoot();
    // A path with a control character or a bidirectional formatting mark is refused before any write.
    const pathProblem = rootPathProblem(root) ?? rootPathProblem(canonicalRoot(root));
    if (pathProblem) throw localDiagnostic(new CommandFailure("refused", "USAGE_INVALID", `${pathProblem}; nothing was started or written`, { target: { root }, remedy: "rename the folder without those characters, then run `cotal up` there" }));
    const control = rootControlProblem(root);
    if (control) throw localDiagnostic(new CommandFailure("refused", "CONFLICT", `${control.message}; nothing was started or written`, { target: { root, controlDirectory: control.controlDirectory }, remedy: control.project === undefined
      ? "prepare a project folder with `cotal space create <space> --root <dir>`, then repeat your original startup command with --root set to that folder"
      : `repeat your original startup command with ${codeSpan(`--root ${shellWord(control.project)}`)} for the enclosing project` }));
    assertUpRootWritable(root);
    // A restore creates its own store. A manifest uses the explicit or default store, not a legacy one.
    if (args.values.restore === undefined) assertUpStoreWritable(root, typeof args.values["store-dir"] === "string" ? args.values["store-dir"] : args.values.file === undefined ? undefined : join(root, ".cotal", "nats"), beforeRestore);
  }
}

function foregroundManifestRefusal(file: string, presentation: ReturnType<typeof presentationOf>, dryRun: boolean, serverOverride: boolean): CommandFailure {
  const manifest = serverOverride ? "<manifest-copy>" : shellWord(file.startsWith("-") ? `./${file}` : file);
  const boot = `${presentation === "json" ? "cotal" : displayCmd()} team boot ${manifest} --foreground`;
  const preview = codeSpan(`${boot} --dry-run${presentation === "rich" ? "" : ` --${presentation}`}`);
  const copy = serverOverride ? `copy the manifest beside the original, set ${codeSpan("broker.servers")} in the copy to the URL from ${codeSpan("--server")} without credentials, then ` : "";
  const remedy = dryRun ? `${copy}preview with ${preview}`
    : `prepare the project if needed with \`cotal space create <space> --root .\`, then ${copy}run ${codeSpan(boot)}`;
  return new CommandFailure("refused", "UNSUPPORTED", "manifest boot has no native foreground custody path; a detached broker was not substituted for the requested terminal-bound lifetime", { remedy });
}

function assertUpRootWritable(root: string): void {
  const problem = upRootWriteProblem(root);
  if (problem) throw new CommandFailure("refused", "PERMISSION_DENIED", `${problem.message}; nothing was started or written`, { target: { root, path: problem.path }, remedy: problem.remedy });
}

/** The broker exits when it cannot write its store, naming the cause only in its own log. The store
 *  a start here opens, as `--store-dir` names it, as the stack or legacy records name it, or `.cotal/nats`,
 *  is refused here, by name, when this account cannot write it. */
function assertUpStoreWritable(root: string, storeDir: string | undefined, beforeRestore: boolean): void {
  const problem = startupStoreProblem(root, storeDir, beforeRestore);
  if (problem) throw new CommandFailure("refused", "PERMISSION_DENIED", `${problem.message}; nothing was started or written`, { target: { root, path: problem.path }, remedy: problem.remedy });
}

/** Validate one broker URL without exposing a value that may carry a credential. Only a legacy
 *  TLS start can use a dial name instead of an IP address. */
function upServerProblem(server: string, servesTls: boolean): string | undefined {
  let url: URL;
  try { url = new URL(server); } catch { return "--server is not a URL"; }
  if (url.protocol !== "nats:" && url.protocol !== "tls:") return "--server must be a nats:// or tls:// URL";
  if (url.username || url.password) return "--server must not embed credentials";
  if (url.search || url.hash || (url.pathname && url.pathname !== "/") || server.includes(",")) return "--server must be one broker URL without a path, query or fragment";
  if (!url.hostname) return "--server names no host";
  // An explicit address is taken as given, so a missing port is never filled in with the default.
  if (!url.port) return "--server names no port";
  if (url.port === "0") return "--server needs a TCP port from 1 to 65535";
  if (url.hostname.startsWith("[")) return IPV6_UNSERVED("--server");
  if (!isIP(url.hostname) && !(servesTls && url.protocol === "tls:")) return `--server names the host ${url.hostname}, and up needs the IP address the broker listens on`;
  return undefined;
}

/** Keep a concrete IPv4 bind in the example. A wildcard listener is reachable on loopback. */
function serverExample(server: string, host: string | undefined): string {
  const address = host && isIP(host) === 4 && !WILDCARD_HOSTS.has(host) ? host : "127.0.0.1";
  let port: string | undefined;
  try { port = new URL(server).port || undefined; } catch { port = undefined; }
  port ??= /:(\d{1,5})\/?$/.exec(server)?.[1];
  const valid = port !== undefined && Number(port) >= 1 && Number(port) <= 65535;
  return `--server ${/^tls:/i.test(server) ? "tls" : "nats"}://${address}:${valid ? Number(port) : "<port>"}`;
}

/** The refusal of a manifest start whose effective `--server` or `broker.servers` lists more than
 *  one URL, or undefined when it names one. The start binds one new local broker to one address, so
 *  it does not pick an entry. The manifest still validates with a list, which `topology view` shows.
 *  The message counts the entries and never repeats them, as one may carry a credential. */
export function bindListRefusal(command: string, file: string, space: string, server: string | undefined, servers: string | undefined): CommandFailure | undefined {
  const count = (server ?? servers)?.split(",").filter((entry) => entry.trim()).length ?? 0;
  if (count < 2) return undefined;
  const source = server !== undefined ? "--server" : "broker.servers";
  return new CommandFailure("refused", "USAGE_INVALID", `${source} lists ${count} broker URLs, and ${command} binds a single broker address; nothing was started or written`, {
    target: { space, path: resolve(file), source, entries: count },
    remedy: server !== undefined ? "pass one --server URL for the new broker to listen on" : `set broker.servers in ${file} to the one URL the new broker listens on`,
    selfContained: true,
  });
}

/** The local stack's own clients cannot reach a broker on an IPv6 address, so neither flag may name one. */
const IPV6_UNSERVED = (flag: string): string => `${flag} names an IPv6 address, and the local stack's own clients cannot reach a broker there`;

/** Why `--host` cannot be the local broker's bind address beside `server`, with the step that fixes
 *  it, or undefined when it can. A wildcard bind keeps a loopback URL, so it pairs with any address.
 *  With no `--host` the broker binds 127.0.0.1, so a `--server` naming another IPv4 address needs one. */
function upHostProblem(host: string | undefined, server: string | undefined): { problem: string; remedy: string } | undefined {
  if (host === undefined) {
    const named = server === undefined ? undefined : new URL(server).hostname;
    return named !== undefined && isIP(named) === 4 && named !== "127.0.0.1" && !WILDCARD_HOSTS.has(named)
      ? { problem: `--server ${server} names ${named}, and with no --host the broker binds 127.0.0.1, so it would not listen where its clients connect`, remedy: `pass --host ${named} to bind the broker there` }
      : undefined;
  }
  const remedy = "put the broker URL, including the intended port, in --server and the matching local IP address alone in --host";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return { problem: `--host ${host} looks like a URL, and it takes a bind host only (an IP or hostname, no scheme)`, remedy };
  if (WILDCARD_HOSTS.has(host)) return undefined;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) === 6) return { problem: IPV6_UNSERVED("--host"), remedy: "pass an IPv4 bind address, for example --host 127.0.0.1" };
  let url: URL | undefined;
  try { url = new URL(`nats://${host}:1`); } catch { url = undefined; }
  if (!url || url.port !== "1" || url.pathname || url.search || url.hash || url.username || url.password)
    return { problem: `--host ${host} is not a valid bind host: an IP or hostname only, with no port; the port comes from --server (or its default)`, remedy };
  if (server !== undefined && !tlsDialName(server) && !bindReaches(host, server))
    return { problem: `--host ${host} and --server ${server} name different addresses: the broker would bind ${host} but be probed at ${new URL(server).hostname}`, remedy };
  return undefined;
}

/** The invoking folder, when a bare `up` makes it its own project root: the only `.cotal` above it is
 *  the machine home's. The folder has no records of its own, so `up` starts it as it starts a folder
 *  with no `.cotal` above it. A stack an earlier release started in the home is left as it is and
 *  still starts from the home. A manifest or a restore still needs a prepared folder. */
export function freshFolderRoot(values: ParsedArgs["values"]): string | undefined {
  if (values.root !== undefined || values.file !== undefined || values.restore !== undefined) return undefined;
  return inheritedMachineHomeRoot() !== undefined ? resolve(process.cwd()) : undefined;
}

/** The space a bare `up` starts in a new project: the name of the project folder, when no `--space`
 *  names one and the folder's records name no space. The name passes the rules `space create`
 *  applies, and a name another folder on this machine holds, running, stopped or prepared, refuses
 *  rather than being taken over. Both checks run before anything is written. */
export function folderNamedSpace(values: ParsedArgs["values"]): string | undefined {
  if (values.space !== undefined || values.root !== undefined || values.file !== undefined || values.restore !== undefined) return undefined;
  const root = freshFolderRoot(values) ?? (machineHomeRoot() ? undefined : cotalRoot());
  if (root === undefined || !recordsNameNoSpace(root)) return undefined;
  const space = basename(resolve(root));
  const named = `up names a new project's space after its folder, and`;
  const checked = checkSpaceName(space);
  const invalid = spaceNameTooLong(space) ?? (checked.ok ? undefined : checked.message.replace(/^✗ /, ""));
  if (invalid) {
    const remedy = presentationOf(values) === "rich"
      ? "repeat your startup command with the same options, adding `--space <name>` with a valid unused name"
      : "for a controller-supported start, prepare this folder with `cotal space create <name> --root .` using a valid unused name, then repeat your startup command with the same options; for native startup, add `--space <name>` and omit the output flag instead";
    throw new CommandFailure("refused", "USAGE_INVALID", `${named} the folder name ${JSON.stringify(space)} cannot be one: ${invalid}; nothing was started or written`, { target: { root }, remedy, selfContained: true });
  }
  assertSelectionNotMoved(root, space);
  const held = findMesh(space) ?? findPreparedSpace(space);
  if (held)
    throw new CommandFailure("refused", "CONFLICT", `${named} "${space}" is already ${"server" in held ? `registered at ${held.server}` : "prepared"} for ${held.root}; nothing was started or written`, { target: { root, space, heldBy: held.root }, remedy: "name this folder's space with `cotal up --space <name>`, naming one this machine does not use; `cotal space` lists the names in use" });
  checkLocalSpace(space, root, "--root", false);
  return space;
}

/** Whether no record names a space for `root`: this machine prepared and registered none there, and
 *  it has no `.cotal`, an empty one, or one with no account, stack journal, runtime record, broker
 *  configuration or maintenance attempt. */
export function recordsNameNoSpace(root: string): boolean {
  if (preparedSpaceAt(root) || meshesForRoot(root).length) return false;
  const control = join(root, ".cotal");
  let entries: string[];
  try { entries = readdirSync(control); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  try { if (readMaintenanceJournal(root)) return false; } catch { return false; }
  return entries.length === 0 || rootNamesNoSpace(root);
}

export function inheritedMachineHomeRoot(): string | undefined {
  const root = machineHomeRoot();
  return root !== undefined && canonicalRoot(process.cwd()) !== canonicalRoot(root) ? root : undefined;
}

/** The root this `up` resolves when it is the machine home, whose `.cotal` holds this machine's own records. */
function machineHomeRoot(): string | undefined {
  const root = cotalRoot();
  return canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir()) ? root : undefined;
}

/** The fresh team entry refuses retained custody before `up -f` can write a launch spec,
 *  regenerate trust or stop a leftover manager. Only a recorded local root is eligible. */
export function assertFreshTeamBootOwnership(root: string, space: string, mode?: "open" | "auth" | "user", own?: { deploymentId: string; server: string; manifestPath: string }): void {
  const current = findMesh(space), prepared = findPreparedSpace(space);
  if (!current && !prepared) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "fresh team boot needs a prepared local space; no checkout or machine-home root was guessed", { target: { root, space } });
  if (current && (current.origin !== "up" || canonicalRoot(current.root) !== canonicalRoot(root)) || prepared && canonicalRoot(prepared.root) !== canonicalRoot(root)) throw new CommandFailure("refused", "CONFLICT", "the selected space is externally registered or its prepared root moved; no fresh local boot was started", { target: { root, space } });
  if (current && mode && current.mode !== mode) throw new CommandFailure("refused", "CONFLICT", "the requested fresh boot changes the locally recorded authentication mode; no trust was replaced", { target: { root, space, recordedMode: current.mode, requestedMode: mode } });
  assertSingleSpaceBroker(authDir(root), "team boot");
  const accounts = listSpaceAccounts(authDir(root));
  if (mode === "open" && accounts.length) throw new CommandFailure("refused", "CONFLICT", "the selected root retains a broker account; an open team boot did not bypass its recorded authorization", { target: { root, space } });
  if (accounts.some((hosted) => hosted !== space)) throw new CommandFailure("refused", "CONFLICT", "the local broker root retains another space's account; team boot did not reassign that trust", { target: { root, space } });
  const userSpaces = userAuthSpacesOnDisk(authDir(root));
  if (mode === "user" && (userSpaces.some((hosted) => hosted !== space) || (accounts.includes(space) && !userSpaces.includes(space))))
    throw new CommandFailure("refused", "CONFLICT", "the selected root holds another user-auth space or static trust without matching user-auth state; team boot did not convert its identity", { target: { root, space } });
  if (mode && mode !== "user" && userSpaces.length) throw new CommandFailure("refused", "CONFLICT", "this root retains user-auth state; a static or open team boot did not re-mode its identity", { target: { root, space } });
  if (localMeshesForRoot(root).some((entry) => entry.space !== space)) throw new CommandFailure("refused", "CONFLICT", "another locally registered space uses this broker root; fresh team boot did not reuse or replace its stack", { target: { root, space } });
  if (readMaintenanceJournal(root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a recovery or maintenance attempt; team boot cannot substitute an ordinary startup", { target: { root, space } });
  const manager = managerRecordState(space, root);
  if (manager.state !== "absent") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a manager record remains, including when its process appears dead; team boot will not stop or overwrite it", { target: { root, space, state: manager.state, path: manager.path }, remedy: "inspect the recorded manager and reconcile its own lifecycle before a fresh team boot" });
  const processes = liveMeshProcesses(root, space);
  if (processes.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a local component may still own this stack; team boot did not replace it", { target: { root, space, processes } });
  const instances = serviceInstances(space), supervisors = serviceSupervisorStore(space).list();
  if (instances.length || supervisors.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service-controller instances or supervisor receipts remain for this space; their ownership was not replaced by fresh team boot", { target: { root, space, instances: instances.map((row) => row.name), supervisors: supervisors.map((row) => row.name) }, remedy: "inspect each service instance and its native supervisor before booting the whole stack" });
  const actions = serviceUnitActionStore(space).list();
  if (actions.some((row) => row.name !== row.record.value.instanceId))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "a retained native action filename differs from its full instance ID; no fresh boot ownership was inferred", { target: { root, space } });
  const attempts = [
    ...serviceInstallIntents(space).map((row) => ({ kind: "install", instanceId: row.name, attemptId: row.record.value.attemptId })),
    ...serviceUninstallIntents(space).map((row) => ({ kind: "uninstall", instanceId: row.name, attemptId: row.record.value.attemptId })),
    ...actions.map((row) => ({ kind: "unit-action", instanceId: row.name, attemptId: row.record.value.attemptId })),
  ];
  if (attempts.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "native service attempts remain for this space; a submitted step may have changed state, so fresh team boot did not replace their custody", { target: { root, space, attempts }, remedy: "inspect and reconcile each retained attempt on its original service instance before fresh boot" });
  let ledgers: ReturnType<typeof listLedgerFiles>;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive ledger directory could not be inspected; no absence of prior owned resources was inferred", { target: { root, space } }); }
  if (ledgers.valid.length || ledgers.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "additive ownership ledgers or unreadable ledger records remain under this root; fresh team boot did not adopt or erase them", { target: { root, space, deploymentIds: ledgers.valid.map(({ ledger }) => ledger.runId), unreadable: ledgers.refused.map(({ path }) => path) }, remedy: "inspect and finish each additive deployment's own lifecycle before a fresh team boot" });
  let additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { additiveAttempts = listAdditiveTeamAttempts(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive attempt inventory could not be read; fresh boot did not assume it was empty", { target: { root, space } }); }
  if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive deployment attempt remains under this root; its native outcome was not adopted as whole-stack ownership", { target: { root, space, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) } });
  let bootAttempts: ReturnType<typeof listFreshTeamAttempts>, summaries: ReturnType<typeof listFreshTeamSummaries>;
  try { bootAttempts = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "fresh boot attempt or summary records could not be read; no earlier startup was assumed settled", { target: { root, space } }); }
  const byId = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  const ownAttempt = own && bootAttempts.valid.find((attempt) => attempt.deploymentId === own.deploymentId);
  if (own && (!ownAttempt || ownAttempt.space !== space || ownAttempt.root !== root || ownAttempt.server !== own.server || ownAttempt.manifestPath !== own.manifestPath || ownAttempt.authMode !== mode || byId.has(own.deploymentId)))
    throw new CommandFailure("refused", "CONFLICT", "this fresh boot's own intent changed or acquired a summary during preparation; no launch spec was written", { target: { root, space, deploymentId: own.deploymentId } });
  const unsettled = bootAttempts.valid.filter((attempt) => attempt.deploymentId !== own?.deploymentId && !freshTeamAttemptSettled(attempt, byId.get(attempt.deploymentId)));
  if (bootAttempts.refused.length || summaries.refused.length || unsettled.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a prior fresh boot attempt lacks a matching readable summary, or an attempt/summary is unreadable; its outcome was not treated as absent", { target: { root, space, unsettledIds: unsettled.map((attempt) => attempt.deploymentId), unreadable: [...bootAttempts.refused, ...summaries.refused].map(({ path }) => path) }, remedy: "inspect each full boot attempt and its original listener before another fresh start; do not retry an unknown boot" });
}

/** Validate + assemble the auth-service daemon's public-exchange argv from `up`'s flags. The three
 *  flags travel with --user-auth (an open mesh has no exchange to publish); --exchange-public-url
 *  and --exchange-trusted-proxy modify the public listener, so they require its port. Returned as
 *  an argv ARRAY — the daemon re-exec never shell-interpolates. */
export function publicExchangeArgs(
  v: { "exchange-public-port"?: string; "exchange-public-url"?: string; "exchange-trusted-proxy"?: boolean; "advertised-server"?: string; "agent-provisioning-url"?: string },
  wantUser: boolean,
): string[] {
  const port = v["exchange-public-port"];
  const url = v["exchange-public-url"];
  const proxy = Boolean(v["exchange-trusted-proxy"]);
  const advertised = v["advertised-server"];
  const provisioning = v["agent-provisioning-url"];
  if (port === undefined && url === undefined && !proxy && advertised === undefined && provisioning === undefined) return [];
  const flags = [port !== undefined && "--exchange-public-port", url !== undefined && "--exchange-public-url", proxy && "--exchange-trusted-proxy", advertised !== undefined && "--advertised-server", provisioning !== undefined && "--agent-provisioning-url"].filter(Boolean);
  if (!wantUser) throw userAuthFlagsRefusal(flags.join(", "));
  if (port === undefined) throw new CommandFailure("refused", "USAGE_INVALID", `${flags.join(", ")} ${flags.length === 1 ? "requires" : "require"} --exchange-public-port. Nothing started.`, { remedy: "add --exchange-public-port with the public listener port, or remove the flags that need it" });
  return [
    "--exchange-public-port", port,
    ...(url !== undefined ? ["--exchange-public-url", url] : []),
    ...(proxy ? ["--exchange-trusted-proxy"] : []),
    ...(advertised !== undefined ? ["--advertised-server", advertised] : []),
    ...(provisioning !== undefined ? ["--agent-provisioning-url", provisioning] : []),
  ];
}

/** The daemon argv for `--service-endpoints`: the auth service hosts the service endpoint door and
 *  host route. User-auth only; an open mesh has no owner to decide. */
export function serviceEndpointsArgs(v: { "service-endpoints"?: boolean }, wantUser: boolean): string[] {
  if (!v["service-endpoints"]) return [];
  if (!wantUser) throw userAuthFlagsRefusal("--service-endpoints");
  return ["--service-endpoints"];
}

function userAuthFlagsRefusal(flags: string): CommandFailure {
  return new CommandFailure("refused", "USAGE_INVALID", `${flags} can only be used with user auth. Nothing started.`, { remedy: "remove the incompatible flags for an open space, or use them with --user-auth instead of --open" });
}

/** The space a `cotal up` that names none runs in this folder. The root's sole account names it
 *  first, as {@link resolveSpace} does. An open mesh has no account, and its first start replaces
 *  the prepared record with a registration, so the space this root's stack journal or its locally
 *  started registration names comes next. Without it a second `up` in the same folder resolved the
 *  default space and refused its own mesh. Several names there are refused, never picked. Then the
 *  space prepared here. A stopped open root with none prepared names its space in the broker
 *  configuration its last start rendered. Then the default.
 *
 *  Only `up` asks this. `resolveSpace` also decides whether identity cleanup may attribute a root to
 *  a space (`reset-space-plan.ts`) and, through `resolveRuntimeSpace`, which space a legacy `down`
 *  removes credentials for; those keep their own answer. */
export function folderSpace(): string {
  const root = cotalRoot();
  if (soleSpaceOf(authDir(root)) === undefined) {
    const named = [...new Set([readStackJournal(root)?.journal.space, ...localMeshesForRoot(root).map((m) => m.space)])].filter((s): s is string => s !== undefined);
    if (named.length > 1)
      throw new CommandFailure("refused", "CONFLICT", `this folder's stack and registrations name ${named.length} spaces (${named.map((s) => `"${s}"`).join(", ")}), so up cannot pick one`, {
        target: { root, spaces: named },
        remedy: "name the space to run with `--space`",
      });
    if (named.length === 1) return named[0];
    // A stopped open root holds no account, so its broker configuration names its space.
    const deployed = preparedSpaceAt(root) ? undefined : retainedOpenSpace(root);
    if (deployed) return deployed;
  }
  return resolveSpace(process.cwd());
}

/** An unavailable selected project must not turn an unnamed startup into a different space. */
export function assertSelectionNotMoved(root: string, space: string): void {
  const current = getCurrent();
  const prepared = current === undefined || current === space ? undefined : findPreparedSpace(current);
  if (!prepared) return;
  const problem = projectRootProblem(prepared.root);
  if (!problem) return;
  const recover = problem === "inaccessible" ? "restore access to the original project folder" : "restore the original project folder at its recorded path";
  throw localDiagnostic(new CommandFailure("refused", "TARGET_UNAVAILABLE", `the selected space "${current}" is prepared in ${prepared.root}, which ${projectRootProblemText(problem)}, and this folder names no space, so up did not start "${space}" here`, {
    target: { root, space: current, preparedRoot: prepared.root },
    remedy: `${recover}, then repeat your startup command in that folder; to start "${space}" here instead, add \`--space ${space}\` to your original command`,
  }));
}
