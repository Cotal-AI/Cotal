import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CotalEndpoint,
  EpEnvelopeError,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  invokeCommand,
  resolveService,
  standaloneConnectOpts,
  newIdentity,
  unansweredRequest,
  resolveAuthProvider,
  type FlagValues,
  type ParsedArgs,
  type UserAuthStatus,
} from "@cotal-ai/core";
import { CLI_USER_ACTOR, accountInventory, authDir, extensionsDir, findCotalRoot, getCurrent, hasUserAuthState, isWorkspaceTargetError, loadExtensionsManifest, loadMeshes, loadSoleSpaceAuth, loadSpaceAuth, localProcessPath, localProcessVisible, parsePid, DELIVERY_PIDFILE, MANAGER_PIDFILE, preflightTarget, probeLiveness, readProcessCommand, renderWorkspaceError, resolveMeshTarget, serverFlag, spaceFlag, type LocalProcess, type LocalProcessContext, type MeshTarget, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { connect } from "@nats-io/transport-node";
import { localProcessSurface } from "../ext-loader.js";
import { cliVersion, cliProvenance, extensionVersions } from "../lib/version.js";
import { agentSkillsSkew } from "../lib/agent-skills.js";
import { managerHasDeliveryMarker } from "../lib/manager-proc.js";
import { machineStatus, resolveRuntimeSpace, webUp, WEB_URL, type MachineStatus } from "../lib/status.js";
import { pidfileState, type PidfileState } from "./down.js";
import { displayCmd } from "../lib/self-exec.js";
import { c, statusBadge } from "../ui.js";

/** `--components` is the fail-loud health pass. Bare `status` remains a broad, recovery-oriented
 * diagnostic; this explicit mode is for an operator or monitor that needs component state and a
 * machine-readable exit disposition rather than a best-effort inventory. */
export const statusFlags = [
  spaceFlag,
  serverFlag,
  { name: "components", type: "boolean", description: "probe manager, delivery, web, and registered broker component health (exit: 0 serving; 1 absent; 2 present but not serving; 3 probe refused)" },
] as const;

type Proc = PidfileState;

/** `cotal status` — detailed, read-only diagnostics for the local machine + selected mesh. */
export async function status(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof statusFlags>;
  const cwd = process.cwd();
  const root = findCotalRoot(cwd);
  const cmd = displayCmd();

  console.log(c.bold("cotal status"));
  await printMachine();
  printExtensions();
  printProject(root, cmd);
  await printRegistry();
  await printTarget(cwd, values, cmd);
  if (values.components) await printComponentHealth(cwd, values);
}

/** The installed extensions (seeded built-in connectors + operator `ext add`s) with their pinned
 *  versions. Always rendered — the `root` line plus an explicit empty state answers "where do these
 *  live / is anything installed", which is precisely ambiguous on a fresh binary before its first
 *  seed. Versions are the manifest pin (add-time), not a live on-disk/host-compat check. */
function printExtensions(): void {
  const exts = extensionVersions();
  section("Extensions");
  row("root", extensionsDir());
  if (!exts.length) {
    row("installed", c.dim("none"));
    return;
  }
  for (const e of exts) row(e.label, c.green(`v${e.version}`) + (e.pkg === e.label ? "" : c.dim(` · ${e.pkg}`)));
}

/** Cotal's authored skills reach non-Claude harnesses through the cross-vendor `~/.agents/skills`
 *  directory (Codex, Cursor, OpenCode, Gemini CLI, Windsurf). Those harnesses have no remote update, so
 *  surface a stale/missing/retired drop here and point at the skills-only write (`cotal setup --skills`).
 *  A corrupt skills bundle throws (fail-loud); we render that as a red integrity error rather than "none shipped". */
function skillsSkewRow(): string {
  let skew;
  try {
    skew = agentSkillsSkew();
  } catch (e) {
    return c.red(`bundle error: ${(e as Error).message}`);
  }
  const behind = skew.filter((s) => s.state !== "current");
  if (!behind.length) return c.green(`current (${skew.length})`);
  if (behind.every((s) => s.state === "missing")) return c.dim(`not installed · ${displayCmd()} setup --skills`);
  const retired = behind.filter((s) => s.state === "retired").length;
  const label = retired ? `${behind.length} to reconcile (${retired} retired)` : `${behind.length}/${skew.length} out of date`;
  return c.yellow(`${label} · ${displayCmd()} setup --skills`);
}

function cliProvenanceLabel(): string {
  const provenance = cliProvenance();
  const kind = provenance.kind === "source" ? "source checkout" : provenance.kind;
  return `(${kind}: ${provenance.root})`;
}

/** The `cotal-skills` Claude Code plugin (user scope) vs this CLI release: stale means an update didn't
 *  take, missing means it isn't installed, broken means it is installed but failed to load; all point at
 *  `cotal setup --skills` so a read-path status user is not routed into unscoped setup writes. */
function claudeSkillsLabel(skills: MachineStatus["claudeSkills"]): string {
  switch (skills.state) {
    case "current":
      return c.green("current");
    case "stale":
      return c.yellow(`${skills.version ? `v${skills.version} ≠ v${cliVersion()} · ` : ""}stale · ${displayCmd()} setup --skills`);
    case "broken":
      return c.red(`load error · ${displayCmd()} setup --skills`);
    case "missing":
      return c.dim(`not installed · ${displayCmd()} setup --skills`);
    default:
      return c.dim("unknown");
  }
}

async function printMachine(): Promise<void> {
  const m = await machineStatus();
  const web = await webUp();
  const webExt = webInstalled();
  section("Machine");
  row("cotal-ai", `${c.green(`v${cliVersion()}`)} ${c.dim(cliProvenanceLabel())}`);
  row("NATS", m.nats === "missing" ? c.red("missing") : c.green(m.nats));
  row("Claude plugin", m.claudePlugin ? c.green("installed") : c.dim("not installed"));
  row("Claude skills", claudeSkillsLabel(m.claudeSkills));
  row("Claude", m.agents.claude ? c.green("on PATH") : c.dim("not on PATH"));
  row("OpenCode", m.agents.opencode ? c.green("on PATH") : c.dim("not on PATH"));
  row("Skills (.agents)", skillsSkewRow());
  row("Web extension", webExt ? c.green("installed") : c.dim("not installed"));
  row("Web process", web ? c.green(WEB_URL) : c.dim(webExt ? "down" : "not installed"));
}

function printProject(root: string, cmd: string): void {
  section("This Folder");
  row("root", root);
  // The inventory READ itself can throw (an EACCES/ELOOP on `.cotal/auth`, not just a bad record):
  // `accountInventory` lets that propagate so the broker-wide guards fail CLOSED, but status is the
  // recovery command and must exit 0 for any trust material it cannot read. Frame the unreadable
  // auth dir and stop.
  let spaces: string[];
  let corrupt: string[];
  try {
    ({ spaces, corrupt } = accountInventory(authDir(root)));
  } catch (e) {
    row("auth", c.red(`auth dir unreadable · ${(e as Error).message}`));
    row("hint", `check permissions on ${authDir(root)} - broker-wide commands refuse while the tenant list cannot be read`);
    row("personas", personaSummary(root));
    return;
  }
  // Status is the command the broker-wide refusals send the operator to, so it must DESCRIBE every
  // state those refusals can name - crashing on one is a dead end in the exact recovery flow. An
  // unreadable record means the tenant list is uncertain: report it (the space-blind sole-load
  // below would throw on it).
  if (corrupt.length > 0) {
    row("auth", c.red(`${corrupt.length} unreadable account record(s) · ${corrupt.join(", ")}`));
    row("hint", `repair or remove ${corrupt.map((f) => join(authDir(root), f)).join(", ")} - broker-wide commands refuse while the tenant list is uncertain`);
    row("personas", personaSummary(root));
    return;
  }
  // A root holding several accounts has no single "this folder's space", and the process rows below
  // are keyed by one. Report the tenant list instead of letting the space-blind read throw.
  if (spaces.length > 1) {
    row("auth", c.green(`${spaces.length} spaces · ${spaces.join(", ")}`));
    row("personas", personaSummary(root));
    console.log(c.dim("  per-space process state is not reported on a multi-space root yet"));
    return;
  }
  // The inventory shape-check is necessary but not sufficient: a record can carry non-empty
  // account fields yet fail COMPOSITION (a malformed account JWT, or one signed by a foreign
  // operator - `composeSpaceAuth` throws on both). Status is the recovery command the broker-wide
  // refusals point at, so it must exit 0 with guidance for ANY record it cannot load, not crash on
  // the ones the cheap shape gate lets through. Frame the load failure the same as an unreadable
  // record and stop.
  let auth: ReturnType<typeof loadSoleSpaceAuth>;
  try {
    auth = loadSoleSpaceAuth(authDir(root));
  } catch (e) {
    row("auth", c.red(`unreadable trust material · ${(e as Error).message.split(" - ")[0]}`));
    row("hint", `${(e as Error).message}`);
    row("personas", personaSummary(root));
    return;
  }
  const userDisk = auth && hasUserAuthState(root, auth.space);
  // An open mesh has no account record to name its space, so the folder's space is read off its
  // runtime records - and a root whose records show two spaces RUNNING has no single answer, the
  // same shape as the multi-account case above. The process rows below are keyed by one space, so
  // report that state and stop rather than crashing in the recovery command that names it.
  let space: string;
  try {
    space = auth?.space ?? resolveRuntimeSpace(root);
  } catch (e) {
    row("auth", c.dim("none (open/local only)"));
    row("hint", (e as Error).message);
    row("personas", personaSummary(root));
    return;
  }
  const context: LocalProcessContext = { root, space, userAuth: Boolean(userDisk) };
  row("auth", auth ? c.green(`space ${auth.space}${userDisk ? " · user-auth" : ""}`) : c.dim("none (open/local only)"));
  row("personas", personaSummary(root));
  let nats: Proc | undefined;
  for (const component of localProcessSurface().filter((component) => localProcessVisible(component, context)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    const state = proc(localProcessPath(component.pidFile, context));
    if (component.name === "nats") nats = state;
    const detail = component.name === "manager" && state.live
      ? c.dim(managerHasDeliveryMarker(context.space) ? " · delivery-aware" : " · old/unknown build")
      : "";
    row(component.name, `${formatProc(state)}${detail}`);
  }
  // A stopped mesh with a persisted store: name the reset verb. Stale state (e.g. durables from
  // an older Cotal generation) is otherwise invisible until a spawn fails on it. The restart is
  // deliberately "your usual flags", never a bare `up` (mode/name/store-dir aren't recorded).
  if (!nats?.live && existsSync(join(root, ".cotal", "nats")))
    row("stored state", c.dim(`JetStream store persists across down/up - if stale: ${cmd} clean store --force, then \`up\` with your usual flags (\`clean all\` also resets identity)`));
}

async function printRegistry(): Promise<void> {
  const meshes = loadMeshes();
  const current = getCurrent();
  section("Recorded Meshes");
  if (!meshes.length) {
    console.log(c.dim("  none - start one with `cotal up --detach`, or register one running elsewhere with `cotal meshes add`"));
    return;
  }
  const pad = Math.max(...meshes.map((m) => m.space.length));
  await Promise.all(
    meshes.map(async (m) => {
      const mark = m.space === current ? c.green("*") : " ";
      // Honour the recorded transport. A bare TCP/INFO probe green-lights a plaintext broker that
      // has substituted for a TLS-required mesh — the FAIL1 attack — so a monitoring list that only
      // asks "is anything listening" cannot report on the one property the record claims.
      const live = await isReachable(m.server, m.tlsRequired ? { tls: true } : {});
      // A `down` record means two different things, and the repair differs: a mesh this machine
      // started can be re-`up`ed here, one registered by hand runs somewhere this machine doesn't
      // control (and, unlike the others, its record is never swept away for it).
      const origin = m.origin === "manual" ? c.dim("  registered") : "";
      const transport = m.tlsRequired ? "  tls-required" : "";
      console.log(
        `  ${mark} ${m.space.padEnd(pad)}  ${live ? c.green("reachable") : c.red("down")}  ${c.dim(`${m.mode}${transport}  ${m.server}  ${m.root}`)}${origin}`,
      );
    }),
  );
  if (current && !meshes.some((m) => m.space === current))
    console.log(c.dim(`  note: current mesh "${current}" is not recorded`));
}

async function printTarget(
  cwd: string,
  values: FlagValues<typeof statusFlags>,
  cmd: string,
): Promise<void> {
  section("Selected Mesh");
  let target: ReturnType<typeof resolveMeshTarget>;
  try {
    target = resolveMeshTarget(cwd, { server: values.server, space: values.space });
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      row("target", c.red(e.code));
      // The canonical renderer names the ACTUAL repair per code (`cotal meshes rm`, `--space
      // <name>`, `cotal up --user-auth`, …). The fixed `up --detach` hint that used to sit here was
      // right for at most one of the seven codes and pointed the other six at a command that does
      // not fix them — worse than no hint, because it reads as a diagnosis.
      row("hint", renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, ""));
      return;
    }
    throw e;
  }

  row("space", target.space);
  row("server", target.server);
  row("mode", target.mode);
  if (target.tlsRequired) row("transport", "tls-required");
  if (target.userAuth) row("idp", target.userAuth.idp.url);
  row("source", target.source);
  row("root", target.root);

  if (target.mode === "user") {
    // Status never static-mints on a user-auth mesh (the flip). Everything here is offline
    // introspection — the login cache + the locally-readable ledger — plus, only when this
    // machine holds a signed-in AND granted login, a real user-mode connect for the snapshot.
    // Same transport discipline as the open/auth path below: a recorded TLS requirement must
    // not collapse to a bare reachability probe (that green-lights a plaintext substitute).
    const live = await isReachable(target.server, target.tlsRequired ? { tls: true } : {});
    row("connection", live ? c.green("reachable") : c.red("unreachable"));
    const stateDir = userAuthStateDir(target.root, target.space);
    let st: UserAuthStatus | undefined;
    try {
      st = await resolveAuthProvider().userStatus({ store: workspaceSecretStore(target.root), dir: stateDir, space: target.space, actor: CLI_USER_ACTOR });
    } catch (e) {
      row("login", c.dim((e as Error).message));
    }
    if (st && !st.login) row("login", c.yellow(`not signed in - ${cmd} login --idp ${st.idpUrl}`));
    if (st?.login) {
      row("login", c.green(st.login.sub) + c.dim(` · session until ${new Date(st.login.expiresAt * 1000).toISOString()}`));
      if (st.grant === "not-granted")
        row("actor", c.yellow(`"${CLI_USER_ACTOR}" not granted - ${cmd} actor grant ${CLI_USER_ACTOR} --sub ${st.login.sub}`));
      else if (st.grant)
        row(
          "actor",
          c.green(`"${CLI_USER_ACTOR}" granted${st.grant.label ? ` (${st.grant.label})` : ""}`) +
            c.dim(
              ` - read [${st.grant.allowSubscribe.join(", ")}], post [${st.grant.allowPublish.join(", ")}]${st.grant.scope.length ? `, scope [${st.grant.scope.join(", ")}]` : ""}`,
            ),
        );
      else row("actor", c.dim("grant not checkable on this machine (no local ledger)"));
    }
    const granted = Boolean(st?.login && st.grant && st.grant !== "not-granted");
    if (live && granted) {
      await userLiveSnapshot(target, stateDir).catch((e) => row("live snapshot", c.dim(`unavailable (${(e as Error).message})`)));
    } else {
      row("live snapshot", c.dim(live ? "needs a signed-in, granted login (see above)" : "broker unreachable"));
    }
    return;
  }

  const preflight = await preflightTarget(target);
  if (!preflight.ok) {
    row("connection", c.red(`${preflight.kind}${preflight.prune ? " (stale registry entry)" : ""}`));
    return;
  }
  row("connection", c.green("ok"));
  await liveSnapshot(target).catch((e) => row("live snapshot", c.dim(`unavailable (${(e as Error).message})`)));
}

