import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  mintCreds,
  newIdentity,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  authDir,
  findCotalRoot,
  getCurrent,
  isWorkspaceTargetError,
  loadExtensionsManifest,
  loadMeshes,
  loadSpaceAuth,
  preflightTarget,
  resolveMeshTarget,
  serverFlag,
  spaceFlag,
} from "@cotal-ai/workspace";
import { managerHasDeliveryMarker } from "../lib/manager-proc.js";
import { machineStatus, webUp, WEB_URL } from "../lib/status.js";
import { displayCmd } from "../lib/self-exec.js";
import { c, statusBadge } from "../ui.js";

export const statusFlags = [spaceFlag, serverFlag] as const;

type Proc = { pid?: number; live: boolean; note?: string };

/** `cotal status` — detailed, read-only diagnostics for the local machine + selected mesh. */
export async function status(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof statusFlags>;
  const cwd = process.cwd();
  const root = findCotalRoot(cwd);
  const cmd = displayCmd();

  console.log(c.bold("cotal status"));
  await printMachine();
  printProject(root);
  await printRegistry();
  await printTarget(cwd, values, cmd);
}

async function printMachine(): Promise<void> {
  const m = await machineStatus();
  const web = await webUp();
  const webExt = webInstalled();
  section("Machine");
  row("NATS", m.nats === "missing" ? c.red("missing") : c.green(m.nats));
  row("Claude plugin", m.claudePlugin ? c.green("installed") : c.dim("not installed"));
  row("Claude", m.agents.claude ? c.green("on PATH") : c.dim("not on PATH"));
  row("OpenCode", m.agents.opencode ? c.green("on PATH") : c.dim("not on PATH"));
  row("Web extension", webExt ? c.green("installed") : c.dim("not installed"));
  row("Web process", web ? c.green(WEB_URL) : c.dim(webExt ? "down" : "not installed"));
}

function printProject(root: string): void {
  const auth = loadSpaceAuth(authDir(root));
  section("This Folder");
  row("root", root);
  row("auth", auth ? c.green(`space ${auth.space}`) : c.dim("none (open/local only)"));
  row("personas", personaSummary(root));
  row("nats", formatProc(proc(root, "nats.pid")));
  row("delivery", formatProc(proc(root, "delivery.pid")));
  const mgr = proc(root, "manager.pid");
  row("manager", `${formatProc(mgr)}${mgr.live ? c.dim(managerHasDeliveryMarker() ? " · delivery-aware" : " · old/unknown build") : ""}`);
  row("web", formatProc(proc(root, "web.pid")));
}

async function printRegistry(): Promise<void> {
  const meshes = loadMeshes();
  const current = getCurrent();
  section("Recorded Meshes");
  if (!meshes.length) {
    console.log(c.dim("  none — start one with `cotal up --detach`"));
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
  row("mode", target.auth ? "auth" : "open");
  row("source", target.source);
  row("root", target.root);

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
      console.log(`    ${statusBadge(p.status)}  ${label}${p.activity ? c.dim(` — ${p.activity}`) : ""}`);
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

function proc(root: string, file: string): Proc {
  const path = join(root, ".cotal", file);
  if (!existsSync(path)) return { live: false, note: "no pidfile" };
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isFinite(pid)) return { live: false, note: "bad pidfile" };
  try {
    process.kill(pid, 0);
    return { pid, live: true };
  } catch {
    return { pid, live: false, note: "stale pidfile" };
  }
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
