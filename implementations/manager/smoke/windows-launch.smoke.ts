/**
 * Windows seam smoke (Stage 1 launch + Stage 2 control plane; no NATS, no test runner) — run with:
 * pnpm smoke:windows
 *
 * Guards the resolver + `.cmd`/`.bat` launch adapter + child-env + authenticated control-plane seams
 * a POSIX-only build breaks on Windows. Most of it runs EVERYWHERE — the pure resolver/quoting and
 * the control-auth checks are the regression guard for the local (macOS/Linux) validate loop
 * (`node:net` abstracts AF_UNIX ↔ named pipe, so the auth logic exercises identically). The pieces
 * that are inherently win32 (the ConPTY argv round-trip, orphan reap, named-pipe squat) are
 * logged-and-skipped off Windows; Windows CI is the oracle for those.
 *
 *   A. resolveOnPath resolves against the PASSED env (not global process.env), and on win32 prefers a
 *      real `.exe` over a `.cmd` shim. [WS1 / security: executable selection stays in P3 isolation]
 *   B. quoteCmdArg / buildCmdCommandLine produce stable, byte-exact cmd command lines, and REJECT
 *      (throw) the arguments cmd can't preserve. [WS2: the cmd-quoting correctness boundary]
 *   C. The PtyRuntime launches a real (pnpm-shim-shaped) `.cmd` through cmd.exe and the program gets
 *      its argv byte-for-byte — the matrix coordinated with win-testlead. [WS2 end-to-end, win32-only]
 *   D. launchEnv copies the allow-list case-insensitively under each var's source key (Windows
 *      `Path`/`ComSpec`/`windir`) with no case-duplicate. [WS5(env)]
 *   E. a hard stop of a `.cmd`-wrapped agent reaps the WHOLE conpty→cmd.exe→node tree (no orphaned
 *      grandchild). [WS2 orphan-on-kill, win32-only]
 *   F. the control endpoint authenticates the first frame: a wrong/absent token is dropped before the
 *      handler or shutdown ever runs; the cooperative `{op:"shutdown"}` routes to onShutdown, not the
 *      hook handler; controlShutdown (manager → server) round-trips. [WS3/WS4: the auth boundary]
 *   G. a managed listener whose endpoint is squatted exits(1) — fatal bind, no degraded plane. [WS3,
 *      win32-only: a named pipe is the only transport where a live squatter yields EADDRINUSE]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { connect, createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveOnPath } from "@cotal-ai/workspace";
import { launchEnv, controlEndpoint, startControlServer, type MeshAgent } from "@cotal-ai/connector-core";
import { quoteCmdArg, buildCmdCommandLine, resolveComspec, preparePtyLaunch } from "../src/runtime/windows-launch.js";
import { controlShutdown } from "../src/control-shutdown.js";
import { createRuntime } from "../src/index.js";

const isWin = process.platform === "win32";
let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(ok ? label : `${label} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, ok);
}
function throws(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// =================================================================================================
// A. resolver — env-aware, .exe-over-.cmd
// =================================================================================================
{
  const dir = mkdtempSync(join(tmpdir(), "cotal-resolve-"));
  // A bare-name lookup must read the PASSED env's PATH, not process.env — otherwise a poisoned
  // manager PATH would pick a different file than the P3-isolated child launches with.
  const base = "cotalresolveprobe";
  const shimName = isWin ? `${base}.cmd` : base;
  writeFileSync(join(dir, shimName), isWin ? "@echo off\r\n" : "#!/bin/sh\necho ok\n", { mode: 0o755 });

  const passEnv: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  check("resolveOnPath finds a bare name via the PASSED env PATH", resolveOnPath(base, passEnv) !== undefined);
  check("resolveOnPath returns undefined when the PASSED env PATH omits the dir", resolveOnPath(base, { PATH: "" }) === undefined);
  // Prove it's the PASSED env, not process.env: empty the real PATH, resolution still succeeds.
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  check("resolveOnPath uses the passed env, not process.env.PATH", resolveOnPath(base, passEnv) !== undefined);
  process.env.PATH = savedPath;

  if (isWin) {
    // Both a real .exe and a .cmd shim on PATH → the .exe wins (CreateProcessW can launch it directly).
    const both = mkdtempSync(join(tmpdir(), "cotal-resolve-both-"));
    writeFileSync(join(both, "foo.exe"), "");
    writeFileSync(join(both, "foo.cmd"), "@echo off\r\n");
    const winEnv: NodeJS.ProcessEnv = { PATH: both, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    check(".exe is preferred over .cmd for a bare name", (resolveOnPath("foo", winEnv) ?? "").toLowerCase().endsWith(".exe"));
    // The preference must survive a HOSTILE/reordered PATHEXT (.CMD before .EXE) — Cotal tiers
    // executables ahead of scripts regardless of env order, so a poisoned PATHEXT can't force the shim.
    const hostileEnv: NodeJS.ProcessEnv = { PATH: both, PATHEXT: ".CMD;.EXE;.BAT;.COM" };
    check(".exe still wins when PATHEXT lists .CMD first (order-independent)", (resolveOnPath("foo", hostileEnv) ?? "").toLowerCase().endsWith(".exe"));
    // Even a STRIPPED PATHEXT that OMITS .EXE entirely must not force the shim — .com/.exe are always probed.
    const strippedEnv: NodeJS.ProcessEnv = { PATH: both, PATHEXT: ".CMD;.BAT" };
    check(".exe still wins when PATHEXT omits .EXE (contents-independent)", (resolveOnPath("foo", strippedEnv) ?? "").toLowerCase().endsWith(".exe"));
    check("an explicit .cmd is honored", (resolveOnPath("foo.cmd", winEnv) ?? "").toLowerCase().endsWith(".cmd"));
    const onlyCmd = mkdtempSync(join(tmpdir(), "cotal-resolve-cmd-"));
    writeFileSync(join(onlyCmd, "bar.cmd"), "@echo off\r\n");
    check("a bare name resolves to its .cmd shim when that's all there is", (resolveOnPath("bar", { PATH: onlyCmd, PATHEXT: ".COM;.EXE;.BAT;.CMD" }) ?? "").toLowerCase().endsWith(".cmd"));
  } else {
    console.log("· .exe-over-.cmd preference is win32-only — skipped (CI is the oracle)");
  }
}

// =================================================================================================
// B. cmd quoting — pure, byte-exact, fail-closed. Runs EVERYWHERE (the local regression guard).
// =================================================================================================
// An env where PATH/TEMP are DEFINED (so %PATH% must be rejected) but the probe var is not.
const qenv: NodeJS.ProcessEnv = { PATH: "x", TEMP: "y" };
{
  // Stable byte output for representative arguments (computed from the Rust append_bat_arg port).
  eq("quoteCmdArg: plain word unquoted", quoteCmdArg("hello", qenv), "hello");
  eq("quoteCmdArg: spaces → quoted", quoteCmdArg("a b c", qenv), '"a b c"');
  eq("quoteCmdArg: metachar & → quoted", quoteCmdArg("a&b", qenv), '"a&b"');
  eq('quoteCmdArg: empty → ""', quoteCmdArg("", qenv), '""');
  eq("quoteCmdArg: trailing backslash doubled", quoteCmdArg("C:\\path\\", qenv), '"C:\\path\\\\"');
  eq('quoteCmdArg: embedded quote → ""', quoteCmdArg('with"quote', qenv), '"with""quote"');
  eq("quoteCmdArg: backslash-quote", quoteCmdArg('a\\"b', qenv), '"a\\\\""b"');
  eq("quoteCmdArg: lone % preserved literally", quoteCmdArg("100%done", qenv), '"100%done"');
  eq("quoteCmdArg: undefined %VAR% preserved literally", quoteCmdArg("%UNDEFINED_COTAL_XYZ%", qenv), '"%UNDEFINED_COTAL_XYZ%"');
  eq("quoteCmdArg: literal ! (delayed expansion off)", quoteCmdArg("!X!", qenv), '"!X!"');

  eq(
    "buildCmdCommandLine: /e:ON /v:OFF /d /s /c with outer-quote-wrapped invocation",
    buildCmdCommandLine("C:\\bin\\claude.cmd", ["a b", "x&y"], qenv),
    '/e:ON /v:OFF /d /s /c ""C:\\bin\\claude.cmd" "a b" "x&y""',
  );

  // REJECT (fail closed) — never silently launch a mutated value.
  throws("quoteCmdArg: rejects a newline", () => quoteCmdArg("a\nb", qenv));
  throws("quoteCmdArg: rejects a carriage return", () => quoteCmdArg("a\rb", qenv));
  throws("quoteCmdArg: rejects a NUL", () => quoteCmdArg("a\0b", qenv));
  throws("quoteCmdArg: rejects a DEFINED %VAR% (cmd would expand it)", () => quoteCmdArg("%PATH%", qenv));
  throws("quoteCmdArg: rejects a defined %VAR% substring form", () => quoteCmdArg("%PATH:~0,1%", qenv));
  throws("buildCmdCommandLine: rejects a quote in the script path", () => buildCmdCommandLine('C:\\b"d\\x.cmd', [], qenv));
  // B2: the resolved SCRIPT PATH gets the same fail-closed %VAR% rejection as argv (a `%TEMP%` in the
  // path would be cmd-expanded inside the quotes and launch a different file).
  throws("buildCmdCommandLine: rejects a defined %VAR% in the script path", () => buildCmdCommandLine("C:\\%PATH%\\x.cmd", [], qenv));
  check("buildCmdCommandLine: an UNdefined %VAR% in the script path is allowed", buildCmdCommandLine("C:\\%UNDEF_COTAL%\\x.cmd", [], qenv).includes("%UNDEF_COTAL%"));

  // B1: the wrap interpreter is the system cmd.exe from the TRUSTED operator env — a poisoned
  // ComSpec in the (child) env is IGNORED; only %SystemRoot% selects it.
  eq("resolveComspec ignores a poisoned ComSpec, uses %SystemRoot%\\System32\\cmd.exe", resolveComspec({ SystemRoot: "C:\\Windows", ComSpec: "C:\\evil\\pwn.exe" }), "C:\\Windows\\System32\\cmd.exe");
  eq("resolveComspec falls back to windir then C:\\Windows", resolveComspec({ windir: "D:\\WINNT" }), "D:\\WINNT\\System32\\cmd.exe");
}

// =================================================================================================
// C. end-to-end: real .cmd shim through the PtyRuntime, argv round-trips byte-for-byte (win32-only)
// =================================================================================================
// The matrix coordinated with win-testlead. PRESERVE = the launched program must receive the exact
// bytes. A * row is high-risk (three quoting layers stack) — asserted here; if it proves
// non-preservable on a real runner it CONVERTS TO REJECT (fail closed), never silent-mutate.
const PRESERVE_MATRIX = [
  "hello",
  "a b c",
  'with"quote',
  '"fully quoted"', // *
  "a&b",
  "a|b",
  "a<b>c",
  "a^b",
  "a)b(",
  "100%done",
  "%UNDEFINED_COTAL_XYZ%",
  "!X!",
  "C:\\path\\",
  "C:\\path\\\\", // *
  'a\\"b', // *
  "", // * (empty element must survive)
  "tab\there", // VERIFY — tab is a CRT separator; quoted should preserve
];

function launchCapture(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let h: ReturnType<ReturnType<typeof createRuntime>["spawn"]>;
    try {
      h = createRuntime("pty", "winsmoke").spawn("winsmoke", { command, args, env }, cwd);
    } catch (e) {
      resolve(`THREW:${(e as Error).message}`);
      return;
    }
    const sess = h.attach();
    let buf = "";
    sess.onData((b) => {
      buf += b.toString("utf8");
    });
    sess.onExit(() => resolve(buf));
    setTimeout(() => {
      try {
        h.stop({ graceful: false });
      } catch {
        /* gone */
      }
      resolve(buf);
    }, 8000);
  });
}