async function liveSnapshot(target: ReturnType<typeof resolveMeshTarget>): Promise<void> {
  const id = newIdentity();
  const creds = target.auth ? await mintCreds(target.auth, id, "observer") : undefined;
  const watchBrokerState = Boolean(target.auth);
  const ep = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    // The recorded requirement, for the same reason as the preflight probe above it: a monitoring
    // command that connects to whatever answers on the address cannot report on the one property
    // this feature provides, and reporting "ok" against a substituted plaintext broker is worse
    // than reporting nothing.
    tls: target.tlsRequired,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    // In open mode the endpoint lazily creates KV buckets for watches. Keep status read-only.
    watchPresence: watchBrokerState,
    watchChannels: watchBrokerState,
    card: { id: id.id, name: "status", kind: "endpoint" },
  });
  await renderSnapshot(ep, watchBrokerState);
}

/** The user-auth live snapshot: the same read-only roster/channels view, connected as THIS
 *  machine's signed-in, ledger-granted login (bearer + sentinel — the flip forbids a status mint). */
async function userLiveSnapshot(target: ReturnType<typeof resolveMeshTarget>, stateDir: string): Promise<void> {
  const { bearer, sentinelCreds } = await resolveAuthProvider().userCredentials({
    store: workspaceSecretStore(target.root),
    dir: stateDir,
    space: target.space,
    actor: CLI_USER_ACTOR,
  });
  const ep = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    // Same reason as liveSnapshot: the recorded requirement is the primary fence against a
    // forged INFO, and a monitoring snapshot that auto-upgrades cannot report on it.
    tls: target.tlsRequired,
    bearer,
    sentinelCreds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    watchChannels: true,
    card: { name: "status", kind: "endpoint" }, // card.id derives from the bearer principal
  });
  await renderSnapshot(ep, true);
}

