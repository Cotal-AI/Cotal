import { spawn as spawnProcess, execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  agentFilePath,
  connectorServers,
  spawnEnvAllow,
  deprovisionAgent,
  firstFreeName,
  isReachable,
  loadAgentFile,
  loadCotalConfig,
  mintCreds,
  newIdentity,
  DEV_OWNER,
  parseShareSelection,
  principalKey,
  mintLifecycleUid,
  provisionAgent,
  provisionAgentDurables,
  registry,
  resolveAuthProvider,
  CotalEndpoint,
  type AgentDef,
  type CompletionResult,
  type Connector,
  type ExtensionRef,
  type FlagSpec,
  type FlagValues,
  type LaunchOpts,
  type LaunchSpec,
  type ParsedArgs,
  type SpaceAuth,
} from "@cotal-ai/core";
import {
  agentActorTokenKey,
  agentCredsKey,
  agentSecretFilePaths,
  agentSentinelCredsKey,
  authDir,
  credsFlag,
  defaultAgentOverride,
  defaultAgentType,
  defaultPersonaOverride,
  defaultPersonaRef,
  launchFlags,
  loadMeshes,
  getSpaceAuth,
  materializeSecretToFile,
  mergeLaunchOptions,
  parseLaunchOptions,
  provenance,
  resolveMeshTarget,
  serverFlag,
  spaceAccountPath,
  spaceFlag,
  userAuthStateDir,
  workspaceSecretStore,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { completedFlagValue, completingFlagValue, hasCompletedFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { preflightOrExit, resolveTargetOrExit } from "../lib/connect.js";
import { askManager, failIfNotOk, onInstanceOrExit, resolveControlTarget, START_TIMEOUT_MS } from "../lib/control.js";
import { listDeclaredChannels, listDeclaredRoles, listPersonas } from "../lib/personas.js";
import { spawnManifest } from "./spawn-manifest.js";
import { extensionNames } from "../ext-loader.js";

/** Completion for `cotal spawn` — `--space <TAB>` lists the running meshes, and the first positional
 *  is a persona from the mesh this spawn would target. Resolved OFFLINE (registry + `current`, no
 *  probe — a <TAB> must stay cheap and never open the network), so it lists the *target* mesh's
 *  personas, not the cwd's. */
export function spawnComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, spawnFlags);
  if (flag?.name === "space")
    return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "agent")
    return { items: registry.all<Connector>("connector").map((c) => ({ value: c.name })), directive: "nofiles" };
  if (flag?.name === "role")
    return { items: listDeclaredRoles().map((value) => ({ value, description: "declared role" })), directive: "nofiles" };
  if (flag?.name === "config") {
    const current = argv[argv.length - 1] ?? "";
    if (current.includes("/") || current.includes("\\") || current.endsWith(".md")) return { items: [], directive: "default" };
    try {
      return { items: personaItems(argv), directive: "nofiles" };
    } catch {
      return { items: [], directive: "nofiles" };
    }
  }
  if (flag && ["subscribe", "allow-subscribe", "allow-publish"].includes(flag.name))
    return { items: listDeclaredChannels().map((value) => ({ value, description: "declared channel" })), directive: "nofiles" };
  if (flag && ["cwd", "file", "creds"].includes(flag.name)) return { items: [], directive: "default" };
  if (flag?.name === "runtime")
    return { items: ["pty", ...extensionNames("runtime")].filter((value, i, all) => all.indexOf(value) === i).map((value) => ({ value })), directive: "nofiles" };

  const positionals = positionalsForCompletion(argv, spawnFlags);
  // Only the first word after `spawn` is the persona positional; once it's typed, defer to the shell.
  if (positionals.length <= 1 && !hasCompletedFlagValue(argv, spawnFlags, "config")) {
    try {
      return { items: personaItems(argv), directive: "nofiles" };
    } catch {
      // No single target (no mesh, or several with no `current`) — fail CLOSED: offer no personas
      // rather than throw. `cotal spawn --space <TAB>` still lists the running meshes.
      return { items: [], directive: "nofiles" };
    }
  }
  return { items: [], directive: "nofiles" };
}

function personaItems(argv: string[]) {
  const target = resolveMeshTarget(process.cwd(), {
    space: completedFlagValue(argv, spawnFlags, "space"),
    server: completedFlagValue(argv, spawnFlags, "server"),
  });
  return listPersonas(target.root).map((p) => ({ value: p.name }));
}

/** Persona selection precedence shared by foreground and detached spawn. */
export function spawnPersonaRef(configFlag: string | undefined, positionals: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  return configFlag ?? positionals[0] ?? defaultPersonaRef("default", env);
}

