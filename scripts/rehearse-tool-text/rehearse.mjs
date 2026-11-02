#!/usr/bin/env node
// Rehearse the coordination tools' text on fresh agents (#5625).
//
//   node scripts/rehearse-tool-text/rehearse.mjs --tree <checkout> --label <baseline|revised> \
//     --harness <claude|jcode> --out <dir> [--scenario <id>[,<id>…]] [--work <dir>] \
//     [--timeout-min 15] [--settle-s 60] [--jcode-config <dir>]
//
// Each scenario runs on its own sandbox mesh: a private directory (mode 700) holding its own
// COTAL_HOME, XDG_CONFIG_HOME, TMPDIR and project root, a broker on a free loopback port, and the
// connectors of --tree added with `cotal ext add`. A seat reads the tool text of the tree it was
// added from, so a baseline and a revised run differ only by --tree. The live mesh, its broker and
// the operator's own connector store are never touched: the CLI runs under a scrubbed environment.
//
// Per run the record holds `cotal history` for every channel involved and for DMs, each seat's tool
// calls with their arguments (from its own transcript: the manager logs no accepted spawn
// arguments), the manager log, the `cotal ps` snapshots, every persona in the catalog at the end,
// and the roster. grade.mjs then applies the scenario's pass check.
//
// Seats run under the operator's own HOME, because Claude Code and jcode read their logins there.
// So they also write per-user state outside the sandbox: a Claude Code project folder per working
// directory, which this script removes after the run when it can show the run created it, and
// entries in Claude Code's own state files, which it leaves alone because live sessions share them.
//
// The sandbox holds copies of the operator's harness credentials, made by the jcode connector and by
// this script for jcode's provider file. After the run the script stops the processes the run
// started, which it knows by the sandbox's own COTAL_HOME, XDG_CONFIG_HOME or TMPDIR in their
// environment, renames the sandbox so nothing new can open it by its path, and deletes it only when
// no process has its working directory, an open file or a sandbox path inside it.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { counts, grade, loadRecord } from "./grade.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
const SPACE = "rehearse";
const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const inside = (path, root) => path === root || path.startsWith(`${root}/`);

function parseArgs(argv) {
  const a = { timeoutMin: 15, settleS: 60, work: join(process.env.TMPDIR || "/tmp", "rehearse-tool-text") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === "--tree") a.tree = resolve(v());
    else if (k === "--label") a.label = v();
    else if (k === "--harness") a.harness = v();
    else if (k === "--out") a.out = resolve(v());
    else if (k === "--scenario") a.only = v().split(",");
    else if (k === "--work") a.work = resolve(v());
    else if (k === "--timeout-min") a.timeoutMin = Number(v());
    else if (k === "--settle-s") a.settleS = Number(v());
    else if (k === "--jcode-config") a.jcodeConfig = resolve(v());
    else throw new Error(`unknown argument ${k}`);
  }
  for (const k of ["tree", "label", "harness", "out"]) if (!a[k]) throw new Error(`--${k} is required`);
  if (!/^[a-z0-9-]+$/.test(a.label)) throw new Error("--label takes lowercase letters, digits and -");
  if (!FIXTURES.models[a.harness]) throw new Error(`--harness must be one of ${Object.keys(FIXTURES.models).join(", ")}`);
  for (const p of ["bin/cotal.ts", "node_modules/.bin/tsx", "extensions/connector-claude-code/dist/mcp.cjs"])
    if (!existsSync(join(a.tree, p))) throw new Error(`--tree ${a.tree} has no ${p}: install and build it first`);
  a.jcodeConfig ??= join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jcode");
  // The sandbox TMPDIR is <work>/r-XXXXXX/tmp, and the manager's control socket under it needs the
  // temp root to be at most 64 bytes.
  if (Buffer.byteLength(join(a.work, "r-XXXXXX", "tmp")) > 64) throw new Error(`--work ${a.work} is too long: the sandbox TMPDIR under it must be at most 64 bytes`);
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bare = (id) => String(id ?? "").replace(/^local\./, "");
const freePort = () => new Promise((res, rej) => {
  const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => (port === 4222 ? rej(new Error("got 4222")) : res(port))); });
});