async function renderSnapshot(ep: CotalEndpoint, watchBrokerState: boolean): Promise<void> {
  ep.on("error", () => {});
  await ep.start();
  try {
    const roster = watchBrokerState ? ep.getRoster() : [];
    const channels = await ep.listChannels();
    const membership = await ep.readMembership().catch(() => undefined);
    row(
      "roster",
      watchBrokerState
        ? (roster.length ? `${roster.length} endpoint${roster.length === 1 ? "" : "s"}` : "empty")
        : c.dim("skipped in open mode (read-only)"),
    );
    for (const p of roster.slice(0, 8)) {
      const label = p.card.role ? `${p.card.name}/${p.card.role}` : p.card.name;
      console.log(`    ${statusBadge(p.status)}  ${label}${p.activity ? c.dim(` - ${p.activity}`) : ""}`);
    }
    if (roster.length > 8) console.log(c.dim(`    +${roster.length - 8} more`));
    row("channels", channels.length ? channels.map((ch) => `${ch.channel}(${ch.messages})`).join(", ") : "none");
    if (membership)
      row(
        "membership feed",
        membership.asOf ? c.green(`${membership.members.length} entries · ${new Date(membership.asOf).toISOString()}`) : c.dim("no heartbeat"),
      );
  } finally {
    await ep.stop();
  }
}