/**
 * `cotal spawn <name-or-path>` — launch an agent in the FOREGROUND of this
 * terminal from a local agent file, joined to the mesh with its persona.
 *
 * With `--detach` the manager spawns it into a detached PTY you `cotal attach` to;
 * otherwise `cotal spawn` hands THIS terminal straight to the agent: run it in your
 * shell, or inside a cmux/tmux pane, and the real Claude TUI takes over. One grammar,
 * two run modes.
 *
 * The launch recipe is the connector's `buildLaunch` (the single source of truth,
 * shared with the manager); only *how the spec runs* differs — foreground exec
 * here vs. a supervised runtime in the manager. The connector is resolved from
 * the registry by agent type, composed at the root.
 *
 * The mesh it joins — creds and personas together — is resolved by {@link resolveMeshTarget}, so a
 * bare `cotal spawn <persona>` from any directory finds the running mesh (one up, or the `current`
 * default) instead of mistaking `~/.cotal` for a space.
 */
/**
 * Auto-number `requested` past any peer already present on the mesh (foo → foo-2 → foo-3) — the same
 * series the manager's spawn funnel uses (firstFreeName). Foreground `cotal spawn` doesn't go through
 * the manager, so it has no name reservation: this is a best-effort, advisory check. It connects a
 * transient presence-watching endpoint, lets the roster settle, and snapshots the live names; two
 * simultaneous `cotal spawn`s can still race onto the same number. If the mesh is unreachable the
 * agent couldn't join it anyway, so dedup is skipped and the requested name stands.
 */
async function uniqueMeshName(
  requested: string,
  { space, server, auth }: { space: string; server: string; auth?: SpaceAuth },
): Promise<string> {
  // Reading presence in auth mode needs a credential (the bucket is OPEN-only for agents): a
  // short-lived least-privilege OPERATOR cred (presence/channel read + self-publish), the same throwaway
  // `cotal dm`/`send` mints to resolve a name → id.
  const creds = auth ? await mintCreds(auth, newIdentity(), "operator") : undefined;
  if (!(await isReachable(server, { creds }))) return requested;
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false, // an invisible probe — don't add ourselves to the roster we're reading
    watchPresence: true,
    card: { name: "spawn-probe", kind: "endpoint" },
  });
  ep.on("error", () => {}); // advisory: a presence-read hiccup must never block the spawn
  await ep.start();
  try {
    // Presence replays from the KV bucket right after connect; settle until the roster count holds
    // steady across two polls (≤1s), then snapshot the names of the peers that are actually live.
    let prev = -1;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const n = ep.getRoster().length;
      if (n === prev) break;
      prev = n;
    }
    const taken = new Set(
      ep.getRoster().filter((p) => p.status !== "offline").map((p) => p.card.name),
    );
    return firstFreeName(requested, (n) => taken.has(n));
  } finally {
    await ep.stop();
  }
}


/** `cotal spawn`'s full grammar: target + the shared launch bundle + the two spawn-only modes
 *  (`--detach` = manager-run; `-f` = manifest deploy). Declared `as const` so the values cast
 *  below is compile-checked against exactly these specs. Foreground and detached parse the SAME
 *  flags — the old `spawn` vs `start` ability drift is structurally gone. */
export const spawnFlags = [
  spaceFlag,
  serverFlag,
  { ...credsFlag, description: "control-caller creds for an off-registry manager (--detach only)" },
  ...launchFlags,
  { name: "detach", type: "boolean", short: "d", description: "launch via the manager into a detached PTY (reattach with `cotal attach`)" },
  { name: "live-only", type: "boolean", description: "foreground only: skip the durable backstop (no read-ACL row; messages missed while disconnected are not replayed)" },
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "deploy a manifest onto the running mesh" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
  { name: "allow-stale", type: "string", value: "<a,b>", description: "with -f: waive named stale agents (apply-only)" },
  { name: "runtime", type: "string", value: "<name>", description: "with -f: override the manifest's runtime" },
  { name: "on", type: "string", value: "<instance>", description: "with --detach: target a specific manager instance id (multi-manager space); default = class anycast" },
] as const satisfies readonly FlagSpec[];

/** Foreground `cotal spawn` resolves its `--agent` connector from the registry (spawn.ts below); on
 *  the published binary nothing static-imports connectors, so declare the resolved one as a required
 *  extension and `runCli` materializes it first (seeded or `ext add`ed), failing loud if absent. The
 *  `-f` manifest launch preflights every type via `preflightConnectors`, and `--detach` resolves the
 *  connector manager-side, so both skip this. */
export function spawnRequiredExtensions(args: ParsedArgs): readonly ExtensionRef[] {
  const v = args.values as FlagValues<typeof spawnFlags>;
  if (v.file || v.detach) return [];
  return [{ kind: "connector", name: v.agent ?? defaultAgentType("claude") }];
}

