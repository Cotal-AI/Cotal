// The console's `:` command catalog — the operator's send/control verbs. A small local list (NOT
// the CLI `Command` registry, which is argv/process-exit shaped). The catalog drives both execution
// and the palette's autocomplete. Write commands publish over the mesh via the observer endpoint;
// they are gated on `canWrite` (open mode, or a privileged --creds). Control commands go through
// `ctx.control` (one per-action call on the CLI's control path, console/control.ts), gated on
// `canControl`; the observer endpoint never carries control.
import { resolvePeer, AmbiguousPeerError, type CotalEndpoint } from "@cotal-ai/core";
import type { MeshSnapshot } from "../view/mesh-view.js";
import type { ManagerReply } from "../lib/control.js";
import type { ControlOp, ManagedRow } from "./control.js";
import { mentionsIn } from "../lib/mentions.js";

export interface CommandCtx {
  ep: CotalEndpoint;
  snapshot: MeshSnapshot;
  activeChannel: string;
  setMode: (m: "normal" | "dm" | "topo") => void;
  setActiveChannel: (c: string) => void;
  toggleRail: () => void;
  openHelp: () => void;
  back?: () => void; // to the space overview
  exit: () => void;
  notify: (msg: string) => void; // transient status line
  /** One control call against this space's manager (console/control.ts). */
  control: (op: ControlOp, args?: Record<string, unknown>) => Promise<ManagerReply>;
  /** The managed rows of EVERY reachable manager in the space (the `cotal ps` scatter, merged):
   *  a single class-queue call would answer for one manager and omit the others' seats. */
  ps: () => Promise<{ ok: true; rows: ManagedRow[] } | { ok: false; error: string }>;
  /** Open the type-the-space-name purge confirm (the palette never purges directly). */
  confirmPurge: () => void;
  /** Open the type-the-channel-name delete confirm for one channel's history and registry entry. */
  confirmDelchan: (channel: string) => void;
  /** Attach to a managed seat's live terminal (suspends the console until detach). */
  startAttach: (name: string) => void;
  /** Put the operator on the roster on its first send (presence, so agents can reply). Idempotent,
   *  canWrite-gated; open mesh only, a one-way notice elsewhere. Await before the send. */
  ensureParticipant: () => Promise<void>;
}

export interface ConsoleCommand {
  name: string;
  summary: string;
  usage?: string;
  write?: boolean; // requires canWrite (publishes over the observer endpoint)
  control?: boolean; // requires canControl (the manager, through the control door)
  run(ctx: CommandCtx, rest: string): Promise<void> | void;
}

/** The reply's error, or a generic word: the status line has one row. */
const why = (r: ManagerReply): string => r.error ?? "failed";

/** One managed-agent row as `:status` prints it. Two facts, printed as two facts, the way
 *  `cotal ps` prints them: `status` is the PROCESS the manager runs and `mesh` is that seat's
 *  presence, and they disagree in the common failure (running for days, offline on the mesh).
 *
 *  Presence `working` is the one word that needs qualifying. It records that the seat said it was
 *  working, never that anyone observed progress, so it reaches the reader as `working · progress
 *  unknown` here exactly as it does from `cotal ps`, the roster, and the connector's orientation.
 *  A bare `working` would claim an observation the manager never made. */
export function formatManagedRow(a: ManagedRow): string {
  const mesh = a.mesh === "working" ? "working · progress unknown" : a.mesh;
  const role = a.role ? ` (${a.role})` : "";
  return `${a.name}${role} · ${a.agent} · ${a.mode} · ${a.status} · mesh ${mesh} · up ${Math.round(a.uptimeMs / 60000)}m`;
}

/** Resolve an agent/endpoint name (with or without a leading @) to its instance id. Fail-loud:
 *  an exact id or a unique name resolves; a same-name collision throws `AmbiguousPeerError`
 *  (the caller renders {@link ambiguityNote}). */
function idOf(snap: MeshSnapshot, name: string): string | undefined {
  return resolvePeer([...snap.agents, ...snap.endpoints], name.replace(/^@/, ""))?.card.id;
}

/** One-line note for the transient status bar when a name matched several peers. */
function ambiguityNote(e: AmbiguousPeerError): string {
  return `"${e.target}" is ambiguous - dm by id: ${e.candidates.map((c) => `${c.name} ${c.id}`).join(", ")}`;
}