function webInstalled(): boolean {
  try {
    return loadExtensionsManifest().extensions.some((e) => e.commands.some((cmd) => cmd.name === "web"));
  } catch {
    return false;
  }
}

function personaSummary(root: string): string {
  const dir = join(root, ".cotal", "agents");
  const def = existsSync(join(dir, "default.md"));
  const demo = ["david.md", "sven.md", "me.md"].filter((f) => existsSync(join(dir, f))).length;
  const parts = [def ? c.green("default") : c.dim("no default")];
  if (demo) parts.push(c.dim(`demo team ${demo}/3`));
  return parts.join(" · ");
}

function proc(path: string): Proc {
  return pidfileState(path);
}

function formatProc(p: Proc): string {
  if (p.live) return c.green(`running (pid ${p.pid})`);
  return c.dim(p.pid ? `${p.note} (${p.pid})` : (p.note ?? "down"));
}

function section(name: string): void {
  console.log(`\n${c.bold(name)}`);
}

function row(name: string, value: string): void {
  console.log(`  ${name.padEnd(16)} ${value}`);
}

/** The distinct exit cases of the component-health pass.  A process record says that this machine
 * knows about a component; a component-owned control answer says it is actually serving.  Do not
 * flatten those questions — the manager incident was exactly a live lease holder that had not
 * reached its service rail. */
