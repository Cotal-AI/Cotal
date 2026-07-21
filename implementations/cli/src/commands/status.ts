import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  mintCreds,
  newIdentity,
  resolveAuthProvider,
  type FlagValues,
  type ParsedArgs,
  type UserAuthStatus,
} from "@cotal-ai/core";
import { CLI_USER_ACTOR, authDir, findCotalRoot, getCurrent, isWorkspaceTargetError, listSpaceAccounts, loadExtensionsManifest, loadMeshes, loadSoleSpaceAuth, loadSpaceAuth, localProcessPath, localProcessVisible, preflightTarget, resolveMeshTarget, serverFlag, spaceFlag, type LocalProcess, type LocalProcessContext, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { cliVersion, extensionVersions } from "../lib/version.js";
import { managerHasDeliveryMarker } from "../lib/manager-proc.js";
import { machineStatus, resolveSpace, webUp, WEB_URL } from "../lib/status.js";
import { pidfileState, type PidfileState } from "./down.js";
import { displayCmd } from "../lib/self-exec.js";
import { c, statusBadge } from "../ui.js";

export const statusFlags = [spaceFlag, serverFlag] as const;

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
}

/** The installed extensions (seeded built-in connectors + operator `ext add`s) with their pinned
 *  versions. Skipped entirely when none are installed (e.g. a fresh binary before its first seed). */
function printExtensions(): void {
  const exts = extensionVersions();
  if (!exts.length) return;
  section("Extensions");
  for (const e of exts) row(e.label, c.green(`v${e.version}`) + (e.pkg === e.label ? "" : c.dim(` · ${e.pkg}`)));
}

async function printMachine(): Promise<void> {
  const m = await machineStatus();
  const web = await webUp();
  const webExt = webInstalled();
  section("Machine");
  row("cotal-ai", c.green(`v${cliVersion()}`));
  row("NATS", m.nats === "missing" ? c.red("missing") : c.green(m.nats));
  row("Claude plugin", m.claudePlugin ? c.green("installed") : c.dim("not installed"));
  row("Claude", m.agents.claude ? c.green("on PATH") : c.dim("not on PATH"));
  row("OpenCode", m.agents.opencode ? c.green("on PATH") : c.dim("not on PATH"));
  row("Web extension", webExt ? c.green("installed") : c.dim("not installed"));
  row("Web process", web ? c.green(WEB_URL) : c.dim(webExt ? "down" : "not installed"));
}

function printProject(root: string, cmd: string): void {
  const spaces = listSpaceAccounts(authDir(root));
  section("This Folder");
  row("root", root);
  // A root holding several accounts has no single "this folder's space", and the process rows below
  // are keyed by one. Report the tenant list instead of letting the space-blind read throw: a status
  // that cannot describe a multi-space broker is worse than a refusal, because the broker-wide
  // lifecycle refusals send the operator here to see what the root actually holds.
  if (spaces.length > 1) {
    row("auth", c.green(`${spaces.length} spaces · ${spaces.join(", ")}`));
    row("personas", personaSummary(root));
    console.log(c.dim("  per-space process state is not reported on a multi-space root yet"));
    return;
  }
  const auth = loadSoleSpaceAuth(authDir(root));
  const userDisk = auth && existsSync(userAuthStateDir(root, auth.space));
  const context: LocalProcessContext = { root, space: auth?.space ?? resolveSpace(root), userAuth: Boolean(userDisk) };
  row("auth", auth ? c.green(`space ${auth.space}${userDisk ? " · user-auth" : ""}`) : c.dim("none (open/local only)"));
  row("personas", personaSummary(root));
  let nats: Proc | undefined;
  for (const component of localProcessSurface().filter((component) => localProcessVisible(component, context)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    const state = proc(localProcessPath(component.pidFile, context));
    if (component.name === "nats") nats = state;
    const detail = component.name === "manager" && state.live
      ? c.dim(managerHasDeliveryMarker() ? " · delivery-aware" : " · old/unknown build")
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
    console.log(c.dim("  none - start one with `cotal up --detach`"));
    return;
  }
  const pad = Math.max(...meshes.map((m) => m.space.length));
  await Promise.all(
    meshes.map(async (m) => {
      const mark = m.space === current ? c.green("*") : " ";
      const live = await isReachable(m.server);
      console.log(
        `  ${mark} ${m.space.padEnd(pad)}  ${live ? c.green("reachable") : c.red("down")}  ${c.dim(`${m.mode}  ${m.server}  ${m.root}`)}`,
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
      row("hint", `${cmd} up --detach`);
      return;
    }
    throw e;
  }

  row("space", target.space);
  row("server", target.server);
  row("mode", target.mode);
  if (target.userAuth) row("idp", target.userAuth.idp.url);
  row("source", target.source);
  row("root", target.root);

  if (target.mode === "user") {
    // Status never static-mints on a user-auth mesh (the flip). Everything here is offline
    // introspection — the login cache + the locally-readable ledger — plus, only when this
    // machine holds a signed-in AND granted login, a real user-mode connect for the snapshot.
    const live = await isReachable(target.server);
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