class Sandbox {
  constructor(args, scenario) {
    this.args = args;
    this.scenario = scenario;
    mkdirSync(args.work, { recursive: true, mode: 0o700 });
    chmodSync(args.work, 0o700);
    // A short name: the manager binds a Unix socket under TMPDIR, and sun_path caps the whole path.
    this.root = mkdtempSync(join(args.work, "r-"));
    chmodSync(this.root, 0o700);
    writeFileSync(join(this.root, "RUN"), `${args.label} ${args.harness} ${scenario.id}\n`);
    for (const d of ["home", "config", "proj", "work", "tmp", "seats"]) mkdirSync(join(this.root, d), { mode: 0o700 });
    this.proj = join(this.root, "proj");
    this.log = [];
    this.claudeBefore = new Set(existsSync(CLAUDE_PROJECTS) ? readdirSync(CLAUDE_PROJECTS) : []);
    this.env = {
      HOME: homedir(), USER: process.env.USER ?? "", LANG: "C.UTF-8", TERM: "xterm-256color", PATH: process.env.PATH ?? "",
      ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
      ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
      ...(process.env.NATS_SERVER_BIN ? { NATS_SERVER_BIN: process.env.NATS_SERVER_BIN } : {}),
      COTAL_HOME: join(this.root, "home"), XDG_CONFIG_HOME: join(this.root, "config"), TMPDIR: join(this.root, "tmp"),
      COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", COTAL_DEFAULT_AGENT: args.harness,
    };
  }