type ComponentVerdict = "serving" | "absent" | "not-serving" | "refused";
type ComponentHealth = { name: string; verdict: ComponentVerdict; facts: string[] };

const COMPONENT_EXIT: Record<ComponentVerdict, number> = {
  serving: 0,
  absent: 1,
  "not-serving": 2,
  refused: 3,
};

/** Machine-readable, uncoloured component records — one line per component.  Human text follows
 * after the state token, but the token/exit contract deliberately stays simple for cron. */
function printComponent(component: ComponentHealth): void {
  console.log(`  ${component.name.padEnd(16)} ${component.verdict}${component.facts.length ? ` · ${component.facts.join(" · ")}` : ""}`);
}

function componentExit(components: readonly ComponentHealth[]): number {
  // Refusal outranks every state: an unreadable control surface is not a clean zero even if some
  // other component answered.  A process that exists but lacks its serving answer is next, then
  // genuine absence.  The order is intentionally one place so a new component cannot accidentally
  // collapse these states by choosing its own exit code.
  return Math.max(...components.map((component) => COMPONENT_EXIT[component.verdict]));
}

function processRecord(path: string): { kind: "absent" } | { kind: "dead"; pid: number } | { kind: "unattributable"; raw: string } | { kind: "live"; pid: number } | { kind: "unknown"; pid: number } {
  if (!existsSync(path)) return { kind: "absent" };
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return { kind: "absent" };
  const pid = parsePid(raw);
  if (pid === undefined) return { kind: "unattributable", raw };
  const liveness = probeLiveness(pid);
  return liveness === "alive" ? { kind: "live", pid } : liveness === "dead" ? { kind: "dead", pid } : { kind: "unknown", pid };
}

