/** REAL broker on loopback: one host process serves two hosted Claude sessions, and each session's
 *  card reports the directory its own SessionStart hook supplied, never the host process's.
 *
 *  The host runs in directory Z. Sessions A and B are served by `serveClaudeSession` in that one
 *  process, and their hooks arrive over each session's own control socket and token, exactly as the
 *  relay delivers them. A separate endpoint reads the cards off the roster. Claude Code documents
 *  `cwd` on every hook as the current working directory and SessionStart `source` as startup,
 *  resume, clear, compact or fork; the card keeps the startup snapshot, so clear and compact (whose
 *  `cwd` follows later `cd`) leave it alone. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CotalEndpoint, isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { ClaudeSession, ClaudeSessionOptions } from "../src/mcp.js";

const require = createRequire(import.meta.url);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let checks = 0;
function check(name: string, passed: boolean, detail?: unknown): void {
  assert.equal(passed, true, `${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`PASS ${name}`);
}

/** One control frame, as the hook relay sends it. Resolves the reply, or undefined when the
 *  connector dropped the connection without one (an unauthenticated frame). */
function hook(path: string, token: string, event: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>); }
    });
    sock.once("error", reject);
    sock.once("close", () => resolve(undefined));
    sock.write(`${JSON.stringify({ token, event })}\n`);
  });
}

