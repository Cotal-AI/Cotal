/**
 * CONSOLE GAPS smoke: the web-parity features driven through the REAL console TUI under node-pty
 * on an open mesh. pnpm --filter @cotal-ai/cli smoke:console-gaps (needs nats-server + node;
 * drives `bin/cotal.ts`, so the CLI's dist must be built).
 *
 *   1. Per-channel unread badges: history at startup is NOT unread (baseline), messages that arrive
 *      while another tab is viewed accrue (`+2`), viewing the channel pins its watermark, and a
 *      later message shows `+1` rather than `+3`. A channel already AT the broker's per-sender
 *      retention cap (1,000 retained, so its count cannot climb) still badges `+1` on a live
 *      arrival: the badge counts arrivals, not retained depth. A channel the mesh did not have
 *      when the console started badges its very first message (`#fresh 1 +1`): no baseline
 *      snapshot swallows the first live event.
 *   2. The roster's harness tag and the agent detail's `runs` / `model` / `skills`, from the card's
 *      self-published meta and skills (no manager needed for that source).
 *   3. `:delchan <channel>`: the verb opens the typed-name confirm, the name arms Enter, the notice
 *      reports the purge count, and the channel's history is actually gone while another survives
 *      (core's clearChannel, the web dashboard's delete, with a bare connection on an open mesh).
 *      The aggregate feed drops the deleted posts and keeps other posts. The deleted channel's tab
 *      leaves the strip on the next poll without showing a badge on the way out.
 *   4. Color follows the CLI's decision: `--no-color` paints the TUI with no ANSI color even under
 *      `FORCE_COLOR`, and so does a non-empty `NO_COLOR`. `FORCE_COLOR` alone paints color, so the
 *      color check can see color.
 *   5. Feed help at 80 by 24 displays complete, readable rows and pages to the remaining shortcuts.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, membershipBucket, setupSpaceStreams } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { recordMesh } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ConsoleSession, clean, screen, wait } from "./_console-pty.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ FAIL: " + n, extra ?? ""); } };

const space = `gaps-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
const home = join(dir, "home");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home; // set BEFORE recordMesh: never touch ~/.cotal
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
recordMesh({ space, server: SERVERS, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

async function checkNarrowNeedsYouPalette(): Promise<void> {
  const cols = 80, rows = 24;
  const s = new ConsoleSession(["--space", space, "--server", SERVERS], home,
    { CI: "false", CONTINUOUS_INTEGRATION: "false" }, { cols, rows });
  try {
    if (!(await s.waitFor("feed", 40_000))) throw new Error(`Console did not paint: ${clean(s.out).slice(-500)}`);
    let from = s.mark();
    s.write("n");
    if (!(await s.waitFor("NEEDS YOU", 8_000, from))) throw new Error("Needs You did not open");
    const rail = await screen(s.out, cols, rows);
    check("Needs You replaces the feed and roster at 80 columns", !rail.includes("feed") && !rail.includes("roster"), rail);

    from = s.mark();
    s.write("\x10");
    const opened = await s.waitFor("Commands", 8_000, from);
    check("Ctrl-P opens Commands over full-screen Needs You", opened, clean(s.out).slice(-500));
    if (!opened) return;

    from = s.mark();
    s.write("\x1b");
    const dismissed = await s.waitFor("NEEDS YOU", 8_000, from);
    const afterEscape = await screen(s.out, cols, rows);
    check("Esc dismisses Commands and keeps Needs You open", dismissed && !afterEscape.includes("Commands"), afterEscape);

    from = s.mark();
    s.write("n");
    check("n returns to the feed after dismissing Commands", await s.waitFor("feed", 8_000, from));
    check("q exits after dismissing Commands", await s.quit(20_000), s.exited);
  } finally {
    await s.close();
  }
}

async function checkDisconnectedQuit(): Promise<void> {
  const nc = await connect({ servers: SERVERS });
  let s: ConsoleSession | undefined;
  try {
    const js = await jetstreamManager(nc);
    const consumerCount = async () => (await js.streams.info(`KV_${membershipBucket(space)}`)).state.consumer_count;
    const before = await consumerCount();
    s = new ConsoleSession(["--space", space, "--server", SERVERS], home, { CI: "false", CONTINUOUS_INTEGRATION: "false" });
    check("console opens on a live broker", await s.waitFor(`● ${space}`, 40_000), clean(s.out).slice(-500));
    const deadline = Date.now() + 10_000;
    while ((await consumerCount()) <= before && Date.now() < deadline) await wait(100);
    check("console has a live membership watch before the outage", (await consumerCount()) > before);
    await nc.close();
    const from = s.mark();
    await killAndAwaitExit(srv, "SIGTERM");
    check("the console paints disconnected before quit", await s.waitFor(`⨯ ${space}`, 10_000, from), clean(s.out.slice(from)).slice(-500));
    const quitFrom = s.mark();
    const exited = await s.quit(20_000);
    const output = s.out.slice(quitFrom);
    check("q exits zero, restores the terminal, and prints no timeout after the broker stops",
      exited && output.includes("\x1b[?1049l") && !output.includes("TimeoutError"), { exit: s.exited, output: clean(output).slice(-500) });
  } finally {
    await nc.close();
    await s?.close();
  }
}

async function checkSmallHelp(): Promise<void> {
  const cols = 80, rows = 24;
  const s = new ConsoleSession(["--space", space, "--server", SERVERS], home, {}, { cols, rows });
  const displayed = () => screen(s.out, cols, rows);
  const hasRow = (frame: string, text: string) => frame.split("\n").some((row) =>
    row.replace(/^│|│$/g, "").trim().replace(/ +/g, " ") === text);
  try {
    check("the 80 by 24 console paints the feed", await s.waitFor(`${space} · all`, 40_000));
    s.write("?");
    await s.waitFor("↑↓ scroll", 8_000);
    const first = await displayed();
    check("short help shows the title, both headings and distinct feed bindings", [
      "cotal console - help", "context: feed panel", "feed panel", "global",
      "Ctrl-d / Ctrl-u half-page down / up", "{ } / K J previous / next message",
      "[ / ] prev / next channel", "d direct-message lens",
    ].every((text) => hasRow(first, text)), first);
    const down = s.mark();
    s.write("\x1b[6~");
    await s.waitFor("q / Ctrl-C", 8_000, down);
    const last = await displayed();
    check("Page Down reaches the final shortcuts and preserves the wrapped commands description", [
      "D delete - kill agent / drop space", "/ search / filter", "? toggle this help", "q / Ctrl-C quit",
      "Ctrl-p commands (spawn / send / attach / status / purge /", "delchan)",
    ].every((text) => hasRow(last, text)), last);
    const up = s.mark();
    s.write("\x1b[5~");
    await s.waitFor("half-page down / up", 8_000, up);
    const back = await displayed();
    check("Page Up restores the first help rows", hasRow(back, "feed panel") && hasRow(back, "Ctrl-d / Ctrl-u half-page down / up"), back);
    const close = s.mark();
    s.write("?");
    check("? closes help and returns to the feed", await s.waitFor(`${space} · all`, 8_000, close));
    check("q quits after leaving help", await s.quit());
  } finally {
    await s.close();
  }
}

let session: ConsoleSession | undefined;
let poster: CotalEndpoint | undefined;
let stub: CotalEndpoint | undefined;
let reader: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space });

  poster = new CotalEndpoint({ space, servers: SERVERS, card: { name: "poster", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  poster.on("error", () => {});
  await poster.start();
  // A roster agent whose card self-publishes harness metadata + skills.
  stub = new CotalEndpoint({
    space, servers: SERVERS, consume: false, watchPresence: false,
    card: { name: "stubby", kind: "agent", meta: { connector: "opencode", model: "test-model-9" }, skills: [{ id: "s1", name: "review", description: "reads diffs" }] },
  });
  stub.on("error", () => {});
  await stub.start();
  reader = new CotalEndpoint({ space, servers: SERVERS, card: { name: "reader", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  reader.on("error", () => {});
  await reader.start();
  await poster.multicast("baseline", { channel: "kept" }); // pre-start history: must NOT count as unread
  // A channel filled to the per-sender retention cap: the 1,001st message evicts the oldest, so the
  // broker's count for it is pinned at 1,000 from here on.
  for (let i = 0; i < 1000; i++) await poster.multicast(`cap-${i}`, { channel: "cap" });
  await poster.multicast("doomed-1", { channel: "doomed" });
  await poster.multicast("doomed-2", { channel: "doomed" });
  check("fixture: both channels have persisted history", (await reader.channelHistory("kept")).length === 1 && (await reader.channelHistory("doomed")).length === 2);
  const capRow = (await reader.listChannels()).find((c) => c.channel === "cap");
  check("fixture: the cap channel sits at the retention cap", capRow?.messages === 1000, capRow);

  session = new ConsoleSession(["--space", space, "--server", SERVERS], home, {}, { cols: 140, rows: 36 });
  const s = session;

  console.log("1. unread badges");
  check("console paints", await s.waitFor(`${space} · all`, 40_000), clean(s.out).slice(-300));
  check("channel tab visible", await s.waitFor("#kept", 15_000));
  await wait(1500); // let the first channel poll land and the baseline settle
  check("no fake unread at startup", !clean(s.out).includes("+1") && !clean(s.out).includes("+2"));
  const freshMark = s.out.length;
  await poster.multicast("first-ever", { channel: "fresh" }); // a channel that did not exist at startup
  check("a channel that first appears after startup badges its first message (+1), no baseline swallows it", await s.waitFor(/#fresh 1 \+1(?!\d)/, 15_000, freshMark), clean(s.out.slice(freshMark)).match(/#fresh [^│\n]{0,20}/)?.[0] ?? clean(s.out.slice(freshMark)).slice(-300));
  await poster.multicast("m2", { channel: "kept" });
  await poster.multicast("m3", { channel: "kept" });
  check("two messages while viewing `all` show a +2 badge on #kept", await s.waitFor(/#kept \d+ \+2(?!\d)/, 15_000));
  // The tab order is alphabetical: cap (2), doomed (3), fresh (4), kept (5).
  s.write("5");
  await wait(1500);
  s.write("1");
  await wait(500);
  const mark = s.out.length;
  await poster.multicast("m4", { channel: "kept" });
  check("viewing pinned the watermark: the next message is +1, not +3", await s.waitFor(/#kept \d+ \+1(?!\d)/, 15_000, mark), clean(s.out.slice(mark)).match(/#kept [^│\n]{0,20}/g)?.slice(-3));
  check("no stale +3 on #kept", !/#kept \d+ \+3/.test(clean(s.out.slice(mark))));
  const capMark = s.out.length;
  await poster.multicast("overflow-live", { channel: "cap" });
  check("a live message on a channel at the retention cap still badges +1 (arrivals, not retained depth)", await s.waitFor(/#cap 1000 \+1(?!\d)/, 15_000, capMark), clean(s.out.slice(capMark)).match(/#cap [^│\n]{0,20}/)?.[0] ?? clean(s.out.slice(capMark)).slice(-300));

  console.log("2. harness tag and the detail card");
  check("roster shows the harness tag next to the name", await s.waitFor("stubby oc", 10_000), clean(s.out).slice(-400));
  s.write("l"); // focus the roster
  await wait(400);
  s.write("\r");
  check("detail: runs field", await s.waitFor("runs:", 8_000));
  check("detail: the connector value", await s.waitFor("opencode", 4_000));
  check("detail: the model", await s.waitFor("test-model-9", 4_000));
  check("detail: the skill and its description", (await s.waitFor("review", 4_000)) && clean(s.out).includes("reads diffs"));
  s.write("\r"); // close the detail
  await wait(400);

  console.log("3. :delchan through the typed-name confirm");
  const beforeDelete = await screen(s.out, 140, 36);
  check("delchan fixture: the aggregate shows posts from both channels",
    beforeDelete.includes("feed · all") && beforeDelete.includes("doomed-2") && beforeDelete.includes("m4"), beforeDelete);
  const dm = s.out.length;
  await s.command("delchan doomed");
  check("delchan: the confirm opens", await s.waitFor("Delete channel", 8_000, dm), clean(s.out.slice(dm)).slice(-300));
  // Enter is armed by the EXACT name and this deletion is irreversible, so the gate gets a negative
  // cell before the valid path. Without it every assertion below passes equally on a confirm that
  // accepts any Enter, which is the failure mode a valid-path-only test cannot see.
  s.write("doome"); // one character short
  await wait(300);
  s.write("\r");
  check("delchan: a name one character short does not delete", !(await s.waitFor("messages purged", 3_000, dm)), clean(s.out.slice(dm)).slice(-200));
  check("...and the channel's history survives the wrong name", (await reader.channelHistory("doomed")).length === 2, await reader.channelHistory("doomed"));
  s.write("\x1b"); // Esc closes the confirm; re-open it rather than editing the typed text
  await wait(500);
  const dm2 = s.mark();
  await s.command("delchan doomed");
  check("delchan: the confirm re-opens after the cancel", await s.waitFor("Delete channel", 8_000, dm2), clean(s.out.slice(dm2)).slice(-200));
  s.write("doomed");
  await wait(300);
  s.write("\r");
  check("delchan: the notice reports the purge", await s.waitFor("deleted #doomed · 2 messages purged", 15_000, dm), clean(s.out.slice(dm)).slice(-300));
  check("delchan: the channel's history is gone", (await reader.channelHistory("doomed")).length === 0);
  check("delchan: the other channel survives", (await reader.channelHistory("kept")).length === 4);
  await wait(3500); // past one channel poll
  const strips = clean(s.out.slice(dm)).match(/1: all[^\n]*/g) ?? [];
  check("delchan: the deleted channel's tab is gone on the next poll", strips.length > 0 && !strips[strips.length - 1].includes("#doomed"), strips.at(-1));
  check("delchan: the tab never carried a badge on the way out", !/#doomed \d+ \+\d/.test(clean(s.out.slice(dm))), clean(s.out.slice(dm)).match(/#doomed \d+ \+\d/)?.[0]);
  const afterDelete = await screen(s.out, 140, 36);
  check("delchan: the aggregate keeps other posts and drops the deleted channel's posts",
    afterDelete.includes("feed · all") && afterDelete.includes("m4") && !/doomed-[12]/.test(afterDelete), afterDelete);

  console.log("4. the aggregate and the channel named all are separate tabs");
  await poster.multicast("other-feed-marker", { channel: "kept" });
  await poster.multicast("literal-all-marker", { channel: "all" });
  check("the aggregate and #all have separate tab labels", await s.waitFor(/1: all\s+2: #all\b/, 15_000));
  check("the aggregate shows both channels", await s.waitFor("other-feed-marker", 5_000) && await s.waitFor("literal-all-marker", 5_000));
  const selectAll = s.mark();
  s.write("2");
  check("tab 2 selects the concrete #all channel", await s.waitFor("feed · #all", 5_000, selectAll));
  const displayed = await screen(s.out, 140, 36);
  check("the selected #all feed only shows posts from #all",
    displayed.includes("literal-all-marker") && !displayed.includes("other-feed-marker"), displayed);
  check("the two tabs have distinct React keys", !clean(s.out).includes("Encountered two children with the same key"));
  check("console quits cleanly", await s.quit(), s.exited);

  console.log("5. color follows --no-color and NO_COLOR");
  // An SGR sequence that sets a foreground or background color. Bold, dim and resets are not color.
  const colored = (raw: string) =>
    [...raw.matchAll(/\x1b\[([0-9;]*)m/g)].some((m) => m[1].split(";").some((p) => /^(3[0-8]|4[0-8]|9[0-7]|10[0-7])$/.test(p)));
  const paint = async (args: string[], env: Record<string, string>) => {
    const c = new ConsoleSession([...args, "--space", space, "--server", SERVERS], home, env, { cols: 140, rows: 36 });
    try {
      const painted = await c.waitFor(`${space} · all`, 40_000);
      await wait(1500); // the roster and the channel strip paint after the frame
      return { painted, colored: colored(c.out), tail: clean(c.out).slice(-200) };
    } finally {
      await c.close();
    }
  };
  const forced = await paint([], { FORCE_COLOR: "1" });
  check("FORCE_COLOR alone paints the console in color", forced.painted && forced.colored, forced.tail);
  const flagged = await paint(["--no-color"], { FORCE_COLOR: "1" });
  check("--no-color paints the console with no ANSI color, even under FORCE_COLOR", flagged.painted && !flagged.colored, flagged.tail);
  const noColor = await paint([], { NO_COLOR: "1" });
  check("a non-empty NO_COLOR paints the console with no ANSI color", noColor.painted && !noColor.colored, noColor.tail);

  console.log("6. help fits a short terminal");
  await checkSmallHelp();
  await Promise.all([reader.stop(), stub.stop(), poster.stop()]);
  console.log("6. command palette over full-screen Needs You");
  await checkNarrowNeedsYouPalette();
  await checkDisconnectedQuit();
} catch (e) {
  fail++;
  console.error("  ✗ threw:", e);
} finally {
  try { await session?.close(); } catch { /* down */ }
  try { await reader?.stop(); } catch { /* down */ }
  try { await stub?.stop(); } catch { /* down */ }
  try { await poster?.stop(); } catch { /* down */ }
  await killAndAwaitExit(srv, "SIGKILL");
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "CONSOLE-GAPS SMOKE OK ✅" : "CONSOLE-GAPS SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
