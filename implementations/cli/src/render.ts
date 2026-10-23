import { oneLine, peerLabel, presenceText, type CotalEndpoint, type PresenceEvent } from "@cotal-ai/core";
import { localeIsUtf8, plainPunctuation } from "@cotal-ai/workspace";
import { MeshView, type FeedEntry } from "./view/mesh-view.js";
import { activityAge, c, color256, presenceDetail, statusBadge } from "./ui.js";

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

const who = (ref: { name: string; role?: string }) => agentColor(ref.name)(peerLabel(ref));

const ts = (epochMs: number) => c.dim(new Date(epochMs).toLocaleTimeString());

// ---- formatting a feed entry / presence change into a line -----------------

// A peer writes the body, its names and the destination it claims. Each is escaped before it is
// colored, so it cannot carry a control sequence to the terminal, as watch --plain and history do.
function target(e: FeedEntry, ascii: boolean): string {
  if (e.delivery === "multicast") return c.cyan("#" + oneLine(e.channel ?? "?"));
  if (e.delivery === "anycast") return c.dim("@" + oneLine(e.toService ?? "?"));
  const names = (e.toNames ?? []).map((n) => agentColor(n)(oneLine(n))).join(", ");
  const mult = e.count && e.count > 1 ? c.dim(` (${e.count}${ascii ? "x" : "×"})`) : "";
  return names + mult;
}

function feedLine(e: FeedEntry, ascii: boolean): string {
  return `${ts(e.ts)} ${who(e.from)} ${c.dim("→")} ${target(e, ascii)}: ${oneLine(e.text)}`;
}

function presenceLine(ev: PresenceEvent, ascii: boolean): string {
  const label =
    ev.type === "join"
      ? c.green("join   ")
      : ev.type === "offline"
        ? c.dim("offline")
        : c.dim("update ");
  const activity = ev.presence.activity ? c.dim(" - " + presenceText(ev.presence.activity) + activityAge(ev.presence)) : "";
  return `${ts(Date.now())} ${label} ${who(ev.presence.card)} ${statusBadge(ev.presence.status, !ascii)}${presenceDetail(ev.presence)}${activity}`;
}

// ---- the passive line stream (console --plain / pipes) ---------------------

/** Wire the (not-yet-started) observer into a scrolling line log via the shared MeshView, and
 *  park until SIGINT. MeshView owns the endpoint lifecycle and all the normalization; this just
 *  prints presence changes and each classified+coalesced feed entry as it lands. `plain`, and a
 *  locale whose character set is not UTF-8, write the lines as plain does: no status marks, and the
 *  punctuation in ASCII wherever it appears. */
export async function runLog(ep: CotalEndpoint, space: string, tapSubject?: string, plain = false): Promise<void> {
  const ascii = plain || !localeIsUtf8();
  const print = (line: string): void => console.log(ascii ? plainPunctuation(line) : line);
  const view = new MeshView(ep, tapSubject ? { tapSubject } : {});
  ep.on("error", (e: Error) => console.error(c.red("! " + oneLine(e.message))));
  view.on("warning", (e: Error) => console.error(c.yellow("! " + oneLine(e.message))));
  view.on("presence", (ev) => print(presenceLine(ev as PresenceEvent, ascii)));
  view.on("entry", (e) => print(feedLine(e as FeedEntry, ascii)));
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
