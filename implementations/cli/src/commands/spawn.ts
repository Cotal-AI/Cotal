import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_SERVER,
  agentFilePath,
  authDir,
  connectorServers,
  firstFreeName,
  isReachable,
  loadAgentFile,
  loadCotalConfig,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  parseShareSelection,
  provisionAgent,
  registry,
  CotalEndpoint,
  type AgentDef,
  type Connector,
  type SpaceAuth,
} from "@cotal-ai/core";
import { cotalRoot } from "../lib/paths.js";
import { resolveSpace } from "../lib/status.js";

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

  // Where the config lives: --config, else the positional <name-or-path>, else
  // discover by --name (.cotal/agents/<name>.md). Same flags as `cotal start`.
  const ref = values.config ?? positionals[0] ?? values.name;
  if (!ref) {
    console.error(
      "usage: cotal spawn <name-or-path> | --config <path> | --name <n>  [--agent <a>] [--role <r>] [--space <s>] [--server <url>] [--prompt <text>] [--transcript] [--share-tools <names|none>]",
    );
    process.exit(1);
  }

  const path = agentFilePath(cotalRoot(), ref);
  let def: AgentDef;
  try {
    def = loadAgentFile(path);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }

  // --name / --role override the file (name defaults from the file's frontmatter).
  const requested = values.name ?? def.name;
  const role = values.role ?? def.role;
  const space = values.space ?? resolveSpace(process.cwd());
  const server = values.server ?? DEFAULT_SERVER;
  const auth = loadSpaceAuth(authDir(cotalRoot()));

  // A second `cotal spawn` of the same agent would otherwise join under a duplicate mesh identity:
  // auto-number the name past anyone already present (best-effort — this path bypasses the manager's
  // race-free reservation; see uniqueMeshName). Everything below (creds path, launch) uses `name`.
  const name = await uniqueMeshName(requested, { space, server, auth });
  if (name !== requested)
    console.error(`"${requested}" is already on the mesh — spawning as ${name} instead`);

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
    const creds = await provisionAgent(prov, auth, identity, {
      subscribe,
      allowSubscribe: splitFlag(values["allow-subscribe"]) ?? def.allowSubscribe ?? subscribe,
      allowPublish: splitFlag(values["allow-publish"]) ?? def.allowPublish,
      role,
      capabilities: def.capabilities,
    });
    await prov.stop();
    credsPath = join(authDir(cotalRoot()), "creds", `${name}.creds`);
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, creds, { mode: 0o600 });
    id = identity.id;
    console.error(`minted creds for ${name} (auth mode) → ${credsPath}`);
  }

  // Which of the operator's personal MCP servers to share with this agent: declared in the cotal
  // config (global ~/.config/cotal + space-local .cotal), narrowed by an optional --share-tools
  // selection. Default (no config) is none — the connector launches isolated.
  const agentType = values.agent ?? "claude";
  const mcpServers = connectorServers(
    loadCotalConfig(cotalRoot()),
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