if (isWin) {
  const dir = mkdtempSync(join(tmpdir(), "cotal-winshim-"));
  // pnpm/npm-shim-shaped: @echo off + %~dp0 + node-chaining + %*. argv.cjs round-trips argv as JSON
  // wrapped in sentinels so it survives ConPTY's terminal rendering.
  writeFileSync(join(dir, "shim.cmd"), '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n');
  writeFileSync(join(dir, "argv.cjs"), 'process.stdout.write("__ARGV__"+JSON.stringify(process.argv.slice(2))+"__END__")\n');
  const shim = join(dir, "shim.cmd");
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };

  for (const arg of PRESERVE_MATRIX) {
    const out = await launchCapture(shim, [arg], env, dir);
    const m = out.match(/__ARGV__(.*)__END__/s);
    if (!m) {
      check(`shim launched + argv captured for ${JSON.stringify(arg)} (got: ${JSON.stringify(out.slice(0, 80))})`, false);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      parsed = `UNPARSEABLE:${m[1]}`;
    }
    eq(`argv preserved byte-for-byte: ${JSON.stringify(arg)}`, parsed, [arg]);
  }

  // C5: multi-arg fidelity — the `%*` boundary is where collapse/split bugs hide. Each arg must keep
  // its position and bytes; an empty arg must survive as a DISTINCT element (length preserved).
  const MULTI_ARG_MATRIX: string[][] = [
    ["a b", "x&y"],
    ["", "x"], // empty arg before a non-empty one
    ["one", "", "three"], // empty arg between non-empty ones
  ];
  for (const args of MULTI_ARG_MATRIX) {
    const out = await launchCapture(shim, args, env, dir);
    const m = out.match(/__ARGV__(.*)__END__/s);
    if (!m) {
      check(`multi-arg shim launched + captured for ${JSON.stringify(args)} (got: ${JSON.stringify(out.slice(0, 80))})`, false);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      parsed = `UNPARSEABLE:${m[1]}`;
    }
    eq(`multi-arg argv preserved (length + bytes): ${JSON.stringify(args)}`, parsed, args);
  }
} else {
  // POSIX passthrough sanity: a shim launches and its output streams through the PtyRuntime. The
  // quoting the win32 matrix exercises end-to-end is still covered locally by section B above.
  const dir = mkdtempSync(join(tmpdir(), "cotal-shim-"));
  const shim = join(dir, "shim.sh");
  writeFileSync(shim, "#!/bin/sh\necho COTAL_SHIM_OK\n", { mode: 0o755 });
  const out = await launchCapture(shim, [], { ...process.env }, dir);
  check("PtyRuntime launches a command and streams its output (POSIX passthrough)", out.includes("COTAL_SHIM_OK"));
  // preparePtyLaunch is a passthrough on POSIX — assert that so the import is exercised everywhere.
  eq("preparePtyLaunch is a passthrough on POSIX", preparePtyLaunch("claude", ["--x"], {}), { command: "claude", args: ["--x"] });
  console.log("· cmd.exe argv round-trip matrix is win32-only — skipped (CI is the oracle)");
}

