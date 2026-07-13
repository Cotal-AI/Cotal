import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  seedChannelRegistry,
  readChannelRegistry,
  effectiveReplay,
  type ChannelConfig,
  type ChannelDefaults,
  type ChannelRegistryFile,
  type ParsedArgs,
} from "@cotal-ai/core";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { c } from "../ui.js";

/**
 * `cotal channels` — inspect and mutate the per-space channel registry (replay policy,
 * description, instructions) while the mesh is up. Writes are privileged: on an auth mesh the
 * command mints ephemeral manager creds from the resolved mesh's `.cotal/auth`; on an open mesh it
 * connects plainly. Works from any directory (resolves the running mesh); `--creds` is a raw
 * off-registry connection.
 *
 *   cotal channels list
 *   cotal channels export [path|-] [--force]
 *   cotal channels set <name> [--replay|--no-replay] [--desc <s>] [--instructions <s>]
 *   cotal channels default --replay|--no-replay
 */
export async function channels(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as ChannelsValues;
  // Validate the subcommand BEFORE connecting, so a typo (or a bare `cotal channels`) prints usage,
  // not "no mesh running" — the same validate-first order as `history`.
  const sub = positionals[0];
  if (sub !== "list" && sub !== "export" && sub !== "set" && sub !== "default") return usage();
  if (sub === "set" && !positionals[1]) return usage(); // need a channel name before touching the mesh
  if (sub !== "export" && values.force) throw new Error("--force is only valid with channels export");
  const exportPath = sub === "export" ? validateExportArgs(positionals, values) : undefined;
  // Tri-state replay: --replay → true, --no-replay → false, neither → leave unchanged.
  const replay = values["no-replay"] ? false : values.replay ? true : undefined;
  // `list` is read-only → the scoped `operator` cred (channel-registry read, no stream-admin).
  // `set`/`default` WRITE the registry → the narrow `channel-writer` cred ($KV.<channelBucket>.> +
  // read-before-write; no stream data, no other bucket, no chat/DM).
  // USER MODE: `list` rides the caller's OWN agent-view bearer (the registry is world-readable
  // in-space); writes ride a one-shot "channel-writer" VIEW bearer, exchange-gated on ledger
  // scope "admin" (the refusal names the exact re-grant).
  const profile = sub === "list" || sub === "export" ? "operator" : "channel-writer";
  const conn = await connectOrExit(values, profile); // creds undefined ⇒ open mode
  const user = conn.bearer && sub !== "list" && sub !== "export" ? await userViewAuthOrExit(conn, "channel-writer") : undefined;
  const { server, space, creds } = conn;
  const auth = user
    ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds }
    : conn.bearer
      ? { bearer: conn.bearer, sentinelCreds: conn.sentinelCreds }
      : { creds };

  switch (sub) {
    case "list": {
      printRegistry(await readChannelRegistry({ servers: server, space, ...auth }));
      return;
    }
    case "export": {
      const path = outputChannelRegistryExport(
        await readChannelRegistry({ servers: server, space, ...auth }),
        exportPath,
        Boolean(values.force),
      );
      if (!path) return;
      console.log(c.green(`✓ exported channel registry for "${space}"`));
      console.log(c.dim(`  ${path}`));
      return;
    }
    case "set": {
      const name = positionals[1];
      if (!name) return usage();
      const cfg: ChannelConfig = {};
      if (replay !== undefined) cfg.replay = replay;
      if (values.window !== undefined) cfg.replayWindow = values.window;
      if (values.desc !== undefined) cfg.description = values.desc;
      if (values.instructions !== undefined) cfg.instructions = values.instructions;
      if (!Object.keys(cfg).length) {
        console.error(c.red("nothing to set - pass --replay/--no-replay, --window, --desc, or --instructions"));
        process.exit(1);
      }
      await seedChannelRegistry({ servers: server, space, ...auth, file: { channels: { [name]: cfg } } });
      console.log(c.green(`✓ set #${name} in "${space}"`));
      return;
    }
    case "default": {
      const defaults: ChannelDefaults = {};
      if (replay !== undefined) defaults.replay = replay;
      if (values.window !== undefined) defaults.replayWindow = values.window;
      if (!Object.keys(defaults).length) {
        console.error(c.red("usage: cotal channels default [--replay|--no-replay] [--window <dur>]"));
        process.exit(1);
      }
      await seedChannelRegistry({ servers: server, space, ...auth, file: { defaults } });
      console.log(c.green(`✓ set space defaults in "${space}"`));
      return;
    }
    default:
      return usage();
  }
}