  cotal(argv, { timeoutS = 240, json = false } = {}) {
    const r = spawnSync(join(this.args.tree, "node_modules/.bin/tsx"), [join(this.args.tree, "bin/cotal.ts"), ...argv], {
      cwd: this.proj, env: this.env, encoding: "utf8", timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    this.log.push({ at: new Date().toISOString(), argv, status: r.status, stdout: json ? undefined : r.stdout, stderr: r.stderr });
    if (!json) return r;
    try { return { ...r, doc: JSON.parse(r.stdout) }; } catch { return { ...r, doc: undefined }; }
  }

  must(argv, opts) {
    const r = this.cotal(argv, opts);
    if (r.status !== 0) throw new Error(`cotal ${argv.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").slice(-1500)}`);
    return r;
  }

  persona(name, frontmatter, body) {
    const yaml = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
    writeFileSync(join(this.proj, ".cotal", "agents", `${name}.md`), `---\n${yaml}\n---\n\n${body}\n`, { mode: 0o600 });
  }

  async start() {
    const { args, scenario } = this;
    for (const ext of ["connector-claude-code", "connector-jcode"]) this.must(["ext", "add", join(args.tree, "extensions", ext)]);
    if (args.harness === "jcode") {
      // jcode reads its provider's env_file from $XDG_CONFIG_HOME/jcode, which the sandbox moved.
      const dest = join(this.root, "config", "jcode");
      mkdirSync(dest, { mode: 0o700 });
      for (const f of readdirSync(args.jcodeConfig)) copyFileSync(join(args.jcodeConfig, f), join(dest, f));
    }
    const channels = { general: { description: "Space-wide talk" }, ...(scenario.channels ?? {}) };
    writeFileSync(join(this.root, "channels.json"), JSON.stringify({ channels }, null, 2));
    this.port = await freePort();
    this.must(["up", "--space", SPACE, "--server", `nats://127.0.0.1:${this.port}`, "--channels", join(this.root, "channels.json")], { timeoutS: 300 });
    const pins = FIXTURES.models[args.harness];
    const pinLines = [`model: ${pins.model}`, ...(pins.variant ? [`variant: ${pins.variant}`] : [])].join("\n");
    for (const name of scenario.catalog ?? []) {
      const text = readFileSync(join(HERE, "personas", `${name}.md`), "utf8").replace("{{pins}}", pinLines);
      writeFileSync(join(this.proj, ".cotal", "agents", `${name}.md`), text, { mode: 0o600 });
    }
    this.persona("alice", { name: "alice", role: "default", ...pins, ...scenario.alice }, "You are alice, a developer on a small team that coordinates on a Cotal mesh.");
    this.catalogAtStart = new Set(readdirSync(join(this.proj, ".cotal", "agents")));
    for (const f of scenario.files ?? []) for (const d of ["work", "proj"]) copyFileSync(join(HERE, "files", f), join(this.root, d, f));
    for (const p of scenario.seedPosts ?? []) this.must(["send", "-c", p.channel, p.text]);
    for (const seat of scenario.present ?? []) {
      const cwd = join(this.root, "seats", seat.name);
      mkdirSync(cwd, { mode: 0o700 });
      this.must(["spawn", seat.name, "--detach", "--agent", args.harness, "--cwd", cwd, ...(seat.prompt ? ["--prompt", seat.prompt] : [])], { timeoutS: 300 });
    }
    await this.settle((scenario.present ?? []).map((s) => s.name), 20, 240);
  }

  ps() {
    const r = this.cotal(["ps", "--json"], { json: true, timeoutS: 90 });
    return r.doc?.result?.items ?? undefined;
  }

  /** Wait until every named seat is present and idle for `quietS` seconds, at most `maxS`. */
  async settle(names, quietS, maxS) {
    const end = Date.now() + maxS * 1000;
    let quietSince;
    while (Date.now() < end) {
      const items = this.ps() ?? [];
      const ok = names.every((n) => items.some((i) => i.name === n && i.mesh === "idle"));
      quietSince = ok ? quietSince ?? Date.now() : undefined;
      if (quietSince && Date.now() - quietSince >= quietS * 1000) return true;
      await sleep(5000);
    }
    return false;
  }

  /** Run alice on the scenario's prompt and watch until the mesh goes quiet. */
  async runAlice() {
    const { args, scenario } = this;
    this.startedAt = new Date().toISOString();
    this.must(["spawn", "alice", "--detach", "--agent", args.harness, "--cwd", join(this.root, "work"), "--prompt", scenario.prompt], { timeoutS: 300 });
    const end = Date.now() + args.timeoutMin * 60 * 1000;
    this.snapshots = [];
    let quietSince, aliceId;
    const spawned = new Map();
    while (Date.now() < end) {
      const items = this.ps();
      if (items) {
        this.snapshots.push({ at: new Date().toISOString(), items });
        aliceId ??= bare(items.find((i) => i.name === "alice")?.id) || undefined;
        for (const i of items) if (aliceId && bare(i.spawner) === aliceId) spawned.set(i.name, { name: i.name, id: bare(i.id), agent: i.agent, model: i.model, cwd: i.cwd });
        const busy = items.some((i) => i.mesh !== "idle");
        const waiting = scenario.waitForSpawnedExit && [...spawned.keys()].some((n) => items.some((i) => i.name === n));
        quietSince = !busy && !waiting ? quietSince ?? Date.now() : undefined;
        if (quietSince && Date.now() - quietSince >= args.settleS * 1000) break;
      }
      await sleep(5000);
    }
    this.timedOut = Date.now() >= end;
    this.aliceId = aliceId;
    this.spawned = [...spawned.values()];
    this.endedAt = new Date().toISOString();
  }

  /** The Claude Code project folders this run's seats created: new since the run started, named
   *  for a path in the sandbox, and holding only transcripts whose every recorded cwd is inside it. */
  claudeProjectDirs() {
    if (!existsSync(CLAUDE_PROJECTS)) return [];
    const slug = this.root.replace(/[^A-Za-z0-9]/g, "-");
    return readdirSync(CLAUDE_PROJECTS)
      .filter((d) => !this.claudeBefore.has(d) && (d === slug || d.startsWith(`${slug}-`)))
      .map((d) => join(CLAUDE_PROJECTS, d))
      .filter((dir) => {
        const cwds = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l).cwd; } catch { return undefined; } }).filter((c) => typeof c === "string"));
        return cwds.every((c) => inside(c, this.root));
      });
  }

  /** Each seat's tool calls, normalized across harnesses: { seat, tool, args, ok, result }. */
  readCalls() {
    const calls = [];
    for (const dir of this.claudeProjectDirs()) {
      const cwdSlug = basename(dir);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
        const rows = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
        calls.push(...claudeCalls(rows, seatForClaude(cwdSlug, this.root)));
      }
    }
    const jhome = join(this.proj, ".cotal", "jcode");
    if (existsSync(jhome)) for (const seatDir of readdirSync(jhome)) {
      const seat = seatDir.replace(new RegExp(`^${SPACE}-`), "").replace(/-[0-9a-f]{12}$/, "");
      const sdir = join(jhome, seatDir, "sessions");
      if (!existsSync(sdir)) continue;
      for (const f of readdirSync(sdir).filter((x) => x.endsWith(".journal.jsonl"))) {
        const msgs = readFileSync(join(sdir, f), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return JSON.parse(l).append_messages ?? []; } catch { return []; } });
        calls.push(...jcodeCalls(msgs, seat));
      }
    }
    return calls;
  }

  history(channel) {
    const r = this.cotal(["history", ...(channel ? [channel] : ["--dms"]), "--json", "--limit", "1000"], { json: true, timeoutS: 90 });
    return r.doc;
  }

  /** Copy what the run left into `dir` and build the record grade.mjs reads. */
  record(dir) {
    mkdirSync(dir, { recursive: true });
    const calls = this.readCalls();
    const channels = new Set(["general", ...Object.keys(this.scenario.channels ?? {}), ...(this.scenario.alice.subscribe ?? [])]);
    for (const c of calls) for (const ch of [c.args?.channel, ...[c.args?.join ?? []].flat(), ...[c.args?.subscribe ?? []].flat()])
      if (typeof ch === "string" && !/[*>]/.test(ch) && ch) channels.add(ch);
    const history = { dms: this.history(), channels: {} };
    for (const ch of channels) history.channels[ch] = this.history(ch);
    const items = [...(history.dms?.result?.items ?? []), ...Object.values(history.channels).flatMap((d) => d?.result?.items ?? [])];
    const seen = new Set();
    const msgs = items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
    const finalPs = this.ps();
    if (!finalPs) throw new Error("the final cotal ps returned no roster, so the end of the run was not observed");
    const who = this.cotal(["who", "--json"], { json: true, timeoutS: 90 }).doc;
    const ids = {};
    for (const s of this.snapshots) for (const i of s.items) ids[i.name] = bare(i.id);
    for (const m of msgs) if (m.from?.name) ids[m.from.name] ??= bare(m.from.id);
    const names = Object.fromEntries(Object.entries(ids).map(([n, id]) => [id, n]));
    const personaDir = join(this.proj, ".cotal", "agents");
    mkdirSync(join(dir, "personas"), { recursive: true });
    const files = readdirSync(personaDir).filter((f) => f.endsWith(".md"));
    for (const f of files) copyFileSync(join(personaDir, f), join(dir, "personas", f));
    const aliceCalls = calls.filter((c) => c.seat === "alice");
    const record = {
      scenario: this.scenario.id, label: this.args.label, harness: this.args.harness, tree: this.args.tree,
      treeCommit: spawnSync("git", ["-C", this.args.tree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      model: FIXTURES.models[this.args.harness], prompt: this.scenario.prompt, startedAt: this.startedAt, endedAt: this.endedAt, timedOut: this.timedOut,
      alice: this.aliceId, ids,
      calls: aliceCalls,
      posts: msgs.filter((m) => m.channel).map((m) => ({ ts: m.ts, channel: m.channel, from: bare(m.from?.id), fromName: m.from?.name, text: m.text, mentions: m.mentions ?? [] })),
      dms: msgs.filter((m) => !m.channel).map((m) => ({ ts: m.ts, from: bare(m.from?.id), fromName: m.from?.name, to: bare(m.to), toName: names[bare(m.to)], text: m.text })),
      spawned: this.spawned,
      presentAtEnd: finalPs.map((i) => i.name),
      finalPsOk: true,
      personasWritten: files.filter((f) => !this.catalogAtStart.has(f)),
    };
    writeFileSync(join(dir, "record.json"), JSON.stringify(record, null, 2));
    writeFileSync(join(dir, "calls.json"), JSON.stringify(calls, null, 2));
    writeFileSync(join(dir, "spawns.json"), JSON.stringify(calls.filter((c) => ["cotal_spawn", "cotal_despawn", "cotal_persona"].includes(c.tool)), null, 2));
    writeFileSync(join(dir, "history.json"), JSON.stringify(history, null, 2));
    writeFileSync(join(dir, "ps.json"), JSON.stringify(this.snapshots, null, 2));
    writeFileSync(join(dir, "roster.json"), JSON.stringify(who ?? null, null, 2));
    const mlog = readdirSync(join(this.proj, ".cotal")).find((f) => /^manager\..*\.log$/.test(f));
    if (mlog) copyFileSync(join(this.proj, ".cotal", mlog), join(dir, "manager.log"));
    mkdirSync(join(dir, "transcripts"), { recursive: true });
    for (const d of this.claudeProjectDirs()) for (const f of readdirSync(d).filter((x) => x.endsWith(".jsonl"))) copyFileSync(join(d, f), join(dir, "transcripts", `claude-${seatForClaude(basename(d), this.root)}-${f}`));
    return record;
  }

  /** Stop the stack, then the processes this run started, then delete the sandbox behind a barrier. */
  async teardown(dir) {
    const down = this.cotal(["down"], { timeoutS: 240 });
    const owned = (p) => p.env.COTAL_HOME === this.env.COTAL_HOME || p.env.XDG_CONFIG_HOME === this.env.XDG_CONFIG_HOME || p.env.TMPDIR === this.env.TMPDIR ||
      ["JCODE_HOME", "COTAL_JCODE_HOME"].some((k) => p.env[k] !== undefined && inside(p.env[k], this.root));
    const afterDown = processes().filter(owned);
    await stop(afterDown);
    const claudeDirs = this.claudeProjectDirs();
    // The barrier: after the rename nothing can open the sandbox by its old path, and a process that
    // was inside it still shows up by its cwd, an open file or its environment.
    const gone = `${this.root}.gone`;
    renameSync(this.root, gone);
    const holders = processes({ fds: true }).filter((p) => owned(p) || inside(p.cwd, gone) || p.fds.some((f) => inside(f, gone)));
    writeFileSync(join(dir, "teardown.json"), JSON.stringify({ downStatus: down.status, stopped: afterDown.map(({ pid, cmd }) => ({ pid, cmd })), holders: holders.map(({ pid, cmd, cwd }) => ({ pid, cmd, cwd })), kept: holders.length ? gone : undefined, claudeDirs }, null, 2));
    writeFileSync(join(dir, "cli.json"), JSON.stringify(this.log, null, 2));
    if (holders.length) throw new Error(`teardown: ${holders.length} process(es) still hold the sandbox, so it was kept at ${gone} (it holds credential copies; remove it once they exit)`);
    for (const d of claudeDirs) rmSync(d, { recursive: true, force: true });
    rmSync(gone, { recursive: true, force: true });
  }
}

function seatForClaude(cwdSlug, root) {
  const slug = root.replace(/[^A-Za-z0-9]/g, "-");
  if (cwdSlug === `${slug}-work`) return "alice";
  if (cwdSlug.startsWith(`${slug}-seats-`)) return cwdSlug.slice(`${slug}-seats-`.length).replace(/-/g, "_");
  return `helper@${cwdSlug.slice(slug.length + 1) || "root"}`;
}

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("");
  return "";
}