// =================================================================================================
// D. child env allow-list — case-insensitive, source-key-preserving, no case-duplicate keys
// =================================================================================================
{
  const saved = { sr: process.env.SystemRoot, cs: process.env.ComSpec, wd: process.env.windir };
  // Non-canonical Windows casings (ComSpec / windir) alongside SystemRoot: launchEnv must forward
  // each under its OWN source key (NOT a forced canonical COMSPEC/WINDIR), and never a case-duplicate.
  process.env.SystemRoot = "C:\\Windows";
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
  process.env.windir = "C:\\Windows";
  const env = launchEnv();
  check("launchEnv forwards SystemRoot", env.SystemRoot === "C:\\Windows");
  check(
    "launchEnv forwards ComSpec under its SOURCE key (not COMSPEC)",
    env.ComSpec === "C:\\Windows\\System32\\cmd.exe" && env.COMSPEC === undefined,
  );
  check("launchEnv forwards windir under its source key", env.windir === "C:\\Windows");
  const lower = Object.keys(env).map((k) => k.toLowerCase());
  check("launchEnv carries no case-duplicate keys (no Path AND PATH)", lower.length === new Set(lower).size);
  const restore = (k: "SystemRoot" | "ComSpec" | "windir", v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("SystemRoot", saved.sr);
  restore("ComSpec", saved.cs);
  restore("windir", saved.wd);
}

// =================================================================================================
// E. orphan-on-kill — a hard stop of a `.cmd`-wrapped agent must terminate the WHOLE tree
//    (conpty → cmd.exe → node grandchild = the real agent), not orphan the grandchild. The wrap adds
//    the cmd.exe layer, so this guards that ConPTY's ClosePseudoConsole reaps through it. win32-only.
// =================================================================================================
if (isWin) {
  const dir = mkdtempSync(join(tmpdir(), "cotal-orphan-"));
  const pidfile = join(dir, "gpid.txt");
  writeFileSync(join(dir, "shim.cmd"), '@echo off\r\nnode "%~dp0orphan-child.cjs"\r\n');
  writeFileSync(
    join(dir, "orphan-child.cjs"),
    'const fs=require("fs"); fs.writeFileSync(process.env.COTAL_ORPHAN_PIDFILE, String(process.pid)); setInterval(()=>{}, 1<<30);\n',
  );
  const h = createRuntime("pty", "orphan").spawn(
    "orphan",
    { command: join(dir, "shim.cmd"), args: [], env: { ...process.env, COTAL_ORPHAN_PIDFILE: pidfile } },
    dir,
  );
  // Wait for the grandchild to actually start (write its real OS pid) — killing before it spawned
  // would be an invalid test.
  let gpid = 0;
  for (let i = 0; i < 100 && !gpid; i++) {
    if (existsSync(pidfile)) {
      const raw = readFileSync(pidfile, "utf8").trim();
      if (/^\d+$/.test(raw)) gpid = Number(raw);
    }
    if (!gpid) await sleep(50);
  }
  check("orphan probe: grandchild started (wrote its pid)", gpid > 0);
  if (gpid > 0) {
    h.stop({ graceful: false }); // win32 hard kill → node-pty ConPTY close
    await sleep(1500); // let the pseudoconsole close propagate down the tree
    let alive = false;
    try {
      process.kill(gpid, 0); // signal 0 = existence probe; throws ESRCH once the process is gone
      alive = true;
    } catch {
      alive = false;
    }
    console.log("orphan-probe: grandchild alive after kill =", alive);
    check("ConPTY kill terminates the cmd.exe→agent grandchild (no orphan)", !alive);
    if (alive) {
      try {
        process.kill(gpid); // never leak a live grandchild on the runner
      } catch {
        /* gone */
      }
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
} else {
  console.log("· orphan-on-kill is win32-only (the cmd.exe grandchild layer) — skipped (CI is the oracle)");
}

// =================================================================================================
// F. authenticated control plane — first-frame auth + shutdown routing. Runs EVERYWHERE (node:net
//    abstracts the AF_UNIX socket / named pipe, so the auth + routing logic exercises identically).
// =================================================================================================
function sendFrame(path: string, frame: unknown): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(path);
    let reply = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(reply);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(frame) + "\n"));
    sock.on("data", (d) => (reply += d));
    sock.on("end", finish);
    sock.on("close", finish);
    sock.on("error", finish);
    setTimeout(finish, 2000);
  });
}
function waitListening(server: ReturnType<typeof startControlServer>): Promise<void> {
  return new Promise((resolve) => {
    server.on("listening", () => resolve());
    setTimeout(resolve, 500); // backstop — listen is async (next tick), we attach before it fires
  });
}
{
  const stubAgent = {} as unknown as MeshAgent;
  const ep = controlEndpoint("smoke", "ctl");

  // F1: endpoint shape — a named pipe on win32 / a tmpdir .sock on POSIX, a 256-bit base64url token,
  // and a token-derived (so unguessable) path.
  check(
    "controlEndpoint path is a named pipe on win32 / a tmpdir .sock on POSIX",
    isWin ? ep.path.startsWith("\\\\.\\pipe\\cotal-") : ep.path.startsWith(join(tmpdir(), "cotal-")) && ep.path.endsWith(".sock"),
  );
  check("controlEndpoint token is a 43-char base64url string (32 random bytes)", /^[A-Za-z0-9_-]{43}$/.test(ep.token));
  check("controlEndpoint path is token-derived (different token → different path)", controlEndpoint("smoke", "ctl").path !== ep.path);

  const events: unknown[] = [];
  let shutdowns = 0;
  const handle = async (_a: MeshAgent, ev: unknown): Promise<Record<string, unknown>> => {
    events.push(ev);
    return { handled: true };
  };
  const server = startControlServer(stubAgent, ep, handle, { onShutdown: () => shutdowns++ });
  await waitListening(server);

  // F2: a WRONG token is dropped before the handler — no reply, the event never reaches it.
  const before = events.length;
  const r2 = await sendFrame(ep.path, { token: "not-the-token", event: { hook_event_name: "X" } });
  await sleep(50);
  eq("auth: wrong token → no reply (connection dropped)", r2, "");
  eq("auth: wrong token → handler NOT invoked", events.length, before);

  // F3: the RIGHT token + an event → handler runs and its reply comes back, with the event intact.
  const r3 = await sendFrame(ep.path, { token: ep.token, event: { hook_event_name: "SessionStart", k: 1 } });
  eq("auth: right token → handler reply returned", r3.trim(), JSON.stringify({ handled: true }));
  eq("auth: right token → handler saw the event", events.at(-1), { hook_event_name: "SessionStart", k: 1 });

  // F4: a valid {op:"shutdown"} routes to onShutdown, NOT the hook handler.
  const evBefore = events.length;
  const r4 = await sendFrame(ep.path, { token: ep.token, op: "shutdown" });
  await sleep(50);
  eq("shutdown: acked", r4.trim(), JSON.stringify({ ok: true }));
  eq("shutdown: onShutdown fired", shutdowns, 1);
  eq("shutdown: NOT routed through the hook handler", events.length, evBefore);

  // F5: a {op:"shutdown"} with a WRONG token shuts nothing down.
  await sendFrame(ep.path, { token: "nope", op: "shutdown" });
  await sleep(50);
  eq("shutdown: wrong token → onShutdown NOT fired", shutdowns, 1);

  // F6: the manager's controlShutdown client round-trips to a server's onShutdown (the WS4 wire path).
  const ep2 = controlEndpoint("smoke", "ws4");
  let ws4 = false;
  const server2 = startControlServer(stubAgent, ep2, handle, { onShutdown: () => (ws4 = true) });
  await waitListening(server2);
  controlShutdown(ep2);
  for (let i = 0; i < 40 && !ws4; i++) await sleep(25);
  check("WS4: controlShutdown(endpoint) reaches the server's onShutdown", ws4);

  server.close();
  server2.close();
}

