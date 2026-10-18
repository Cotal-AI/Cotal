/**
 * The Claude plugin's server in a session Cotal did not launch: a plain Claude Code session, and
 * Claude Desktop with `--desktop`. Each conversation joins the local mesh when it calls
 * `cotal_connect`, as an identity of its own, and leaves it when it disconnects or the server ends.
 *
 * Live: a sandbox `cotal up` with static credentials, the built `dist/mcp.cjs` copied beside a
 * `cli.json` as `cotal setup` writes it, and each server driven over raw JSON-RPC on stdio, as Claude
 * drives it. The CLI it runs is the built one, so this is the installed path end to end.
 *
 * Needs `nats-server` on PATH and a build. Run: pnpm smoke:claude-local:live
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = join(REPO, "bin", "dist", "cotal.js");
const MCP = join(REPO, "extensions", "connector-claude-code", "dist", "mcp.cjs");
for (const built of [CLI, MCP])
  if (!existsSync(built)) {
    console.error(`✗ ${built} missing — build first: pnpm --filter cotal-ai... build`);
    process.exit(1);
  }

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(400, () => {
      s.destroy();
      res(false);
    });
  });

const PORT = await freePort();
const DECOY_PORT = await freePort(); // nothing listens here: the decoy mesh is down
const SPACE = `clocal${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-claude-local-"));
const COTAL_HOME = join(dir, "cotalhome");
const CONFIG = join(dir, "config");
const ROOT = join(dir, "project");
const DECOY = join(dir, "decoy"); // another project, whose mesh is recorded and down
const sandbox = recordSmokeSandbox({ root: ROOT, cotalHome: COTAL_HOME, xdgConfigHome: CONFIG });
mkdirSync(join(ROOT, ".cotal", "agents"), { recursive: true });
mkdirSync(join(DECOY, ".cotal"), { recursive: true });
writeFileSync(
  join(ROOT, ".cotal", "agents", "default.md"),
  "---\nname: default\nrole: default\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\n\nThe smoke's default persona.\n",
);

// Scrub ambient COTAL_* (this smoke may itself run inside a mesh session), so every command and
// server below takes its mesh only from the sandbox.
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("COTAL_")) env[k] = v;
Object.assign(env, { COTAL_HOME, XDG_CONFIG_HOME: CONFIG, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1" });

const cotal = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(process.execPath, [CLI, ...args], options);
};

/** A plugin directory as `cotal setup` materializes it: the server, and the CLI record beside it. */
function plugin(name: string, recorded: boolean): string {
  const dist = join(dir, name, "dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(MCP, join(dist, "mcp.cjs"));
  if (recorded) writeFileSync(join(dist, "cli.json"), `${JSON.stringify({ argv: [process.execPath, CLI] })}\n`);
  return join(dist, "mcp.cjs");
}
const SERVER = plugin("plugin", true);
const UNRECORDED = plugin("unrecorded", false);

interface Served {
  p: ChildProcess;
  instructions: string;
  tools: string[];
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  exited: Promise<number | null>;
  stderr(): string;
}

const servers: Served[] = [];

/** Start one server as Claude starts it, and complete the MCP handshake. */
async function serve(script: string, cwd: string, flags: string[] = []): Promise<Served> {
  const p = spawn(process.execPath, [script, ...flags], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
  let buf = "";
  let err = "";
  let next = 0;
  const waiters = new Map<number, (m: any) => void>();
  p.stderr!.on("data", (d) => (err += d));
  p.stdout!.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        waiters.get(m.id)?.(m);
      } catch {
        /* not a reply */
      }
    }
  });
  const rpc = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve) => {
      const id = ++next;
      waiters.set(id, resolve);
      p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await rpc("tools/list", {});
  const s: Served = {
    p,
    instructions: String(init.result?.instructions ?? ""),
    tools: (listed.result?.tools ?? []).map((t: { name: string }) => t.name),
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      return String(r.result?.content?.[0]?.text ?? JSON.stringify(r));
    },
    exited,
    stderr: () => err,
  };
  servers.push(s);
  return s;
}