const refused = (s) => /^(Couldn't|Can't|Cannot|Error|MCP error)/.test(s.trim());

function claudeCalls(rows, seat) {
  const uses = new Map(), out = [];
  for (const o of rows) for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
    if (b.type === "tool_use" && /^mcp__[^_]+(?:_[^_]+)*__cotal_/.test(b.name)) uses.set(b.id, { seat, tool: b.name.replace(/^mcp__.*__(cotal_)/, "$1"), args: b.input });
    if (b.type === "tool_result" && uses.has(b.tool_use_id)) {
      const u = uses.get(b.tool_use_id), result = text(b.content);
      out.push({ ...u, ok: !b.is_error && !refused(result), result });
    }
  }
  return out;
}

function jcodeCalls(msgs, seat) {
  const uses = new Map(), out = [];
  for (const m of msgs) for (const b of m.content ?? []) {
    if (b.type === "tool_use") {
      const viaProxy = b.name === "mcp_call" && b.input?.server === "cotal";
      const direct = /^mcp__cotal__cotal_/.test(b.name);
      if (viaProxy) uses.set(b.id, { seat, tool: b.input.tool, args: b.input.arguments ?? {} });
      else if (direct) uses.set(b.id, { seat, tool: b.name.replace(/^mcp__cotal__/, ""), args: b.input });
    }
    if (b.type === "tool_result" && uses.has(b.tool_use_id)) {
      const u = uses.get(b.tool_use_id), result = text(b.content);
      out.push({ ...u, ok: !b.is_error && !refused(result), result });
    }
  }
  return out;
}

