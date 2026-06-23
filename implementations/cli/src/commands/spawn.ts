import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  agentFilePath,
  authDir,
  connectorServers,
  firstFreeName,
  isReachable,
  loadAgentFile,
  loadCotalConfig,
  loadMeshes,
  mintCreds,
  newIdentity,
  parseShareSelection,
  probeConnect,
  provisionAgent,
  registry,
  removeMesh,
  resolveMeshTarget,
  CotalEndpoint,
  type AgentDef,
  type CompletionResult,
  type Connector,
  type MeshTarget,
  type SpaceAuth,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "../lib/meshes.js";
import { listPersonas } from "../lib/personas.js";

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
 * Unlike `cotal start` (the manager spawns into a detached PTY you attach to),
 * `cotal spawn` hands the terminal straight to the agent: run it in your shell,
 * or inside a cmux/tmux pane, and the real Claude TUI takes over.
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
  // short-lived manager cred, the same throwaway `cotal dm` mints to resolve a name → id.
  const creds = auth ? await mintCreds(auth, newIdentity(), "manager") : undefined;
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

/** Resolve the mesh this spawn targets, exiting with one human sentence on an unresolved/ambiguous
 *  registry rather than a stack trace. Prunes dead registry entries first so a crashed mesh doesn't
 *  block a bare spawn or get offered by `--space`. */
async function resolveTargetOrExit(flags: { server?: string; space?: string }): Promise<MeshTarget> {
  await pruneStaleMeshes();
  try {
    return resolveMeshTarget(process.cwd(), flags);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
}

/** Confirm the resolved mesh is actually up and accepts our creds — replaces the raw NATS
 *  "Authorization Violation" trace with one sentence, and prunes the entry if the broker is gone. */
async function preflightOrExit(target: MeshTarget): Promise<void> {
  const creds = target.auth ? await mintCreds(target.auth, newIdentity(), "manager") : undefined;
  const probe = await probeConnect(target.server, creds ? { creds } : {});
  if (probe.ok) return;
  // A target whose server + mode came from a registry record owns that record, so a definitive
  // failure prunes the stale entry. `local-recorded` (a local project matched to an entry by root)
  // is registry-owned for pruning even though the success line treats it as a quiet local target.
  const fromRegistry =
    target.source === "registry" ||
    target.source === "current" ||
    target.source === "flag-space" ||
    target.source === "local-recorded";
  if (probe.reason === "unreachable") {
    if (fromRegistry) removeMesh(target.space); // the broker is gone — drop the stale entry
    console.error(
      c.red(
        `✗ no mesh running at ${target.server}${fromRegistry ? " (stale registry entry — removed)" : ""} — run \`cotal up\``,
      ),
    );
  } else if (fromRegistry && target.auth) {
    // We DID present creds minted from the registry's own trust material and the broker rejected
    // them — so the entry now points at a DIFFERENT broker on that port. The fix isn't "spawn from
    // the root" (we just used it); it's that the registry entry is stale. Drop it and say so.
    removeMesh(target.space);
    console.error(
      c.red(
        `✗ mesh "${target.space}" at ${target.server} no longer matches its registry entry (credentials rejected — port reused?) — re-run \`cotal up\` from ${target.root}, or \`cotal meshes\` to see what's live`,
      ),
    );
  } else if (fromRegistry) {
    // An OPEN-mode registry target probed credlessly, but the broker now wants auth — the recorded
    // open mesh is gone (its port was reused by an auth broker). Same stale class; drop the entry.
    removeMesh(target.space);
    console.error(
      c.red(
        `✗ open mesh "${target.space}" at ${target.server} no longer matches its registry entry (broker now requires auth — port reused?) — re-run \`cotal up\` from ${target.root}, or \`cotal meshes\` to see what's live`,
      ),
    );
  } else if (target.auth) {
    // Creds were presented and rejected, but the target is a local project / --server we don't own
    // in the registry. A different mesh is likely on that port — the user owns the diagnosis, so we
    // don't prune; we point at the likely cause. "Can't provide" would be wrong: the folder DID.
    console.error(
      c.red(
        `✗ credentials for "${target.space}" were rejected at ${target.server} — a different mesh may be running there. Run \`cotal meshes\` to check, or \`cotal up\` here to start yours`,
      ),
    );
  } else {
    // No creds to present (open, non-registry) and the broker wants auth.
    console.error(
      c.red(
        `✗ broker at ${target.server} requires auth, but this mesh is open (no trust material) — use \`--space <name>\` for an auth mesh, or run \`cotal up\` here without \`--open\``,
      ),
    );
  }
  process.exit(1);
}

export async function spawn(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      config: { type: "string" },
      space: { type: "string" },
      server: { type: "string" },
      agent: { type: "string" },
      role: { type: "string" },
      prompt: { type: "string" },
      transcript: { type: "boolean" },
      "no-transcript": { type: "boolean" },
      "share-tools": { type: "string" },
      subscribe: { type: "string" }, // read set override (comma-separated)
      "allow-subscribe": { type: "string" }, // read ACL override
      "allow-publish": { type: "string" }, // post ACL override
    },
  });
  const splitFlag = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  // Transcript mirroring to `tr-<name>` is OFF by default; `--transcript` opts in
  // (`--no-transcript` is accepted too, to be explicit about the default).
  const transcript = values.transcript ? true : values["no-transcript"] ? false : false;

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
  if (auth) {
    const identity = newIdentity();
    const prov = new CotalEndpoint({
      space,
      servers: server,
      creds: await mintCreds(auth, newIdentity(), "manager"),
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      card: { name: "spawn-provisioner", role: "manager", kind: "endpoint" },
    });
    prov.on("error", (e: Error) => console.error(`! provisioner: ${e.message}`));
    await prov.start();
    const subscribe = splitFlag(values.subscribe) ?? def.subscribe;
    // Direct foreground spawn is LIVE-ONLY: this short-lived provisioner is not a managing Plane-3 host,
    // and no long-lived manager knows this agent (it's in no manager's `agents` ledger), so a durable
    // boot membership could be neither authorized for reader delivery nor leaved via self-service. Skip
    // it — the agent reads live via its core-sub; a durable backstop requires spawning under a manager
    // (`cotal start` / `cotal up`).
    const creds = await provisionAgent(prov, auth, identity, {
      subscribe,
      allowSubscribe: splitFlag(values["allow-subscribe"]) ?? def.allowSubscribe ?? subscribe,
      allowPublish: splitFlag(values["allow-publish"]) ?? def.allowPublish,
      role,
      capabilities: def.capabilities,
      durableMembership: false,
    });
    await prov.stop();
    credsPath = join(authDir(target.root), "creds", `${name}.creds`);
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, creds, { mode: 0o600 });
    id = identity.id;
    console.error(`minted creds for ${name} (auth mode) → ${credsPath}`);
  }

  // Which of the operator's personal MCP servers to share with this agent: declared in the cotal
  // config (global ~/.config/cotal + the target mesh's .cotal), narrowed by an optional
  // --share-tools selection. Default (no config) is none — the connector launches isolated.
  const agentType = values.agent ?? "claude";
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
    prompt: values.prompt,
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