/** Comma-list flag → string[] (shared by both spawn modes). */
const splitFlag = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** The `--detach` mode: hand the launch to the running manager over the control plane. One grammar
 *  with the foreground path; the persona file is resolved (and is the access default) manager-side,
 *  overridden by the same flags, which ride the `start` op. Replaces the removed `cotal start`. */
async function spawnDetached(
  values: FlagValues<typeof spawnFlags>,
  positionals: string[],
  events: boolean | undefined,
  launchOptions: Record<string, string> | undefined,
): Promise<void> {
  // WHICH file the manager loads — the exact foreground precedence (`--config` > positional >
  // `COTAL_DEFAULT_PERSONA` > `default`). Identity is separate:
  // when `--name` is given it OVERRIDES the file's `name:` (foreground's `requested`), threaded
  // as the op's `identity` so it is never silently dropped in detached mode.
  const defaultPersona = defaultPersonaOverride();
  const ref = spawnPersonaRef(values.config, positionals);
  const managerConfigRef = values.config ?? (!positionals[0] && defaultPersona ? ref : undefined);
  const on = onInstanceOrExit(values.on, "cotal spawn <persona> --detach");
  const t = await resolveControlTarget(
    { space: values.space, server: values.server, creds: values.creds },
    "control-caller-privileged",
    on,
  );
  provenance.read("mesh", `${t.space} (${t.server})`);
  console.error(c.dim("waiting for it to join the mesh (the manager replies on a real outcome - join, exit, or ~30s) …"));
  const reply = await askManager(t.space, t.server, "start", {
    name: ref,
    identity: values.name,
    role: values.role,
    agent: values.agent ?? defaultAgentOverride(),
    config: managerConfigRef,
    model: values.model,
    variant: values.variant,
    launchOptions,
    cwd: values.cwd,
    resume: values.resume, // host-local session id; the manager preflights connector resume support
    prompt: values.prompt,
    shareTools: values["share-tools"],
    subscribe: splitFlag(values.subscribe),
    allowSubscribe: splitFlag(values["allow-subscribe"]),
    allowPublish: splitFlag(values["allow-publish"]),
    // Tri-state: true (--events), false (--no-events, explicit), absent → manager default.
    events,
    // #159 B1: the manager replies only on a REAL outcome (presence join / process exit / ~30s
    // readiness backstop) — the start request must outlive that window, not the 5s op default.
    // `--on <instance>` pins the spawn to that exact manager instance (P2 item 3 multi-manager).
  }, t.auth, "owner", START_TIMEOUT_MS, { instanceId: on });
  failIfNotOk(reply);
  const d = reply.data as { name: string; role?: string; agent: string; mode: string };
  console.log(
    c.green(`✓ spawned ${c.bold(d.name)} (detached)`) +
      c.dim(` (${d.role ?? "no role"} · ${d.agent} · ${d.mode}) - attach with: cotal attach --name ${d.name}`),
  );
}

