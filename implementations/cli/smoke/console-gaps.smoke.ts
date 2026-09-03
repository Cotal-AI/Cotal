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
 *      The deleted channel's tab leaves the strip on the next channel poll, and never shows a
 *      badge on the way out (its watermark is dropped only once the tab is gone).
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { ConsoleSession, clean, wait } from "./_console-pty.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ FAIL: " + n, extra ?? ""); } };
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

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
  await poster.multicast("doomed-1", { channel: "doomed" });
  await poster.multicast("doomed-2", { channel: "doomed" });
  // A channel filled to the per-sender retention cap: the 1,001st message evicts the oldest, so the
  // broker's count for it is pinned at 1,000 from here on.
  for (let i = 0; i < 1000; i++) await poster.multicast(`cap-${i}`, { channel: "cap" });
  check("fixture: both channels have persisted history", (await reader.channelHistory("kept")).length === 1 && (await reader.channelHistory("doomed")).length === 2);
  const capRow = (await reader.listChannels()).find((c) => c.channel === "cap");
  check("fixture: the cap channel sits at the retention cap", capRow?.messages === 1000, capRow);

  session = new ConsoleSession(["--space", space, "--server", SERVERS], home, {}, { cols: 140, rows: 36 });
  const s = session;

  console.log("1. unread badges");
  check("console paints", await s.waitFor(`${space} · #`, 40_000), clean(s.out).slice(-300));
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
  check("console quits cleanly", await s.quit(), s.exited);
} catch (e) {
  fail++;
  console.error("  ✗ threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  try { await session?.close(); } catch { /* down */ }
  try { await reader?.stop(); } catch { /* down */ }
  try { await stub?.stop(); } catch { /* down */ }
  try { await poster?.stop(); } catch { /* down */ }
  srv.kill("SIGKILL");
  await new Promise<void>((res) => { if (srv.exitCode !== null) return res(); srv.once("exit", () => res()); setTimeout(res, 3000); });
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "CONSOLE-GAPS SMOKE OK ✅" : "CONSOLE-GAPS SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