export interface ChannelsValues {
  server?: string;
  space?: string;
  creds?: string;
  replay?: boolean;
  "no-replay"?: boolean;
  window?: string;
  desc?: string;
  instructions?: string;
  force?: boolean;
}

/** Validate export-only arguments before connecting so a typo cannot touch the mesh. */
export function validateExportArgs(positionals: string[], values: ChannelsValues): string | undefined {
  if (positionals.length > 2) throw new Error("channels export accepts at most one output path");
  const mutationFlag = ["replay", "no-replay", "window", "desc", "instructions"].find(
    (flag) => values[flag as keyof ChannelsValues] !== undefined,
  );
  if (mutationFlag) throw new Error(`--${mutationFlag} is not valid with channels export`);
  const path = positionals[1];
  if (values.force && (path === undefined || path === "-"))
    throw new Error("--force requires an output path; stdout is never overwritten");
  return path;
}

/** Stable JSON in the exact declarative shape accepted by `cotal up --channels`. */
export function serializeChannelRegistry(registry: ChannelRegistryFile): string {
  return `${JSON.stringify(canonicalJson(registry), null, 2)}\n`;
}

/** Write canonical JSON to stdout, or safely create/replace the requested file. */
export function outputChannelRegistryExport(
  registry: ChannelRegistryFile,
  destination: string | undefined,
  force: boolean,
): string | undefined {
  const output = serializeChannelRegistry(registry);
  if (destination === undefined || destination === "-") {
    process.stdout.write(output);
    return undefined;
  }
  return writeChannelRegistryExport(destination, output, force);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonicalJson(item)]));
}

/** Write without following the destination: exclusive create, or atomic entry replacement. */
export function writeChannelRegistryExport(destination: string, output: string, force: boolean): string {
  const path = resolve(destination);
  if (!force) {
    try {
      writeFileSync(path, output, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`${path} already exists - pass --force to overwrite`);
      throw error;
    }
    return path;
  }

  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, output, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

function printRegistry(reg: ChannelRegistryFile): void {
  const def = reg.defaults?.replay;
  const dw = reg.defaults?.replayWindow;
  console.log(c.dim(`space default replay: ${def === undefined ? "true (built-in)" : def}${dw ? `, window=${dw}` : ""}`));
  const entries = Object.entries(reg.channels ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    console.log(c.dim("no channel entries yet."));
    return;
  }
  for (const [name, cfg] of entries) {
    const effective = effectiveReplay(cfg, reg.defaults);
    const src = cfg.replay === undefined ? " (default)" : "";
    const win = cfg.replayWindow ?? reg.defaults?.replayWindow;
    console.log(`#${name}  replay=${effective}${src}${effective && win ? ` window=${win}` : ""}`);
    if (cfg.description) console.log(c.dim(`  ${cfg.description}`));
    if (cfg.instructions) console.log(c.dim(`  usage: ${cfg.instructions}`));
  }
}

function usage(): void {
  console.error(
    c.red(
      "usage: cotal channels <list | export [path|-] [--force] | set <name> [--replay|--no-replay] [--window <dur>] [--desc <s>] [--instructions <s>] | default [--replay|--no-replay] [--window <dur>]> [--space <s>] [--server <url>] [--creds <path>]",
    ),
  );
  process.exit(1);
}
