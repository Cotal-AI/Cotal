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
 *   cotal channels set <name> [--replay|--no-replay] [--desc <s>] [--instructions <s>]
 *   cotal channels default --replay|--no-replay
 */
export async function channels(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as { server?: string; space?: string; creds?: string; replay?: boolean; "no-replay"?: boolean; window?: string; desc?: string; instructions?: string };
  // Validate the subcommand BEFORE connecting, so a typo (or a bare `cotal channels`) prints usage,
  // not "no mesh running" — the same validate-first order as `history`.
  const sub = positionals[0];
  if (sub !== "list" && sub !== "set" && sub !== "default") return usage();
  if (sub === "set" && !positionals[1]) return usage(); // need a channel name before touching the mesh
  // Tri-state replay: --replay → true, --no-replay → false, neither → leave unchanged.
  const replay = values["no-replay"] ? false : values.replay ? true : undefined;
  // `list` is read-only → the scoped `operator` cred (channel-registry read, no stream-admin).
  // `set`/`default` WRITE the registry → the narrow `channel-writer` cred ($KV.<channelBucket>.> +
  // read-before-write; no stream data, no other bucket, no chat/DM).
  // USER MODE: `list` rides the caller's OWN agent-view bearer (the registry is world-readable
  // in-space); writes ride a one-shot "channel-writer" VIEW bearer, exchange-gated on ledger
  // scope "admin" (the refusal names the exact re-grant).
  const profile = sub === "list" ? "operator" : "channel-writer";
  const conn = await connectOrExit(values, profile); // creds undefined ⇒ open mode
  const user = conn.bearer && sub !== "list" ? await userViewAuthOrExit(conn, "channel-writer") : undefined;
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
      "usage: cotal channels <list | set <name> [--replay|--no-replay] [--window <dur>] [--desc <s>] [--instructions <s>] | default [--replay|--no-replay] [--window <dur>]> [--space <s>] [--server <url>] [--creds <path>]",
    ),
  );
  process.exit(1);
}
