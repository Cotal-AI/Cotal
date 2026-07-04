import { spawn as spawnProcess } from "node:child_process";
import { join, dirname, resolve as resolvePath } from "node:path";
import {
  agentFilePath,
  connectorServers,
  firstFreeName,
  isReachable,
  loadAgentFile,
  loadCotalConfig,
  mintCreds,
  mkSecretDir,
  newIdentity,
  parseShareSelection,
  provisionAgent,
  registry,
  writeSecretFile,
  CotalEndpoint,
  type AgentDef,
  type CompletionResult,
  type Connector,
  type FlagSpec,
  type FlagValues,
  type ParsedArgs,
  type SpaceAuth,
  CONTROL_PRIVILEGED,
} from "@cotal-ai/core";
import {
  authDir,
  credsFlag,
  defaultAgentOverride,
  defaultAgentType,
  launchFlags,
  loadMeshes,
  provenance,
  resolveMeshTarget,
  serverFlag,
  spaceFlag,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { preflightOrExit, resolveTargetOrExit } from "../lib/connect.js";
import { askManager, failIfNotOk, resolveControlTarget, START_TIMEOUT_MS } from "../lib/control.js";
import { listPersonas } from "../lib/personas.js";
import { spawnManifest } from "./spawn-manifest.js";

/** Completion for `cotal spawn` — `--space <TAB>` lists the running meshes, and the first positional
 *  is a persona from the mesh this spawn would target. Resolved OFFLINE (registry + `current`, no
 *  probe — a <TAB> must stay cheap and never open the network), so it lists the *target* mesh's
 *  personas, not the cwd's. */
export function spawnComplete(argv: string[]): CompletionResult {
  if (argv[argv.length - 2] === "--space")
    return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  // Only the first word after `spawn` is the persona positional; once it's typed, defer to the shell.
  if (argv.length <= 1) {
    try {
      const target = resolveMeshTarget(process.cwd());
      return { items: listPersonas(target.root).map((p) => ({ value: p.name })), directive: "nofiles" };
    } catch {
      // No single target (no mesh, or several with no `current`) — fail CLOSED: offer no personas
      // rather than throw. `cotal spawn --space <TAB>` still lists the running meshes.
      return { items: [], directive: "nofiles" };
    }
  }
  return { items: [], directive: "nofiles" };
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
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "deploy a manifest onto the running mesh" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
  { name: "allow-stale", type: "string", value: "<a,b>", description: "with -f: waive named stale agents (apply-only)" },
  { name: "runtime", type: "string", value: "<pty|tmux|cmux>", description: "with -f: override the manifest's runtime" },
] as const satisfies readonly FlagSpec[];

/** Comma-list flag → string[] (shared by both spawn modes). */
const splitFlag = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** The `--detach` mode: hand the launch to the running manager over the control plane. One grammar
 *  with the foreground path; the persona file is resolved (and is the access default) manager-side,
 *  overridden by the same flags, which ride the `start` op. Replaces the removed `cotal start`. */
async function spawnDetached(
  values: FlagValues<typeof spawnFlags>,
  positionals: string[],
  transcript: boolean | undefined,
): Promise<void> {
  // WHICH file the manager loads — the exact foreground precedence (`--config` > positional >
  // `--name` > `default`); `--name` doubles as the ref fallback there too. Identity is separate:
  // when `--name` is given it OVERRIDES the file's `name:` (foreground's `requested`), threaded
  // as the op's `identity` so it is never silently dropped in detached mode.
  const ref = values.config ?? positionals[0] ?? values.name ?? "default";
  const t = await resolveControlTarget(
    { space: values.space, server: values.server, creds: values.creds },
    "control-caller-privileged",
  );
  provenance.read("mesh", `${t.space} (${t.server})`);
  console.error(c.dim("waiting for it to join the mesh (the manager replies on a real outcome — join, exit, or ~30s) …"));
  const reply = await askManager(t.space, t.server, "start", {
    name: ref,
    identity: values.name,
    role: values.role,
    agent: values.agent ?? defaultAgentOverride(),
    config: values.config,
    model: values.model,
    cwd: values.cwd,
    resume: values.resume, // host-local session id; the manager preflights connector resume support
    prompt: values.prompt,
    shareTools: values["share-tools"],
    subscribe: splitFlag(values.subscribe),
    allowSubscribe: splitFlag(values["allow-subscribe"]),
    allowPublish: splitFlag(values["allow-publish"]),
    // Tri-state: true (--transcript), false (--no-transcript, explicit), absent → manager default.
    transcript,
    // #159 B1: the manager replies only on a REAL outcome (presence join / process exit / ~30s
    // readiness backstop) — the start request must outlive that window, not the 5s op default.
  }, t.creds, CONTROL_PRIVILEGED, START_TIMEOUT_MS);
  failIfNotOk(reply);
  const d = reply.data as { name: string; role?: string; agent: string; mode: string };
  console.log(
    c.green(`✓ spawned ${c.bold(d.name)} (detached)`) +
      c.dim(` (${d.role ?? "no role"} · ${d.agent} · ${d.mode}) — attach with: cotal attach --name ${d.name}`),
  );
}

export async function spawn(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as FlagValues<typeof spawnFlags>;

  // `spawn -f cotal.yaml` is a distinct path: deploy a manifest onto a RUNNING mesh (additive,
  // ownership-scoped). The broker must already be reachable; bringing up a fresh mesh is `up -f`.
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
  // Transcript mirroring to `tr-<name>` is OFF by default. Tri-state: true (--transcript),
  // false (--no-transcript, explicit), undefined (absent). Foreground treats absent as off;
  // detached forwards the tri-state so absent defers to the manager's default.
  const transcript = values.transcript ? true : values["no-transcript"] ? false : undefined;

  // `--detach`: the SAME grammar, launched by the manager into a detached PTY. The persona is
  // resolved manager-side (its workspace root owns `.cotal/agents`); flags ride the control
  // request and override the file exactly as the foreground path does.
  if (values.detach) {
    return spawnDetached(values, positionals, transcript);
  }
  // `--creds` names a CONTROL-CALLER credential (reach an off-registry manager) — meaningless for
  // a foreground launch, which provisions the agent's own creds. Fail loud, never ignore.
  if (values.creds) {
    console.error(c.red("✗ --creds is only valid with --detach (it authenticates the manager control call)"));
    process.exit(1);
  }

  // Which mesh this spawn joins — creds + personas together, resolved from --server/--space, a local
  // project, or the registry (the running mesh / the `current` default).
  const target = await resolveTargetOrExit({ server: values.server, space: values.space });
  const { space, server, auth } = target;

  // Where the config lives: --config, else the positional <name-or-path>, else --name
  // (.cotal/agents/<name>.md under the TARGET mesh's root). With none, fall back to its `default`
  // persona — `cotal spawn` with no args launches `<root>/.cotal/agents/default.md`.
  const ref = values.config ?? positionals[0] ?? values.name ?? "default";
  const path = agentFilePath(target.root, ref);
  let def: AgentDef;
  try {
    def = loadAgentFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error(
        c.red(
          ref === "default"
            ? "✗ no default persona yet — run `cotal setup` to seed one, or name a persona: `cotal spawn <name>`"
            : `✗ no persona "${ref}" in ${target.space}'s ${target.personaRoot} — use \`--config <path>\` for a file elsewhere`,
        ),
      );
    } else {
      console.error(c.red(`✗ ${(e as Error).message}`));
    }
    process.exit(1);
  }

  // Provenance: say which persona file WON resolution (--config > positional > --name > default)
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
  const name = await uniqueMeshName(requested, { space, server, auth });
  if (name !== requested)
    console.error(`"${requested}" is already on the mesh — spawning as ${name} instead`);

  // When the target was auto-resolved (one mesh up, or the `current` default), say which mesh we
  // picked — it isn't obvious from the cwd. An explicit --space/--server or a local project is
  // self-evident, so stay quiet there.
  if (target.source === "registry" || target.source === "current")
    console.error(c.dim(`→ joining mesh ${space} (${server}) as ${name}`));

  // Auth mode (`.cotal/auth` present): mint a stable identity + scoped creds for this agent
  // and pre-create its bind-only durables, via a short-lived privileged provisioner — the
  // same onboarding the manager does, so the foreground launch joins the authed mesh too.
  // Open mode (no `.cotal/auth`): unchanged — the session connects without creds.
  let id: string | undefined;
  let credsPath: string | undefined;
  // The agent's access policy (flags > persona file) — minted into the creds AND forwarded to the
  // connector (COTAL_SUBSCRIBE / COTAL_ALLOW_*) so the session's runtime read/post set matches its
  // credentials. One source, so a `--subscribe` override can't land in the creds yet be lost at
  // runtime (the connector would otherwise read only the persona file / fall back to `general`).
  const subscribe = splitFlag(values.subscribe) ?? def.subscribe;
  const allowSubscribe = splitFlag(values["allow-subscribe"]) ?? def.allowSubscribe ?? subscribe;
  const allowPublish = splitFlag(values["allow-publish"]) ?? def.allowPublish;
  if (auth) {
    const identity = newIdentity();
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
    // Direct foreground spawn is LIVE-ONLY: this short-lived provisioner is not a managing Plane-3 host,
    // and no long-lived manager knows this agent (it's in no manager's `agents` ledger), so a durable
    // boot membership could be neither authorized for reader delivery nor leaved via self-service. Skip
    // it — the agent reads live via its core-sub; a durable backstop requires spawning under a manager
    // (`cotal spawn --detach` / `cotal up`).
    const creds = await provisionAgent(prov, auth, identity, {
      subscribe,
      allowSubscribe,
      allowPublish,
      role,
      capabilities: def.capabilities,
      durableMembership: false,
    });
    await prov.stop();
    credsPath = join(authDir(target.root), "creds", `${name}.creds`);
    mkSecretDir(dirname(credsPath)); // harden the creds dir before the cred lands
    writeSecretFile(credsPath, creds);
    id = identity.id;
    provenance.wrote(`creds for ${name} (auth mode)`, credsPath);
  }

  // Which of the operator's personal MCP servers to share with this agent: declared in the cotal
  // config (global ~/.config/cotal + the target mesh's .cotal), narrowed by an optional
  // --share-tools selection. Default (no config) is none — the connector launches isolated.
  const agentType = values.agent ?? defaultAgentType("claude");
  const mcpServers = connectorServers(
    loadCotalConfig(target.root),
    agentType,
    parseShareSelection(values["share-tools"]),
  );

  const connector = registry.resolve<Connector>("connector", agentType);
  const spec = connector.buildLaunch({
    space,
    name,
    role,
    id,
    creds: credsPath,
    servers: server,
    configPath: path,
    // Model override (wins over the agent file's `model:`) — launch-grammar parity with --detach.
    model: values.model,
    subscribe,
    allowSubscribe,
    allowPublish,
    prompt: values.prompt,
    // Fork an existing session into the mesh. `prompt + resume` is a supported combo (claude accepts
    // the positional prompt alongside `--resume … --fork-session`); an unsupported connector throws.
    resume: values.resume,
    transcript,
    mcpServers,
  });

  console.error(
    `spawning ${name}${role ? ` (${role})` : ""} on the mesh — press Enter at the dev-channels prompt`,
  );
  const child = spawnProcess(spec.command, spec.args, {
    stdio: "inherit",
    // P3: only the connector-declared env (OS allow-list + identity + named model key) — never
    // `...process.env`, so the operator's unrelated secrets don't bleed into the foreground agent.
    env: spec.env ?? {},
    // `--cwd` roots the agent at another folder/repo (launch-grammar parity with --detach); a
    // relative path resolves against the invoking shell's cwd. Omitted → inherit this cwd.
    cwd: values.cwd ? resolvePath(values.cwd) : undefined,
  });
  await new Promise<void>((resolve) => {
    child.on("error", (e) => {
      console.error(`✗ failed to launch ${spec.command}: ${e.message}`);
      process.exitCode = 1;
      resolve();
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