// =================================================================================================
// G. fatal bind on a squatted endpoint — win32-only. A named pipe is the only transport where a LIVE
//    squatter yields EADDRINUSE (libuv binds with FILE_FLAG_FIRST_PIPE_INSTANCE; POSIX unlinks a
//    stale socket first). A managed listener must then exit(1), never serve a hijacked/no-op plane.
// =================================================================================================
if (isWin) {
  const ep = controlEndpoint("squat", "test");
  const squatter = createServer(() => {});
  await new Promise<void>((resolve) => squatter.listen(ep.path, () => resolve()));
  const probe = fileURLToPath(new URL("./fatal-bind-probe.ts", import.meta.url));
  const res = spawnSync(process.execPath, ["--import", "tsx", probe, ep.path, ep.token], { timeout: 15000 });
  check(`fatal bind: a squatted managed listener exits(1) (got status ${res.status})`, res.status === 1);
  squatter.close();
} else {
  console.log("· fatal-bind-on-squat needs a live named-pipe squatter (EADDRINUSE) — win32-only, skipped (CI is the oracle)");
}

// =================================================================================================
// H. pre-auth DoS hardening — on the win32 pipe ANY local process can connect, so an UNauthenticated
//    client streaming bytes with no newline must NOT grow `buf` toward the ~512MB string limit and
//    crash the long-lived server. The connection is dropped (oversized) and the server keeps serving.
//    Runs everywhere (the bound is platform-agnostic).
// =================================================================================================
{
  const stubAgent = {} as unknown as MeshAgent;
  const ep = controlEndpoint("smoke", "dos");
  let hits = 0;
  const handle = async (): Promise<Record<string, unknown>> => {
    hits++;
    return { ok: true };
  };
  const server = startControlServer(stubAgent, ep, handle);
  await waitListening(server);

  // Stream >1 MiB with NO newline — must be dropped without ever reaching the handler or crashing.
  const flood = await new Promise<string>((resolve) => {
    const sock = connect(ep.path);
    let done = false;
    const finish = (r: string): void => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    sock.on("connect", () => sock.write("x".repeat((1 << 20) + 1024)));
    sock.on("close", () => finish("closed"));
    sock.on("error", () => finish("closed"));
    setTimeout(() => finish("timeout"), 4000);
  });
  check("DoS: oversized newline-less frame is dropped (connection closed)", flood === "closed");
  eq("DoS: oversized frame never reached the handler", hits, 0);

  // The server SURVIVED the flood and still serves a valid frame on a fresh connection.
  const r = await sendFrame(ep.path, { token: ep.token, event: { hook_event_name: "Ping" } });
  eq("DoS: server still serves a valid frame after the flood", r.trim(), JSON.stringify({ ok: true }));
  eq("DoS: the post-flood valid frame reached the handler", hits, 1);

  // Slow-loris: dribble bytes (no newline) PAST the auth deadline. An ABSOLUTE deadline must drop it
  // even though traffic keeps arriving — an idle timeout would reset on each byte and never fire.
  const loris = await new Promise<string>((resolve) => {
    const sock = connect(ep.path);
    let done = false;
    const finish = (s: string): void => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(s);
    };
    sock.on("connect", () => {
      let n = 0;
      const t = setInterval(() => {
        if (n++ > 9 || sock.destroyed) return clearInterval(t);
        try {
          sock.write("x"); // one byte, never a newline — past the 5s deadline (~8s of dribble)
        } catch {
          clearInterval(t);
        }
      }, 800);
    });
    sock.on("close", () => finish("closed"));
    sock.on("error", () => finish("closed"));
    setTimeout(() => finish("timeout"), 11000);
  });
  check("DoS: a slow-loris (dribbled bytes, no newline) is dropped at the absolute auth deadline", loris === "closed");
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
