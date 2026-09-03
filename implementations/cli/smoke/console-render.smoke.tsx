/**
 * Console render smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * The console's models were well covered and its RENDER SITES were not, which is a gap the models'
 * own greens hide: `sparkline()` and `membershipFreshness()` can be perfect while the component
 * that was supposed to draw them no longer calls them, and every existing cell stays green because
 * every existing cell imports the helper rather than the component. Deleting the `<Sparkline/>`
 * from the status bar, or the membership pill from the topology header, was measured to leave the
 * whole suite green.
 *
 * So these cells mount the REAL components. Ink renders into a supplied stream rather than a TTY,
 * which needs no test-only dependency on a published package: `ink` is already the CLI's own.
 * What is asserted is what an operator would see on the screen.
 */
import { render } from "ink";
import React from "react";
import { Writable } from "node:stream";
import type { Presence } from "@cotal-ai/core";
import { StatusBar } from "../src/console/ui/StatusBar.js";
import { Topo } from "../src/console/ui/topo/Topo.js";
import { MEMBERSHIP_STALE_MS } from "../src/console/ui/topo/model.js";
import type { FeedEntry, MembershipView } from "../src/view/mesh-view.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** Mount one element, let Ink paint, return the painted text with CSI stripped. */
async function paint(el: React.ReactElement, cols = 200): Promise<string> {
  let buf = "";
  const sink = new Writable({ write(c, _e, cb) { buf += String(c); cb(); } }) as unknown as NodeJS.WriteStream;
  sink.columns = cols;
  sink.rows = 40;
  const app = render(el, { stdout: sink, patchConsole: false });
  await wait(120);
  app.unmount();
  return strip(buf);
}

const status = {
  connected: true, space: "netcup", error: undefined, warning: undefined, dmVisible: true,
} as unknown as Parameters<typeof StatusBar>[0]["status"];
const ratesWith = (activity: number[]): Parameters<typeof StatusBar>[0]["rates"] =>
  ({ msgsPerSec: 0, activity }) as unknown as Parameters<typeof StatusBar>[0]["rates"];

console.log("1. the status bar actually draws the activity series, it does not merely own one");
// The gap this closes: sparkline.smoke.ts ends on "the status bar WOULD draw that as a flat floor",
// asserted by calling sparkline() directly. Nothing rendered the status bar, so removing its
// <Sparkline/> changed no cell.
{
  const loud = await paint(
    <StatusBar status={status} rates={ratesWith([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4])}
      activeChannel="all" agentCount={2} mode="normal" railOpen={false} canWrite canControl width={200} />,
  );
  check("a rising series reaches the screen as scaled bars", loud.includes("▃▅█"), loud.slice(0, 160));
  check("...and the bars sit between the msg/s figure and the 60s label", /msg\/s\s*▁*▃▅█\s*60s/.test(loud), loud.slice(0, 160));

  const quiet = await paint(
    <StatusBar status={status} rates={ratesWith(new Array(15).fill(0))}
      activeChannel="all" agentCount={2} mode="normal" railOpen={false} canWrite canControl width={200} />,
  );
  check("a silent minute paints a flat floor of the full width", quiet.includes("▁".repeat(15)), quiet.slice(0, 160));
  check("...which is a DIFFERENT screen from the loud one, so the bars are not decoration",
    !quiet.includes("▃▅█"), quiet.slice(0, 160));
}

console.log("2. the participant roster claim reaches the status bar");
{
  const on = await paint(
    <StatusBar status={status} rates={ratesWith([])} activeChannel="all" agentCount={1}
      mode="normal" railOpen={false} canWrite canControl onRoster width={200} />,
  );
  const off = await paint(
    <StatusBar status={status} rates={ratesWith([])} activeChannel="all" agentCount={1}
      mode="normal" railOpen={false} canWrite canControl width={200} />,
  );
  check("on roster is shown when the operator's peer is up", on.includes("on roster"), on.slice(0, 160));
  check("...and is absent when it is not, so the indicator tracks the peer", !off.includes("on roster"), off.slice(0, 160));
}

console.log("3. the topology header draws the membership pill, in each of its four states");
// Same gap: topo-membership.smoke.ts imports foldTopo and membershipFreshness, never Topo, so
// deleting the pill from the header left every cell green.
{
  const agents: Presence[] = [];
  const feed: FeedEntry[] = [];
  const topo = (membership: MembershipView | undefined) => (
    <Topo feed={feed} agents={agents} membership={membership} channels={[{ channel: "general", messages: 0 }]}
      variant={0} width={200} height={12} blocked={false}
      onFocus={() => {}} onOpenAgent={() => {}} onOpenMessage={() => {}} />
  );
  const now = Date.now();
  const member = { id: "UMEMBER00000000000000000000000000000000000000", live: ["general"], durable: ["general"] };
  const live = await paint(topo({ snapshot: { asOf: now, members: [member] } as never }));
  const stale = await paint(topo({ snapshot: { asOf: now - MEMBERSHIP_STALE_MS - 1_000, members: [member] } as never }));
  const trafficOnly = await paint(topo({ snapshot: { asOf: undefined, members: [] } as never }));
  const unreadable = await paint(topo({ unreadable: "no read permission on the membership subject" }));

  check("live is painted in the header", /membership:\s*live/.test(live), live.slice(0, 200));
  check("stale is painted in the header", /membership:\s*stale/.test(stale), stale.slice(0, 200));
  check("traffic-only is painted in the header", /membership:\s*traffic-only/.test(trafficOnly), trafficOnly.slice(0, 200));
  check("unreadable is painted in the header", /membership:\s*unreadable/.test(unreadable), unreadable.slice(0, 200));
  check("...and unreadable carries its reason, which is the whole point of that state",
    unreadable.includes("no read permission"), unreadable.slice(0, 240));

  // A pill that printed one constant would pass every cell above taken singly.
  const labels = [live, stale, trafficOnly, unreadable].map((s) => s.match(/membership:\s*([a-z-]+)/)?.[1]);
  check("the four states paint four DIFFERENT labels", new Set(labels).size === 4, labels);
}

console.log(`\n${fail === 0 ? "CONSOLE-RENDER SMOKE OK ✅" : "CONSOLE-RENDER SMOKE FAILED ❌"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
