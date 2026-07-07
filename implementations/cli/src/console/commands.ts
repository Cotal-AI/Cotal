// The console's `:` command catalog — the operator's send/control verbs. A small local list (NOT
// the CLI `Command` registry, which is argv/process-exit shaped). The catalog drives both execution
// and the palette's autocomplete. Write commands publish over the mesh via the observer endpoint,
// gated on `canWrite` (open mode, or a privileged --creds). Control commands go through
// `ctx.control` (a per-action tier-scoped request — see console/control.ts), gated on `canControl`.
import {
  CONTROL_PRIVILEGED,
  resolvePeer,
  AmbiguousPeerError,
  type ControlReply,
  type ControlTier,
  type CotalEndpoint,
} from "@cotal-ai/core";
import type { MeshSnapshot } from "../view/mesh-view.js";
import { mentionsIn } from "../lib/mentions.js";

export interface CommandCtx {
  ep: CotalEndpoint;
  snapshot: MeshSnapshot;
  activeChannel: string;
  setMode: (m: "normal" | "dm" | "topo" | "views") => void;
  setActiveChannel: (c: string) => void;
  toggleRail: () => void;
  openHelp: () => void;
  back?: () => void; // to the space overview
  exit: () => void;
  notify: (msg: string) => void; // transient status line
  /** One control request against the manager, with per-action authorization. */
  control: (op: string, args: Record<string, unknown>, tier: ControlTier) => Promise<ControlReply>;
  /** Open the type-the-space-name purge confirm (the palette never purges directly). */
  confirmPurge: () => void;
  /** Upgrade the console to a participant on the operator's first send (presence + own inbox), so
   *  agents can reply. Idempotent, canWrite-gated. Await before the send. */
  ensureParticipant: () => Promise<void>;
  /** Record an outbound DM locally so the DM lens shows both sides of the thread. */
  recordOutboundDm: (toId: string, text: string) => void;
}

export interface ConsoleCommand {
  name: string;
  summary: string;
  usage?: string;
  write?: boolean; // requires canWrite (publishes over the observer endpoint)
  control?: boolean; // requires canControl (manager control plane)
  run(ctx: CommandCtx, rest: string): Promise<void> | void;
}

/** Resolve an agent/endpoint name (with or without a leading @) to its instance id. Fail-loud:
 *  an exact id or a unique name resolves; a same-name collision throws `AmbiguousPeerError`
 *  (the caller renders {@link ambiguityNote}). */
function idOf(snap: MeshSnapshot, name: string): string | undefined {
  return resolvePeer([...snap.agents, ...snap.endpoints], name.replace(/^@/, ""))?.card.id;
}

/** One-line note for the transient status bar when a name matched several peers. */
function ambiguityNote(e: AmbiguousPeerError): string {
  return `"${e.target}" is ambiguous — dm by id: ${e.candidates.map((c) => `${c.name} ${c.id}`).join(", ")}`;
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
      ctx.recordOutboundDm(id, m[2]);
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
      ctx.recordOutboundDm(id, "👋 ping");
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
      try {
        const r = await ctx.control("ps", {}, CONTROL_PRIVILEGED);
        if (!r.ok) return ctx.notify("ps: " + (r.error ?? "failed"));
        const list = (r.data as { name: string; paused?: boolean }[]) ?? [];
        ctx.notify(
          list.length
            ? "agents: " + list.map((a) => a.name + (a.paused ? " ⏸" : "")).join(", ")
            : "no managed agents",
        );
      } catch (e) {
        ctx.notify("ps: " + (e as Error).message);
      }
    },
  },
  {
    name: "spawn",
    summary: "spawn an agent from a persona",
    usage: "spawn <persona> [name]",
    control: true,
    run: async (ctx, rest) => {
      const [persona, identity] = rest.trim().split(/\s+/).filter(Boolean);
      if (!persona) return ctx.notify("usage: spawn <persona> [name]");
      try {
        const r = await ctx.control("start", identity ? { name: persona, identity } : { name: persona }, CONTROL_PRIVILEGED);
        if (!r.ok) return ctx.notify("spawn: " + (r.error ?? "failed"));
        ctx.notify(`spawned ${(r.data as { name?: string })?.name ?? persona}`);
      } catch (e) {
        ctx.notify("spawn: " + (e as Error).message);
      }
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
      try {
        const r = await ctx.control("status", { name }, CONTROL_PRIVILEGED);
        if (!r.ok) return ctx.notify("status: " + (r.error ?? "failed"));
        const a = r.data as { name: string; role?: string; mode: string; status: string; paused?: boolean; mesh: string; uptimeMs: number };
        ctx.notify(
          `${a.name}${a.role ? " (" + a.role + ")" : ""} · ${a.mode} · ${a.paused ? "paused" : a.status} · mesh ${a.mesh} · up ${Math.round(a.uptimeMs / 60000)}m`,
        );
      } catch (e) {
        ctx.notify("status: " + (e as Error).message);
      }
    },
  },
  {
    name: "purge",
    summary: "clear the space's history (confirm)",
    control: true,
    run: (ctx) => ctx.confirmPurge(),
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
  if (cmd.write && !canWrite) return ctx.notify("read-only — pass --creds to send");
  if (cmd.control && !canControl) return ctx.notify("no control authority — pass --creds, or run against a mesh whose auth you hold");
  void cmd.run(ctx, rest);
}