export const COMMANDS: ConsoleCommand[] = [
  {
    name: "msg",
    summary: "post to a channel",
    usage: "msg [#channel] <text>",
    write: true,
    run: async (ctx, rest) => {
      let channel = ctx.activeChannel === "all" ? "general" : ctx.activeChannel;
      let text = rest;
      const m = rest.match(/^#(\S+)\s+([\s\S]+)/);
      if (m) {
        channel = m[1];
        text = m[2];
      }
      if (!text.trim()) return ctx.notify("usage: msg [#channel] <text>");
      await ctx.ensureParticipant();
      await ctx.ep.multicast(text, { channel, mentions: mentionsIn(text) });
      ctx.notify(`→ #${channel}`);
    },
  },
  {
    name: "dm",
    summary: "direct-message an agent",
    usage: "dm <@agent> <text>",
    write: true,
    run: async (ctx, rest) => {
      const m = rest.match(/^@?(\S+)\s+([\s\S]+)/);
      if (!m) return ctx.notify("usage: dm <@agent> <text>");
      let id: string | undefined;
      try {
        id = idOf(ctx.snapshot, m[1]);
      } catch (e) {
        if (e instanceof AmbiguousPeerError) return ctx.notify(ambiguityNote(e));
        throw e;
      }
      if (!id) return ctx.notify(`no agent "${m[1]}"`);
      await ctx.ensureParticipant();
      await ctx.ep.unicast(id, m[2]);
      ctx.notify(`→ ${m[1].replace(/^@/, "")}`);
    },
  },
  {
    name: "call",
    summary: "ping an agent + open the DM lens",
    usage: "call <@agent>",
    write: true,
    run: async (ctx, rest) => {
      const name = rest.replace(/^@/, "").trim().split(/\s+/)[0] ?? "";
      let id: string | undefined;
      try {
        id = idOf(ctx.snapshot, name);
      } catch (e) {
        if (e instanceof AmbiguousPeerError) return ctx.notify(ambiguityNote(e));
        throw e;
      }
      if (!id) return ctx.notify(`no agent "${name}"`);
      await ctx.ensureParticipant();
      await ctx.ep.unicast(id, "👋 ping");
      ctx.setMode("dm");
      ctx.notify(`called ${name}`);
    },
  },
  {
    name: "ask",
    summary: "anycast a role / service",
    usage: "ask <@role> <text>",
    write: true,
    run: async (ctx, rest) => {
      const m = rest.match(/^@?(\S+)\s+([\s\S]+)/);
      if (!m) return ctx.notify("usage: ask <@role> <text>");
      await ctx.ensureParticipant();
      await ctx.ep.anycast(m[1], m[2]);
      ctx.notify(`→ @${m[1]}`);
    },
  },
  {
    name: "ps",
    summary: "list manager-spawned agents",
    control: true,
    run: async (ctx) => {
      const r = await ctx.ps();
      if (!r.ok) return ctx.notify("ps: " + r.error);
      ctx.notify(r.rows.length ? "agents: " + r.rows.map((a) => a.name).join(", ") : "no managed agents");
    },
  },
  {
    name: "spawn",
    summary: "spawn an agent from a persona (waits for it to join)",
    usage: "spawn <persona> [name]",
    control: true,
    run: async (ctx, rest) => {
      const [persona, identity] = rest.trim().split(/\s+/).filter(Boolean);
      if (!persona) return ctx.notify("usage: spawn <persona> [name]");
      ctx.notify(`spawning ${persona}… (the manager answers on join, exit, or its readiness deadline)`);
      const r = await ctx.control("start", identity ? { name: persona, identity } : { name: persona });
      if (!r.ok) return ctx.notify("spawn: " + why(r));
      ctx.notify(`spawned ${(r.data as { name?: string })?.name ?? persona}`);
    },
  },
  {
    name: "status",
    summary: "one managed agent's state",
    usage: "status <agent>",
    control: true,
    run: async (ctx, rest) => {
      const name = rest.replace(/^@/, "").trim().split(/\s+/)[0] ?? "";
      if (!name) return ctx.notify("usage: status <agent>");
      const r = await ctx.control("status", { name });
      if (!r.ok) return ctx.notify("status: " + why(r));
      ctx.notify(formatManagedRow(r.data as ManagedRow));
    },
  },
  {
    name: "attach",
    summary: "open a managed seat's terminal (Ctrl-] to detach)",
    usage: "attach <agent>",
    control: true,
    run: (ctx, rest) => {
      const name = rest.replace(/^@/, "").trim().split(/\s+/)[0] ?? "";
      if (!name) return ctx.notify("usage: attach <agent>");
      ctx.startAttach(name);
    },
  },
  {
    name: "purge",
    summary: "clear the space's history (type the space name to confirm)",
    control: true,
    run: (ctx) => ctx.confirmPurge(),
  },
  {
    name: "delchan",
    summary: "delete one channel's history + registry entry (type its name to confirm)",
    usage: "delchan <channel>",
    control: true,
    run: (ctx, rest) => {
      const channel = rest.replace(/^#/, "").trim().split(/\s+/)[0] ?? "";
      if (!channel) return ctx.notify("usage: delchan <channel>");
      ctx.confirmDelchan(channel);
    },
  },
  { name: "dms", summary: "toggle the DM lens", run: (ctx) => ctx.setMode("dm") },
  { name: "topo", summary: "toggle the topology lens", run: (ctx) => ctx.setMode("topo") },
  { name: "needs-you", summary: "toggle the needs-you rail", run: (ctx) => ctx.toggleRail() },
  { name: "spaces", summary: "back to the space overview", run: (ctx) => ctx.back?.() },
  { name: "help", summary: "show keybindings", run: (ctx) => ctx.openHelp() },
  { name: "quit", summary: "quit the console", run: (ctx) => ctx.exit() },
];

/** Parse + dispatch a typed palette line. Unknown / read-only-blocked commands notify and no-op. */
export function runCommand(line: string, ctx: CommandCtx, canWrite: boolean, canControl: boolean): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const name = trimmed.split(/\s+/)[0].toLowerCase();
  const rest = trimmed.slice(trimmed.indexOf(name) + name.length).trim();
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return ctx.notify(`unknown command: ${name}`);
  if (cmd.write && !canWrite) return ctx.notify("read-only - pass --creds to send");
  if (cmd.control && !canControl) return ctx.notify("no control path - a raw --creds file cannot drive the manager; run against a registered mesh");
  // A verb that throws (a control call that could not even start) lands on the status line rather
  // than as an unhandled rejection that would take the console down over one bad line.
  void Promise.resolve(cmd.run(ctx, rest)).catch((e: unknown) => ctx.notify(`${name}: ${(e as Error).message}`));
}
