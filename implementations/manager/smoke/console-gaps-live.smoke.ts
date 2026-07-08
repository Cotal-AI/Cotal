/**
 * Console web-parity features live smoke — run with: pnpm smoke:console-gaps:live (needs
 * nats-server + node; the script chains `pnpm build` — the console under test runs the BUILT dists).
 *
 * Drives the REAL console TUI under node-pty (open mesh + Manager) through the features ported
 * from the web dashboard: per-channel unread badges (baseline at startup — history is not unread;
 * accrue while another tab is viewed; viewing pins the watermark), the roster's harness tag +
 * `runs`/`model`/`skills` in the agent detail (from the card's self-published meta), and the
 * `:delchan` flow (verb → type-the-channel-name confirm → deleted notice). The op itself is
 * guarded server-side by purge-channel-live.smoke.ts; this covers the console half.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn, type IPty } from "@lydell/node-pty";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const COTAL = join(repoRoot, "bin", "cotal.ts");
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ FAIL: " + n, extra ?? "")); };

const space = `gaps-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-gaps-"));
const workspaceRoot = join(dir, "ws");
const home = join(dir, "home");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
mkdirSync(join(home, "meshes"), { recursive: true });
writeFileSync(join(home, "meshes", `${space}.json`),
  JSON.stringify({ space, server: SERVERS, root: workspaceRoot, mode: "open", ts: new Date().toISOString() }));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });

let out = "";
let exited: number | undefined;
let p: IPty | undefined;
const waitFor = async (m: string, ms: number, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (out.slice(from).includes(m)) return true; if (exited !== undefined) return out.slice(from).includes(m); await wait(100); }
  return false;
};

let poster: CotalEndpoint | undefined;
let stub: CotalEndpoint | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await wait(200); }
  await setupSpaceStreams({ servers: SERVERS, space });
  await mgr.start();

  poster = new CotalEndpoint({ space, servers: SERVERS, card: { name: "poster", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  poster.on("error", () => {});
  await poster.start();
  // A roster agent whose card self-publishes harness metadata + skills.
  stub = new CotalEndpoint({
    space, servers: SERVERS, consume: false, watchPresence: false,
    card: {
      name: "stubby", kind: "agent",
      meta: { connector: "opencode", model: "test-model-9" },
      skills: [{ id: "s1", name: "review", description: "reads diffs" }],
    },
  });
  stub.on("error", () => {});
  await stub.start();
  await poster.multicast("baseline", { channel: "kept" }); // pre-start history — must NOT count as unread

  p = ptySpawn(TSX, [COTAL, "console", "--space", space, "--server", SERVERS], {
    name: "xterm-256color", cols: 140, rows: 36, cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", COTAL_HOME: home },
  });
  p.onData((d) => (out += d));
  p.onExit((e) => (exited = e.exitCode));

  check("console paints", await waitFor(`${space} · #`, 30_000));
  check("channel tab visible", await waitFor("#kept", 15_000));
  await wait(1500); // let the first channel poll land + baseline settle
  check("no fake unread at startup", !out.includes("+1"));
  // The name and tag are separate Ink Text nodes with ANSI color codes between them — strip first.
  const cleanHas = async (m: string, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").includes(m)) return true;
      await wait(100);
    }
    return false;
  };
  check("roster shows the harness tag", await cleanHas("stubby oc", 10_000), out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").slice(-400));

  // Two background messages while viewing `all` → +2 badge.
  await poster.multicast("m2", { channel: "kept" });
  await poster.multicast("m3", { channel: "kept" });
  check("unread badge +2 appears", await waitFor("+2", 15_000));

  // View the channel (tab 2) → watermark pins; back to all; one more message → +1 (not +3).
  p.write("2");
  await wait(1500);
  p.write("1");
  await wait(500);
  const mark = out.length;
  await poster.multicast("m4", { channel: "kept" });
  check("viewing cleared the watermark (+1, not +3)", await waitFor("+1", 15_000, mark), out.slice(mark).slice(-300));
  check("no stale +3", !out.slice(mark).includes("+3"));

  // Agent detail: focus the roster, open the first row.
  p.write("l"); // focus roster
  await wait(400);
  p.write("\r");
  check("detail: runs field", await waitFor("runs:", 8_000));
  check("detail: connector value", await waitFor("opencode", 4_000));
  check("detail: model", await waitFor("test-model-9", 4_000));
  check("detail: skill listed", await waitFor("review", 4_000) && out.includes("reads diffs"));
  p.write("\r"); // close detail
  await wait(400);

  // delchan flow: verb → typed-name confirm → notice.
  const dm = out.length;
  p.write(":");
  await wait(400);
  p.write("delchan kept");
  await wait(200);
  p.write("\r");
  check("delchan confirm opens", await waitFor("Delete channel", 8_000, dm), out.slice(dm).slice(-300));
  p.write("kept");
  await wait(300);
  p.write("\r");
  check("delchan notice", await waitFor("deleted #kept", 10_000, dm), out.slice(dm).slice(-300));

  p.write("q");
  for (let i = 0; i < 50 && exited === undefined; i++) await wait(100);
  check("console quits cleanly", exited === 0, exited);
} catch (e) {
  fail++;
  console.error("  ✗ threw:", (e as Error).message);
} finally {
  try { p?.kill(); } catch { /* down */ }
  try { await stub?.stop(); } catch { /* down */ }
  try { await poster?.stop(); } catch { /* down */ }
  try { await mgr.stop(); } catch { /* down */ }
  srv.kill("SIGKILL");
  await new Promise<void>((res) => { if (srv.exitCode !== null) return res(); srv.once("exit", () => res()); setTimeout(res, 3000); });
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "CONSOLE-GAPS SMOKE OK ✅" : "CONSOLE-GAPS SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