function pidFacts(record: ReturnType<typeof processRecord>): string[] {
  if (record.kind === "live" || record.kind === "dead" || record.kind === "unknown") return [`pid ${record.pid}`];
  return [];
}

function processVerdict(record: ReturnType<typeof processRecord>): ComponentVerdict | undefined {
  if (record.kind === "absent" || record.kind === "dead") return "absent";
  if (record.kind === "unattributable" || record.kind === "unknown") return "refused";
  return undefined;
}

/** A manager's only control claim is its service rail: a pid, a lease, or a registration is not a
 * serving answer.  The generic manager `status` command is the manager-owned health surface and is
 * deliberately called only after we establish that its local process record remains alive. */
async function componentEp(target: MeshTarget): Promise<{ ep: CotalEndpoint; close(): Promise<void> }> {
  const id = newIdentity();
  const creds = target.auth ? await mintCreds(target.auth, id, "deployer") : undefined;
  const ep = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    tls: target.tlsRequired,
    creds,
    lifecycleUid: target.auth ? mintLifecycleUid() : undefined,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { id: id.id, name: "status-components", kind: "endpoint" },
  });
  ep.on("error", () => {});
  await ep.start();
  return { ep, close: () => ep.stop().catch(() => {}) };
}

/** A service registration is the health target itself.  Calling its `status` command through a
 * generic endpoint does not work on this base because a passive status endpoint has no v0.4 caller
 * rail; a one-shot standalone caller does. */