export async function spawn(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as FlagValues<typeof spawnFlags>;

  // `spawn -f cotal.yaml` is a distinct path: deploy a manifest onto a RUNNING mesh (additive,
  // ownership-scoped). The broker must already be reachable; bringing up a fresh mesh is `up -f`.
  // `--on` is read only by the detached imperative launch. A foreground spawn runs the connector in
  // this process (no manager to pin), and a manifest deploy launches every agent through the
  // manager class queue (`spawnManifest` takes no instance). Both would have to ignore the flag;
  // an ignored pin is a silent fallback, so refuse it where it cannot apply, as `--dry-run` is.
  if (values.on !== undefined && (!values.detach || values.file)) {
    console.error(c.red("✗ --on only applies to a detached imperative spawn (`cotal spawn <persona> --detach --on <instance>`); a foreground spawn has no manager to pin and a manifest deploy (-f) launches through the manager class queue"));
    process.exit(1);
  }
  if (values.file) {
    await spawnManifest(values.file, {
      dryRun: Boolean(values["dry-run"]),
      server: values.server,
      space: values.space,
      runtime: values.runtime,
      allowStale: splitFlag(values["allow-stale"]),
    });
    return;
  }
  // `--resume ""` / `--resume=` means the operator asked to resume but named no session — fail loud
  // rather than silently spawn a fresh one (no fallbacks). An absent flag (undefined) is fine.
  if (values.resume !== undefined && !values.resume.trim()) {
    console.error("--resume needs a session id (got an empty value)");
    process.exit(1);
  }
  if (values.variant !== undefined && !values.variant.trim()) {
    console.error("--variant needs a variant name (got an empty value)");
    process.exit(1);
  }
  // `--dry-run` is a manifest-only flag (`-f`): on an imperative spawn it would have to be ignored
  // (and once WAS, silently spawning a real agent) — refuse instead.
  if (values["dry-run"]) {
    console.error(c.red("✗ --dry-run only applies to a manifest deploy (`cotal spawn -f <manifest> --dry-run`)"));
    process.exit(1);
  }
  // Parse `--opt k=v` pairs once, up front — a malformed pair fails loud before either launch path
  // (foreground or detached) does any work. The opaque map is core-agnostic; the connector validates.
  let cliLaunchOptions: Record<string, string> | undefined;
  try {
    cliLaunchOptions = parseLaunchOptions(values.opt);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  // The AG-UI event plane is OFF by default. Tri-state: true (--events), false (--no-events,
  // explicit), undefined (absent). Foreground treats absent as off; detached forwards the tri-state
  // so absent defers to the manager's default. The flag ARMS the emitter; the manager separately
  // grants publish on the channel the connector names. Both are required, which is what stops a
  // hand-written grant from turning events on by itself.
  const events = values.events ? true : values["no-events"] ? false : undefined;

  // `--detach`: the SAME grammar, launched by the manager into a detached PTY. The persona is
  // resolved manager-side (its workspace root owns `.cotal/agents`); flags ride the control
  // request and override the file exactly as the foreground path does.
  if (values.detach) {
    return spawnDetached(values, positionals, events, cliLaunchOptions);
  }
  // `--creds` names a CONTROL-CALLER credential (reach an off-registry manager) — meaningless for
  // a foreground launch, which provisions the agent's own creds. Fail loud, never ignore.
  if (values.creds) {
    console.error(c.red("✗ --creds is only valid with --detach (it authenticates the manager control call)"));
    process.exit(1);
  }

  // Which mesh this spawn joins — creds + personas together, resolved from --server/--space, the
  // selected `current` mesh, a local project, or the registry's only running mesh.
  const target = await resolveTargetOrExit({ server: values.server, space: values.space });
  const { space, server, auth } = target;

  const defaultPersona = defaultPersonaOverride();
  // Where the config lives: --config, else the positional <persona>, else COTAL_DEFAULT_PERSONA
  // (.cotal/agents/<name>.md under the TARGET mesh's root). With none, fall back to its `default`
  // persona — `cotal spawn` with no args launches `<root>/.cotal/agents/default.md`.
  const ref = spawnPersonaRef(values.config, positionals);
  const path = agentFilePath(target.root, ref);
  let def: AgentDef;
  try {
    def = loadAgentFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error(
        c.red(
          ref === "default" && !defaultPersona
            ? "✗ no default persona yet - run `cotal setup` to seed one, or name a persona: `cotal spawn <name>`"
            : `✗ no persona "${ref}"${!values.config && !positionals[0] && defaultPersona ? " from COTAL_DEFAULT_PERSONA" : ""} in ${target.space}'s ${target.personaRoot} - pass a catalog name, or use \`--config <path>\` for a file elsewhere`,
        ),
      );
    } else {
      console.error(c.red(`✗ ${(e as Error).message}`));
    }
    process.exit(1);
  }

  // Provenance: say which persona file WON resolution (--config > positional > COTAL_DEFAULT_PERSONA > default)
  // — the user must never wonder which directory their agent's definition came from.
  provenance.read("persona", path);

  // --name / --role override the file (name defaults from the file's frontmatter).
  const requested = values.name ?? def.name;
  const role = values.role ?? def.role;

  // Preflight: fail with one sentence if the mesh is down or won't take our creds, instead of
  // crashing mid-connect with a raw NATS Authorization Violation.
  await preflightOrExit(target);

  // A second `cotal spawn` of the same agent would otherwise join under a duplicate mesh identity:
  // auto-number the name past anyone already present (best-effort — this path bypasses the manager's
  // race-free reservation; see uniqueMeshName). Everything below (creds path, launch) uses `name`.
  // USER mesh: the advisory presence read has no credential to ride (no static mint — U10), so the
  // requested name stands; a same-name respawn ROTATES that actor's grant (upsert), which kills the
  // previous holder's next bearer refresh with the "secret is stale — respawn" health state rather
  // than aliasing it silently.
  const name = target.mode === "user" ? requested : await uniqueMeshName(requested, { space, server, auth });
  if (name !== requested)
    console.error(`"${requested}" is already on the mesh - spawning as ${name} instead`);

  // When the target was auto-resolved (one mesh up, or the `current` default), say which mesh we
  // picked — it isn't obvious from the cwd. An explicit --space/--server or a local project is
  // self-evident, so stay quiet there.
  if (target.source === "registry" || target.source === "current")
    console.error(c.dim(`→ joining mesh ${space} (${server}) as ${name}`));

  const agentType = values.agent ?? defaultAgentType("claude");
  let connector: Connector;
  try {
    connector = registry.resolve<Connector>("connector", agentType);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  const variant = values.variant ?? def.variant;
  if (variant && !connector.supportsModelVariant) {
    console.error(c.red(`✗ ${agentType} connector does not support model variants (variant)`));
    process.exit(1);
  }

  // Auth mode (`.cotal/auth` present): mint a stable identity + scoped creds for this agent
  // and pre-create its bind-only durables, via a short-lived privileged provisioner — the
  // same onboarding the manager does, so the foreground launch joins the authed mesh too.
  // Open mode (no `.cotal/auth`): unchanged — the session connects without creds.
  let id: string | undefined;
  let credsPath: string | undefined;
  // The incarnation's lifecycle UID (SPEC 13.1), minted once per spawn: the launched endpoint binds
  // its lifecycle-keyed dm/dlv/chathist durables by it (auth modes pin the same names in the cred;
  // open mode still needs it for the durable names). A foreground spawn is one lifecycle.
  const lifecycleUid = mintLifecycleUid();
  let userAuth: LaunchOpts["userAuth"];
  let userCleanup: (() => Promise<void>) | undefined;
  // The agent's access policy (flags > persona file) — minted into the creds AND forwarded to the
  // connector (COTAL_SUBSCRIBE / COTAL_ALLOW_*) so the session's runtime read/post set matches its
  // credentials. One source, so a `--subscribe` override can't land in the creds yet be lost at
  // runtime (the connector would otherwise read only the persona file / fall back to `general`).
  const subscribe = splitFlag(values.subscribe) ?? def.subscribe;
  const allowSubscribe = splitFlag(values["allow-subscribe"]) ?? def.allowSubscribe ?? subscribe;
  let allowPublish = splitFlag(values["allow-publish"]) ?? def.allowPublish;
  // The AG-UI event plane, refused HERE for the same reason the manager refuses it before
  // provisioning: a connector that cannot emit must stop the launch while there is still nothing to
  // roll back. The GRANT cannot be derived yet, because it is keyed on the principal and in user
  // mode the owner is resolved inside the provisioning call below.
  if (events && !connector.eventChannel) {
    console.error(c.red(`\u2717 connector "${connector.name}" does not publish an AG-UI event plane, but --events was requested`));
    process.exit(1);
  }
  if (target.mode === "user") {
    // USER mesh: the agent runs as a ledger-granted (owner, actor) principal under the LOGGED-IN
    // operator's owner — never a static identity (U10). Provisioning + grant + a one-shot bearer
    // preflight all happen BEFORE launch, so the spawned agent is never the first to discover a
    // dead auth plane.
    let eventGrant: string | undefined;
    ({ userAuth, cleanup: userCleanup, eventChannel: eventGrant } = await provisionUserForeground(target, name, ref, {
      subscribe,
      allowSubscribe,
      allowPublish,
      role,
      capabilities: def.capabilities,
      lifecycleUid,
      liveOnly: values["live-only"] as boolean | undefined,
      ...(events ? { eventChannel: connector.eventChannel! } : {}),
    }));
    // The launch's post-set is forwarded to the session as COTAL_ALLOW_PUBLISH, so it has to carry
    // whatever was actually minted. Letting the two diverge is how an agent ends up holding a right
    // its own runtime does not know it has.
    if (eventGrant) allowPublish = [...(allowPublish ?? []), eventGrant];
  } else if (auth) {
    const identity = newIdentity();
    // THE EVENT GRANT, from the principal this spawn ALLOCATED. Static mode keys on the nkey, never
    // on the display name: a name is not an identity, and the manager derives the same subject from
    // the same connector function, so a foreground and a detached spawn of one persona land on one
    // channel rather than two.
    if (events) allowPublish = [...(allowPublish ?? []), connector.eventChannel!({ owner: DEV_OWNER, actor: identity.id })];
    const prov = new CotalEndpoint({
      space,
      servers: server,
      creds: await mintCreds(auth, newIdentity(), "provisioner"),
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      card: { name: "spawn-provisioner", role: "provisioner", kind: "endpoint" },
    });
    prov.on("error", (e: Error) => console.error(`! provisioner: ${e.message}`));
    await prov.start();
    // Foreground provisions the SAME durable footprint as `--detach` (DM/DLV durables + read-ACL
    // row): the daemon authorizes durable joins off the ACL row and leave is agent self-service, so
    // no managing host is required — and a silently live-only foreground agent permanently loses
    // every channel message posted while its connection blips (reconnect deliberately re-opens the
    // core-subs without re-backfill). `--live-only` opts back out; on a mesh with no delivery
    // daemon the boot join itself reports live-only, ACL row or not.
    const creds = await provisionAgent(prov, auth, identity, {
      subscribe,
      allowSubscribe,
      allowPublish,
      role,
      capabilities: def.capabilities,
      ...(values["live-only"] ? { durableMembership: false } : {}),
      lifecycleUid,
    });
    await prov.stop();
    // Store first (the source of truth), then materialize — the child's launch reads this FILE.
    // The CLI is the local FS composition (byte-identical), same posture as the manager's spawn.
    const secrets = workspaceSecretStore(target.root);
    credsPath = agentSecretFilePaths(target.root, name).creds;
    await secrets.put(agentCredsKey(name), creds);
    await materializeSecretToFile(secrets, agentCredsKey(name), credsPath);
    id = identity.id;
    provenance.wrote(`creds for ${name} (auth mode)`, credsPath);
  }

  // Which of the operator's personal MCP servers to share with this agent: declared in the cotal
  // config (global ~/.config/cotal + the target mesh's .cotal), narrowed by an optional
  // --share-tools selection. Default (no config) is none — the connector launches isolated.
  const cotalConfig = loadCotalConfig(target.root);
  const mcpServers = connectorServers(cotalConfig, agentType, parseShareSelection(values["share-tools"]));
  // Extra spawned-agent environment names are resolved here, like shared MCP servers, because a
  // connector never reads the config file itself.
  const envAllow = spawnEnvAllow(cotalConfig);

  // Auth mode provisions the identity + writes its creds to disk BEFORE the connector validates the
  // launch (e.g. `buildLaunch` throws on a rejected `--opt`) and before the child execs. The SAME
  // retirement serves a failed launch (rollback) and the normal foreground departure: each spawn
  // mints a fresh identity, so an exited agent's footprint (creds file, DM/DLV durables, ACL row)
  // is dead weight no future spawn reuses — mirror the manager's `deprovision` with an ephemeral,
  // target-pinned deprovisioner cred. Best-effort like the manager's (a SIGKILLed CLI can't run
  // it; the residue is the same class a crashed manager leaves). A no-op in open mode.
  let retired = false;
  const retireProvision = async (why: string): Promise<void> => {
    if (retired || !auth || !id || !credsPath) return;
    retired = true;
    // The store delete is the authoritative removal; the rmSync clears the FS materialization
    // (byte-identical locally). Best-effort-loud, like the broker teardown below.
    await workspaceSecretStore(target.root).delete(agentCredsKey(name)).catch((e) =>
      console.error(`! retire: dropping ${name}'s cred from the secret store failed: ${(e as Error).message}`));
    rmSync(credsPath, { force: true });
    console.error(`  ↩ retired creds for ${name} (${why})`);
    try {
      const dc = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: id, lifecycleUid } });
      await deprovisionAgent({ servers: server, space, targetId: id, lifecycleUid, creds: dc });
    } catch (e) {
      console.error(`! retire: broker teardown for ${name} failed: ${(e as Error).message}`);
    }
  };

  // From here through a successful child launch, a THROW must undo whatever this spawn provisioned —
  // the user-mode actor grant (userCleanup) OR the static-auth creds + broker footprint
  // (retireProvision) — otherwise a buildLaunch/spawn rejection (unsupported resume/model/`--opt`,
  // a bad connector) leaves the just-granted identity standing. The planes are exclusive, so each
  // cleanup is a no-op in the other's mode.
  let child: ReturnType<typeof spawnProcess>;
  let spec: LaunchSpec;
  try {
    spec = connector.buildLaunch({
      space,
      name,
      role,
      id,
      creds: credsPath,
      userAuth,
      lifecycleUid,
      servers: server,
      configPath: path,
      // Model override (wins over the agent file's `model:`) — launch-grammar parity with --detach.
      model: values.model,
      variant,
      // Opaque connector options: `--opt` flags win per key over the persona's `launchOptions:`.
      launchOptions: mergeLaunchOptions(def.launchOptions, cliLaunchOptions),
      subscribe,
      allowSubscribe,
      allowPublish,
      prompt: values.prompt,
      // Fork an existing session into the mesh. `prompt + resume` is a supported combo (claude accepts
      // the positional prompt alongside `--resume … --fork-session`); an unsupported connector throws.
      resume: values.resume,
      events,
      mcpServers,
      envAllow,
      // Where a connector that keeps per-agent local state roots it. The manager passes its own
      // workspace root here; the foreground path did not, so an armed session refused at launch
      // construction because its write-ahead log had nowhere to live that a later start would look.
      workspaceRoot: target.root,
    });

    // What happens next belongs to the CONNECTOR: naming one harness's first-run gate for all of
    // them sends the operator looking for a prompt that never appears, and reads as a hang.
    console.error(
      `spawning ${name}${role ? ` (${role})` : ""} on the mesh${connector.launchHint ? ` - ${connector.launchHint}` : ""}`,
    );
    if (userAuth) console.error(c.dim(`  running as you: ${userAuth.owner}.${name} (actor granted; revoked automatically when this process exits)`));
    child = spawnProcess(spec.command, spec.args, {
      stdio: "inherit",
      // P3: only connector-declared environment reaches the foreground agent, never ambient
      // process.env. Explicit spawn.env remains the operator opt-in for additional names.
      env: spec.env ?? {},
      // `--cwd` roots the agent at another folder/repo (launch-grammar parity with --detach); a
      // relative path resolves against the invoking shell's cwd. Omitted → inherit this cwd.
      cwd: values.cwd ? resolvePath(values.cwd) : undefined,
    });
  } catch (e) {
    // Launch construction / spawn threw AFTER provisioning — undo BOTH planes (each a no-op in the
    // other's mode): revoke the user-mode actor grant AND roll back the static-auth creds + footprint,
    // before rethrowing, so no standing grant survives a spawn that never started.
    if (userCleanup) await userCleanup().catch((err) => console.error(c.red(`✗ revoking ${name}'s actor grant: ${(err as Error).message}`)));
    await retireProvision("launch build failed");
    throw e;
  }
  await new Promise<void>((resolve) => {
    child.on("error", (e) => {
      // The exec never started, so the just-provisioned static-auth identity is orphaned — roll it
      // back. (User-mode revoke runs unconditionally once this promise settles, below.)
      console.error(`✗ failed to launch ${spec.command}: ${e.message}`);
      void retireProvision("exec failed").finally(() => {
        process.exitCode = 1;
        resolve();
      });
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
  // STATIC MODE: the departure half of the run-scoped identity — the agent is gone and no future
  // spawn reuses this identity, so retire its creds + broker footprint now (the manager's despawn
  // deprovision, foregrounded). Best-effort: a SIGKILLed CLI can't run it, and that residue is the
  // same class a crashed manager leaves.
  await retireProvision("agent exited");
  // USER MODE: the runtime-grant invariant applies to the foreground departure too — the agent is
  // gone, so its standing mint authority (ledger row + secret files) goes with it. Best-effort
  // (a SIGKILLed CLI can't run this; the next same-name spawn's rotation is the backstop), loud
  // on failure, never blocking the exit code already set above.
  if (userCleanup) await userCleanup().catch((e) => console.error(c.red(`✗ revoking ${name}'s actor grant: ${(e as Error).message}`)));
}

/** Foreground USER-MODE onboarding — the CLI-side twin of the manager's user spawn provisioning:
 *  owner = the logged-in operator (offline, from the login cache + local user-auth material);
 *  principal-keyed durables on an ephemeral provisioner (LIVE-ONLY, like static foreground);
 *  ledger grant with a fresh per-agent secret (upsert rotates); 0600 secret/sentinel files; and a
 *  one-shot bearer preflight whose operator-exact sentence is the refusal. Exits on any failure —
 *  the agent process is never launched into a broken auth chain. */
async function provisionUserForeground(
  target: MeshTarget,
  name: string,
  ref: string,
  opts: { subscribe?: string[]; allowSubscribe?: string[]; allowPublish?: string[]; role?: string; capabilities?: string[]; lifecycleUid: string; liveOnly?: boolean; eventChannel?: (p: { owner: string; actor: string }) => string },
): Promise<{ userAuth: NonNullable<LaunchOpts["userAuth"]>; cleanup: () => Promise<void>; eventChannel?: string }> {
  const { space, server } = target;
  const dir = userAuthStateDir(target.root, space);
  const store = workspaceSecretStore(target.root);
  const fail = (msg: string): never => {
    console.error(c.red(`✗ ${msg}`));
    process.exit(1);
  };
  let provider: ReturnType<typeof resolveAuthProvider>;
  let owner: string;
  try {
    provider = resolveAuthProvider();
    owner = await provider.ownerForLogin({ store, dir, space });
  } catch (e) {
    return fail((e as Error).message);
  }
  // The provisioner cred is INFRA (pre-flip static coexistence, like the manager's own creds) —
  // loaded explicitly here for durable pre-creation only, never for the agent's identity.
  // The event grant, derived HERE because this is the first point at which the owner exists: in
  // user mode the principal is (resolved owner, actor name), and neither half is known to the
  // caller before `ownerForLogin` answers.
  const eventGrant = opts.eventChannel?.({ owner, actor: name });
  const publish = eventGrant ? [...(opts.allowPublish ?? []), eventGrant] : (opts.allowPublish ?? []);
  const infra = await getSpaceAuth(store, space); // cross-check the bundle names the space we resolved this root for
  if (!infra) return fail(`space "${space}" has user-auth state but no trust record under ${authDir(target.root)} (expected ${spaceAccountPath(authDir(target.root), space)} or the legacy auth.json) - re-run \`cotal up --user-auth\` here`);
  const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = agentSecretFilePaths(target.root, name);
  try {
    // The GRANT first — it is the envelope-rule enforcement point (a delegation must sit within
    // the spawner's own grant), so a refused delegation exits here with zero broker footprint —
    // the same ordering as Manager.provisionUserAgent, for the same reason.
    const grant = await provider.grantAgent({
      store,
      dir,
      space,
      owner,
      actor: name,
      scope: (opts.capabilities ?? []).filter((s) => s === "spawn" || s === "admin" || /^role:[A-Za-z0-9_-]+$/.test(s)),
      allowSubscribe: opts.allowSubscribe?.length ? opts.allowSubscribe : (opts.subscribe?.length ? opts.subscribe : ["general"]),
      allowPublish: publish,
      role: opts.role,
      parent: `${owner}.cli`,
      label: ref,
      lifecycleUid: opts.lifecycleUid,
    });
    const prov = new CotalEndpoint({
      space,
      servers: server,
      creds: await mintCreds(infra, newIdentity(), "provisioner"),
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      card: { name: "spawn-provisioner", role: "provisioner", kind: "endpoint" },
    });
    prov.on("error", (e: Error) => console.error(`! provisioner: ${e.message}`));
    await prov.start();
    try {
      // Full durable footprint, same as the static foreground path: the ACL row is what lets the
      // delivery daemon authorize this agent's durable joins. `--live-only` opts out.
      await provisionAgentDurables(prov, { owner, actor: name, lifecycleUid: opts.lifecycleUid }, {
        subscribe: opts.subscribe,
        allowSubscribe: opts.allowSubscribe,
        role: opts.role,
        ...(opts.liveOnly ? { durableMembership: false } : {}),
      });
    } finally {
      await prov.stop();
    }
    // The store holds the source of truth; the bearer re-exec (`--token-file`) and the launch's
    // sentinel handoff read FILES — materialize both at the canonical paths (byte-identical
    // rewrites under this, the local FS, composition).
    await store.put(agentActorTokenKey(name), grant.actorToken);
    await store.put(agentSentinelCredsKey(name), grant.sentinelCreds);
    await materializeSecretToFile(store, agentActorTokenKey(name), tokenPath);
    await materializeSecretToFile(store, agentSentinelCredsKey(name), sentinelPath);
    rmSync(healthPath, { force: true });
    provenance.wrote(`actor grant ${owner}.${name} (user mode)`, tokenPath);
    const bearerCmd = [
      process.execPath,
      ...process.execArgv,
      process.argv[1],
      provider.agentBearerCommand,
      "--dir", dir,
      "--space", space,
      "--owner", owner,
      "--actor", name,
      "--token-file", tokenPath,
      "--health-file", healthPath,
    ];
    await new Promise<void>((res, rej) => {
      execFile(bearerCmd[0], bearerCmd.slice(1), { timeout: 30_000, maxBuffer: 64 * 1024 }, (err, _stdout, stderr) => {
        if (err) return rej(new Error(stderr.trim() || err.message));
        res();
      });
    });
    return {
      userAuth: { owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd },
      ...(eventGrant ? { eventChannel: eventGrant } : {}),
      // The foreground departure's half of the runtime-grant invariant: the caller runs this when
      // the agent process exits — revoke the row, shred the secret material, and retire the broker
      // footprint the durable provisioning above created (DM/DLV durables + ACL row), the same
      // teardown the rollback path below runs on a failed preflight.
      cleanup: async () => {
        await provider.revokeAgent({ dir, owner, actor: name });
        await store.delete(agentActorTokenKey(name));
        await store.delete(agentSentinelCredsKey(name));
        rmSync(tokenPath, { force: true });
        rmSync(sentinelPath, { force: true });
        rmSync(healthPath, { force: true });
        const targetId = principalKey(owner, name).key;
        await mintCreds(infra, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid: opts.lifecycleUid } })
          .then((creds) => deprovisionAgent({ servers: server, space, targetId, lifecycleUid: opts.lifecycleUid, creds }))
          .catch((err) => console.error(c.red(`✗ retiring ${name}'s broker footprint: ${(err as Error).message}`)));
      },
    };
  } catch (e) {
    // Roll back EVERYTHING this attempt materialized, including the broker footprint the durable
    // provisioning above created — a refused spawn leaves no row, no secret, no orphaned durables.
    await provider.revokeAgent({ dir, owner, actor: name }).catch(() => {});
    await store.delete(agentActorTokenKey(name)).catch(() => {});
    await store.delete(agentSentinelCredsKey(name)).catch(() => {});
    rmSync(tokenPath, { force: true });
    rmSync(sentinelPath, { force: true });
    rmSync(healthPath, { force: true });
    const targetId = principalKey(owner, name).key;
    await mintCreds(infra, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid: opts.lifecycleUid } })
      .then((creds) => deprovisionAgent({ servers: server, space, targetId, lifecycleUid: opts.lifecycleUid, creds }))
      .catch((err) => console.error(c.red(`✗ rollback deprovision ${name}: ${(err as Error).message}`)));
    return fail(`agent auth preflight failed for "${name}": ${(e as Error).message}`);
  }
}