/** The credential directories app-identity made for this server's conversations: the record in
 *  each names the process that asked, which is the server itself. */
function heldBy(pid: number | undefined): string[] {
  return readdirSync(tmpdir())
    .filter((n) => n.startsWith("cotal-app-identity-"))
    .filter((n) => {
      try {
        return (JSON.parse(readFileSync(join(tmpdir(), n, "identity.json"), "utf8")) as { owner?: number }).owner === pid;
      } catch {
        return false;
      }
    });
}

const connectionId = (text: string) => /connection_id: (\S+)/.exec(text)?.[1] ?? "";

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await cond()) return true;
  return cond();
}

let meshUp = false;
try {
  const up = cotal(ROOT, "up", "--detach", "--server", `nats://127.0.0.1:${PORT}`, "--space", SPACE);
  meshUp = true;
  check("the sandbox mesh comes up with static credentials", up.status === 0 && (await portOpen(PORT)), `${up.stdout}\n${up.stderr}`);

  // ── what a plain session is served ───────────────────────────────────────────────────────────
  const code = await serve(SERVER, ROOT);
  check(
    "a session Cotal did not launch is served the gateway's tools",
    ["cotal_connect", "cotal_wait", "cotal_disconnect", "cotal_dm"].every((t) => code.tools.includes(t)) && !code.tools.includes("cotal_how_to_join"),
    code.tools,
  );
  check("  and told this is the Cotal server on this computer", code.instructions.startsWith("This is the Cotal server on this computer"), code.instructions.slice(0, 120));

  const unrecorded = await serve(UNRECORDED, ROOT);
  const refused = await unrecorded.call("cotal_connect", { name: "claude_unrecorded" });
  check(
    "a plugin `cotal setup` did not install refuses to connect, naming the remedy",
    /not installed by `cotal setup`/.test(refused) && /Run `cotal setup` again/.test(refused),
    refused,
  );
  check("  and it made no credential directory", heldBy(unrecorded.p.pid).length === 0);
  unrecorded.p.stdin!.end();
  await unrecorded.exited;

  // ── a Claude Code session and Claude Desktop, each conversation its own identity ──────────────
  const a = await code.call("cotal_connect", { name: "claude_local" });
  const idA = connectionId(a);
  check("a Claude Code conversation connects under the name it asked for", /^Connected as claude_local\./.test(a) && idA !== "", a);
  check("  holding one credential directory of its own", heldBy(code.p.pid).length === 1, heldBy(code.p.pid));

  // Desktop's working directory is not the person's project. This one starts in the decoy project,
  // which the `--desktop` server must not read; the cells after `current` is cleared depend on it.
  const desktop = await serve(SERVER, DECOY, ["--desktop"]);
  const b = await desktop.call("cotal_connect", { name: "claude_local" });
  const idB = connectionId(b);
  check("a Desktop conversation asking for a live name gets the next free one", /^Connected as claude_local_2 \("claude_local" was taken\)/.test(b) && idB !== "", b);
  const c = await desktop.call("cotal_connect", { name: "claude_desktop" });
  const idC = connectionId(c);
  check("a second Desktop conversation in the same server is a separate identity", /^Connected as claude_desktop\./.test(c) && idC !== "" && idC !== idB, c);
  check("  each with its own credential directory", heldBy(desktop.p.pid).length === 2, heldBy(desktop.p.pid));

  // ── push: a held wait returns when a peer's DM lands ─────────────────────────────────────────
  const token = `local-dm-${process.pid}`;
  const waitStarted = Date.now();
  const waiting = code.call("cotal_wait", { connection_id: idA, seconds: 40 });
  await sleep(1_000);
  const sent = cotal(ROOT, "send", "dm", "claude_local", token);
  check("a peer DMs the Claude Code conversation by name", sent.status === 0, `${sent.stdout}\n${sent.stderr}`);
  const woke = await waiting;
  check("  and its held wait returns that DM before its bound", woke.includes(token) && Date.now() - waitStarted < 40_000, woke);

  const roster = await desktop.call("cotal_roster", { connection_id: idC });
  check(
    "every conversation is present under its own name",
    ["claude_local/", "claude_local_2/", "claude_desktop/"].every((n) => roster.includes(n)),
    roster,
  );

  // ── leaving ──────────────────────────────────────────────────────────────────────────────────
  const before = heldBy(desktop.p.pid);
  const left = await desktop.call("cotal_disconnect", { connection_id: idC });
  check("cotal_disconnect ends that conversation's connection", /^Disconnected/.test(left), left);
  const after = heldBy(desktop.p.pid);
  check("  and retires its credential directory, leaving the other one", before.length === 2 && after.length === 1 && before.includes(after[0]!), after);
  let seen = "";
  const gone = await until(async () => {
    seen = await code.call("cotal_roster", { connection_id: idA });
    return seen.split("\n").every((l) => !l.includes("claude_desktop/") || /offline/.test(l));
  });
  check("  and its name goes offline on the mesh", gone, seen);

  // ── which mesh, with no `cotal use` mesh selected ────────────────────────────────────────────
  // `cotal up` selected the sandbox mesh. Without that, the working directory decides for Claude
  // Code, and only the running meshes decide for Desktop.
  const decoy = cotal(ROOT, "meshes", "add", "decoy", "--server", `nats://127.0.0.1:${DECOY_PORT}`, "--root", DECOY, "--mode", "open", "--force");
  check("a second project's mesh is recorded, and down", decoy.status === 0 && !(await portOpen(DECOY_PORT)), `${decoy.stdout}\n${decoy.stderr}`);
  unlinkSync(join(COTAL_HOME, "current-mesh"));
  const inDecoy = await serve(SERVER, DECOY);
  const down = await inDecoy.call("cotal_connect", { name: "claude_decoy" });
  check(
    "a Claude Code session in that project is told its mesh is not answering",
    /"decoy"/.test(down) && /not answering/.test(down) && /cotal up/.test(down) && heldBy(inDecoy.p.pid).length === 0,
    down,
  );
  inDecoy.p.stdin!.end();
  await inDecoy.exited;
  const d = await desktop.call("cotal_connect", { name: "claude_desktop" });
  check("a Desktop conversation started in that project joins the one running mesh", /^Connected as claude_desktop\./.test(d), d);
  check("  with a credential directory of its own", heldBy(desktop.p.pid).length === 2, heldBy(desktop.p.pid));

  // ── the server ending retires what it held ───────────────────────────────────────────────────
  desktop.p.stdin!.end();
  check("Desktop closing the server's stdin ends it cleanly", (await desktop.exited) === 0, desktop.stderr().slice(-400));
  check("  and every credential directory it held is retired", heldBy(desktop.p.pid).length === 0, heldBy(desktop.p.pid));
  code.p.kill("SIGTERM");
  check("a signalled server ends cleanly", (await code.exited) === 0, code.stderr().slice(-400));
  check("  and retires its conversation's credential directory", heldBy(code.p.pid).length === 0, heldBy(code.p.pid));

  const torn = cotal(ROOT, "down");
  meshUp = false;
  check("`cotal down` stops the sandbox mesh", torn.status === 0, `${torn.stdout}\n${torn.stderr}`);
  check("  and its broker is gone", await until(async () => !(await portOpen(PORT))));

  console.log(`\nCLAUDE LOCAL SERVER SMOKE PASSED ✅  (${pass} checks)`);
} catch (e) {
  console.error(`\n✗ claude local server smoke failed: ${(e as Error).message}`);
  for (const s of servers) if (s.stderr().trim()) console.error(`--- server ${s.p.pid} stderr ---\n${s.stderr().slice(-1500)}`);
  process.exitCode = 1;
} finally {
  for (const s of servers) {
    if (s.p.exitCode === null && s.p.signalCode === null) s.p.kill("SIGKILL");
    await s.exited;
    for (const held of heldBy(s.p.pid)) rmSync(join(tmpdir(), held), { recursive: true, force: true });
  }
  if (meshUp) cotal(ROOT, "down");
  rmSync(dir, { recursive: true, force: true });
}