async function managerServiceHealth(
  target: MeshTarget,
  auth: { creds?: string; caller: { owner: string; actor: string; uid: string } },
): Promise<{ instanceId?: unknown; runtime?: unknown }> {
  const nc = await connect({
    servers: target.server,
    ...standaloneConnectOpts(auth.creds ? { creds: auth.creds, tls: target.tlsRequired } : { tls: target.tlsRequired }),
    maxReconnectAttempts: 0,
  });
  try {
    const service = await resolveService(nc, target.space, "manager", auth.caller, { deadlineMs: 3_000 });
    const response = await invokeCommand(nc, target.space, service, "status", undefined, { deadlineMs: 3_000 });
    if (response.reply.ok !== true)
      throw new EpEnvelopeError(response.reply.error?.code === "unavailable" ? "unavailable" : "failed-precondition", response.reply.error?.message ?? "manager status refused");
    return response.reply.data as { instanceId?: unknown; runtime?: unknown };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

async function managerHealth(target: MeshTarget, context: LocalProcessContext): Promise<ComponentHealth> {
  const record = processRecord(localProcessPath(MANAGER_PIDFILE, context));
  const facts = pidFacts(record);
  // A corrupt or kernel-unreadable LOCAL record is neither evidence that the manager is absent nor
  // permission to replace it with a network answer.  Name that failed local control surface first.
  if (record.kind === "unattributable" || record.kind === "unknown") {
    facts.push(record.kind === "unattributable" ? "unattributable pidfile" : "pid liveness unestablishable");
    facts.push("phase not reported by this manager build");
    return { name: "manager", verdict: "refused", facts };
  }
  if (record.kind === "dead") facts.push("stale pidfile");

  let close: (() => Promise<void>) | undefined;
  try {
    const component = await componentEp(target);
    close = component.close;
    const lease = await component.ep.readManagerLease();
    if (lease) facts.push(`lease holder ${lease.holder}`, `lease pid ${lease.pid}`);
    else facts.push("lease absent");
    // The service caller triple is part of the manager's own authenticated control surface.  Keep
    // the minted credential and the subject caller on the SAME identity; a mismatched random actor
    // would turn an authorized manager into a false no-answer on static meshes.
    const serviceIdentity = newIdentity();
    const serviceUid = mintLifecycleUid();
    const serviceCreds = target.auth
      ? await mintCreds(target.auth, serviceIdentity, "deployer", { lifecycleUid: serviceUid })
      : undefined;
    const served = await managerServiceHealth(target, {
      creds: serviceCreds,
      caller: { owner: "local", actor: serviceIdentity.id, uid: serviceUid },
    });
    facts.push(`service instance ${served.instanceId ?? "unreported"}`);
    facts.push(`runtime ${served.runtime ?? "unreported"}`);
    facts.push("phase not reported by this manager build");
    facts.push("serve reachable");
    // A manager service without its own liveness lease is a contradicted component surface, not a
    // healthy one. It still reports reachability, but cannot claim the required lease holder.
    return { name: "manager", verdict: lease ? "serving" : "not-serving", facts };
  } catch (e) {
    facts.push("phase not reported by this manager build");
    // A no-responder service rail or an absent manager registry is definitive no-service evidence.
    // The lease and PID answer whether that missing service belongs to an extant component (not
    // serving) or an absent one; any other failed probe remains a refusal.
    const noService = e instanceof EpEnvelopeError && (unansweredRequest(e) || /service registry.*stream not found/i.test(e.message));
    facts.push(noService ? "serve no answer" : `serve probe refused: ${(e as Error).message}`);
    if (!noService) return { name: "manager", verdict: "refused", facts };
    const liveRecord = record.kind === "live";
    const hasLease = facts.some((fact) => fact.startsWith("lease holder "));
    return { name: "manager", verdict: liveRecord || hasLease ? "not-serving" : "absent", facts };
  } finally {
    await close?.();
  }
}

/** Delivery owns two answers: its ready lease is its liveness/control surface; its latest explicit
 * adoption report is the renewal record it writes through the manager-owned renewal pass.  The
 * latter is intentionally not inferred from credential mtime or process output. */
async function deliveryHealth(target: MeshTarget, context: LocalProcessContext): Promise<ComponentHealth> {
  const record = processRecord(localProcessPath(DELIVERY_PIDFILE, context));
  const facts = pidFacts(record);
  const stopped = processVerdict(record);
  const renewalPath = join(context.root, ".cotal", "renewal.json");
  let renewal: { adoption?: { ok: boolean; error?: string } } | undefined;
  try {
    if (existsSync(renewalPath)) renewal = JSON.parse(readFileSync(renewalPath, "utf8")) as { adoption?: { ok: boolean; error?: string } };
  } catch (e) {
    facts.push(`renewal record unreadable: ${(e as Error).message}`);
    return { name: "delivery", verdict: "refused", facts };
  }
  if (renewal?.adoption === undefined) facts.push("renewal adoption not reported");
  else facts.push(renewal.adoption.ok ? "renewal adoption accepted" : `renewal adoption refused${renewal.adoption.error ? `: ${renewal.adoption.error}` : ""}`);
  if (stopped) {
    if (record.kind === "dead") facts.push("stale pidfile");
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    return { name: "delivery", verdict: stopped, facts };
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const component = await componentEp(target);
    close = component.close;
    const lease = await component.ep.readDeliveryLease(0);
    if (!lease) {
      facts.push("ready lease absent");
      return { name: "delivery", verdict: "not-serving", facts };
    }
    facts.push(`lease holder ${lease.holder}`);
    facts.push(lease.ready ? "ready" : "starting (lease not ready)");
    return { name: "delivery", verdict: lease.ready ? "serving" : "not-serving", facts };
  } catch (e) {
    // A live recorded daemon with no delivery lease bucket cannot be serving this build's delivery
    // control surface.  A denied/timed-out read is different: it is a refusal and must never read
    // as a clean absence.
    const noLeaseSurface = /stream not found/i.test((e as Error).message);
    facts.push(noLeaseSurface ? "ready lease absent" : `lease probe refused: ${(e as Error).message}`);
    return { name: "delivery", verdict: noLeaseSurface ? "not-serving" : "refused", facts };
  } finally {
    await close?.();
  }
}

/** The web dashboard owns the HTTP listener and identifies itself through `/api/meta`, including
 * the serving PID.  A raw TCP success is insufficient: another program could own its port. */
export function webProbeTarget(command: string):
  | { host: string; port: number; url: URL }
  | { refused: string } {
  const portMatch = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?:\s|$)/.exec(command);
  const hostMatch = /(?:^|\s)--host(?:=|\s+)([^\s]+)(?:\s|$)/.exec(command);
  // A direct web process uses the documented defaults. A detached process is re-execed with `web`
  // in argv; an arbitrary live PID record whose command has neither form is not evidence that the
  // default endpoint is its control face, so decline the probe rather than test a bystander.
  const isWebCommand = /(?:^|\s)web(?:\s|$)/.test(command);
  if (!portMatch && !isWebCommand)
    return { refused: "port probe refused (recorded PID is not a web command)" };
  const port = portMatch ? Number(portMatch[1]) : 7799;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { refused: "port probe refused (invalid process port)" };
  const host = hostMatch?.[1] ?? "127.0.0.1";
  try {
    const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (unbracketed.includes("[") || unbracketed.includes("]") || /[\s/?#@]/.test(unbracketed)) throw new Error("invalid");
    const ipv6 = unbracketed.includes(":");
    const parsed = new URL(`http://${ipv6 ? `[${unbracketed}]` : unbracketed}:${port}/api/meta`);
    const normalized = ipv6 ? parsed.hostname.slice(1, -1) : parsed.hostname;
    if (normalized === "0.0.0.0" || normalized === "::" || normalized === "::ffff:0:0") throw new Error("invalid");
    return {
      host: normalized,
      port,
      url: parsed,
    };
  } catch {
    return { refused: "host probe refused (invalid process host)" };
  }
}

async function webHealth(context: LocalProcessContext): Promise<ComponentHealth> {
  const record = processRecord(localProcessPath("web.pid", context));
  const facts = pidFacts(record);
  const stopped = processVerdict(record);
  if (stopped) {
    if (record.kind === "dead") facts.push("stale pidfile");
    if (record.kind === "unattributable") facts.push("unattributable pidfile");
    if (record.kind === "unknown") facts.push("pid liveness unestablishable");
    return { name: "web", verdict: stopped, facts };
  }
  // The dashboard exposes its own requested port in its process command.  We ask only the exact
  // recorded PID — never scan ports — and then require that HTTP's `/api/meta` names the same PID.
  // An unreadable command is a probe refusal rather than an assumption that the documented default
  // was used.
  if (record.kind !== "live") throw new Error("web component record lost its live pid after classification");
  const pid = record.pid;
  const command = readProcessCommand(pid);
  if (command.kind !== "command") return { name: "web", verdict: "refused", facts: [...facts, "port probe refused (process command unreadable)"] };
  const target = webProbeTarget(command.command);
  if ("refused" in target) return { name: "web", verdict: "refused", facts: [...facts, target.refused] };
  try {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(500) });
    const meta = await response.json() as { pid?: unknown };
    if (response.ok && meta.pid === pid) return { name: "web", verdict: "serving", facts: [...facts, `host ${target.host}`, `port ${target.port}`, "http reachable"] };
    return { name: "web", verdict: "not-serving", facts: [...facts, `host ${target.host}`, `port ${target.port}`, "http identity mismatch"] };
  } catch {
    // The registered web process has no persistent endpoint record beyond its own command. If that
    // exact HTTP surface cannot identify the recorded PID, this component is present but not serving.
  }
  return { name: "web", verdict: "not-serving", facts: [...facts, `host ${target.host}`, `port ${target.port}`, "http not answered"] };
}

async function brokerHealth(target: MeshTarget): Promise<ComponentHealth> {
  try {
    const reachable = await isReachable(target.server, target.tlsRequired ? { tls: true } : {});
    return reachable
      ? { name: "broker", verdict: "serving", facts: [`registered ${target.server}`, "reachable"] }
      : { name: "broker", verdict: "not-serving", facts: [`registered ${target.server}`, "unreachable"] };
  } catch (e) {
    return { name: "broker", verdict: "refused", facts: [`registered ${target.server}`, `probe refused: ${(e as Error).message}`] };
  }
}

async function printComponentHealth(cwd: string, values: FlagValues<typeof statusFlags>): Promise<void> {
  section("Component Health");
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(cwd, { server: values.server, space: values.space });
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      printComponent({ name: "target", verdict: "refused", facts: [e.code, renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "")] });
      process.exitCode = COMPONENT_EXIT.refused;
      return;
    }
    throw e;
  }
  const context: LocalProcessContext = { root: target.root, space: target.space, userAuth: target.mode === "user" };
  const components = await Promise.all([
    managerHealth(target, context),
    deliveryHealth(target, context),
    webHealth(context),
    brokerHealth(target),
  ]);
  for (const component of components) printComponent(component);
  process.exitCode = componentExit(components);
}
