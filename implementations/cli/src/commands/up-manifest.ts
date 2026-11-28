import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isReachable, DEFAULT_SERVER, loadAccountLimits, type BrokerTransport } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, brokerAddressForDisplay, canonicalRoot, getCurrent, loadMeshes, oneLine, writeResult, type Report, workspaceSecretStore } from "@cotal-ai/workspace";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { resolveAuthProvider } from "../lib/auth-proc.js";
import { c, stderrLine } from "../ui.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { canonicalServer } from "../lib/broker-service.js";
import { clearManagerArtifacts, managerLogDisplayPath, stopManager } from "../lib/manager-proc.js";
import { ManifestError, formatIssue, loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { UnusableFile } from "../lib/unusable-file.js";
import { buildLaunchSpec, genRunId, manifestToChannels, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { writeFreshTeamAttempt, writeFreshTeamSummary } from "../lib/team-fresh.js";
import { renderUpPlan, renderInherited, renderWarnings } from "../lib/manifest/render.js";
import { idpUrlProblem, serverUrlProblems } from "../lib/manifest/resolve.js";
import { failManifest, refuseManifestSpaceMismatch } from "./topology.js";
import { type StackUpNative } from "./stack-up.js";
import { preflightUserStack } from "./stack-user-auth.js";
import { preflightRuntime } from "../ext-loader.js";
import {
  resolveTransport,
  assertTlsIntentServed,
  commitTransportPolicy,
  tlsAddress,
  announceTransport,
  assertServesDialHost,
  refuseUnnamedLastStore,
  refuseMissingNamedStore,
  checkStartStore,
} from "./up-transport.js";
import { reconcileHostAndServer, assertFreshTeamBindAvailable } from "./up-host.js";
import { refuseRegisteredAddress, postStart, recreateDeletedStreams } from "./up-stores.js";
import { authSetup } from "./up-broker-auth.js";
import { bindListRefusal, assertFreshTeamBootOwnership } from "./up-args.js";
import { prepareBrokerStart, startMeshDetached, assertBrokerAddressFree, recordOurMesh } from "./up-detach.js";

/** Every fresh-boot input a controller team boot freezes before its first effect. It holds no
 *  credential, trust material or launch spec; those are produced only after this plan exists. */
export interface FreshTeamBootPlan {
  root: string;
  space: string;
  server: string;
  /** The declared bind host, or undefined when the manifest left it unset (loopback default). */
  host: string | undefined;
  mode: "open" | "auth" | "user";
  idp: string | undefined;
  runtime: string;
  manifestPath: string;
  prepared: PreparedManifest;
  transport: BrokerTransport;
  maxSessions: number | undefined;
  logFile: string | undefined;
  logfileSizeLimit: number | undefined;
  logfileMaxNum: number | undefined;
}

/** The fresh boot's read-only preparation, shared by the controller team boot. It runs the same
 *  manifest load, override, mode agreement, ownership, bind, runtime, reachability and connector
 *  refusals as the retained `upManifest` fresh path, in the same order, and writes nothing. */
export async function prepareFreshTeamBoot(file: string, opts: { space: string; transport: BrokerTransport; retry: () => string; server?: string; host?: string; runtime?: string; open?: boolean; userAuth?: boolean; idp?: string; maxSessions?: number }): Promise<FreshTeamBootPlan> {
  const flags: UpManifestFlags = { ...opts, dryRun: false, freshTeamBoot: true };
  let prepared: PreparedManifest;
  try { prepared = loadManifest(resolve(file), undefined, true); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot manifest changed or could not be resolved before startup; no broker was started", { target: { path: resolve(file), space: opts.space } }); }
  if (opts.space !== prepared.manifest.space)
    throw new CommandFailure("refused", "CONFLICT", "the fresh boot manifest no longer names the selected space; no broker was started", { target: { selectedSpace: opts.space, declaredSpace: prepared.manifest.space } });
  const declared = prepared.manifest.broker?.auth;
  if (opts.open && declared === "user") throw new CommandFailure("refused", "CONFLICT", "--open contradicts this manifest's user-auth mode; no trust or broker was changed", { target: { space: opts.space } });
  if (opts.userAuth && declared !== "user") throw new CommandFailure("refused", "CONFLICT", "--user-auth contradicts this manifest's declared auth mode; no trust or broker was changed", { target: { space: opts.space } });
  if (opts.idp && declared !== "user") throw new CommandFailure("refused", "CONFLICT", "--idp needs this manifest's user-auth mode; no trust or broker was changed", { target: { space: opts.space } });
  const idpProblem = opts.idp === undefined ? undefined : idpUrlProblem(opts.idp, "--idp");
  if (idpProblem) throw new CommandFailure("refused", "SCHEMA_INVALID", idpProblem, { target: { space: opts.space } });
  const serverProblems = opts.server === undefined ? [] : serverUrlProblems(opts.server, "--server");
  if (serverProblems.length) throw new CommandFailure("refused", "SCHEMA_INVALID", serverProblems.join("; "), { target: { space: opts.space } });
  const list = bindListRefusal("team boot", file, opts.space, opts.server, prepared.manifest.broker?.servers);
  if (list) throw list;
  const { prepared: eff, hostSource, serverSource } = applyUpOverrides(prepared, flags);
  const m = eff.manifest;
  const host = m.broker?.host ?? "127.0.0.1";
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, hostSource, serverSource) : (m.broker?.servers ?? DEFAULT_SERVER);
  const open = m.broker?.auth === false;
  const mode = open ? "open" as const : m.broker?.auth === "user" ? "user" as const : "auth" as const;
  const runtime = m.runtime ?? "pty";
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; no channel metadata or broker was written", { target: { space: m.space }, remedy: "use static/user authentication for durable delivery, or declare live delivery for an open mesh" });
  const otherSpaces = loadMeshes().filter((row) => row.space !== m.space && row.server === server).map((row) => row.space);
  if (otherSpaces.length) {
    const address = brokerAddressForDisplay(server) ?? "not displayable";
    const names = otherSpaces.map((name) => `"${oneLine(name)}"`).join(", ");
    throw new CommandFailure("refused", "CONFLICT", `the broker address ${address} is already recorded for ${otherSpaces.length === 1 ? "local space" : "local spaces"} ${names}. No broker was started.`, {
      target: { space: m.space, server: address, otherSpaces },
      remedy: `choose a free port in the manifest's \`broker.servers\`, then retry with ${opts.retry()} from the same folder`,
    });
  }
  assertFreshTeamBootOwnership(cotalRoot(), m.space, mode);
  await assertFreshTeamBindAvailable(server, host, m.space);
  try { await preflightRuntime(runtime); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; no fresh boot intent or broker was started", { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
  if (await isReachable(server)) throw new CommandFailure("refused", "CONFLICT", "the selected address already has a broker; fresh boot did not adopt it or start a competing listener", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" } });
  const conn = await preflightConnectors(prepared);
  if (conn) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed before the fresh boot intent; no native effect was requested", { target: { space: m.space }, remedy: conn });
  return { root: canonicalRoot(cotalRoot()), space: m.space, server, host: m.broker?.host, mode, idp: m.broker?.idp, runtime, manifestPath: resolve(file), prepared: eff, transport: assertServesDialHost(opts.transport, new URL(server).hostname), maxSessions: opts.maxSessions, logFile: m.broker?.logFile, logfileSizeLimit: m.broker?.logfileSizeLimit, logfileMaxNum: m.broker?.logfileMaxNum };
}

/** A stack's auth mode in words, and the manifest's `broker.auth` value that declares it. */
const RESUME_MODE = { open: { words: "open", field: "false" }, auth: { words: "static auth", field: "static" }, user: { words: "user auth", field: "user" } } as const;

/** A team boot that resumes one exact stopped controller stack whose manager was never attempted.
 *  The same manifest load, agreement, durable-on-open, runtime, reachability and connector refusals
 *  as {@link prepareFreshTeamBoot}, without the fresh zero-instance ownership gate: that gate is
 *  replaced by the stopped-stack eligibility the caller binds under its lock. The manifest may not
 *  move the recorded broker: its server must equal the recorded one, and a declared bind host must
 *  equal the recorded host. Writes nothing. */
export async function prepareResumeTeamBoot(file: string, opts: { space: string; transport: BrokerTransport; recorded: { server: string; mode: "open" | "auth" | "user"; host?: string } }): Promise<FreshTeamBootPlan> {
  let prepared: PreparedManifest;
  try { prepared = loadManifest(resolve(file), undefined, true); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the team manifest changed or could not be resolved before startup; nothing was resumed", { target: { path: resolve(file), space: opts.space } }); }
  if (opts.space !== prepared.manifest.space)
    throw new CommandFailure("refused", "CONFLICT", "the team manifest no longer names the selected space; nothing was resumed", { target: { selectedSpace: opts.space, declaredSpace: prepared.manifest.space } });
  const { prepared: eff, hostSource, serverSource } = applyUpOverrides(prepared, { transport: opts.transport, dryRun: false, freshTeamBoot: true });
  const m = eff.manifest;
  const declaredServer = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, hostSource, serverSource) : (m.broker?.servers ?? DEFAULT_SERVER);
  const server = opts.recorded.server;
  const open = m.broker?.auth === false;
  const mode = open ? "open" as const : m.broker?.auth === "user" ? "user" as const : "auth" as const;
  const runtime = m.runtime ?? "pty";
  // Each setting the manifest moves, with both values and the manifest change that keeps the recorded one.
  const shown = (address: string) => brokerAddressForDisplay(address) ?? "not displayable";
  const moved = [
    ...(canonicalServer(declaredServer) !== canonicalServer(server) ? [{ name: "broker address", recorded: shown(server), declared: shown(declaredServer), keep: `set \`broker.servers\` to ${shown(server)}` }] : []),
    ...(m.broker?.host !== undefined && m.broker.host !== opts.recorded.host ? [{ name: "bind host", recorded: opts.recorded.host ?? "none", declared: m.broker.host, keep: opts.recorded.host ? `set \`broker.host\` to ${opts.recorded.host}` : "remove `broker.host`" }] : []),
    ...(mode !== opts.recorded.mode ? [{ name: "auth mode", recorded: RESUME_MODE[opts.recorded.mode].words, declared: RESUME_MODE[mode].words, keep: `set \`broker.auth\` to \`${RESUME_MODE[opts.recorded.mode].field}\`` }] : []),
  ];
  if (moved.length) {
    const named = moved.map((row) => `${row.name} (recorded ${row.recorded}, declared ${row.declared})`);
    throw new CommandFailure("refused", "CONFLICT", `the manifest differs from the recorded stopped stack in its ${named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0]}; nothing was resumed`, {
      target: { space: m.space, recorded: { ...opts.recorded, server: shown(server) }, declared: { server: shown(declaredServer), host: m.broker?.host ?? null, mode } },
      remedy: `${moved.map((row) => row.keep).join(" and ")} in the manifest to resume this stack, or boot the manifest as a new space in another folder prepared with \`cotal space create <space>\``,
    });
  }
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; nothing was resumed", { target: { space: m.space } });
  const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
  if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; the stopped stack was not resumed over it", { target: { space: m.space, otherSpaces: other.map((row) => row.space) } });
  try { await preflightRuntime(runtime); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; nothing was resumed", { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
  if (await isReachable(server)) throw new CommandFailure("refused", "CONFLICT", "the recorded broker address already answers; the stopped stack was not resumed over it", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" } });
  const conn = await preflightConnectors(prepared);
  if (conn) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed; nothing was resumed", { target: { space: m.space }, remedy: conn });
  return { root: canonicalRoot(cotalRoot()), space: m.space, server, host: opts.recorded.host, mode, idp: m.broker?.idp, runtime, manifestPath: resolve(file), prepared: eff, transport: assertServesDialHost(opts.transport, new URL(server).hostname), maxSessions: undefined, logFile: m.broker?.logFile, logfileSizeLimit: m.broker?.logfileSizeLimit, logfileMaxNum: m.broker?.logfileMaxNum };
}

/** The recorded broker transport of a prepared root, decided without persisting anything: a team
 *  boot names no TLS flags, so it inherits the root's recorded policy exactly as a bare `up` does. */
export function recordedBrokerTransport(root: string): BrokerTransport {
  return resolveTransport({}, undefined, root, { persist: false, quiet: true });
}

/** Recheck, under the fresh boot's own lock, the ownership and bind refusals that a concurrent
 *  writer could have invalidated after {@link prepareFreshTeamBoot}. */
export async function recheckFreshTeamBoot(plan: FreshTeamBootPlan, own?: { deploymentId: string }): Promise<void> {
  assertFreshTeamBootOwnership(plan.root, plan.space, plan.mode, own ? { deploymentId: own.deploymentId, server: plan.server, manifestPath: plan.manifestPath } : undefined);
  await assertFreshTeamBindAvailable(plan.server, plan.host ?? "127.0.0.1", plan.space);
}

/** The native callbacks a controller stack start uses, shared by `cotal up` and a controller team
 *  boot so both prepare, seed and record through the same native path. */
export function controllerStackNative(): StackUpNative {
  return {
    prepareBroker: async (opts) => {
      const prepared = await prepareBrokerStart({ transport: opts.transport, server: opts.server, space: opts.space, ...(opts.open ? { open: true } : {}), ...(opts.userAuth ? { userAuth: opts.userAuth } : {}), ...(opts.host ? { host: opts.host } : {}), ...(opts.wsPort !== undefined ? { wsPort: opts.wsPort } : {}), ...(opts.storeDir ? { storeDir: opts.storeDir } : {}), ...(opts.existingStore ? { existingStore: opts.existingStore } : {}), ...(opts.maxFileStore !== undefined ? { maxFileStore: opts.maxFileStore } : {}), ...(opts.logFile !== undefined ? { logFile: opts.logFile } : {}), ...(opts.logfileSizeLimit !== undefined ? { logfileSizeLimit: opts.logfileSizeLimit } : {}), ...(opts.logfileMaxNum !== undefined ? { logfileMaxNum: opts.logfileMaxNum } : {}), ...(opts.authTimeout !== undefined ? { authTimeout: opts.authTimeout } : {}), ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}), ...(opts.accountResolver !== undefined ? { accountResolver: opts.accountResolver } : {}), ...(opts.noManager ? { noManager: true } : {}), quietBoot: true });
      return { root: prepared.root, server: prepared.server, space: prepared.space, storeDir: prepared.storeDir, transport: prepared.transport, ...(prepared.setup ? { setup: { mintProvisioner: prepared.setup.mintProvisioner, wsPort: prepared.setup.wsPort, moveWebsocketPort: prepared.setup.moveWebsocketPort } } : {}), ...(prepared.setup?.prepared && prepared.setup.stateDir ? { user: { prepared: prepared.setup.prepared, stateDir: prepared.setup.stateDir } } : {}), confPath: prepared.confPath, bin: prepared.bin, source: prepared.source, version: prepared.version, ...(prepared.setup?.authTimeout !== undefined ? { authTimeout: prepared.setup.authTimeout } : {}), ...(prepared.maxPayload !== undefined ? { maxPayload: prepared.maxPayload } : {}), ...(prepared.setup?.accountResolver !== undefined ? { accountResolver: prepared.setup.accountResolver } : {}) };
    },
    initializeStreams: async (server, space, setup, seedFile, recreateIssuedStores, recreateMembershipStore) => postStart(server, space, setup && { creds: await setup.mintProvisioner() }, seedFile, recreateIssuedStores, recreateMembershipStore, true),
    recreateDeletedStreams,
    recordMesh: (entry) => recordOurMesh({ ...entry, ts: new Date().toISOString() }, "started", true),
    commitTransport: (root, chosen, limits) => commitTransportPolicy(root, chosen, true, undefined, limits),
  };
}

/** The structured refusal for a manifest `up -f` cannot use: the located problems of one that does
 *  not validate, or the read failure of one that cannot be read. Both exit 1, as the text path does. */
export function manifestFileRefusal(e: unknown, path: string): CommandFailure {
  if (e instanceof ManifestError) {
    // One line per problem: a parse error's code frame stays out of the sentence.
    const issues = e.issues.map((issue) => ({ ...issue, message: issue.message.split("\n")[0]!.replace(/(at line \d+, column \d+):$/, "$1") }));
    return new CommandFailure("refused", "SCHEMA_INVALID", `the manifest does not validate, so nothing was started: ${issues.map((issue) => formatIssue(e.file, issue)).join("; ")}`, { target: { path, issues }, remedy: "fix each named problem and run the command again" });
  }
  // A refusal that already names the problem, such as a directory given as the manifest, keeps its
  // own sentence and remedy, as the text path prints them.
  if (e instanceof CommandFailure) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  return new UnusableFile(code === "ENOENT" ? `manifest file not found: ${path}` : `the manifest ${path} could not be read (${code ?? (e as Error).message})`, { file: path });
}

/** `cotal up -f cotal.yaml` — bring up a FRESH mesh from a manifest (broker + channels + booted
 *  agents). `up -f` is a broker-CREATION command: `broker.servers` is the bind address for the NEW
 *  local broker, never a connect target. A broker already reachable there (local OR remote) means
 *  fresh boot refusal; an unbindable/remote address makes the broker fail to start (no silent
 *  local fallback). It owns the whole space, so `cotal down` tears it down without an additive
 *  ownership ledger. */
export async function upManifest(file: string, opts: UpManifestFlags): Promise<void> {
  let prepared: PreparedManifest;
  try {
    prepared = loadManifest(resolve(file), opts.logFile, opts.dryRun ? "preview" : true);
  } catch (e) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot manifest changed or could not be resolved before startup; no broker was started", { target: { path: resolve(file), space: opts.space } });
    failManifest(e);
  }
  if (opts.freshTeamBoot && opts.space !== prepared.manifest.space)
    throw new CommandFailure("refused", "CONFLICT", "the fresh boot manifest no longer names the selected space; no broker was started", { target: { selectedSpace: opts.space, declaredSpace: prepared.manifest.space } });
  refuseManifestSpaceMismatch(prepared, opts.space);
  // The auth-mode sources (flags vs manifest) must AGREE — any mismatch names both sources and the
  // exact correction in one sentence (a no-fallback identity decision, never a bare enum error).
  const declared = prepared.manifest.broker?.auth;
  const declaredStr = declared === undefined ? '"static" (the unset default)' : JSON.stringify(declared);
  if (opts.open && declared === "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--open contradicts this manifest's user-auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    console.error(c.red('✗ --open contradicts this manifest\'s broker.auth: "user" - a user-auth space cannot run unauthenticated. Drop --open, or change the manifest.'));
    process.exit(1);
  }
  if (opts.userAuth && declared !== "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--user-auth contradicts this manifest's declared auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    stderrLine("✗ ", `--user-auth requires manifest broker.auth: "user" (this manifest's broker.auth is ${declaredStr}). Either set broker.auth: "user" in the manifest, or drop --user-auth.`, c.red);
    process.exit(1);
  }
  if (opts.idp && declared !== "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--idp needs this manifest's user-auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    stderrLine("✗ ", `--idp is for user-auth spaces (this manifest's broker.auth is ${declaredStr}) - set broker.auth: "user" in the manifest, or drop --idp.`, c.red);
    process.exit(1);
  }
  const idpProblem = opts.idp === undefined ? undefined : idpUrlProblem(opts.idp, "--idp");
  if (idpProblem) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", idpProblem, { target: { space: prepared.manifest.space } });
    stderrLine("✗ ", `${idpProblem}`, c.red);
    process.exit(1);
  }
  const serverProblems = opts.server === undefined ? [] : serverUrlProblems(opts.server, "--server");
  if (serverProblems.length) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", serverProblems.join("; "), { target: { space: prepared.manifest.space } });
    for (const problem of serverProblems) stderrLine("✗ ", `${problem}`, c.red);
    process.exit(1);
  }
  // Each entry of a list is checked above; the start still needs one address, before any parse of it.
  const list = bindListRefusal(opts.freshTeamBoot ? "team boot" : "up -f", file, prepared.manifest.space, opts.server, prepared.manifest.broker?.servers);
  if (list) throw list;
  // Apply CLI overrides to one effective manifest (flag > manifest > default) so render + seed +
  // broker + launch all agree on the same values.
  const { prepared: eff, hostSource, serverSource } = applyUpOverrides(prepared, opts);
  const m = eff.manifest;
  if (m.broker?.logFile === undefined && (opts.logfileSizeLimit !== undefined || opts.logfileMaxNum !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "--logfile-size-limit and --logfile-max-num require --log-file or broker.logFile in the manifest", { remedy: "pass --log-file <path>, set broker.logFile in the manifest, or omit the rotation flags" });
  const host = m.broker?.host ?? "127.0.0.1";
  // Same bind-vs-probe reconciliation as the flag path: a manifest that sets `broker.host` without
  // an explicit `broker.servers` would otherwise bind one address and be probed at another.
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, hostSource, serverSource) : (m.broker?.servers ?? DEFAULT_SERVER);
  assertTlsIntentServed(server, opts.transport, opts.server !== undefined ? "--server" : "the manifest's broker.servers");
  // A --tls-cert broker serves TLS only, so its address says tls://, as a bare up requires of --server.
  if (opts.transport.kind === "tls-required" && server.split(",").some((url) => /^nats:\/\//i.test(url.trim())))
    throw new CommandFailure("refused", "USAGE_INVALID", `--tls-cert serves the broker over TLS, so ${opts.server !== undefined ? "--server" : "the manifest's broker.servers"} must be a tls:// address; nothing was started or written`, {
      target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" },
      remedy: opts.server !== undefined ? `pass --server ${tlsAddress(server)}` : `set broker.servers to ${tlsAddress(server)} in ${file}`,
    });
  const open = m.broker?.auth === false; // default is auth
  if (open && loadAccountLimits(cotalRoot()) !== undefined)
    throw new Error("accountLimits requires an authenticated broker; open mode has no data-account JWT");
  const userAuth = m.broker?.auth === "user" ? { idpUrl: m.broker.idp } : undefined;
  const runtime = m.runtime ?? "pty";
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; no channel metadata or broker was written", { target: { space: m.space, defaultDurable: m.defaults?.deliveryClass === "durable", channels: m.channels.filter((channel) => channel.deliveryClass === "durable").map((channel) => channel.name) }, remedy: "use static/user authentication for durable delivery, or declare live delivery for an open mesh" });
  // The address this manifest names is held by the same rule as a `--server` on the flag path: a
  // stopped space keeps its registered address, and a second stack started there answers for both
  // registrations. A fresh team boot has its own refusal below, so this is the ordinary `up -f`.
  if (!opts.freshTeamBoot)
    refuseRegisteredAddress(server, m.space, opts.dryRun
      ? "choose another address for --server and repeat the same --dry-run"
      : opts.server !== undefined ? "choose another address for --server and repeat the original command" : `point broker.servers in ${file} at another address`);
  if (opts.freshTeamBoot) {
    const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
    if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; fresh team boot did not create a listener over its recorded target", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable", otherSpaces: other.map((row) => row.space) }, remedy: "inspect both registrations and their native brokers; exact-address conflicts block creation, while no conflict does not prove exclusivity" });
  }
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth");
    await assertFreshTeamBindAvailable(server, host, m.space);
  }
  // A manifest needs its manager to boot declared agents.
  if (opts.noManager && eff.agents.length)
    throw new FlagValueRefusal(`--no-manager cannot launch this manifest: it declares ${eff.agents.length} agent(s), and a manifest's agents are booted by its manager (which --no-manager omits)`, "drop --no-manager, or use a broker-only manifest with no agents");
  const effectiveNoManager = Boolean(opts.noManager);
  // The open-mesh refusal must be RE-STATED here, not only against the CLI `--open` flag: on this
  // path openness comes from the MANIFEST (`broker.auth: false`), which the flag-level guard cannot
  // see. Without it, `cotal up -f open.yaml --rotate-sys` boots an open broker, exits 0 and rotates
  // nothing: a rotation ask answered with silent success, the exact failure class this change
  // exists to remove. Before the dry-run print and before anything boots.
  if (opts.rotateSys && open)
    throw new FlagValueRefusal("--rotate-sys is for auth meshes: this manifest sets broker.auth: false (open), so there is no system account or $SYS credentials to rotate, and nothing was started", "drop --rotate-sys for this open manifest");
  // Before the dry-run print and before connector preflight or any write, as the refusals above.
  if (!opts.storeDir) refuseUnnamedLastStore(cotalPath("nats"));
  else refuseMissingNamedStore(resolve(opts.storeDir));
  if (userAuth) await preflightUserStack(cotalRoot(), m.space, userAuth.idpUrl);
  checkStartStore(opts.storeDir, m.space);

  // Preview and apply only probe a runtime when starting a manager.
  try { if (!effectiveNoManager) await preflightRuntime(runtime); }
  catch (error) {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the requested runtime did not pass preflight; ${opts.freshTeamBoot ? "no fresh boot intent or broker was started" : "no broker was started"}`, { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" });
  }

  if (opts.dryRun) {
    // Dial-host SAN must refuse here too (S6). The real route runs assertServesDialHost after
    // the plan is computed; dry-run used to return before that check and green-lit a launch
    // the applying command refuses. Validate against the effective server; still no writes.
    // Announce only AFTER the dial-host check so a wrong-SAN dry-run does not print TLS: serving.
    assertServesDialHost(opts.transport, new URL(server).hostname);
    // Connector preflight on the dry-run path too (#315): the real route refuses a manifest at
    // preflightConnectors before anything boots; a dry run that plans a launch the applying
    // command refuses is the same green-lit-a-refusal failure class.
    const dryConn = await preflightConnectors(prepared);
    if (dryConn) {
      stderrLine("✗ ", `connector preflight failed: ${dryConn}`, c.red);
      process.exit(1);
    }
    if (opts.transport.kind === "tls-required") announceTransport(opts.transport);
    console.log(renderUpPlan(eff, server));
    // The plan names when the applying command omits the manager.
    if (effectiveNoManager)
      console.log(c.dim("  no manager will start on this host (--no-manager): broker, channels and, in auth mode, the delivery daemon come up, and no agents launch from here"));
    return;
  }

  // up -f never adopts a running broker. The old spawn -f route is no longer a manifest deploy.
  if (await isReachable(server)) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "the selected address already has a broker; fresh boot did not adopt it or start a competing listener", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" }, remedy: "inspect the existing broker and selected local records, or use another prepared address" });
    // This folder's own mesh for the manifest's space is named as running, as a bare `up` names it,
    // with the routes that change it instead of the advice for a foreign broker.
    if (loadMeshes().some((row) => row.server === server && row.root === cotalRoot() && row.space === m.space)) {
      stderrLine("✗ ", `mesh "${m.space}" is already running at ${brokerAddressForDisplay(server) ?? "its address"} from this folder - \`up -f\` boots a fresh mesh and does not apply a manifest to a running one; stop it with \`cotal down\`, then retry your original command`, c.red);
      process.exit(1);
    }
    stderrLine("✗ ", `${brokerAddressForDisplay(server) ?? "selected address"} already has a broker - a fresh boot will not adopt it. Stop the owned stack or select another address; team deploy supports only all-new channel cards, not agent apply.`, c.red);
    process.exit(1);
  }
  await assertBrokerAddressFree(server, `${displayCmd()} up -f ${shellWord(file)}`, host);
  // Connectors + their required binaries must exist before any mutation (no fallback).
  const conn = await preflightConnectors(prepared);
  if (conn) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed before the fresh boot intent; no native effect was requested", { target: { space: m.space }, remedy: conn });
    stderrLine("✗ ", `connector preflight failed: ${conn}`, c.red);
    process.exit(1);
  }
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth");
    await assertFreshTeamBindAvailable(server, host, m.space);
  }

  const deploymentId = genRunId();
  if (opts.freshTeamBoot) {
    try { writeFreshTeamAttempt(cotalRoot(), { schemaVersion: 1, kind: "fresh-team-attempt", deploymentId, space: m.space, root: cotalRoot(), server, authMode: open ? "open" : userAuth ? "user" : "auth", manifestPath: resolve(file), createdAt: new Date().toISOString() }); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "fresh boot intent creation or its durability did not confirm; no trust preparation, launch spec or listener was requested", { target: { space: m.space, deploymentId, root: cotalRoot(), intentPath: join(cotalRoot(), ".cotal", `team-boot-attempt-${deploymentId}.json`) }, remedy: "inspect the exact intent path before deciding whether any further boot can be attempted" }); }
  }

  // USER-AUTH manifest: the agents run under the LOGGED-IN operator's owner, and the launch spec
  // (consumed by the manager at boot) must carry it — so resolve it NOW. On a fresh mesh the
  // derivation material doesn't exist yet; ensure it just-in-time (authSetup + prepareServer are
  // idempotent ensure-* — the same contract the refresh-heal path already rides). Not logged in /
  // no provider = the exact recovery sentence, before anything boots.
  let owner: string | undefined;
  if (userAuth) {
    try {
      mkdirSync(cotalPath("nats"), { recursive: true, mode: 0o700 });
      // NO `rotateSys` here on purpose: this is an owner-derivation pre-resolve that runs BEFORE the
      // real boot, and the boot below carries the flag. Rotating in both would burn two generations
      // per `up -f --rotate-sys` and retire the account the first pass just minted creds against.
      const setup = await authSetup(cotalPath("nats"), server, m.space, host, userAuth, assertServesDialHost(opts.transport, new URL(server).hostname), false, undefined, opts.freshTeamBoot);
      owner = await resolveAuthProvider().ownerForLogin({ store: workspaceSecretStore(cotalRoot()), dir: setup.stateDir!, space: m.space });
    } catch (e) {
      if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh user-auth owner preparation did not confirm; trust or provider state may have changed, but no launch spec or listener was requested", { target: { space: m.space, deploymentId, root: cotalRoot() }, remedy: "inspect the retained boot intent, trust state and login before deciding another action; do not repeat an uncertain preparation" });
      stderrLine("✗ ", `${(e as Error).message}`, c.red);
      process.exit(1);
    }
  }
  // The resolved launch spec is written FIRST so the ONE control-plane manager that comes up with
  // the broker (inside startMeshDetached) carries it. Exactly one manager serves a space (the
  // singleton lease): a second `supervise` started here for the launch would race the plain one for
  // the lease — the loser refuses, so either the agents never boot or the incumbent is orphaned
  // behind an overwritten pid file. The manager materializes each transient persona and mints creds
  // from the resolved policy — never re-reading a file for authority.
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth", { deploymentId, server, manifestPath: resolve(file) });
    try { await assertFreshTeamBindAvailable(server, host, m.space); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh boot's bind address was not confirmed after owner preparation; no launch spec or listener was requested, but its retained intent and any prepared trust were not discarded", { target: { space: m.space, deploymentId, server: brokerAddressForDisplay(server) ?? "not displayable" }, remedy: "inspect the exact retained intent, trust state and address before deciding another boot; this bind probe does not reserve the listener" }); }
  }
  let specPath: string;
  try { specPath = writeLaunchSpec(cotalRoot(), buildLaunchSpec(eff, deploymentId, owner)); }
  catch (error) {
    if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh boot intent was recorded, but launch-spec creation did not confirm its outcome; no broker launch was attempted and the intent remains for inspection", { target: { space: m.space, deploymentId, root: cotalRoot() }, remedy: "inspect the original intent and launch-spec path before another boot; no effect was retried" });
    throw error;
  }
  // Ordinary up can reconcile a leftover manager. Fresh team boot must not signal one: its
  // stricter prewrite gate required no manager record at all, and a later contender wins
  // neither stop authority nor permission to replace it.
  if (!opts.freshTeamBoot) {
    await stopManager(m.space);
    clearManagerArtifacts(m.space);
  }
  let pid: number;
  let controlPlane = false;
  let authService = true;
  let deliveryResponderBound: boolean | null = null;
  try {
    // `m.broker?.host`, not the defaulted `host`: same reason as the flag path — only a host the
    // manifest actually declared is an exposure decision worth persisting.
    ({ pid, controlPlane, authService, deliveryResponderBound } = await startMeshDetached({ transport: opts.transport, server, space: m.space, open, userAuth, rotateSys: opts.rotateSys, host: m.broker?.host, logFile: m.broker?.logFile, logfileSizeLimit: m.broker?.logfileSizeLimit, logfileMaxNum: m.broker?.logfileMaxNum, seed: manifestToChannels(eff), runtime, launch: specPath, maxSessions: opts.maxSessions, noManager: effectiveNoManager, quietBoot: opts.freshTeamBoot, ...(opts.storeDir ? { storeDir: opts.storeDir } : {}) }));
  } catch (e) {
    if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh broker startup did not confirm completion after its launch spec was written; the listener or control plane may have changed state and the boot was not retried", { target: { space: m.space, deploymentId, launchSpec: specPath }, changed: [{ kind: "launch-spec-written", path: specPath }], remedy: "inspect this exact run and the recorded local listener, manager and auth state before another boot" });
    // A classified failure, such as a certificate this client refuses, keeps its code and next step.
    if (isCommandFailure(e)) throw e;
    stderrLine("✗ ", `${(e as Error).message}`, c.red);
    process.exit(1);
  }
  // Transport committed inside startMeshDetached before delivery (S5+S9).
  let summaryRecorded = false;
  try {
    writeFreshTeamSummary(cotalRoot(), {
      schemaVersion: 1, kind: "fresh-team-summary", deploymentId, space: m.space,
      root: cotalRoot(), server, authMode: open ? "open" : userAuth ? "user" : "auth", brokerPid: pid, manifestPath: resolve(file),
      requestedAgents: eff.agents.map((agent) => agent.name),
      declaredChannels: m.channels.map((channel) => channel.name),
      recordedAt: new Date().toISOString(), managerRequested: !effectiveNoManager,
      controlPlaneReturned: controlPlane, authServiceReturned: authService, deliveryResponderBound,
      agentReadiness: "not-checked",
    });
    summaryRecorded = true;
  } catch {
    console.error(c.yellow(`! the native fresh boot returned but its local team summary could not be recorded (run ${deploymentId}); do not repeat the boot just to recreate the summary`));
  }
  if (opts.freshTeamBoot) {
    if (!authService || !controlPlane || !summaryRecorded || (!open && deliveryResponderBound !== true))
      throw new CommandFailure("partial", "OPERATION_PARTIAL", "the fresh broker started, but its control plane, auth service, delivery responder or local deployment summary did not confirm readiness; the same boot was not retried", { target: { space: m.space, deploymentId, brokerPid: pid, launchSpec: specPath }, changed: [{ kind: "broker-started", pid, server: brokerAddressForDisplay(server) ?? "not displayable" }, { kind: "launch-spec-written", path: specPath }, ...(summaryRecorded ? [{ kind: "fresh-summary-recorded", deploymentId }] : [])], remedy: "inspect this exact run, the local broker and manager, and any retained summary before deciding another action" });
    const inheritedAccess = eff.agents.flatMap((agent) => {
      const access = agent.inherited;
      return access.capabilities.length || access.subscribe.length || access.allowSubscribe.length || access.allowPublish.length
        ? [{ agent: agent.name, persona: agent.persona ?? null, capabilities: access.capabilities, subscribe: access.subscribe, allowSubscribe: access.allowSubscribe, allowPublish: access.allowPublish }]
        : [];
    });
    let currentSelection: string | null = null;
    let selectionChecked = false;
    try { currentSelection = getCurrent() ?? null; selectionChecked = true; }
    catch { /* The returned broker receipt remains usable without a current-default read. */ }
    const result = { kind: "fresh-team-boot" as const, space: m.space, root: cotalRoot(), deploymentId, server: brokerAddressForDisplay(server) ?? "not displayable", brokerPid: pid, manifestPath: resolve(file), runtime, currentSelection, selectionChecked,
      mode: open ? "open" : userAuth ? "user-auth" : "static-auth", controlPlaneReturned: controlPlane, authServiceReturned: authService, deliveryResponderBound, summaryRecorded,
      requestedAgents: eff.agents.map((agent) => ({ name: agent.name, application: agent.agentType, role: agent.role ?? null })),
      declaredChannels: m.channels.map((channel) => ({ name: channel.name, deliveryClass: channel.deliveryClass ?? null, replay: channel.replay ?? null, replayWindow: channel.replayWindow ?? null })), inheritedAccess, agentReadiness: "not-checked" as const };
    writeResult(opts.presentation ?? "rich", { command: "team boot", target: { space: m.space, root: cotalRoot(), deploymentId }, result, completeness: "partial", warnings: [...eff.warnings.map((warning) => ({ code: "MANIFEST_WARNING", target: { agent: warning.agent }, message: warning.message })), ...(!selectionChecked ? [{ code: "CURRENT_SELECTION_UNAVAILABLE", target: { space: m.space }, message: "The current default space could not be read after boot; no default was inferred." }] : [])] }, (data): Report => ({ sections: [
      { title: "Fresh team broker returned", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Deployment", data.deploymentId], ["Root", data.root], ["Broker", data.server], ["Broker PID", String(data.brokerPid)], ["Manifest", data.manifestPath], ["Auth mode", data.mode], ["Runtime request", data.runtime], ["Current default", data.selectionChecked ? data.currentSelection ?? "none selected" : "not checked"], ["Control-plane ensure", "returned"], ["Delivery responder", data.deliveryResponderBound === null ? "not required" : "bound when boot returned"], ["Membership material", "not checked by this receipt"], ["Auth service", data.mode === "user-auth" ? "returned at boot" : "not required"], ["Launch summary", "recorded"], ["Agent readiness", "not checked"]] }, { kind: "lines", lines: ["The manager was requested as part of boot; this receipt does not establish agent joins, current broker health or whole-stack stop authority."] }] },
      { title: "Requested topology", blocks: [data.requestedAgents.length ? { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "application", label: "Application" }, { key: "role", label: "Role" }], rows: data.requestedAgents.slice(0, 100).map((agent) => ({ ...agent, role: agent.role ?? "none" })) } : { kind: "lines", lines: ["No agents requested."] }, data.declaredChannels.length ? { kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "delivery", label: "Declared delivery" }, { key: "replay", label: "Declared replay" }, { key: "window", label: "Declared window" }], rows: data.declaredChannels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, delivery: channel.deliveryClass ?? "not declared", replay: channel.replay === null ? "not declared" : channel.replay ? "on" : "off", window: channel.replayWindow ?? "not declared" })) } : { kind: "lines", lines: ["No channels declared."] }, ...((data.requestedAgents.length > 100 || data.declaredChannels.length > 100) ? [{ kind: "lines" as const, lines: ["Showing at most 100 declared agents and channels; the saved summary retains all names."] }] : [])] },
      ...(data.inheritedAccess.length ? [{ title: "Persona-inherited access", blocks: [{ kind: "table" as const, columns: [{ key: "agent", label: "Agent" }, { key: "persona", label: "Persona" }, { key: "scope", label: "Outside manifest channels" }], rows: data.inheritedAccess.slice(0, 100).map((row) => ({ agent: row.agent, persona: row.persona ?? "none", scope: [row.capabilities.length ? `capabilities ${row.capabilities.join(",")}` : "", row.subscribe.length ? `subscribe ${row.subscribe.join(",")}` : "", row.allowSubscribe.length ? `read ${row.allowSubscribe.join(",")}` : "", row.allowPublish.length ? `post ${row.allowPublish.join(",")}` : ""].filter(Boolean).join(" · ") })) }, { kind: "lines" as const, lines: [...(data.inheritedAccess.length > 100 ? ["Additional inherited scopes are not shown in this terminal view."] : []), "These scopes came from referenced personas and are not limited to channels declared by this manifest."] }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal team show ${data.deploymentId}`, description: "Read this local launch summary" }, { command: `cotal watch --space ${data.space}`, description: "Observe the selected mesh" }, { command: `cotal down --space ${data.space} --dry-run`, description: "Inspect local stop records without stopping the stack" }] }] },
    ] }));
    return;
  }
  console.log(c.green(`✓ mesh "${m.space}" up at ${server}`) + c.dim(` (broker pid ${pid})`));
  console.log(c.dim(`  seeded ${m.channels.length} channel(s): ${m.channels.map((ch) => "#" + ch.name).join(", ")}`));
  if (summaryRecorded) console.log(c.dim(`  fresh deployment ${deploymentId} recorded; \`cotal team show ${deploymentId}\` reads its launch summary, not live ownership`));
  // Never claim a launch the control plane can't deliver: the manager carries the launch spec, so a
  // degraded control plane (announced above) means the agents are NOT coming up.
  if (effectiveNoManager) {
    // Truthful summary for the broker-only boot (#1417): nothing was omitted by accident, and the
    // agents this manifest declares (none — a declaring manifest is refused above) launch elsewhere.
    console.log(c.dim(`  broker-only (--no-manager): no manager started on this host - run \`cotal supervise --space ${m.space} --server ${server}\` from a manager host to manage agents`));
  } else if (controlPlane) {
    // U6: on a user mesh the agents run under the OPERATOR's identity — say whose they are.
    // The manager launches them after this command returns, so nothing here knows whether one joined:
    // no success mark, and name where the outcome shows.
    console.log(`  launch pending: the manager (${runtime}) starts ${eff.agents.length} agent(s)${owner ? ` as you (owner ${owner})` : ""} after this returns; up -f does not wait for them to join`);
    console.log(c.dim(`  who joined: \`cotal ps --space ${m.space}\`   ·   a failed launch and its reason: ${managerLogDisplayPath(m.space)}`));
  } else {
    stderrLine("✗ ", `${eff.agents.length} agent(s) NOT launched - the control plane did not come up (see above)`, c.red);
  }

  // Loud summary: any persona-inherited access an `include` manifest dragged in, plus warnings.
  const inherited = renderInherited(eff);
  if (inherited) console.log("\n" + inherited);
  if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  const downRoute = opts.root ? `from ${oneLine(cotalRoot())}, run \`cotal down\`` : "`cotal down`";
  console.log(c.dim(`\nWatch: \`cotal watch --space ${m.space}\` (terminal)   ·   Dashboard: configure the explicit web service preset separately   ·   Tear down: ${downRoute}`));
  // A declared-user-auth manifest whose auth service never became ready, or a degraded control
  // plane: the mesh is up + recorded, but this launch did not deliver what it declared — exit
  // non-zero so CI/wrappers don't read success (the consequence line printed at the failure above).
  if (!authService || !controlPlane || !summaryRecorded) process.exitCode = 1;
}

/** CLI overrides for `up -f` — each wins over the manifest's own value (flag > manifest > default).
 *  `userAuth` is a consistency ASSERTION against the manifest, not an override, and `idp` overrides
 *  only on a user-auth manifest: the manifest declares the auth mode; a disagreeing flag is a hard
 *  error, never a silent re-mode. */
interface UpManifestFlags {
  root?: string;
  freshTeamBoot?: boolean;
  presentation?: "rich" | "json" | "plain";
  /** The listener's transport, decided above the `--file` branch. NON-OPTIONAL: this path is one of
   *  the three that used to drop `--tls-cert`/`--tls-key` at the call boundary and serve plaintext. */
  transport: BrokerTransport;
  dryRun: boolean;
  server?: string;
  host?: string;
  space?: string;
  runtime?: string;
  open?: boolean;
  userAuth?: boolean;
  idp?: string;
  /** `--rotate-sys` on the manifest path: the same class-3 renewal, carried to the ONE boot that
   *  renders the broker config (`startMeshDetached`), never to the owner-derivation pre-resolve. */
  rotateSys?: boolean;
  /** Operator-set live-session ceiling, recorded and handed to the manager started with the mesh. */
  maxSessions?: number;
  /** #1417 broker-only boot: the broker (+ channels, + delivery daemon in auth mode) comes up and
   *  NO manager starts on this host. The manifest's agents are booted BY its manager, so a manifest
   *  declaring agents under `--no-manager` is a contradiction refused before anything boots. */
  noManager?: boolean;
  /** `--store-dir`: the JetStream store this boot opens instead of `.cotal/nats`. */
  storeDir?: string;
  logFile?: string;
  logfileSizeLimit?: number;
  logfileMaxNum?: number;
}

/** Return a copy of the prepared manifest with CLI overrides applied to broker/space/runtime, so the
 *  whole launch (render, seed, broker, manager, launch spec) runs against one effective manifest.
 *  A flag names itself. A value that came from the file keeps that file's key, and a value neither
 *  supplied is named by the flag that would supply it. */
function applyUpOverrides(prepared: PreparedManifest, o: UpManifestFlags): { prepared: PreparedManifest; hostSource: string; serverSource: string } {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (o.host) broker.host = o.host;
  if (o.open) broker.auth = false;
  if (o.idp) broker.idp = o.idp;
  if (o.logFile !== undefined) broker.logFile = o.logFile;
  if (o.logfileSizeLimit !== undefined) broker.logfileSizeLimit = o.logfileSizeLimit;
  if (o.logfileMaxNum !== undefined) broker.logfileMaxNum = o.logfileMaxNum;
  return {
    prepared: {
      ...prepared,
      manifest: {
        ...m,
        broker: Object.keys(broker).length ? broker : undefined,
        runtime: (o.runtime as typeof m.runtime) ?? m.runtime,
      },
    },
    hostSource: !o.host && m.broker?.host !== undefined ? "broker.host" : "--host",
    serverSource: !o.server && m.broker?.servers !== undefined ? "broker.servers" : "--server",
  };
}
