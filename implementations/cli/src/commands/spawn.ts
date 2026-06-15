import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_SERVER,
  agentFilePath,
  authDir,
  loadAgentFile,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  provisionAgent,
  registry,
  CotalEndpoint,
  type AgentDef,
  type Connector,
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
      resume: { type: "string" },
    },
  });

  // Where the config lives: --config, else the positional <name-or-path>, else
  // discover by --name (.cotal/agents/<name>.md). Same flags as `cotal start`.
  const ref = values.config ?? positionals[0] ?? values.name;
  if (!ref) {
    console.error(
      "usage: cotal spawn <name-or-path> | --config <path> | --name <n>  [--agent <a>] [--role <r>] [--resume <id>] [--space <s>] [--server <url>] [--prompt <text>]",
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
  const name = values.name ?? def.name;
  const role = values.role ?? def.role;
  const space = values.space ?? resolveSpace(process.cwd());
  const server = values.server ?? DEFAULT_SERVER;

  // Auth mode (`.cotal/auth` present): mint a stable identity + scoped creds for this agent
  // and pre-create its bind-only durables, via a short-lived privileged provisioner — the
  // same onboarding the manager does, so the foreground launch joins the authed mesh too.
  // Open mode (no `.cotal/auth`): unchanged — the session connects without creds.
  let id: string | undefined;
  let credsPath: string | undefined;
  const auth = loadSpaceAuth(authDir(cotalRoot()));
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
    const creds = await provisionAgent(prov, auth, identity, {
      channels: def.publish ?? def.channels,
      role,
    });
    await prov.stop();
    credsPath = join(authDir(cotalRoot()), "creds", `${name}.creds`);
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, creds, { mode: 0o600 });
    id = identity.id;
    console.error(`minted creds for ${name} (auth mode) → ${credsPath}`);
  }

  const connector = registry.resolve<Connector>("connector", values.agent ?? "claude");
  const spec = connector.buildLaunch({
    space,
    name,
    role,
    id,
    creds: credsPath,
    servers: server,
    configPath: path,
    prompt: values.prompt,
    resume: values.resume,
  });

  console.error(
    `spawning ${name}${role ? ` (${role})` : ""} on the mesh — press Enter at the dev-channels prompt`,
  );
  const child = spawnProcess(spec.command, spec.args, {
    stdio: "inherit",
    env: { ...process.env, ...spec.env },
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
