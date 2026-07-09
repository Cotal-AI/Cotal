import type { CotalEndpoint, PresenceEvent } from "@cotal-ai/core";
import { MeshView, type FeedEntry } from "./view/mesh-view.js";
import { c, color256, statusBadge } from "./ui.js";

// ---- per-agent color (ANSI) ------------------------------------------------

// Readable 256-color palette; avoids the status hues (green/yellow/red) so an agent's name
// never reads as a status. (The Ink TUI keeps a parallel hex palette in console/ui/theme.ts —
// color is a per-surface presentation concern, not part of the shared model.)
const PALETTE = [39, 208, 170, 78, 214, 111, 203, 150, 141, 180, 117, 222, 75, 209];
const colorCache = new Map<string, (s: string) => string>();

export function agentColor(name: string): (s: string) => string {
  let fn = colorCache.get(name);
  if (!fn) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    fn = color256(PALETTE[h % PALETTE.length]);
    colorCache.set(name, fn);
  }
  return fn;
}

const who = (ref: { name: string; role?: string }) =>
  agentColor(ref.name)(ref.name) +
  (ref.role && ref.role !== ref.name ? c.dim("/" + ref.role) : "");

const ts = (epochMs: number) => c.dim(new Date(epochMs).toLocaleTimeString());

// ---- formatting a feed entry / presence change into a line -----------------

function target(e: FeedEntry): string {
  if (e.delivery === "multicast") return c.cyan("#" + (e.channel ?? "?"));
  if (e.delivery === "anycast") return c.dim("@" + (e.toService ?? "?"));
  const names = (e.toNames ?? []).map((n) => agentColor(n)(n)).join(", ");
  const mult = e.count && e.count > 1 ? c.dim(` (${e.count}×)`) : "";
  return names + mult;
}

function feedLine(e: FeedEntry): string {
  return `${ts(e.ts)} ${who(e.from)} ${c.dim("→")} ${target(e)}: ${e.text}`;
}

function presenceLine(ev: PresenceEvent): string {
  const label =
    ev.type === "join"
      ? c.green("join   ")
      : ev.type === "offline"
        ? c.dim("offline")
        : c.dim("update ");
  const activity = ev.presence.activity ? c.dim(" - " + ev.presence.activity) : "";
  return `${ts(Date.now())} ${label} ${who(ev.presence.card)} ${statusBadge(ev.presence.status)}${activity}`;
}

// ---- the passive line stream (console --plain / pipes) ---------------------

/** Wire the (not-yet-started) observer into a scrolling line log via the shared MeshView, and
 *  park until SIGINT. MeshView owns the endpoint lifecycle and all the normalization; this just
 *  prints presence changes and each classified+coalesced feed entry as it lands. */
export async function runLog(ep: CotalEndpoint, space: string, tapSubject?: string): Promise<void> {
  const view = new MeshView(ep, tapSubject ? { tapSubject } : {});
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  view.on("presence", (ev) => console.log(presenceLine(ev as PresenceEvent)));
  view.on("entry", (e) => console.log(feedLine(e as FeedEntry)));
  await view.start();
  console.log(c.dim(`watching space ${c.bold(space)} - Ctrl-C to stop\n`));
  const shutdown = async () => {
    await view.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}