async function child(): Promise<void> {
  const { serveClaudeSession } = require("@cotal-ai/connector-claude-code/mcp") as {
    serveClaudeSession(opts: ClaudeSessionOptions): Promise<ClaudeSession>;
  };
  const host = process.cwd(), root = dirname(host), servers = process.env.HOSTED_DIRECTORY_SERVER!;
  const space = "hosted_directory";
  await setupSpaceStreams({ servers, space });
  const peer = new CotalEndpoint({ servers, space, card: { name: "dir_peer", kind: "endpoint" }, consume: false, watchChannels: false });
  const marker = new CotalEndpoint({ servers, space, card: { name: "dir_marker", kind: "endpoint" }, consume: false, watchPresence: false, watchChannels: false });
  peer.on("error", () => {}); marker.on("error", () => {});
  type Seat = { name: string; dir: string; socket: string; token: string; input: PassThrough; output: PassThrough; session?: ClaudeSession };
  const seats: Seat[] = [];
  const card = (name: string) => peer.getRoster().find((p) => p.card.name === name && p.status !== "offline");
  const cwdOf = (name: string) => card(name)?.card.meta?.cwd as string | undefined;
  const until = async (what: string, ok: () => boolean) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await wait(25)) if (ok()) return true;
    return false;
  };
  // Every presence write lands in one ordered stream, so once the peer has seen the marker's newer
  // activity it has also seen any card change a session published before it.
  let barriers = 0;
  const barrier = async () => {
    const label = `barrier-${++barriers}`;
    await marker.setActivity(label);
    return until(label, () => peer.getRoster().some((p) => p.card.name === "dir_marker" && p.activity === label));
  };
  const sessionStart = (seat: Seat, source: string, cwd: string, token = seat.token) =>
    hook(seat.socket, token, { hook_event_name: "SessionStart", session_id: `${seat.name}-session`, transcript_path: join(seat.dir, "t.jsonl"), cwd, source });
  try {
    await peer.start(); await marker.start();
    for (const name of ["sess_a", "sess_b"]) {
      const home = join(root, `${name}_home`), dir = join(root, `${name}_project`);
      mkdirSync(home, { mode: 0o700 }); mkdirSync(dir, { mode: 0o700 });
      const input = new PassThrough(), output = new PassThrough(); output.resume();
      input.on("error", () => {}); output.on("error", () => {});
      const seat: Seat = { name, dir, socket: join(home, "c.sock"), token: randomBytes(32).toString("hex"), input, output };
      seats.push(seat);
      seat.session = await serveClaudeSession({
        env: {
          HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COTAL_NAME: name, COTAL_SPACE: space,
          COTAL_SERVERS: servers, COTAL_WORKSPACE_ROOT: home, COTAL_CONTROL_SOCKET: seat.socket,
          COTAL_CONTROL_TOKEN: seat.token, COTAL_CHANNEL: "0",
        },
        input, output,
      });
    }
    const [a, b] = seats as [Seat, Seat];
    check("hosted_dir_sessions_published", await until("both", () => card(a.name) !== undefined && card(b.name) !== undefined));
    const beforeHook = { a: cwdOf(a.name), b: cwdOf(b.name) };

    check("hosted_dir_hook_replied", (await sessionStart(a, "startup", a.dir)) !== undefined && (await sessionStart(b, "startup", b.dir)) !== undefined);
    await until("startup", () => cwdOf(a.name) === a.dir && cwdOf(b.name) === b.dir);
    check("hosted_dir_session_a_directory", cwdOf(a.name) === a.dir, { got: cwdOf(a.name), want: a.dir, host });
    check("hosted_dir_session_b_directory", cwdOf(b.name) === b.dir, { got: cwdOf(b.name), want: b.dir, host });
    check("hosted_dir_no_host_fallback_before_hook", beforeHook.a === undefined && beforeHook.b === undefined, { beforeHook, host });

    // Later `cd` reaches clear/compact hooks; neither moves the startup snapshot. An undocumented
    // source is not trusted either, and a frame without the session's token never reaches it.
    const moved = join(root, "moved"); mkdirSync(moved, { mode: 0o700 });
    for (const source of ["compact", "clear", "not-a-documented-source"]) await sessionStart(a, source, moved);
    const refused = await sessionStart(b, "startup", moved, randomBytes(32).toString("hex"));
    check("hosted_dir_barrier_seen", await barrier());
    check("hosted_dir_compact_clear_keep_snapshot", cwdOf(a.name) === a.dir, { got: cwdOf(a.name) });
    check("hosted_dir_wrong_token_refused", refused === undefined && cwdOf(b.name) === b.dir, { refused, got: cwdOf(b.name) });

    // A resumed session is a session start, so it reports its directory again.
    await sessionStart(b, "resume", moved);
    check("hosted_dir_resume_reports", await until("resume", () => cwdOf(b.name) === moved), { got: cwdOf(b.name) });

    // The card keeps the harness's pathname bytes. A real directory whose name has a space inside and
    // at its end is a different directory from its trimmed sibling, and the card names the one the
    // hook reported. An empty cwd names no directory, so it leaves the snapshot alone.
    const spaced = join(root, "spaced project "), plain = join(root, "spaced project");
    mkdirSync(spaced, { mode: 0o700 }); mkdirSync(plain, { mode: 0o700 });
    check("hosted_dir_spaced_and_plain_are_distinct_dirs", statSync(spaced).ino !== statSync(plain).ino);
    await sessionStart(a, "resume", spaced);
    check("hosted_dir_spaced_barrier_seen", await barrier());
    check("hosted_dir_trailing_space_bytes_kept", cwdOf(a.name) === spaced, { got: cwdOf(a.name), want: spaced });
    check("hosted_dir_spaced_sibling_untouched", cwdOf(b.name) === moved, { got: cwdOf(b.name) });
    await sessionStart(a, "resume", "");
    check("hosted_dir_empty_barrier_seen", await barrier());
    check("hosted_dir_empty_cwd_keeps_snapshot", cwdOf(a.name) === spaced, { got: cwdOf(a.name) });

    // Lifetime: once A closes, its socket takes no more frames and B's card is untouched.
    await a.session?.close(); a.session = undefined;
    const late = await sessionStart(a, "startup", moved).then(() => "answered", () => "unreachable");
    check("hosted_dir_closed_session_unreachable", late === "unreachable", { late });
    check("hosted_dir_closed_barrier_seen", await barrier());
    check("hosted_dir_closed_session_offline_sibling_kept", card(a.name) === undefined && cwdOf(b.name) === moved, { b: cwdOf(b.name) });
    console.log(`hosted-session-directory smoke: ${checks} checks passed`);
  } finally {
    const closed = await Promise.allSettled([...seats.map((s) => s.session?.close()), peer.stop(), marker.stop()]);
    for (const s of seats) { s.input.destroy(); s.output.destroy(); }
    assert.deepEqual(closed.filter((entry) => entry.status === "rejected"), [], "directory fixture teardown failed");
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
  const brokerHome = join(root, "broker-home"); mkdirSync(brokerHome, { mode: 0o700 });
  const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, "js")], {
    stdio: "ignore", env: { HOME: brokerHome, PATH: process.env.PATH, LANG: "C.UTF-8" },
  });
  const release = teardownOnSignal(broker, root);
  try {
    await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
    assert.equal(broker.exitCode, null);
    console.log("PASS hosted_dir_broker_ready");
    // The host process runs in its own directory, distinct from both sessions' project directories.
    const host = join(root, "host"); mkdirSync(host, { mode: 0o700 });
    for (const name of ["home", "xdg", "cotal", "tmp"]) mkdirSync(join(root, name), { mode: 0o700 });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const childProcess = spawn(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, fileURLToPath(import.meta.url)], {
        cwd: host,
        env: {
          HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), COTAL_HOME: join(root, "cotal"), TMPDIR: join(root, "tmp"),
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, LANG: "C.UTF-8",
          HOSTED_DIRECTORY_CASE: "1", HOSTED_DIRECTORY_SERVER: servers,
          ...(process.env.SMOKE_BROKER_SCOPE ? { SMOKE_BROKER_SCOPE: process.env.SMOKE_BROKER_SCOPE } : {}),
        },
        stdio: ["ignore", "inherit", "pipe"], timeout: 60_000,
      });
      const releaseChild = teardownOnSignal(childProcess, host);
      let stderr = "";
      childProcess.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      childProcess.once("error", reject);
      childProcess.once("close", (code, signal) => { releaseChild(); resolve({ code, signal, stderr }); });
    });
    if (result.code !== 0 || result.signal) { process.stderr.write(result.stderr); throw new Error("hosted session directory failed"); }
  } finally {
    await killAndAwaitExit(broker);
    rmSync(root, { recursive: true, force: true });
    release();
  }
}
(process.env.HOSTED_DIRECTORY_CASE ? child() : main()).catch((error) => { console.error(error); process.exitCode = 1; });