/** A process's start time, which tells a live pid from a reused one. */
function started(pid) {
  try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2).split(" ")[19]; } catch { return undefined; }
}

/** This user's processes, other than this script and its parent, with cwd, environment and,
 *  when asked, the paths of their open files. */
function processes({ fds = false } = {}) {
  const mine = new Set([process.pid, process.ppid]);
  const found = [];
  for (const d of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    const pid = Number(d);
    if (mine.has(pid)) continue;
    try {
      if (statSync(`/proc/${d}`).uid !== process.getuid()) continue;
      const read = (f, fn) => { try { return fn(f); } catch { return undefined; } };
      const env = Object.fromEntries((read(`/proc/${d}/environ`, (f) => readFileSync(f, "utf8")) ?? "").split("\0").filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
      found.push({
        pid, start: started(pid), env,
        cwd: read(`/proc/${d}/cwd`, readlinkSync) ?? "",
        cmd: (read(`/proc/${d}/cmdline`, (f) => readFileSync(f, "utf8")) ?? "").replace(/\0/g, " ").slice(0, 300),
        fds: fds ? (read(`/proc/${d}/fd`, readdirSync) ?? []).map((f) => read(`/proc/${d}/fd/${f}`, readlinkSync) ?? "") : [],
      });
    } catch {}
  }
  return found;
}

/** SIGTERM, then SIGKILL after ten seconds, each only while the pid still names the same process. */
async function stop(procs) {
  const same = (p) => started(p.pid) === p.start;
  for (const p of procs) if (same(p)) try { process.kill(p.pid, "SIGTERM"); } catch {}
  let left = procs;
  for (let i = 0; i < 20 && left.length; i++) { await sleep(500); left = left.filter(same); }
  for (const p of left) if (same(p)) try { process.kill(p.pid, "SIGKILL"); } catch {}
  await sleep(500);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = FIXTURES.scenarios.filter((s) => !args.only || args.only.includes(s.id));
  if (args.only) for (const id of args.only) if (!scenarios.some((s) => s.id === id)) throw new Error(`no scenario "${id}"`);
  mkdirSync(args.out, { recursive: true });
  const summary = [];
  for (const scenario of scenarios) {
    const dir = join(args.out, `${args.label}-${args.harness}-${scenario.id}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const box = new Sandbox(args, scenario);
    let result;
    try {
      await box.start();
      await box.runAlice();
      box.record(dir);
      const record = loadRecord(dir);
      result = { ...grade(scenario.id, record), counts: counts(record), timedOut: record.timedOut, startedAt: record.startedAt, endedAt: record.endedAt };
    } catch (e) {
      result = { scenario: scenario.id, pass: false, error: String(e?.stack ?? e) };
    } finally {
      // A run whose sandbox could not be removed is not a result: it fails, and says what was kept.
      try { await box.teardown(dir); } catch (e) { result = { ...result, pass: false, error: [String(e?.message ?? e), result.error].filter(Boolean).join("\n") }; }
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
    summary.push({ scenario: scenario.id, title: scenario.title, pass: result.pass, error: result.error ? result.error.split("\n")[0] : undefined, failed: (result.checks ?? []).filter((c) => !c.ok).map((c) => c.check) });
    console.log(`${args.label} ${args.harness} ${scenario.id}: ${result.error ? "ERROR " + result.error.split("\n")[0] : result.pass ? "PASS" : "FAIL " + summary.at(-1).failed.join("; ")}`);
  }
  writeFileSync(join(args.out, `summary-${args.label}-${args.harness}.json`), JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
